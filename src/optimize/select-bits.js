/**
 * A float `select` picks between the operands' bits (speed tier).
 *
 * V8 lowers a float `select` on x64 to a branch around a register move (x64
 * has no conditional move for vector registers), so a condition the data
 * decides (a hash bit choosing a gradient's sign, a comparison of loaded
 * values) mispredicts about half the time. The same choice made over the
 * operands' bits, `(f64.reinterpret_i64 (select (i64.reinterpret_f64 a)
 * (i64.reinterpret_f64 b) c))`, is a conditional move between integer
 * registers: no branch. The bits chosen are the operand's own, NaN payloads
 * and signed zeros included, and the operands and the condition evaluate in
 * the order they did.
 *
 * Only a condition the data decides afresh takes the bits: a bit of a computed
 * word, or an order between two computed floats. A test against a literal, or
 * inside a loop against a bound the loop never writes (a clamp's limits read
 * before it), and a NaN test (`x != x`, the canonicalization every float result
 * takes on the way into a generic slot) almost always answer alike; their
 * branch predicts, and costs less than the two register transfers the integer
 * move needs.
 *
 * A choice between the two operands of its own order test (`d < m ? d : m`, a
 * running minimum, a nearest feature point, `a > b ? a : b`) is the SIMD
 * pseudo-minimum or pseudo-maximum of those operands, whose definition is that
 * choice (`pmin(m, d)` = `d < m ? d : m`, NaN and signed zeros included): lane 0
 * of `f64x2.pmin` over the two splats. V8 lowers it to `minpd` on x64 and
 * `fcmgt` + `bsl` on arm64, all in vector registers: no branch, and none of the
 * transfers between register files the integer move puts on the chain a running
 * minimum carries from one iteration to the next. The operands then evaluate in
 * the other order, so one of them must be a read the other's evaluation does not
 * change. Without SIMD (`optimize: { simd: false }`) the choice takes the bits.
 *
 * A running minimum of values of no sign (`if (d2 < f1) f1 = d2` over squared
 * distances, worley's nine feature points) chooses by its words instead, on every
 * target: for +0, the positives and +Infinity the unsigned order of the bits is
 * the floats' order, and every NaN's bits, of either sign, lie above +Infinity's,
 * where `d < m` never picks one either. The minimum lives in an integer local, so
 * the chain from one step to the next is a compare and a select between integer
 * registers; the pseudo-minimum's chain on arm64 is a splat, `fcmgt`, `bsl` and a
 * lane move (worley 0.85x the time on an M4, 0.975x on an EPYC 9V45 and 1.017x on
 * a Xeon 8370C). Every step's value is a square, a sum or a root of such (a local
 * read through the write its list makes last before the step), every other write
 * of the minimum a literal of no sign that is no NaN or another such minimum.
 *
 * @module optimize/select-bits
 */

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const ORDERS = ['eq', 'ne', 'lt', 'gt', 'le', 'ge']
const FLOAT_CMP = new Set(['f32', 'f64'].flatMap(t => ORDERS.map(o => `${t}.${o}`)))
const ANY_CMP = new Set([...FLOAT_CMP, ...['i32', 'i64'].flatMap(t => ['eq', 'ne', 'eqz', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'].map(o => `${t}.${o}`))])
const BITS = { f64: ['i64', 'i64.reinterpret_f64', 'f64.reinterpret_i64'], f32: ['i32', 'i32.reinterpret_f32', 'f32.reinterpret_i32'] }

/** The float type `n` produces ('f64' | 'f32'), or null where it is no float or unknown. */
const floatType = (n, locals, globals) => {
  if (!isArr(n) || typeof n[0] !== 'string') return null
  const op = n[0]
  if (op === 'local.get' || op === 'local.tee') return BITS[locals.get(n[1])] ? locals.get(n[1]) : null
  if (op === 'global.get') return BITS[globals.get(n[1])] ? globals.get(n[1]) : null
  if (op === 'select') return isArr(n[1]) && n[1][0] === 'result' ? (BITS[n[1][1]] ? n[1][1] : null) : floatType(n[1], locals, globals) ?? floatType(n[2], locals, globals)
  const t = op.slice(0, 4)
  return (t === 'f64.' || t === 'f32.') && !FLOAT_CMP.has(op) ? op.slice(0, 3) : null
}

const isConst = (n) => isArr(n) && typeof n[0] === 'string' && n[0].endsWith('.const')
// the same read: two gets of one local, or a tee and a get of it
const sameRead = (a, b) => isArr(a) && isArr(b) && b[0] === 'local.get' && (a[0] === 'local.get' || a[0] === 'local.tee') && a[1] === b[1]
/** A condition the data decides afresh: a bit of a computed word (`h & 1`, its zero test), or
 *  an order between two computed floats (`d < best`). A test against a literal (a clamp, a
 *  threshold, a tag, Infinity) and a NaN test (`x != x`) hold the same way nearly always: their
 *  branch predicts, and stays. */
const decidedByData = (c, fixed = isConst) => {
  if (!isArr(c)) return false
  if (c[0] === 'i32.eqz' && c.length === 2) c = c[1]
  if (c[0] === 'i32.and' && c.length === 3) {
    if (isConst(c[1]) === isConst(c[2])) return false
    const word = isConst(c[1]) ? c[2] : c[1]
    return isArr(word) && !ANY_CMP.has(word[0])
  }
  return FLOAT_CMP.has(c[0]) && c.length === 3 && !fixed(c[1]) && !fixed(c[2]) && !sameRead(c[1], c[2]) && !sameRead(c[2], c[1])
}

// the locals `n` writes
const writes = (n, set = new Set()) => {
  if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') set.add(n[1])
  for (let i = 1; i < n.length; i++) if (isArr(n[i])) writes(n[i], set)
  return set
}
// the locals a loop writes, its nested loops included
const writtenIn = (loop, memo) => {
  let set = memo.get(loop)
  if (!set) memo.set(loop, set = writes(loop))
  return set
}

// a read of a local, or a tee of one: the local, else null
const readOf = (n) => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && typeof n[1] === 'string' ? n[1] : null
const PSEUDO = { f64: ['f64x2.splat', 'f64x2.pmin', 'f64x2.pmax', 'f64x2.extract_lane'], f32: ['f32x4.splat', 'f32x4.pmin', 'f32x4.pmax', 'f32x4.extract_lane'] }
/** `select(a, b, c)` of type `t` as the pseudo-minimum or -maximum of its arms, or null.
 *  `c` orders the arms' own values (`a < b`, `a > b`, `b < a`, `b > a`): `a < b ? a : b` is
 *  `pmin(b, a)`, `b < a ? a : b` is `pmax(b, a)`. The arms then evaluate b first: one of them
 *  is a bare read the other leaves alone, and b writes no local a or the test reads. */
const pseudoMinMax = (a, b, c, t) => {
  const x = readOf(a), y = readOf(b)
  if (x == null || y == null || x === y || !isArr(c) || c.length !== 3 || c[1]?.[0] !== 'local.get' || c[2]?.[0] !== 'local.get') return null
  const op = c[0].slice(4)
  if (c[0].slice(0, 3) !== t || (op !== 'lt' && op !== 'gt')) return null
  // which arm the test puts first: `a op b` or `b op a`
  const first = c[1][1] === x && c[2][1] === y ? 'a' : c[1][1] === y && c[2][1] === x ? 'b' : null
  if (!first) return null
  // (the test reads a's value after b ran)
  if (writes(b).has(x) || !(a[0] === 'local.get' || b[0] === 'local.get' && !writes(a).has(y))) return null
  // `a < b` (`b > a`): the smaller wins
  const min = (op === 'lt') === (first === 'a')
  const [splat, pmin, pmax, lane] = PSEUDO[t]
  return [lane, '0', [min ? pmin : pmax, [splat, b], [splat, a]]]
}

// A float that is +0 or more, or NaN, and never -0: a square, a sum, product, quotient, minimum or
// maximum of such, a root of one, an absolute value, an unsigned conversion, a literal of no sign,
// a local every write of which is one (a local starts at +0; a parameter is the caller's). Its bits
// as an unsigned word order as the floats do, and every NaN lies above +Infinity.
const SQUARES = new Set(['f64.mul', 'f32.mul'])
const NONNEG_JOIN = new Set(['f64.add', 'f32.add', 'f64.mul', 'f32.mul', 'f64.div', 'f32.div', 'f64.min', 'f32.min', 'f64.max', 'f32.max'])
const NONNEG_ALWAYS = new Set(['f64.abs', 'f32.abs', 'f64.convert_i32_u', 'f64.convert_i64_u', 'f32.convert_i32_u', 'f32.convert_i64_u'])
const NONNEG_OF = new Set(['f64.sqrt', 'f32.sqrt', 'f64.promote_f32'])
// a float literal's value as the text spells it (`inf`, `nan:0x…`, a decimal), NaN where unread (a hex float)
const literalValue = (v) => {
  if (typeof v === 'number') return v
  const t = String(v).toLowerCase()
  if (t === 'inf' || t === '+inf' || t === 'infinity') return Infinity
  if (t === '-inf' || t === '-infinity') return -Infinity
  return t.includes('nan') ? NaN : Number(t)
}
const nonneg = (n, writesOf, params, seen = new Set()) => {
  if (!isArr(n)) return false
  const op = n[0]
  if (op === 'f64.const' || op === 'f32.const') { const v = literalValue(n[1]); return v >= 0 && !Object.is(v, -0) }
  if (op === 'local.tee') return nonneg(n[2], writesOf, params, seen)
  if (op === 'local.get') {
    const x = n[1]
    if (params.has(x)) return false
    if (seen.has(x)) return true   // (a cycle: the other writes decide)
    seen.add(x)
    const ok = (writesOf.get(x) ?? []).every(w => nonneg(w, writesOf, params, seen))
    seen.delete(x)
    return ok
  }
  // x * x: one value, read twice
  if (SQUARES.has(op) && n.length === 3 && isArr(n[1]) && isArr(n[2]) && n[2][0] === 'local.get' &&
      (n[1][0] === 'local.get' || n[1][0] === 'local.tee') && n[1][1] === n[2][1]) return true
  if (NONNEG_JOIN.has(op)) return n.length === 3 && nonneg(n[1], writesOf, params, seen) && nonneg(n[2], writesOf, params, seen)
  if (NONNEG_ALWAYS.has(op)) return true
  if (NONNEG_OF.has(op)) return nonneg(n[1], writesOf, params, seen)
  return false
}
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
// (a statement a branch may leave or enter mid-list: what follows it may not have seen what precedes it)
const BRANCHES_IN = (s) => isArr(s) && (s[0] === 'loop' || s[0] === 'block' || s[0] === 'if' || s[0] === 'br' || s[0] === 'br_if' || s[0] === 'br_table')
const BITS_OF = { f64: ['i64', 'i64.reinterpret_f64', 'f64.reinterpret_i64', 'i64.lt_u', 'i64.const'], f32: ['i32', 'i32.reinterpret_f32', 'f32.reinterpret_i32', 'i32.lt_u', 'i32.const'] }
/** A running minimum of values none of which is -0 or below (`if (d < m) m = d` over distances,
 *  squared or not) chooses by its words: an unsigned compare of the bits orders such values as
 *  the floats do, and puts every NaN above +Infinity, where the float compare never picks it
 *  either. The minimum then lives in an integer local, its reads converting it back: the chain from
 *  one step to the next is a compare and a select between integer registers, on every target.
 *  Every other write of the minimum is a literal of no sign, never NaN. In `fn`, in place. */
const wordMinimums = (fn, locals) => {
  const writesOf = new Map(), statements = new Map(), bad = new Set()
  const where = new Map()   // a statement → [its list, its index]
  const scan = (n, list) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      let l = writesOf.get(n[1]); if (!l) writesOf.set(n[1], l = []); l.push(n[2])
      if (n[0] === 'local.tee' || !list) bad.add(n[1]); else { let st = statements.get(n[1]); if (!st) statements.set(n[1], st = []); st.push(n) }
    }
    for (let i = 1; i < n.length; i++) { if (LISTS.has(n[0])) where.set(n[i], [n, i]); scan(n[i], LISTS.has(n[0])) }
  }
  scan(fn, false)
  const params = new Set(fn.filter(d => isArr(d) && d[0] === 'param' && typeof d[1] === 'string').map(d => d[1]))
  // `(local.set $m (select A (local.get $m) (lt (read of A) (local.get $m))))`, or `gt` with the reads swapped
  const stepOf = (st, m) => {
    const e = st[2]
    if (!isArr(e) || e[0] !== 'select' || e.length !== 4) return null
    const [, a, b, c] = e
    const x = readOf(a)
    if (x == null || x === m || !isArr(b) || b[0] !== 'local.get' || b[1] !== m || !isArr(c) || c.length !== 3) return null
    const t = locals.get(m), get = (y, k) => isArr(c[k]) && c[k][0] === 'local.get' && c[k][1] === y
    const min = (c[0] === `${t}.lt` && get(x, 1) && get(m, 2)) || (c[0] === `${t}.gt` && get(m, 1) && get(x, 2))
    return min ? a : null
  }
  // A step's value read from a local: the write of it the statements before the step in its own list
  // make last, where none of them writes it otherwise (a local the optimizer shares between values
  // holds other ones elsewhere), else every write of it
  const stepValue = (st, a) => {
    if (!isArr(a) || a[0] !== 'local.get' || !where.has(st)) return a
    const [list, k] = where.get(st), x = a[1]
    for (let i = k - 1; i >= 1; i--) {
      const s = list[i]
      if (isArr(s) && s[0] === 'local.set' && s[1] === x) return s[2]
      if (isArr(s) && (writes(s).has(x) || BRANCHES_IN(s))) return a
    }
    return a
  }
  const clean = (st, a) => nonneg(stepValue(st, a), writesOf, params)
  // The minimums: every write a step over a value of no sign, a literal of no sign that is no NaN,
  // or a copy of another minimum of the type (a loop's version carrying it), at least one a step
  // among them. A copy's source leaving the set takes the copy with it.
  const cand = new Set()
  const literal = (v, t) => isArr(v) && v[0] === `${t}.const` && nonneg(v, writesOf, params) && !Number.isNaN(literalValue(v[1]))
  const copyOf = (v, t) => isArr(v) && v[0] === 'local.get' && locals.get(v[1]) === t ? v[1] : null
  for (const [m, sts] of statements) {
    const t = locals.get(m)
    if (bad.has(m) || !BITS_OF[t] || params.has(m)) continue
    if (sts.every(st => { const a = stepOf(st, m); return a ? clean(st, a) : literal(st[2], t) || copyOf(st[2], t) })) cand.add(m)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const m of [...cand]) {
      const t = locals.get(m)
      if (statements.get(m).every(st => stepOf(st, m) || literal(st[2], t) || cand.has(copyOf(st[2], t)))) continue
      cand.delete(m); changed = true
    }
  }
  // (a set of copies with no step among them chooses nothing)
  const stepped = new Set([...cand].filter(m => statements.get(m).some(st => stepOf(st, m))))
  for (let changed = true; changed;) {
    changed = false
    for (const m of cand) if (!stepped.has(m) && statements.get(m).some(st => stepped.has(copyOf(st[2], locals.get(m))))) { stepped.add(m); changed = true }
  }
  const plan = new Map([...cand].filter(m => stepped.has(m)).map(m => [m, `${m}$w`]))   // $m → its word local
  if (!plan.size) return
  // a copy whose source is not in the plan reads it as a float: leave the set whole or not at all
  for (const m of plan.keys()) for (const st of statements.get(m)) { const y = copyOf(st[2], locals.get(m)); if (y && !plan.has(y)) return }
  const rewrite = (n) => {
    if (!isArr(n)) return n
    if (n[0] === 'local.get' && plan.has(n[1])) return [BITS_OF[locals.get(n[1])][2], ['local.get', plan.get(n[1])]]
    if (n[0] === 'local.set' && plan.has(n[1])) {
      const m = n[1], w = plan.get(m), [, toBits, , lt] = BITS_OF[locals.get(m)]
      const a = stepOf(n, m)
      if (a) {
        const tmp = `${w}$d`
        return ['local.set', w, ['select', ['local.tee', tmp, [toBits, rewrite(a)]], ['local.get', w], [lt, ['local.get', tmp], ['local.get', w]]]]
      }
      const y = isArr(n[2]) && n[2][0] === 'local.get' && plan.has(n[2][1]) ? n[2][1] : null
      return ['local.set', w, y ? ['local.get', plan.get(y)] : [toBits, n[2]]]
    }
    for (let i = 1; i < n.length; i++) n[i] = rewrite(n[i])
    return n
  }
  for (let i = 1; i < fn.length; i++) fn[i] = rewrite(fn[i])
  let at = 2
  while (at < fn.length && isArr(fn[at]) && (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
  const decls = []
  for (const [m, w] of plan) { const word = BITS_OF[locals.get(m)][0]; decls.push(['local', w, word], ['local', `${w}$d`, word]) }
  fn.splice(at, 0, ...decls)
}

/** Rewrite the float selects of every function in `ast` (a module) to integer selects of their bits,
 *  those of a choice between two ordered operands to their pseudo-minimum or -maximum where `simd`. */
export function selectBits(ast, { simd = true } = {}) {
  if (!isArr(ast)) return ast
  const globals = new Map()
  for (const n of ast) {
    const g = isArr(n) && n[0] === 'import' ? n[n.length - 1] : n
    if (isArr(g) && g[0] === 'global' && typeof g[1] === 'string') {
      const t = g[2]
      globals.set(g[1], isArr(t) ? t[1] : t)   // `(mut f64)` or `f64`
    }
  }
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const locals = new Map()
    for (const d of fn) if (isArr(d) && (d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string' && d[1][0] === '$') locals.set(d[1], d[2])
    // Inside a loop, a bound the loop never writes (a clamp's limits read
    // once before it) holds as a literal does.
    wordMinimums(fn, locals)
    const memo = new Map()
    const visit = (n, loop) => {
      const fixed = loop ? (x) => isConst(x) || isArr(x) && x[0] === 'local.get' && !writtenIn(loop, memo).has(x[1]) : isConst
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        visit(c, c[0] === 'loop' ? c : loop)
        if (c[0] !== 'select') continue
        const typed = isArr(c[1]) && c[1][0] === 'result'
        const at = typed ? 2 : 1
        if (c.length !== at + 3 || !decidedByData(c[at + 2], fixed)) continue
        const t = floatType(c, locals, globals)
        if (!t) continue
        const pm = simd ? pseudoMinMax(c[at], c[at + 1], c[at + 2], t) : null
        if (pm) { n[i] = pm; continue }
        const [w, toBits, fromBits] = BITS[t]
        n[i] = [fromBits, ['select', ...(typed ? [['result', w]] : []), [toBits, c[at]], [toBits, c[at + 1]], c[at + 2]]]
      }
    }
    visit(fn)
  }
  return ast
}

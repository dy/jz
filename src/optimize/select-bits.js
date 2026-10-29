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

// the locals a loop writes, its nested loops included
const writtenIn = (loop, memo) => {
  let set = memo.get(loop)
  if (set) return set
  memo.set(loop, set = new Set())
  const walk = (n) => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') set.add(n[1])
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) walk(n[i])
  }
  walk(loop)
  return set
}

/** Rewrite the float selects of every function in `ast` (a module) to integer selects of their bits. */
export function selectBits(ast) {
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
        const [w, toBits, fromBits] = BITS[t]
        n[i] = [fromBits, ['select', ...(typed ? [['result', w]] : []), [toBits, c[at]], [toBits, c[at + 1]], c[at + 2]]]
      }
    }
    visit(fn)
  }
  return ast
}

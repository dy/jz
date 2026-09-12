/**
 * Wide integer accumulation: carry an f64 accumulator as i64 through a loop
 * while it provably stays an exact integer, so each ToInt32 read is one
 * `i32.wrap_i64` instead of a saturating truncation plus guard, and each
 * update is an integer add instead of an f64 round trip.
 *
 * The class: inside one loop, an f64 local `$acc` whose every write (outside
 * nested loops) is `local.set` of an f64 add/sub tree over integer leaves —
 * `f64.convert_i32_*` reads and integer constants — with `acc` itself as one
 * leaf, and whose every other read sits under a ToInt32 sink (`|0`'s guarded
 * select, the finite-proven bare wrap, the exact `$__to_int32` store
 * conversion) over such a tree. With K integer leaves per iteration and
 * |acc| ≤ C = 2⁵³ − K·2³² at the top of an iteration, every intermediate is an
 * integer of magnitude ≤ 2⁵³, which f64 holds exactly, so the i64 copy agrees
 * bit for bit: ToInt32 is the low word and the ring `i32.add`/`i32.sub` over
 * it, an update is `i64.add`/`i64.sub`, and the value converts back exactly at
 * loop exit.
 *
 *   (block $done
 *     (block $slow
 *       (br_if $slow ¬(acc is an integer, not -0, |acc| ≤ C))
 *       (local.set $acc64 (i64.trunc_sat_f64_s acc))
 *       (block $exit                       ;; the clone's `br $brk` exits land here
 *         (loop $L
 *           (if |acc64| > C (then acc ← acc64 (br $slow)))   ;; header check
 *           …body: updates as i64.add, sinks as i32.wrap_i64…)
 *         acc ← acc64 (br $done))          ;; fallthrough exit
 *       acc ← acc64 (br $brk))             ;; the original exit target
 *     (loop $L …original, verbatim…))
 *
 * The header check bails to the ORIGINAL loop at the same iteration with the
 * f64 value restored, so an accumulator that outgrows 2⁵³ (where JS rounds)
 * continues under f64 semantics from that point: no trip-count proof, and
 * zero-trip loops, early exits and any trip count behave as before. Declined
 * when the accumulator is read any other way inside the loop (a plain f64 use,
 * a `local.tee`), updated inside a nested loop, or when a branch leaves the
 * loop past its enclosing block (the restore would be skipped). V8's JIT
 * speculates such accumulators as int32 from feedback; this is the ahead-of-
 * time proof of the same thing. Speed tiers only: the loop body is duplicated.
 *
 * @module optimize/wide-accumulator
 */
import { findBodyStart, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'

const isArr = Array.isArray
const isInf = (n) => isArr(n) && n[0] === 'f64.const' && (n[1] === Infinity || n[1] === 'inf' || n[1] === 'Infinity')
const isZero32 = (n) => isArr(n) && n[0] === 'i32.const' && Number(n[1]) === 0
const isLabel = (s) => typeof s === 'string' && s[0] === '$'
const isConv = (n) => isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && n.length === 2
const intConst = (n) => isArr(n) && n[0] === 'f64.const' && typeof n[1] === 'number' && Number.isInteger(n[1]) && !Object.is(n[1], -0) && Math.abs(n[1]) <= 2 ** 32 ? n[1] : null

// An f64 add/sub tree over integer leaves reading `name` in at most one leaf:
// { k: integer leaves, self: reads name }. Null for any other shape.
const intTree = (n, name) => {
  if (!isArr(n)) return null
  if (n[0] === 'local.get') return n[1] === name ? { k: 0, self: true } : null
  if (isConv(n) || intConst(n) != null) return { k: 1, self: false }
  if ((n[0] === 'f64.add' || n[0] === 'f64.sub') && n.length === 3) {
    const a = intTree(n[1], name), b = intTree(n[2], name)
    return a && b && !(a.self && b.self) ? { k: a.k + b.k, self: a.self || b.self } : null
  }
  return null
}

// The f64 operand under a ToInt32 sink shape, or null:
//   (select (i32.wrap_i64 (i64.trunc_sat_f64_s E)) (i32.const 0) (f64.ne E' inf))   toI32's guard, E' re-reading E
//   (i32.wrap_i64 (i64.trunc_sat_f64_s E))                                           the finite-proven form
//   (call $__to_int32 E)                                                             the exact store conversion
const sinkOperand = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'select' && n.length === 4 && isZero32(n[2])) {
    const w = n[1], c = n[3]
    if (!(isArr(w) && w[0] === 'i32.wrap_i64' && isArr(w[1]) && w[1][0] === 'i64.trunc_sat_f64_s')) return null
    const e = w[1][1]
    if (!(isArr(c) && c[0] === 'f64.ne' && isInf(c[2]))) return null
    const reread = isArr(e) && (e[0] === 'local.tee' || e[0] === 'local.get') ? e[1] : null
    return reread != null && isArr(c[1]) && c[1][0] === 'local.get' && c[1][1] === reread ? e : null
  }
  if (n[0] === 'i32.wrap_i64' && isArr(n[1]) && n[1][0] === 'i64.trunc_sat_f64_s') return n[1][1]
  if (n[0] === 'call' && n[1] === '$__to_int32' && n.length === 3) return n[2]
  return null
}

export function wideAccumulator(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const f64Locals = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && c[2] === 'f64') f64Locals.add(c[1])
  }
  if (!f64Locals.size) return
  // Loops with their parent slot, innermost first (children follow parents in pre-order).
  const loops = [], reads = new Map()
  let unsafe = false, id = 0
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: (n, parent, idx) => {
    if (n[0] === 'loop' && parent) loops.push({ node: n, parent, idx })
    const reserved = typeof n[1] === 'string' && /^\$__wa(\d+)/.exec(n[1])
    if (reserved) id = Math.max(id, Number(reserved[1]) + 1)
    // Exceptions can expose unrestored carriers to a catch outside the loop.
    // Numeric local references can alias a named carrier. Decline both.
    if (/^(try|try_table|catch.*)$/.test(n[0]) ||
        /^local\.(get|set|tee)$/.test(n[0]) && !isLabel(n[1])) unsafe = true
    if (n[0] === 'local.get') reads.set(n[1], (reads.get(n[1]) ?? 0) + 1)
  } })
  if (unsafe) return
  const newLocals = []
  for (let k = loops.length - 1; k >= 0; k--) versionLoop(loops[k])
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)

  function versionLoop({ node: loop, parent, idx }) {
    if (!isLabel(loop[1]) || loop.some(x => isArr(x) && (x[0] === 'result' || x[0] === 'param'))) return
    // The enclosing block's label is the loop's own exit target; every other
    // outward branch skips the restore.
    const brk = parent[0] === 'block' && isLabel(parent[1]) && !parent.some(x => isArr(x) && x[0] === 'result') ? parent[1] : null
    const inner = new Set()
    walkAst(loop, { enter: n => { if ((n[0] === 'block' || n[0] === 'loop') && isLabel(n[1])) inner.add(n[1]) } })
    let escapes = false
    walkAst(loop, { enter: n => {
      if (n[0] === 'br' || n[0] === 'br_if') { if (!inner.has(n[1]) && n[1] !== brk) escapes = true }
      else if (n[0] === 'br_table') for (const l of n.slice(1)) if (!isArr(l) && (!isLabel(l) || !inner.has(l) && l !== brk)) escapes = true
    } })
    if (escapes) return
    // Candidates: f64 locals every write of which is an int-tree update outside nested loops.
    const leaves = new Map(), bad = new Set()
    walkAst(loop, { enter: (n, p) => {
      if (p && n[0] === 'loop') {
        walkAst(n, { enter: m => { if ((m[0] === 'local.set' || m[0] === 'local.tee') && f64Locals.has(m[1])) bad.add(m[1]) } })
        return false
      }
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && f64Locals.has(n[1])) {
        const t = n[0] === 'local.set' ? intTree(n[2], n[1]) : null
        if (t?.self) leaves.set(n[1], (leaves.get(n[1]) ?? 0) + t.k); else bad.add(n[1])
      }
    } })
    const names = [...leaves.keys()].filter(name => !bad.has(name))
    if (!names.length) return
    const wide = new Map(names.map(name => [name, `$__wa${id++}`]))
    // Rewrite a clone: every read of a candidate must be its own update or sit under a sink.
    let ok = true, sinkLeaves = 0, sinks = 0
    const dropped = new Map()   // guard temps whose only read was the select's re-read
    const accOf = (n) => !isArr(n) ? null
      : n[0] === 'local.get' ? (wide.has(n[1]) ? n[1] : null)
      : n[0] === 'f64.add' || n[0] === 'f64.sub' ? accOf(n[1]) ?? accOf(n[2]) : null
    const mk64 = (n) =>   // the i64 form of an int tree
      n[0] === 'local.get' ? ['local.get', wide.get(n[1])]
      : n[0] === 'f64.convert_i32_s' ? ['i64.extend_i32_s', rw(n[1])]
      : n[0] === 'f64.convert_i32_u' ? ['i64.extend_i32_u', rw(n[1])]
      : n[0] === 'f64.const' ? ['i64.const', String(n[1])]
      : [n[0] === 'f64.add' ? 'i64.add' : 'i64.sub', mk64(n[1]), mk64(n[2])]
    const mk32 = (n) =>   // ToInt32 of an int tree: the ring over the low word
      n[0] === 'local.get' ? ['i32.wrap_i64', ['local.get', wide.get(n[1])]]
      : isConv(n) ? rw(n[1])
      : n[0] === 'f64.const' ? ['i32.const', n[1] | 0]
      : [n[0] === 'f64.add' ? 'i32.add' : 'i32.sub', mk32(n[1]), mk32(n[2])]
    const rw = (n) => {
      if (!isArr(n) || !ok) return n
      if (n[0] === 'local.get' && wide.has(n[1])) { ok = false; return n }
      if (n[0] === 'local.set' && wide.has(n[1])) return ['local.set', wide.get(n[1]), mk64(n[2])]
      const e = sinkOperand(n)
      if (e != null) {
        const v = isArr(e) && e[0] === 'local.tee' && e.length === 3 ? e[2] : e
        const name = accOf(v), t = name != null && intTree(v, name)
        if (t?.self) {
          if (e[0] === 'local.tee') dropped.set(e[1], (dropped.get(e[1]) ?? 0) + 1)
          sinks++
          sinkLeaves = Math.max(sinkLeaves, t.k)
          return mk32(v)
        }
      }
      const out = [n[0]]
      for (let i = 1; i < n.length; i++) out.push(rw(n[i]))
      return out
    }
    const clone = rw(loop)
    if (!ok) return
    // A deleted tee may feed code after this loop. Only its own guard reads
    // may disappear; the census includes every read in the whole function.
    for (const [t, count] of dropped) if (reads.get(t) !== count) ok = false
    // K integer leaves per iteration: at least one (a step), few enough to keep the bound.
    const K = Math.max(...names.map(name => leaves.get(name))) + sinkLeaves
    if (!ok || !sinks || K < 1 || K > 2 ** 16) return
    // |acc| bound at the top of an iteration: the iteration's K integer steps stay ≤ 2⁵³.
    const C = 2 ** 53 - K * 2 ** 32, C64 = String(C), C64x2 = String(2 * C), Cf = C
    const exit = `$__wa${id++}x`, slow = `$__wa${id++}s`, done = `$__wa${id++}d`
    const relabel = (n) => {
      if (!isArr(n)) return n
      if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === brk) return [n[0], exit, ...n.slice(2).map(relabel)]
      if (n[0] === 'br_table') return n.map((x, i) => i > 0 && x === brk ? exit : relabel(x))
      return n.map(relabel)
    }
    const restore = () => names.map(name => ['local.set', name, ['f64.convert_i64_s', ['local.get', wide.get(name)]]])
    const header = names.map(name => ['if',
      ['i64.gt_u', ['i64.add', ['local.get', wide.get(name)], ['i64.const', C64]], ['i64.const', C64x2]],
      ['then', ...restore(), ['br', slow]]])
    const fast = [clone[0], clone[1], ...header, ...clone.slice(2)]
    const entry = names.flatMap(name => {
      const acc = () => ['local.get', name]
      return [
        // An integer that survives the i64 round trip bit for bit (rejects NaN, ±∞, fractions, -0) …
        ['br_if', slow, ['i64.ne', ['i64.reinterpret_f64', ['f64.convert_i64_s', ['i64.trunc_sat_f64_s', acc()]]], ['i64.reinterpret_f64', acc()]]],
        // … within the carried magnitude.
        ['br_if', slow, ['f64.gt', ['f64.abs', acc()], ['f64.const', Cf]]],
        ['local.set', wide.get(name), ['i64.trunc_sat_f64_s', acc()]],
      ]
    })
    for (const name of names) newLocals.push(['local', wide.get(name), 'i64'])
    const guarded = brk == null
      ? [fast, ...restore(), ['br', done]]
      : [['block', exit, relabel(fast), ...restore(), ['br', done]], ...restore(), ['br', brk]]
    parent[idx] = ['block', done, ['block', slow, ...entry, ...guarded], cloneIR(loop)]
  }
}

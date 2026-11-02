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
 * zero-trip loops, early exits and any trip count behave as before. A loop
 * whose passes a counter bounds (optimize/word-ranges.js loopTrips: `i = i + 1`
 * on every way round, within the interval its test holds it to) needs no
 * header: T passes of steps of magnitude D (a literal's, 2³¹ for an int32, 2³²
 * for a uint32) move the carrier by at most T·D, so an entry within 2⁵³ − T·D
 * stays exact throughout (a prefix sum over 256 int32 counts, a token counter
 * under a string's length). A carrier is declined when read any other way
 * inside the loop (a plain f64 use, a `local.tee`) or updated inside a nested
 * loop; the loop is declined when its branches out reach more than one label
 * (the restore runs before the one branch out; a sink is also the conversion's
 * inline tail, peephole.js lowerToInt32Tails). V8's JIT
 * speculates such accumulators as int32 from feedback; this is the ahead-of-
 * time proof of the same thing. Level 2 and above: the loop body is duplicated,
 * so the size tier keeps one loop. The win does not need a ToInt32 read: the
 * carried update alone takes an f64 add off the loop-carried chain.
 *
 * @module optimize/wide-accumulator
 */
import { findBodyStart, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'
import { int32Operand, guardedInt32Operand } from '../ir/numeric.js'
import { wordRanges, loopTrips } from './word-ranges.js'
import { IR_FULL, irSize, kernelLoopIR } from '../growth.js'

const isArr = Array.isArray
const isLabel = (s) => typeof s === 'string' && s[0] === '$'
const isConv = (n) => isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && n.length === 2
const intConst = (n) => isArr(n) && n[0] === 'f64.const' && typeof n[1] === 'number' && Number.isInteger(n[1]) && !Object.is(n[1], -0) && Math.abs(n[1]) <= 2 ** 32 ? n[1] : null

// An f64 add/sub tree over integer leaves reading `name` in at most one leaf:
// { k: integer leaves, mag: the most they add, self: reads name }. Null for any other shape.
const intTree = (n, name) => {
  if (!isArr(n)) return null
  if (n[0] === 'local.get') return n[1] === name ? { k: 0, mag: 0, self: true } : null
  if (isConv(n)) return { k: 1, mag: n[0] === 'f64.convert_i32_u' ? 2 ** 32 : 2 ** 31, self: false }
  if (intConst(n) != null) return { k: 1, mag: Math.abs(intConst(n)), self: false }
  if ((n[0] === 'f64.add' || n[0] === 'f64.sub') && n.length === 3) {
    const a = intTree(n[1], name), b = intTree(n[2], name)
    return a && b && !(a.self && b.self) ? { k: a.k + b.k, mag: a.mag + b.mag, self: a.self || b.self } : null
  }
  return null
}

export function wideAccumulator(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const f64Locals = new Set(), params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && c[2] === 'f64') f64Locals.add(c[1])
    if (isArr(c) && c[0] === 'param') params.add(c[1])
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
  // the way to each loop: every construct around it and the child the way goes through
  const paths = new Map(), way = []
  const trace = (n) => { for (let i = 1; i < n.length; i++) if (isArr(n[i])) { way.push([n, i]); if (n[i][0] === 'loop') paths.set(n[i], way.slice()); trace(n[i]); way.pop() } }
  trace(fn)
  const writesTo = (n, name) => isArr(n) && ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name || n.some(m => writesTo(m, name)))
  // The literal a float local holds where a loop starts, or null: the last write before
  // the loop in the sequences around it, a literal, or a declared local's zero; an
  // outer loop's earlier passes and a write the way may skip leave it unknown.
  const entryValue = (loop, name) => {
    const path = paths.get(loop)
    for (let d = (path?.length ?? 0) - 1; d >= 0; d--) {
      const [n, i] = path[d], op = n[0]
      if (op === 'if') {
        // (an arm is entered past the test alone)
        const test = n.findIndex((c, k) => k > 0 && isArr(c) && c[0] !== 'result' && c[0] !== 'type' && c[0] !== 'param')
        if (test < 0 || test >= i || writesTo(n[test], name)) return null
        continue
      }
      if (op !== 'func' && op !== 'block' && op !== 'loop' && op !== 'then' && op !== 'else') return null
      for (let j = i - 1; j >= 1; j--) {
        const c = n[j]
        if (isArr(c) && c[0] === 'local.set' && c[1] === name) return intConst(c[2])
        if (writesTo(c, name)) return null
      }
      if (op === 'func') return params.has(name) ? null : 0
      if (op === 'loop') return null
    }
    return null
  }
  // Whether running off the end of `loop` reaches the end of the block `label` and
  // nothing between: the loop and each construct up to that block last in its sequence.
  const endsAt = (loop, label) => {
    const path = paths.get(loop)
    for (let d = (path?.length ?? 0) - 1; d >= 0; d--) {
      const [n, i] = path[d], op = n[0]
      if (op === 'if') continue
      if (op !== 'block' && op !== 'then' && op !== 'else') return false
      for (let j = i + 1; j < n.length; j++) if (isArr(n[j])) return false
      if (op === 'block' && n[1] === label) return true
    }
    return false
  }
  // (the passes each loop runs, as the function stands before any loop is versioned)
  let ranges
  const trips = (loop) => (ranges ??= wordRanges(fn) || false) ? loopTrips(loop, ranges) : Infinity
  // the labels of the function's blocks of no result: where a branch out may go after the restore
  // (a label named twice could be another construct where a branch resolves it)
  const plainBlocks = new Set(), named = new Set(), twice = new Set()
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: n => {
    if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && isLabel(n[1])) { if (named.has(n[1])) twice.add(n[1]); named.add(n[1]) }
    if (n[0] === 'block' && isLabel(n[1]) && !n.some(x => isArr(x) && (x[0] === 'result' || x[0] === 'param' || x[0] === 'type'))) plainBlocks.add(n[1])
  } })
  for (const l of twice) plainBlocks.delete(l)
  // a version is a copy of its loop: past the function's growth budget, of a kernel loop alone (src/growth.js)
  let room = IR_FULL - irSize(fn)
  for (let k = loops.length - 1; k >= 0; k--) versionLoop(loops[k])
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)

  // A copy of a float local the loop's statements read only until either is written
  // again (`t = sum; count[i] = t; sum += c`, a store staging its value) reads the
  // original there, and the copy goes: the original's reads are then all there is.
  function forwardCopies(loop) {
    let i = 2
    while (isArr(loop[i]) && (loop[i][0] === 'result' || loop[i][0] === 'type' || loop[i][0] === 'param')) i++
    for (; i < loop.length; i++) {
      const c = loop[i]
      if (!isArr(c) || c[0] !== 'local.set' || !f64Locals.has(c[1]) || !isArr(c[2]) || c[2][0] !== 'local.get' || !f64Locals.has(c[2][1]) || c[1] === c[2][1]) continue
      const t = c[1], a = c[2][1]
      const writes = (n) => isArr(n) && ((n[0] === 'local.set' || n[0] === 'local.tee') && (n[1] === t || n[1] === a) || n.some(writes))
      const readsOf = (n) => !isArr(n) ? 0 : (n[0] === 'local.get' && n[1] === t ? 1 : 0) + n.reduce((k, m) => k + readsOf(m), 0)
      let j = i + 1, seen = 0
      for (; j < loop.length && !writes(loop[j]); j++) seen += readsOf(loop[j])
      // (every read of the copy in the function, counted afresh: a loop versioned before this one copied its reads)
      if (!seen || seen !== readsOf(fn)) continue
      const sub = (n) => { if (!isArr(n)) return; for (let k = 1; k < n.length; k++) if (isArr(n[k]) && n[k][0] === 'local.get' && n[k][1] === t) n[k] = ['local.get', a]; else sub(n[k]) }
      for (let k = i + 1; k < j; k++) if (loop[k][0] === 'local.get' && loop[k][1] === t) loop[k] = ['local.get', a]; else sub(loop[k])
      loop.splice(i--, 1)
    }
  }

  function versionLoop({ node: orig, parent, idx }) {
    let loop = orig
    if (!isLabel(loop[1]) || loop.some(x => isArr(x) && (x[0] === 'result' || x[0] === 'param'))) return
    const n0 = irSize(loop)
    if (n0 > room && !kernelLoopIR(loop)) return
    // The one label the loop's branches out reach (a block of no result around
    // it, its own exit or one past an arm holding it): the restore runs before it.
    const inner = new Set()
    walkAst(loop, { enter: n => { if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && isLabel(n[1])) inner.add(n[1]) } })
    const out = new Set()
    let escapes = false
    walkAst(loop, { enter: n => {
      if (n[0] === 'br' || n[0] === 'br_if') { if (!inner.has(n[1])) out.add(n[1]) }
      else if (n[0] === 'br_table') for (const l of n.slice(1)) if (!isArr(l) && (!isLabel(l) || !inner.has(l))) escapes = true
    } })
    if (escapes || out.size > 1) return
    const brk = out.size ? [...out][0] : null
    if (brk != null && (!isLabel(brk) || !plainBlocks.has(brk))) return
    // (the copy reads the carrier where a store staged it; the loop as written stays as it is)
    loop = cloneIR(orig)
    forwardCopies(loop)
    // Candidates: f64 locals every write of which is an int-tree update outside nested loops.
    const leaves = new Map(), mags = new Map(), bad = new Set()
    walkAst(loop, { enter: (n, p) => {
      if (p && n[0] === 'loop') {
        walkAst(n, { enter: m => { if ((m[0] === 'local.set' || m[0] === 'local.tee') && f64Locals.has(m[1])) bad.add(m[1]) } })
        return false
      }
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && f64Locals.has(n[1])) {
        const t = n[0] === 'local.set' ? intTree(n[2], n[1]) : null
        if (t?.self) { leaves.set(n[1], (leaves.get(n[1]) ?? 0) + t.k); mags.set(n[1], (mags.get(n[1]) ?? 0) + t.mag) } else bad.add(n[1])
      }
    } })
    let names = [...leaves.keys()].filter(name => !bad.has(name))
    if (!names.length) return
    const wide = new Map(names.map(name => [name, `$__wa${id++}`]))
    // Rewrite a clone: every read of a candidate must be its own update or sit under a sink.
    let ok = true, sinkLeaves = 0, sinkMag = 0
    const rejected = new Set()
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
      if (!isArr(n)) return n
      if (n[0] === 'local.get' && wide.has(n[1])) { rejected.add(n[1]); return n }
      if (n[0] === 'local.set' && wide.has(n[1])) return ['local.set', wide.get(n[1]), mk64(n[2])]
      // (the conversion's inline tail reads a tee's temp in both arms, the select form once)
      const plain = int32Operand(n), e = plain ?? guardedInt32Operand(n)
      if (e != null) {
        const v = isArr(e) && e[0] === 'local.tee' && e.length === 3 ? e[2] : e
        const name = accOf(v), t = name != null && intTree(v, name)
        if (t?.self) {
          if (e[0] === 'local.tee') dropped.set(e[1], (dropped.get(e[1]) ?? 0) + (plain ? 1 : 2))
          sinkLeaves = Math.max(sinkLeaves, t.k)
          sinkMag = Math.max(sinkMag, t.mag)
          return mk32(v)
        }
      }
      const out = [n[0]]
      for (let i = 1; i < n.length; i++) out.push(rw(n[i]))
      return out
    }
    let clone
    for (;;) {
      clone = rw(loop)
      if (!rejected.size) break
      // A counter read by a float comparison does not disqualify an unrelated
      // integer accumulator. Rebuild from the original loop after removing
      // rejected carriers, so their reads and writes retain f64 semantics.
      for (const name of rejected) wide.delete(name)
      names = names.filter(name => wide.has(name))
      if (!names.length) return
      rejected.clear(); dropped.clear(); sinkLeaves = 0; sinkMag = 0
    }
    // A deleted tee may feed code after this loop. Only its own guard reads
    // may disappear; the census includes every read in the whole function.
    for (const [t, count] of dropped) if (reads.get(t) !== count) ok = false
    // K integer leaves per iteration: at least one (a step), few enough to keep the bound.
    const K = Math.max(...names.map(name => leaves.get(name))) + sinkLeaves
    if (!ok || K < 1 || K > 2 ** 16) return
    // |acc| bound at the top of an iteration: the iteration's K integer steps stay ≤ 2⁵³.
    // Where the loop's passes are bounded, the bound at entry covers them all and no
    // iteration tests.
    const growth = trips(orig) * Math.max(...names.map(name => mags.get(name)))
    const counted = growth + sinkMag < 2 ** 52
    const C = counted ? 2 ** 53 - growth - sinkMag : 2 ** 53 - K * 2 ** 32, C64 = String(C), C64x2 = String(2 * C), Cf = C
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
    const fast = counted ? clone : [clone[0], clone[1], ...header, ...clone.slice(2)]
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
    // Counted passes from literals within the bound: the copy alone, no test, no loop beside it.
    const starts = counted ? names.map(name => entryValue(orig, name)) : []
    if (counted && starts.every(v => v != null && Math.abs(v) <= C)) {
      const init = names.map((name, k) => ['local.set', wide.get(name), ['i64.const', String(starts[k])]])
      // (where leaving to `brk` and running off the loop's end arrive at one place, both
      // restore after a block around the loop, which keeps the loop's top-test shape)
      const parts = brk == null ? [...init, fast, ...restore()]
        : endsAt(orig, brk) ? [['block', exit, ...init, relabel(fast)], ...restore()]
        : [['block', done, ...init, ['block', exit, relabel(fast), ...restore(), ['br', done]], ...restore(), ['br', brk]]]
      parent.splice(idx, 1, ...parts)
      room -= parts.reduce((k, p) => k + irSize(p), 0) - n0
      return
    }
    const guarded = brk == null
      ? [fast, ...restore(), ['br', done]]
      : [['block', exit, relabel(fast), ...restore(), ['br', done]], ...restore(), ['br', brk]]
    parent[idx] = ['block', done, ['block', slow, ...entry, ...guarded], orig]
    room -= irSize(parent[idx]) - n0
  }
}

// Loop-body op counts and the inputs that select the loops a call enters, shared
// by the codegen ratchet (test/perf-ratchet.js) and the spelling gate
// (test/spellings.js).
import { instantiate } from '../interop.js'
import encodeWat from 'watr/compile'

// Count instruction nodes (every S-expr array) lexically inside any `(loop …)`.
// A wide-accumulator versioning (src/optimize/wide-accumulator.js) keeps the
// original loop as the cold fallback, the last child of its `$__wa…d` block:
// the per-iteration cost this proxies is the guarded clone's, so the fallback
// is not counted. The clone's header check is real per-iteration work and is.
// A specialized loop (src/optimize/specialize.js) keeps the loop as written
// the same way: the last child of its `$__sp.f<n>d` block, or of the block
// that block holds (the loop's own exit). The copy's guards and the tests
// ahead of it are counted.
// A loop's compaction site (src/optimize/loop-compact.js) tests the heap
// against a threshold each iteration, which is counted, and past it runs the
// kernel once per megabytes allocated: that block, `(if (call $__gc_begin …)
// (then …))`, is cold and not counted.
const isLoop = (n) => Array.isArray(n) && n[0] === 'loop'
const isSite = (n) => n[0] === 'if' && Array.isArray(n[1]) && n[1][0] === 'call' && n[1][1] === '$__gc_begin'
export const loopBodyOps = (tree, entered) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n) || n[0] === 'loop' && entered && !entered.has(n) || isSite(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && typeof n[0] === 'string') count++
    let end = n[0] === 'block' && /^\$__wa\d+d$/.test(n[1]) ? n.length - 1 : n.length
    const copy = n[0] === 'block' && typeof n[1] === 'string' && /__sp\.f\d+d$/.test(n[1])
    if (copy && isLoop(n[end - 1])) end--
    for (let i = 1; i < end; i++) {
      const c = n[i]
      if (!copy || !Array.isArray(c) || c[0] !== 'block' || !isLoop(c[c.length - 1])) { walk(c, here); continue }
      if (here) count++
      for (let k = 1; k < c.length - 1; k++) walk(c[k], here)
    }
  }
  walk(tree, false)
  return count
}

// Identify the loops selected by real entry guards, after all codegen passes.
// Instrument only a temporary assembly: counters never enter the measured tree.
// This handles both if/else and block/br_if forms without guessing from names or
// ignoring arbitrary fallback arms. Total loop cost remains independently capped.
// `calls` are [export, args] pairs, run in order on one instance: the result is
// the loops entered at instantiation, and for each call the loops it entered
// (with the reset after it) and what it returned.
export const runEntered = (tree, calls) => {
  const loops = [], start = new Set(), runs = []
  let cur = start
  const walk = n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'loop') {
      const id = loops.length
      let body = typeof n[1] === 'string' ? 2 : 1
      while (Array.isArray(n[body]) && ['type', 'param', 'result'].includes(n[body][0])) body++
      loops.push([n, body])
      n.splice(body, 0, ['call', '$__ratchet_enter', ['i32.const', id]])
    }
    for (const c of n) walk(c)
  }
  walk(tree)
  tree.splice(1, 0, ['import', '"ratchet"', '"enter"', ['func', '$__ratchet_enter', ['param', 'i32']]])
  let binary
  try { binary = encodeWat(tree) }
  finally { tree.splice(1, 1); for (const [loop, body] of loops) loop.splice(body, 1) }
  const imports = { ratchet: { enter: id => cur.add(loops[id][0]) } }
  const each = (exports, reset) => {
    for (const [name, args] of calls) {
      cur = new Set()
      runs.push({ loops: cur, ret: exports[name](...args) })
      reset?.()
    }
  }
  // numbers cross a raw instance; arrays go through the host bridge
  if (calls.some(([, args]) => args.some(a => typeof a === 'object'))) {
    const { exports, memory } = instantiate(new WebAssembly.Module(binary), { imports })
    each(exports, () => memory?.reset?.())
  } else {
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(binary), imports)
    each(exports)
  }
  return { start, runs }
}

// The ops of the loops any of `calls` (argument lists of `f`) entered.
export const enteredLoopOps = (tree, calls) => {
  const { start, runs } = runEntered(tree, calls.map(args => ['f', args]))
  return loopBodyOps(tree, new Set([...start, ...runs.flatMap(r => [...r.loops])]))
}

// Correct Number counters need a guarded integer loop plus a full-Number
// fallback. Across the same 40 int seeds the entered integer loops remain 647
// nodes; the additional fallback costs 702. Preserve 647 as the fast-path cap,
// and also cap the existing overall proxy at 1349. Inputs cover no work, positive integer
// and fractional bounds; fallback presence cannot dilute the fast-path bar.
const INT_CALLS = [[0, 3, 5, 7], [4, 3, 5, 7], [3.5, -1, 0, 7]]
// The float, mixed and cond programs take the same (n, p0, p1, p2) and got the
// same guarded copy for their Number counters (2026-10-01, `prove counter
// widths and preserve full Number loop bounds`; the wide accumulator's clones
// are evaluated per carrier since the same day). With those calls the entered
// loops count what the whole corpus did before: float 784, mixed 1137 against
// 1148, cond 581; the retained fallbacks are the rest of the total, which keeps
// its own cap. A category that takes arrays is counted whole, as before.
export const NUMERIC_CALLS = { int: INT_CALLS, float: INT_CALLS, mixed: INT_CALLS, cond: INT_CALLS }
// The array programs take the same guarded copies, and their totals count the
// runtime's loops too (the reach walk, the reset's heal loops, the string
// helpers), so the loops the calls enter are a small share of each: Float64Array,
// Float32Array and plain arrays run each element-kind variant, no work and a
// fractional bound run the guards. Against the restored baselines' tree
// (88f5f193), entered: buf 3715 -> 2830, nest 1878 -> 2034, slice 25910 -> 26128,
// ring 4720 -> 4720, condref 10565 -> 7587, fgather 6840 -> 5920; the totals'
// growth (buf 17288 -> 23668, nest 3571 -> 5595, slice 121648 -> 153420, ring
// 18720 -> 30720, condref 85265 -> 139181, fgather 14400 -> 18800) is the
// retained Number loops beside the guarded copies, as int's was. nest's four and
// slice's five more nodes a program sit in the versioned outer loops' bound
// snaps; the inner loops are what they were.
const f64 = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = (i * 7 % 11) + 0.25; return a }
const f32 = (n) => new Float32Array(f64(n))
const arr = (n) => Array.from(f64(n))
export const ARRAY_CALLS = {
  buf: () => [[f64(64), 8], [f32(64), 8], [arr(64), 8], [f64(64), 0], [f64(64), 3.5]],
  nest: () => [[f64(64), 8], [f32(64), 8], [arr(64), 8], [f64(64), 0]],
  slice: () => [[f64(128), f64(4), 3, 8], [f32(128), f64(4), 3, 8], [arr(128), arr(4), 3, 8], [f64(128), f64(4), 0, 8]],
  ring: () => [[f64(8192), f64(64), 8], [f32(8192), f32(64), 8], [arr(8192), arr(64), 8], [f64(8192), f64(64), 0]],
  condref: () => [[f64(64), f64(64), 1, 8], [f64(64), f64(64), 2, 8], [f32(64), f32(64), 1, 8], [arr(64), arr(64), 1, 8], [f64(64), f64(64), 1, 0]],
  fgather: () => [[f64(64), f64(64), 8], [f32(64), f32(64), 8], [arr(64), arr(64), 8], [f64(64), f64(64), 0]],
}

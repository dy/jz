// Loop-body op counts and the inputs that select the loops a call enters, shared
// by the codegen ratchet (test/perf-ratchet.js), the spelling gate
// (test/spellings.js) and the data-form gate (test/data-forms.js).
import { instantiate } from '../interop.js'
import encodeWat from 'watr/compile'

// Count instruction nodes (every S-expr array) lexically inside any `(loop …)`;
// `weigh` takes the place of the count of one per node (the data-form gate
// counts the calls and the SIMD ops with it, and a called function's body).
const isLoop = (n) => Array.isArray(n) && n[0] === 'loop'
export const isSite = (n) => n[0] === 'if' && Array.isArray(n[1]) && n[1][0] === 'call' && n[1][1] === '$__gc_begin'
const isOp = (n) => typeof n[0] === 'string'
export const loopBodyOps = (tree, entered, weigh = isOp) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n) || n[0] === 'loop' && entered && !entered.has(n) || isSite(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here) count += Number(weigh(n))
    let end = n[0] === 'block' && /^\$__wa\d+d$/.test(n[1]) ? n.length - 1 : n.length
    const copy = n[0] === 'block' && typeof n[1] === 'string' && /__sp\.f\d+d$/.test(n[1])
    if (copy && isLoop(n[end - 1])) end--
    for (let i = 1; i < end; i++) {
      const c = n[i]
      if (!copy || !Array.isArray(c) || c[0] !== 'block' || !isLoop(c[c.length - 1])) { walk(c, here); continue }
      if (here) count += Number(weigh(c))
      for (let k = 1; k < c.length - 1; k++) walk(c[k], here)
    }
  }
  walk(tree, false)
  return count
}

// Identify the loops selected by real entry guards, after all codegen passes.
// Instrument only a temporary assembly: counters never enter the measured tree.
// `keep`: every call goes through the host bridge (a boxed result decoded, the
// host imports given) and the memory is not reset between calls, whose state
// later calls read (test/data-forms.js).
const DECLS = new Set(['param', 'result', 'local', 'export', 'type'])
export const runEntered = (tree, calls, keep = false, steady = null) => {
  const loops = [], start = new Map(), runs = [], kept = new Map(), funcs = []
  let cur = start, ran = 0
  const walk = n => {
    if (!Array.isArray(n)) return
    // (`steady`: every function counts its entries, the calls a run makes whatever
    // the tier wrote out, unrolled or left in an arm that never runs)
    if (steady && n[0] === 'func') {
      let body = typeof n[1] === 'string' ? 2 : 1
      while (Array.isArray(n[body]) && DECLS.has(n[body][0])) body++
      funcs.push([n, body])
      n.splice(body, 0, ['call', '$__ratchet_fn'])
    }
    if (n[0] === 'loop') {
      const id = loops.length
      let body = typeof n[1] === 'string' ? 2 : 1
      while (Array.isArray(n[body]) && ['type', 'param', 'result'].includes(n[body][0])) body++
      // (past the loop's leading exits: a loop its first test leaves at once
      // runs no step and is not entered; a `br_if` to the loop itself is no exit)
      while (Array.isArray(n[body]) && n[body][0] === 'br_if' && n[body][1] !== n[1] && String(n[body][1]) !== '0') body++
      loops.push([n, body])
      n.splice(body, 0, ['call', '$__ratchet_enter', ['i32.const', id]])
    }
    for (const c of n) walk(c)
  }
  walk(tree)
  const heads = [['import', '"ratchet"', '"enter"', ['func', '$__ratchet_enter', ['param', 'i32']]]]
  if (steady) heads.push(['import', '"ratchet"', '"fn"', ['func', '$__ratchet_fn']])
  tree.splice(1, 0, ...heads)
  let binary
  try { binary = encodeWat(tree) }
  finally { tree.splice(1, heads.length); for (const [loop, body] of loops) loop.splice(body, 1); for (const [fn, body] of funcs) fn.splice(body, 1) }
  const imports = { ratchet: { enter: id => cur.set(loops[id][0], (cur.get(loops[id][0]) ?? 0) + 1), fn: () => { ran++ } } }
  const each = (exports, reset) => {
    for (const [name, args] of calls) {
      cur = new Map(); ran = 0
      const ret = exports[name](...args)
      runs.push({ loops: cur, ret, ran })
      reset?.()
    }
  }
  // numbers cross a raw instance; arrays go through the host bridge
  if (keep || calls.some(([, args]) => args.some(a => typeof a === 'object'))) {
    const { exports, memory, instance } = instantiate(new WebAssembly.Module(binary), { imports })
    each(exports, keep ? null : () => memory?.reset?.())
    // What a call of each export of `steady` takes from the heap and the calls it
    // makes, its first call behind it (a durable array's snapshot, a table's first
    // growth): the middle of eight calls' advances of the bump pointer (`__jz_heap`)
    // and of their counts of function entries, so a call in which a compaction
    // gives back the calls' before it is no measure, and both are the same on every
    // machine. A kernel that keeps nothing takes none.
    const heap = instance.exports.__jz_heap
    if (steady) {
      cur = new Map()
      const middle = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1]
      for (const name of steady) {
        exports[name]()
        const took = [], made = []
        for (let i = 0; i < 8; i++) { const at = heap?.value ?? 0; ran = 0; exports[name](); took.push((heap?.value ?? 0) - at); made.push(ran) }
        kept.set(name, { mem: Math.max(0, middle(took)), ran: middle(made) })
      }
    }
  } else {
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(binary), imports)
    each(exports)
  }
  return { start, runs, kept }
}

// The ops of the loops any of `calls` (argument lists of `f`) entered.
export const enteredLoopOps = (tree, calls) => {
  const { start, runs } = runEntered(tree, calls.map(args => ['f', args]))
  return loopBodyOps(tree, new Set([...start.keys(), ...runs.flatMap(r => [...r.loops.keys()])]))
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
// fractional bound run the guards.
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

import { walkAst } from '../../ast.js'
import { readStep } from './addr-model.js'
import { LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'
import { strips } from './scaffold.js'

// ---- Cost model: one weight of the ops a lift runs, read two ways ----
//
// `passCost` is the chooser's measure (index.js): what a lift costs a pass of the loop it lifts,
// over every lowering alike. `isProfitable` is a lowering's own gate, where one asks it (the
// general map, stencil and reduce, the gather map): `scalarCost`, the weighted ops of one
// original iteration (`body`), against `vectorCost`, those of one vector step (`lifted`, the
// tree the codegen emits, `lanes` elements) plus a fixed prologue overhead; it declines when
// `vectorCost / lanes >= scalarCost`. Estimates, not a simulator.
//
// Weights: `load`/`store` = 1, the baseline unit. Arithmetic/compare/convert-class ops (add,
// sub, mul, and, or, xor, shift, eq/lt/gt/…, min, max, neg, abs, sqrt, floor/ceil/trunc/nearest,
// convert/extend/narrow/wrap/promote/demote, splat) = 1 — same instruction-count class as a
// load. `div`/`rem` (float only — integer div/rem are never LANE_PURE, see that table's own
// header; a speculated arm containing one fails to lift and declines the WHOLE loop, never
// reaching this cost check) = 8 — division has no fast SIMD form on wasm (no reciprocal-estimate
// instruction in the MVP+SIMD feature set). `bitselect` (blend, the if-conversion codegen
// above) = 5.
//
// Calibration: these weights are an ESTIMATE, not a measured multiplier. A wall-clock microbench
// (`d = mask ? a : b` vs `d = a + b` vs `d = a / b`, SIMD_OPT, both a 2e7-element streaming pass
// and a 2e5-element pass repeated 200× to stay cache-resident) showed NO measurable difference
// between add/blend/div on V8 — all three are memory-bandwidth-bound, not compute-bound, at any
// array size tried. That is itself useful signal (real streaming SIMD kernels are memory-bound,
// so op-mix rarely changes wall-clock much), but it means no microbench can supply a blend/div
// MULTIPLIER directly. The weights actually used are a conservative PRIOR instead (in the spirit
// of LLVM's TargetTransformInfo select/div cost classes — blend ~2-5x, div severalx-to-double-digit
// x, target-dependent), gate-calibrated against corpus behavior: `div`=8 is the illustrative
// starting value (never empirically contradicted — no corpus loop has a speculated arm with float
// division to test against either way); `bitselect`=5 and `COST_OVERHEAD_PROLOGUE` = 1 are chosen
// so the model does not decline a real, corpus-shaped case (`test/simd.js`'s f64 same-array
// runtime-offset map, an ordinary affine MAP at f64's 2-lane width, where prologue overhead alone
// would otherwise punish a profitable plain map) while still declining the synthetic decline case
// (§SIMD cost model tests). Governing rule: if the model would decline a real corpus case, the
// model is wrong; recalibrate the weights, never special-case the site.
const COST_WEIGHT = { load: 1, store: 1, bitselect: 5, div: 8, div_s: 8, div_u: 8, rem_s: 8, rem_u: 8 }
// (`ge` takes `get` too: a local's or a global's read weighs one. The weights below were
// tuned with it, the f64 same-array runtime-offset map of test/simd.js among them.)
const _COST_ARITH_RE = /^(add|sub|mul|and|or|xor|shl|shr|eqz|eq|ne|lt|gt|le|ge|min|max|neg|abs|sqrt|floor|ceil|trunc|nearest|convert|extend|narrow|wrap|promote|demote|splat|replace_lane|clz|ctz|popcnt|copysign|reinterpret|pmin|pmax)/
function opCostWeight(op) {
  if (typeof op !== 'string') return 0
  const suffix = op.includes('.') ? op.slice(op.lastIndexOf('.') + 1) : op
  if (suffix in COST_WEIGHT) return COST_WEIGHT[suffix]
  if (suffix.startsWith('load')) return COST_WEIGHT.load
  if (suffix.startsWith('store')) return COST_WEIGHT.store
  if (_COST_ARITH_RE.test(suffix)) return 1
  return 0   // control-flow wrappers, local.get/set/tee, block/if/then/else, br(_if), i32.const/
             // f64.const (immediates — free, embedded in the instruction stream) — no runtime cost
             // this simple a model needs to attribute; both scalarCost and vectorCost skip them
             // identically, so the RATIO this gate actually compares is unaffected either way.
}
/** The weighted ops of `nodes` (the scalar body or its lift), the measure every gate here compares. */
export function liftWeight(nodes) { return weighTree(nodes) }
function weighTree(nodes) {
  let w = 0
  const account = n => {
    if (!isArr(n)) return
    const op = n[0]
    w += opCostWeight(op)
    // A LOAD_OPS/STORE_OPS node's ADDRESS operand is index/base arithmetic (`base + (idx<<K)`),
    // not the "arith" the table's weights describe (the DATA the loop actually computes) — it's
    // a compiler implementation detail identical in kind on both sides of this comparison (the
    // scalar loop recomputes it once PER ELEMENT, the vector step once per GROUP — vectorization's
    // own amortization win, which this model should reward, not double-charge by also weighing the
    // address subtree as if it were user-visible compute). Skip it: count the memory access itself
    // (`opCostWeight` above already did, via the `load`/`store` weight) and continue only into a
    // STORE's VALUE operand — the actual data being written.
    // Scalar-domain load/store (pre-lift `body`) AND their lifted v128 forms (post-lift
    // `lifted`, a load of part of a vector or a splat of one element among them — same
    // address-skip reasoning applies identically to both sides of the ÷lanes comparison).
    if (LOAD_OPS[op] || (op.startsWith('v128.load') && !op.endsWith('_lane'))) return false
    if ((STORE_OPS[op] && n.length === 3) || (op === 'v128.store' && n.length === 3)) {
      if (isArr(n[2])) walkAst(n[2], { enter: account })
      return false
    }
  }
  for (const n of nodes) walkAst(n, { enter: account })
  return w
}
/**
 * What a lift costs one pass of the loop it lifts, the one measure the chooser compares
 * (index.js): of the loops the lift emits beside the loop as written (`scalarLoop`, its tail,
 * not counted), the one running the most passes at a time, its body's weight (liftWeight)
 * over those passes. A loop runs as many passes at a time as a strip's counter steps there
 * (scaffold.js `strips`), one where it steps none (a pixel's channels as its lanes). A lift
 * with no loop of its own (a bulk copy) costs nothing a pass.
 */
export function passCost(r, scalarLoop) {
  const ivs = new Set()
  walkAst(r.wrapper, { enter: n => { const at = strips.get(n); if (at) ivs.add(at.iv) } })
  let best = null
  const visit = (n) => {
    if (!isArr(n) || n === scalarLoop) return
    if (n[0] === 'loop') {
      let w = 1
      for (let i = 2; i < n.length; i++) { const st = readStep(n[i]); if (st && st.by && ivs.has(st.name)) w = Math.max(w, Math.abs(st.by)) }
      const c = weighTree(n.slice(2)) / w
      if (!best || w > best.w || (w === best.w && c < best.c)) best = { w, c }
      return
    }
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  visit(r.wrapper)
  return best ? best.c : 0
}

// Fixed per-loop overhead the op-weight walk can't see (the bound calc and the branch back),
// paid once per loop run, not per vector step, so kept small (1, tuned down from 3: the f64
// map above was declined by the prologue alone at 2 lanes).
const COST_OVERHEAD_PROLOGUE = 1
// `body`/`lifted` are the arrays the asking lowering already built for its precondition scan and
// its codegen. True: proceed; false: the lowering declines like any failed precondition.
export function isProfitable(body, lifted, lanes) {
  const scalarCost = weighTree(body)
  const vectorCost = weighTree(lifted) + COST_OVERHEAD_PROLOGUE
  return vectorCost / lanes < scalarCost
}

import { walkAst } from '../../ast.js'
import { LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'

// ---- Cost model (.work/vectorizer-generality-design.md's final follow-up seam, Part 2): a
// profitability gate for the GENERAL base layers ONLY (tryGeneralMap/
// tryGeneralStencil/tryGeneralReduce below) — every idiom FUSER above (tryDivergentEscapeVectorize,
// tryBlurMultiPixel, tryButterfly, …) keeps its own separately-tuned, always-fire behavior
// unchanged; this gate never runs for them. Today the three general recognizers vectorize
// UNCONDITIONALLY the instant their affine/dependence proof succeeds — sound, but blind to
// whether the SIMD prologue/epilogue/blend overhead is actually worth paying for a given body.
//
// Estimate, not a simulator: `scalarCost` = weighted op count of ONE original scalar iteration
// (`body`, pre-lift); `vectorCost` = weighted op count of ONE vector step (`lifted`, the SAME
// tree the codegen below emits, processing `lanes` elements) + a fixed prologue overhead + a
// per-guard overhead when runtime alias-versioning (layer 3) adds a disjointness check. Decline
// (the caller returns null, exactly like any other precondition failure in this file) when
// `vectorCost / lanes >= scalarCost` — vectorizing would cost at least as much per element as
// just running the scalar loop.
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
// division to test against either way); `bitselect`=5 and `COST_OVERHEAD_PROLOGUE`/
// `COST_OVERHEAD_PER_GUARD` = 1/1 are chosen so the model does not decline a real, corpus-shaped
// case (`test/simd.js`'s alias-versioned f64 same-array runtime-offset map — an ordinary affine
// MAP with one alias-versioning guard, NO if-conversion, at f64's 2-lane width, where guard/
// prologue overhead alone would otherwise punish a perfectly profitable plain map) while still
// declining the synthetic decline case below (§SIMD cost model tests). Governing rule: if the
// model would decline a real corpus case, the model is wrong — recalibrate the weights, never
// special-case the site. Weight is shifted FROM the lane-count-sensitive per-loop overhead (which
// penalizes every general-layer recognizer, if-converted or not, hardest at f64/i64's 2 lanes)
// TOWARD the blend-specific weight (which only penalizes if-conversion codegen). A full corpus
// sweep against the test suite is the decisive calibration signal — not either number in isolation.
const COST_WEIGHT = { load: 1, store: 1, bitselect: 5, div: 8, div_s: 8, div_u: 8, rem_s: 8, rem_u: 8 }
const _COST_ARITH_RE = /^(add|sub|mul|and|or|xor|shl|shr|eqz|eq|ne|lt|gt|le|ge|min|max|neg|abs|sqrt|floor|ceil|trunc|nearest|convert|extend|narrow|wrap|promote|demote|splat|clz|ctz|popcnt|copysign|reinterpret|pmin|pmax)/
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
    // Scalar-domain load/store (pre-lift `body`) AND their lifted v128 form (post-lift
    // `lifted` — same address-skip reasoning applies identically to both sides of the ÷lanes
    // comparison this model computes).
    if (LOAD_OPS[op] || op === 'v128.load') return false
    if ((STORE_OPS[op] && n.length === 3) || (op === 'v128.store' && n.length === 3)) {
      if (isArr(n[2])) walkAst(n[2], { enter: account })
      return false
    }
  }
  for (const n of nodes) walkAst(n, { enter: account })
  return w
}
// Fixed per-loop overhead the op-weight walk above can't see structurally (it isn't part of
// `lifted` — it's the wrapper every one of the 3 general recognizers builds around it): the SIMD
// bound calc (`boundSetup`) and the loop's own branch-back test, identical in shape across all
// three. Amortized per-lane by the SAME ÷lanes division every other cost in this model goes
// through — deliberately kept SMALL (1, not the bound calc's own ~3 raw ops): this overhead is
// paid ONCE per loop EXECUTION, not once per vector STEP, so charging it in full against a
// single lanes-wide group (as this model's ÷lanes necessarily does, having no visibility into
// the loop's actual, runtime-only trip count) overstates it for the common case — a loop this
// pass decides to vectorize at all typically runs many groups, amortizing the real prologue cost
// to near nothing. See `COST_WEIGHT`'s own header doc for how this got tuned down from an
// initial 3 (a real corpus-shaped alias-versioned map at f64's 2-lane width was being wrongly
// declined by prologue+guard overhead alone).
const COST_OVERHEAD_PROLOGUE = 1
// Runtime alias-versioning (layer 3) adds a disjointness guard (`i32.or` of
// `le_s`/`ge_s` pairs) evaluated once before the loop, one clause per mismatched site pair — the
// SAME "paid once per execution, not once per step" reasoning as the prologue above applies here
// too (kept at 1, tuned down from an initial 2 for the identical reason — see `COST_WEIGHT`'s
// header doc). `tryGeneralReduce` never has store sites (no hazard, no guard — see its own
// header doc), so it always calls this with `guardCount = 0`.
const COST_OVERHEAD_PER_GUARD = 1
// Profitability check shared by all 3 general recognizers below. `body`/`lifted` are the SAME
// arrays each recognizer already built for its own precondition scan / codegen — this reuses
// them, no separate walk of the source AST. Returns true (proceed) or false (the caller declines
// exactly like any other failed precondition — `return null`, no different from an unliftable op).
export function isProfitable(body, lifted, lanes, guardCount = 0) {
  const scalarCost = weighTree(body)
  const vectorCost = weighTree(lifted) + COST_OVERHEAD_PROLOGUE + guardCount * COST_OVERHEAD_PER_GUARD
  return vectorCost / lanes < scalarCost
}

// ---- General MAP base layer (.work/vectorizer-generality-design.md §2-3 step 3, MAP slice) --
//
// BASE LAYER: runs LAST in the dispatch chain (after every idiom recognizer above, including
// tryButterfly) — it exists to catch dependence-free elementwise loops whose address arithmetic
// isn't one of the specific WAT shapes tryVectorize/tryMemCopyFill/tryRampMap/tryToneMap/
// tryStencil hand-match, not to compete with them for the specimens they already own (first-
// match-wins dispatch order is unchanged, so every existing corpus hit is untouched).
//
// Address proof: a real affine-in-IV solver (`ivCoeff`), not a fixed literal WAT-shape list —
// ported from tryStencil's own `ivCoeff`/`matchAddr` (the exact algorithm that already proves
// "coefficient 0 or 1" for f64/f32 neighbour-load stencils), simplified to drop the toroidal
// wrap-select and float-domain-index branches (genuinely stencil-specific, out of scope for a
// plain map) and GENERALIZED to every LOAD_OPS/STORE_OPS lane type — tryStencil hard-declines
// non-float lanes (`if (lt !== 'f64' && lt !== 'f32') return false`) because an i32-typed local
// is ambiguously either address/index scalar OR i8/i16/i32 LANE data (both share WAT storage
// type 'i32'); this pass resolves that ambiguity the same way tryVectorize's own `_isAddressLocal`
// does (ported below as `_isAddrLocalGM`, parametrized on THIS pass's own `matchAddr`).
//
// Dependence proof: no loop-carried scalar (tryVectorize/tryStencil's own "first access of a
// written local must not be a read" rule, reused verbatim), plus tryStencil's own same-array
// alias gate — every access to a WRITTEN base must hit the SAME element (`elemKey`); a mismatch
// (e.g. `a[i] = a[i-1] + a[i]`, a genuine recurrence) is a real cross-iteration dependency.
// Distinct bases (different arrays) are assumed non-aliasing — the same baseline convention
// tryVectorize/tryStencil already rely on (tryStencil's own doc, "the SAME assumption the plain
// map path already relies on") — see the runtime-versioning note below for why that convention
// stays untouched here.
//
// RUNTIME ALIAS VERSIONING (layer 3, .work/vectorizer-generality-design.md follow-up — LLVM's
// loop-versioning-for-vectorization answer to the same static-proof gap): an `elemKey` mismatch
// used to be an unconditional decline. Every mismatch this pass can reach is SAME-BASE by
// construction (the check only runs when `exprEq` already proved the two accesses share one
// base) — e.g. `a[i] = a[i-off] + b[i]` with `off` a runtime value masked/ranged so the address
// itself is provably in-bounds but the DISTANCE between the two accesses to `a` isn't provably
// non-zero. This is exactly LLVM's runtime-dependence-checking case (RuntimePointerChecking /
// LoopVersioningLICM): the two affine accesses differ by a compile-time-UNKNOWN but
// LOOP-INVARIANT element delta `D` (guaranteed invariant — never merely assumed — because both
// sides already passed `ivCoeff`'s coefficient-EXACTLY-1 proof, so `D = idxA − idxB` is algebraic
// cancellation of the IV term, true for ANY value plugged in, mod-2^32 exact regardless of
// intermediate overflow). The vectorization-safety criterion for a self-dependence at a constant
// distance is `|D| ≥ VF` (lanes) — within one SIMD step all lane reads happen (one `v128.load`)
// before any lane writes (one `v128.store`), and consecutive steps advance both the read and
// write windows by the SAME `lanes` stride, so a gap ≥ `lanes` between them means no step ever
// reads a position a PRIOR step already overwrote, nor misses a write a later step depends on —
// this is the textbook LLVM loop-vectorizer distance-≥-VF rule. Cross-array aliasing (different
// bases) is deliberately OUT of scope here — see the header doc's own note above: it is
// currently an UNCHECKED, unconditional assumption everywhere in this file (not merely here),
// and versioning it would mean adding a runtime guard to every existing multi-array corpus
// specimen (a regression risk against every existing corpus hit) — a separate, much larger
// initiative (base-provenance analysis: which locals are provably fresh/non-escaping vs.
// caller-supplied) that this pass does not attempt.
//
// When every mismatch reduces to that shape, the loop is VERSIONED: the SIMD body (this whole
// pass's normal codegen, unchanged) runs behind a hoisted, loop-invariant disjointness guard
// (`i32.or(D ≤ −lanes, D ≥ lanes)`, ANDed across every mismatched pair); the ELSE branch is a
// fresh CLONE of `bl.blockNode` — the UNTOUCHED original scalar loop, byte-identical store order,
// used nowhere else in the wrapper (the existing SIMD-prefix tail keeps its own separate use of
// the same node). Declines (returns null, exactly as before — zero behavior change) when: the op
// isn't enabled (`aliasVersion` opt), the body is too large to duplicate a second time
// (`ALIAS_VERSION_MAX_BODY_NODES` — reused, not invented, see its own doc), or a mismatch's
// element delta isn't expressible as an integer (a non-stride-aligned `offset=N` memarg, which
// `matchOffset`/`matchAddr`'s own grammar has never produced in practice but isn't proven
// impossible) — the same conservative "no partial credit" posture every gate in this file uses.
//
// Bounds: reuses `bl`'s own invariant-bound requirement (boundLocal unwritten, or an i32.const);
// trip-count remainder handled by the same epilogue convention every recognizer above uses — the
// original scalar loop, unmodified, runs as the tail after the SIMD prefix (`bl.blockNode`).
//
// Subsumption: op vocabulary is IDENTICAL to every MAP-class recognizer above (same `liftStmt`/
// `LANE_PURE`/`REDUCE_OPS`-adjacent lift machinery, same `ctx` shape) — the only axis this pass
// generalizes is the ADDRESS proof (arbitrary nested +/-/tee, both `i32.add` operand orders,
// runtime-invariant index shifts `a[i+off]`) and, for integer lanes, DEPENDENCE proof parity with
// what tryStencil already gives float lanes. New-reach cases (verified in test/simd.js): integer-
// lane (i8/i16/i32/i64) elementwise maps at a runtime-invariant index shift — `out[i] = a[i+off]`,
// `out[i+off] = a[i]`, both `i+off` and `off+i` operand orders, multi-array independent shifts —
// none of which any prior recognizer's literal `matchLaneAddr`/`matchLaneOffset` shape accepts
// (confirmed empirically: `--why-not-simd` declines all of them without this pass; tryStencil itself
// declines on lane type alone before ever reaching its own affine check); plus same-array
// runtime-offset recurrences that are ACTUALLY disjoint at runtime — `a[i] = a[i-k]
// + b[i]` for a runtime `k` — now versioned instead of unconditionally declining.
//
// Out of scope for this base-layer slice: REDUCTION/STENCIL-proper generalization (design §4
// step 4), the float-domain grid-index branch tryStencil's own `ivCoeff` carries (2-D row-base
// loops), non-constant (runtime-computed) stride coefficients, and cross-array runtime alias
// versioning (needs a base-provenance analysis this pass doesn't have — see the versioning note
// above).

// Loop-versioning body-size gate (layer 3): a genuine SAME-BASE dependence that IS runtime-
// disjoint gets a versioned wrapper — SIMD body + a second, full clone of the scalar loop as the
// alias fallback — instead of an unconditional decline. That second clone is real code-size cost
// this pass didn't pay before, so it's capped exactly like `optimize/recurse.js`'s own
// body-duplicating transform (accumulator-fusion recursion unrolling) caps ITS clone: same
// number, same rationale ("a small body"), reused verbatim rather than inventing a new threshold.
export const ALIAS_VERSION_MAX_BODY_NODES = 110
export const gmNodeCount = (n) => {
  if (!isArr(n)) return 1
  let c = 1
  for (let i = 1; i < n.length; i++) c += gmNodeCount(n[i])
  return c
}

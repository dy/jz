
/**
 * Lane-local SIMD-128 vectorizer.
 *
 *   Recognizes inner loops of shape:
 *     for (let i = 0; i < N; i++) arr[i] = f(arr[i], …)
 *   where every body op is "lane-pure" — its k-th lane output depends only
 *   on k-th lane inputs. Lifts the body to SIMD-128, prefixed before the
 *   original (now tail) loop. Original loop runs the remainder.
 *
 * Design:
 *   • Lane-purity is a structural property, not a benchmark match. The op
 *     whitelist is the single source of truth (one entry per (lane-type, op)).
 *   • Lift is mechanical. The recognizer either matches the structure — in
 *     which case lifting is unambiguous — or skips. No bench-specific
 *     heuristics.
 *   • Tail loop is the original WAT, untouched. If anything regresses the
 *     SIMD recognizer just doesn't match, never miscompiles.
 *
 * Match conditions:
 *   1. (block $brk (loop $L (br_if $brk !cond) BODY (i = i+1) (br $L)))
 *   2. cond is `(i32.lt_s i BOUND)` or `i32.lt_u`; BOUND is loop-invariant.
 *   3. All loads/stores in BODY use address `(add base (shl i K))` where
 *      base is loop-invariant and K matches the elem stride. Optional
 *      enclosing `local.tee` is allowed (and reused).
 *   4. All loads share the same opcode → defines lane type.
 *   5. All other ops in BODY are in the lane-pure whitelist for that type.
 *   6. Each non-induction local in BODY is either purely loop-invariant
 *      (only read) or purely lane-local (first action is a write). Never
 *      both — that's a loop-carried scalar (reduction / stencil) → bail.
 *
 * Lift produces, before the original block:
 *     (local.set $__simd_bound{N} (i32.and BOUND (i32.const ~(LANES-1))))
 *     (block $__simd_brk{N}
 *       (loop $__simd_loop{N}
 *         (br_if $__simd_brk{N} (i32.eqz (i32.lt_s i $__simd_bound{N})))
 *         <body lifted op-by-op; lane-local locals routed to v128 shadows>
 *         (local.set $i (i32.add i (i32.const LANES)))
 *         (br $__simd_loop{N})))
 *
 * The original block runs immediately after with i pre-advanced; its own
 * `i < BOUND` guard handles the tail.
 */




import { findBodyStart, dollar } from '../../ir.js'
import { warn, ctx, DBG_INVARIANTS } from '../../ctx.js'
import { walkAst } from '../../ast.js'
import { constNum, isI32Const } from './addr-model.js'
import { tryChannelReduce } from './blur-channel.js'
import { tryButterfly } from './butterfly.js'
import { tryDivergentEscapeVectorize } from './divergent-escape.js'
import { hoistReductionInvariantsIn, slpPairsIn } from './dot-slp.js'
import { vecState } from './lift.js'
import { tryGeneralMap, tryVectorize } from './map.js'
import { tryMemCopyFill } from './memcpy.js'
import { forEachLocalDef, isArr } from './node-utils.js'
import { matchOuterPixelLoop } from './outer-scaffold.js'
import { tryOuterStripRest } from './outer-strip.js'
import { tryRampMap } from './ramp.js'
import { tryGeneralReduce, tryReduce } from './reduce.js'
import { canonicalizeIfBr, foldVecIdentities, matchBlockLoop, normalizeTransparentBlocks } from './scaffold.js'
import { tryGeneralStencil, tryStencil } from './stencil.js'
import { tryStrengthReduceIV } from './strength-reduce.js'
import { tryToneMap } from './tone-map.js'

// ---- HIR provenance link shadow-assert (.work/research.md §BodyModel slice 4) ---------
//
// JZ_DEBUG_INVARIANTS-gated: `node` is the raw WAT block node the dispatch just matched `bl`
// against; `loopPlanLink` (ir.js) maps it back to the HIR facts proved about this loop at
// emission time (emit.js's `'for'` handler, the sole writer), keyed by node IDENTITY, as a
// `{ plan, lowering }` pair — `plan` the frozen HIR-side facts, `lowering` the mutable WAT-side
// name map (see ir.js's doc). A miss is the expected outcome once ANY rewrite has replaced the
// block array between emission and here (pre-trio spec 2: fail-open) — proves nothing, asserts
// nothing. A HIT that disagrees is a genuine finding: the two derivations describe the SAME loop
// and must name the same induction variable / the same constant bound where both resolve one.
function assertLoopPlanAgrees(node, bl) {
  const link = ctx.plans.loweringLinks.get(node)
  if (!link) return
  const { plan, lowering } = link
  if (lowering.ivName != null && dollar(lowering.ivName) !== bl.incVar)
    throw new Error(`LoopPlan #${plan.id} IV diverges from WAT: HIR ivName=${lowering.ivName} (${dollar(lowering.ivName)}), WAT incVar=${bl.incVar}`)
  if (plan.boundConst != null && isI32Const(bl.bound) && constNum(bl.bound) !== plan.boundConst)
    throw new Error(`LoopPlan #${plan.id} bound diverges from WAT: HIR boundConst=${plan.boundConst}, WAT bound=${constNum(bl.bound)}`)
}

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
// opts gates the recognizer set + lift variants (all default-safe so a bare
// `vectorizeLaneLocal(fn)` is the conservative scalar-preserving pass):
//   multiAcc, relaxedFma, blurMP, whyNot, stencil, outerStrip, pureFuncMap, toneMap.
export function vectorizeLaneLocal(fn, opts = {}) {
  const { multiAcc = false, relaxedFma = false, blurMP = true, whyNot = false,
    stencil = false, outerStrip = false, pureFuncMap = null, toneMap = false, slp = false, crPow = false,
    aliasVersion = true } = opts
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const fnName = typeof fn[1] === 'string' ? fn[1] : '(anon)'
  let whyNotN = 0

  // Normalize jz's per-statement `block` grouping into flat statement lists ONCE, up front —
  // the recognizers below (both the scaffold consumers and the raw-node matchers like ramp-map,
  // stencil, per-pixel) were tuned on watr's flattened shape. Pre-watr, jz wraps each source
  // statement group in a transparent block; without this every loop body would arrive as a
  // single opaque `block` node and no lift would fire. Walking `fn` itself also flattens a
  // top-level body block (decls never match — they aren't blocks).
  normalizeTransparentBlocks(fn)
  // Canonicalize the raw arithmetic identities watr would fold (chiefly `i<<0` byte addresses),
  // so the address/value matchers read dataflow, not jz's un-folded emission.
  for (let i = bodyStart; i < fn.length; i++) fn[i] = foldVecIdentities(fn[i])
  // Canonicalize the `if COND (then (br L))` break idiom to `br_if L COND` (watr's brif shape),
  // so the loop-scan recognizers see the branch form they were tuned against.
  canonicalizeIfBr(fn)

  // Build local-name → wasm-type map.
  const fnLocals = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    } else if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    }
  }

  // Loop-invariant constant locals — hoistConstantPool's `$…_pg` pool (`set $L (f64.const C)`,
  // written exactly once). name → numeric value, used to resolve a constant `pow` exponent that
  // reached the loop as a pooled local rather than a literal.
  const constLocals = new Map()
  {
    const setCount = new Map()
    forEachLocalDef(fn.slice(bodyStart), (name, rhs, node) => {
      if (node.length !== 3) return
      setCount.set(name, (setCount.get(name) || 0) + 1)
      if (isArr(rhs) && rhs[0] === 'f64.const') constLocals.set(name, +rhs[1])
    })
    for (const [k, c] of setCount) if (c !== 1) constLocals.delete(k)   // multiply-written → not invariant
  }

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []
  // Whether a REAL SIMD lift happened (as opposed to the scalar tryStrengthReduceIV
  // fallback below, which also populates newLocalDeclsAll with plain i32 locals) —
  // the caller pins the function's $name/$name$exp boundary wrapper on this, so a
  // false positive here would needlessly block watr's inlineOnce on a non-SIMD fn.
  let simdFired = false

  // Hoist loop-invariant partial products out of unrolled dot reductions (rust/LLVM's
  // mat4 prologue trick). Reassociates the float sum, so tied to the relaxedFma tier;
  // runs BEFORE the dot-pair vectorizer so a hoisted dot drops below DOT_UNROLL steps
  // and stays scalar (faster here than the pack/extract SIMD form — see the lab).
  if (relaxedFma) hoistReductionInvariantsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll)
  // Unified SLP packer (dot-sequence tier, then element-store tier) — see slpPairsIn.
  slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp)
  if (newLocalDeclsAll.length) simdFired = true

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      if (vecState.whyNotActive) vecState.whyNotReason = null
      // Recognition layer: match the canonical (block (loop)) scaffold ONCE; the
      // inner-scaffold lifters (memcpy/map/reduce) consume the descriptor instead of
      // each re-matching. The outer-pixel + special-shape recognizers (outer-strip
      // family, ramp-map, channel-reduce) do their own matching on the raw node.
      // Order is preserved exactly — it is load-bearing (first match wins).
      // allowInlinedLi: accept an inlined LICM preamble (`$__inl*___li*`) too — jz's
      // LICM hoists ToInt32/casts of loop-invariant params just before the loop (e.g.
      // `a[i] & m` with a runtime `m`), and after inlining the snap is renamed off the
      // bare `$__li*` form. The preamble is pure & loop-invariant by construction
      // (hasSideEffect-guarded) and cloned ahead of the SIMD block, so this only widens
      // which loops the recognizers see, never changes a lifted result.
      const bl = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })
      // HIR provenance link shadow-assert (.work/research.md §BodyModel slice 4) — see
      // assertLoopPlanAgrees's own doc. `bl`-scoped only (the IV/bound facts it exists to
      // cross-check); a null `bl` has nothing to compare. Runs BEFORE the consultation below
      // so it still checks the fresh WAT derivation, unmodified by the override.
      if (DBG_INVARIANTS && bl) assertLoopPlanAgrees(node, bl)
      // FIRST REAL CONSUMPTION (.work/research.md §BodyModel): the shadow-assert above runs
      // across the full battery with zero divergences, so wherever the link resolves an IV
      // name, it is PROVEN to equal `bl.incVar`'s WAT-derived one. Roles invert: the plan
      // becomes the primary source for the name every bl-based
      // recognizer below reads (tryMemCopyFill/tryVectorize/tryReduce/
      // tryStencil/tryToneMap/tryStrengthReduceIV — all share
      // this one `bl`), and `matchInc1`'s WAT walk above becomes the fail-open FALLBACK (link
      // miss keeps its structurally-derived name) plus, under JZ_DEBUG_INVARIANTS, the shadow
      // (assertLoopPlanAgrees, run just above, already fills that role — nothing left to add).
      // Bound/hull are NOT flipped here: assertLoopPlanAgrees only proves `plan.boundConst`
      // against `bl.bound` in the branch where `bl.bound` is ALREADY an `i32.const` node — i.e.
      // exactly the case where the WAT derivation is already the concrete number in one read: a
      // non-const (boundLocal) bound is never compared, so consulting the plan there would be
      // unproven. Narrowed to the proven subset (banked finding, .work/research.md §BodyModel).
      if (bl) {
        const link = ctx.plans.loweringLinks.get(node)
        if (link && link.lowering.ivName != null) bl.incVar = dollar(link.lowering.ivName)
      }
      // LoopPlan classification (stage-3 slice 1): the OUTER-pixel scaffold is
      // matched ONCE here — the five outer-family recognizers consume this
      // descriptor (with its inner-loop census) instead of each re-matching.
      // `bl` (inner scaffold) + `op` (outer scaffold) together are the loop's
      // plan; a recognizer whose scaffold is null skips without walking.
      const op = matchOuterPixelLoop(node)
      // Loose-envelope variant of the same scaffold (any non-loop content
      // tolerated) — shared by blur-multi-pixel + channel-reduce, both LATE
      // in the `??` chain below. Lazy + memoized: most blocks either aren't
      // loop scaffolds at all or already match one of the earlier `bl`-based
      // recognizers, so the chain short-circuits before ever reaching the
      // two consumers — computing this third matcher pass upfront would be
      // pure waste on that (common) path. `getBlLoose()` runs the actual
      // `matchBlockLoop` at most once, on first read.
      let blLoose, blLooseComputed = false
      const getBlLoose = () => blLooseComputed ? blLoose
        : (blLooseComputed = true, blLoose = matchBlockLoop(node, { envelope: 'loose' }))
      let r = tryDivergentEscapeVectorize(node, fnLocals, freshIdRef, op)
        ?? tryMemCopyFill(bl, fnLocals, freshIdRef)
        ?? tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals)
        ?? tryReduce(bl, fnLocals, freshIdRef, multiAcc)
        ?? tryStencil(node, fnLocals, freshIdRef, stencil, bl)
        ?? tryRampMap(node, fnLocals, freshIdRef)
        ?? tryChannelReduce(node, fnLocals, freshIdRef, getBlLoose(), blurMP)
        ?? tryOuterStripRest(node, fnLocals, freshIdRef, pureFuncMap, outerStrip, op)
        ?? tryToneMap(bl, fnLocals, freshIdRef, toneMap)
        ?? tryButterfly(node, fnLocals, freshIdRef)
        ?? tryGeneralMap(node, fnLocals, freshIdRef, bl, { aliasVersion })
        ?? tryGeneralStencil(node, fnLocals, freshIdRef, stencil, bl, { aliasVersion })
        ?? tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc)
      // --why-not-simd: a canonical loop-shaped candidate that no SIMD pass took.
      // Reported BEFORE the scalar strength-reduce fallback (which fires on most
      // affine loops and would otherwise mask "didn't vectorize"). Diagnostic only.
      // Reuses `op` (already matched above) instead of re-running matchOuterPixelLoop.
      if (!r && vecState.whyNotActive && (bl || op)) {
        whyNotN++
        warn('simd-why-not',
          `${fnName}: loop #${whyNotN} not vectorized — ${vecState.whyNotReason || 'no SIMD-liftable shape (loop-carried dependency, non-affine address, or unsupported control flow)'}`,
          { fn: `${fnName}#${whyNotN}` })
      }
      if (r) simdFired = true   // one of the real SIMD recognizers above matched
      if (r) {
        // Mark the consumed subtree: the wrapper REUSES these nodes (scalar tail, and the
        // lane splats alias the original load nodes), so a deferred strength-reduce must
        // never rewrite inside them — it would mutate the lifted lanes through the alias.
        walkAst(node, { enter: n => { srConsumed.add(n) } })
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      } else if (bl) {
        // Scalar IV strength-reduction is a non-SIMD fallback — DEFERRED to after the
        // whole walk. Applied eagerly here (post-order = innermost first) it rewrites an
        // inner reduction loop into its wrapper before the ENCLOSING loop's outer
        // recognizers (outer-strip / iterated-reduce / conv-column / tone-map) ever run,
        // and they bail on the non-canonical inner shape — metaballs' pixel loop lost its
        // whole f64x2 outer-strip to an eager strength-reduce of the blob loop.
        deferredSR.push([node, parent, idx, bl])
      }
    }
  }
  const deferredSR = [], srConsumed = new Set()
  vecState.whyNotActive = whyNot
  vecState.relaxF32 = relaxedFma
  vecState.crPow = crPow
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  vecState.whyNotActive = false
  vecState.relaxF32 = false
  vecState.crPow = false
  // Apply the deferred scalar fallback innermost-first (push order), skipping candidates
  // inside any SIMD-consumed subtree (see the mark above), plus a same-slot check for
  // wrappers that replaced the candidate node itself.
  for (const [node, parent, idx, bl] of deferredSR) {
    if (srConsumed.has(node) || parent[idx] !== node) continue
    const r = tryStrengthReduceIV(bl, fnLocals, freshIdRef)
    if (r) { parent[idx] = r.wrapper; newLocalDeclsAll.push(...r.newLocalDecls) }
  }

  if (newLocalDeclsAll.length) {
    // Sibling loops (and the straight-line dot pass) can each lift the SAME source
    // local to an identically-named `$name__v` v128 scratch. Post-order vectorizes
    // innermost-first and an outer loop bails once its inner became a wrapper block,
    // so no two NESTED loops ever share a lift — every collision is between
    // SEQUENTIAL loops, where one shared scratch is correct (each writes its lanes
    // before reading). Declaring a local twice is invalid wasm ("duplicate local"),
    // so keep one decl per name (all dups are the identical `['local', name, 'v128']`).
    fn.splice(bodyStart, 0, ...new Map(newLocalDeclsAll.map(d => [d[1], d])).values())
  }
  return simdFired
}


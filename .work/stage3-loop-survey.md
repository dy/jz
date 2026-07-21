# Stage 3 opening survey — recognizer chain inventory (2026-07-21)

Ground truth for "loop model as the vectorizer's substrate". Mapped by full
read of the chain; line numbers as of slice-4 landing.

## Structure today: two tiers, no shared substrate

- **AST tier** (post-prepare AST): `src/compile/loop-model.js` primitives + 6
  recognizers, driven sequentially from `analyzeFuncForEmit`
  (src/compile/index.js:443-462, fixed order, each rewrites func.body):
  `loopIVDivMod → loopSquare → unrollRecurrence → unrollScalarChain →
  selectArmUpdates → clampPeel`.
- **WASM tier** (WAT s-exprs): `src/optimize/vectorize.js`, entry
  `vectorizeLaneLocal` (:6635), post-order block walk (innermost first),
  explicit first-match-wins `??` chain (:6729-6744). Pre-canonicalization:
  `normalizeTransparentBlocks` / `foldVecIdentities` / `canonicalizeIfBr`
  (:6650-6656). Non-SIMD `tryStrengthReduceIV` is DEFERRED past the walk so
  outer recognizers see canonical inner shapes (:6763-6769).
- A third independent affine derivation lives in `src/type.js:affineIdxOfIV`
  (:155) for typed-bounds versioning — used by neither tier.

## Recognizer → generic-class map

AST tier: loop-divmod.js:40 strength-red div/mod (other); loop-square.js:63
i*i narrowing (other); loop-recurrence.js:86 recurrence-unroll; :188
serial-chain-pair; :294 selectArmUpdates (predicated map, scalar); 
peel-stencil.js:152 clamp peel (stencil enabler).

WASM tier straight-line: hoistReductionInvariantsIn :349 (SLP-enabler);
vectorizeStraightLineF64DotPairsIn :231 (SLP); slpStorePairsIn :530 (SLP).

WASM tier loop chain (dispatch order): tryDivergentEscapeVectorize :4625
(predicated map); tryMemCopyFill :3460 (bulk-mem); tryVectorize :1268 (map);
tryReduceVectorize :1920 (reduce); tryMapReduceVectorize :2326 (fused
map+reduce); tryStencil :1640 (stencil); tryRampMap :3756 (map);
tryBlurMultiPixel :4217 (strip-mine+reduce); tryChannelReduce :4413 (reduce);
tryByteScan :3608 (search-reduce); tryPerPixelColor :5229 (map);
tryOuterStrip :5512 (strip-mine); tryIteratedReduce :5732 (strip-mine ×
recurrence × predicated hybrid); tryConvColumn :5927 (strip-mine);
tryToneMap :6163 (predicated map); tryButterfly :6470 (SLP);
tryStrengthReduceIV :3366 (scalar addr strength-red, deferred fallback).

## Duplication the model must absorb

1. **IV+bound scaffold ×4** in vectorize.js, zero sharing: matchBlockLoop
   :1208; matchOuterPixelLoop :4586; tryRampMap inline scan :3759;
   tryBlurMultiPixel :4218 / tryChannelReduce :4420. All re-implement
   loop-model.js's normalizeLoop+unitIncVar on WAT IR.
2. **Affine-of-IV ×3-4**: type.js affineIdxOfIV :155; vectorize
   matchConstMulIV/matchLaneOffset/matchLaneAddr :927/:942/:1017;
   matchAffineAddr :3340; buildPivotCoeff delta-walk ~:4166.
3. **Closure-mutation/IV-safety** combined manually per AST pass
   (closureMutatedVars + findMutations at each call site).
4. **Dependence never computed** — the "distinct base subtrees ⇒
   non-aliasing" standing model is re-asserted in prose at tryVectorize/
   tryStencil :1635, tryOuterStrip :5510, tryButterfly :6470. A solver-fed
   dependence set replaces prose with facts.
5. **Bound-literalness** re-checked ad hoc everywhere (litVal, boundVal,
   constNum :820 …).

## Existing substrate + the seed pattern

loop-model.js (91 lines) = primitives only: freshLoopId, litVal/litN,
unitIncVar, normalizeLoop, closureMutatedVars, rewriteBlocks. No per-loop
record. The ONE existing publish-a-proof example: peel-stencil stamps
`_rangeFacts` on the interior loop body (:213), consumed by type.js's
interval walker (:1291, :1855) — this is the shape to generalize into the
canonical per-loop record: IVs + trip ranges, affine accesses (one
language absorbing all four derivations), dependence sets (solver
aliasing), reductions/recurrences, masks/effects, profitability.

## Dispatch-semantics correction (2026-07-21, before anyone refactors wrong)

The two tiers have DIFFERENT composition semantics and must be unified
differently:
- **WASM tier** is genuine first-match-wins per block (`??` chain) — class
  dispatch over a shared record is semantics-preserving there.
- **AST tier** is a COMPOSE-PIPELINE: all 6 passes sweep the whole body in
  sequence, and a loop rewritten by pass k can legitimately re-match pass
  k+1 (divmod-reduced loop later clamp-peeled). Collapsing it into one
  first-match walk CHANGES semantics. The correct AST-tier unification is
  sharing the per-loop RECORD computation (normalizeLoop + unitIncVar +
  closureMutatedVars + findMutations once per loop per sweep, invalidated
  on rewrite), keeping the pipeline order.

## Step 3 DONE first (2026-07-21) — WASM scaffold unification

matchBlockLoop is now the ONLY block/loop IV scaffold. `matchLoopBrEnd`
extracted (loop label + br back-edge, shared by every envelope); three
opt-ins each preserving its consumer's exact acceptance set:
`multiInc` (tryRampMap: trailing `x += C` run, exit IV steps 1; bound
local/const stays the consumer residual), `envelope:'loose'`
(tryBlurMultiPixel + tryChannelReduce: any non-loop content tolerated;
blur's narrower i32.eqz∘lt_s exit stays its own residual),
`envelope:'pixelIV'` (matchOuterPixelLoop: labeled block, pure local.set
preamble, nothing after the loop). Net −104 lines. Bench WAT byte-parity
vs HEAD proven; battery-gated. The 4 duplicated scans are dead.

## Order of attack (matches plan Stage 3)

1. Grow loop-model.js into the record builder on the AST tier (its 6
   consumers already share primitives — smallest step).
2. One extent/affine computation shared with type.js's affineIdxOfIV
   (guard + vectorizer + unrollers read the same facts).
3. WASM-tier scaffold unification: matchBlockLoop becomes the only IV
   scaffold; the 3 inline scans die.
4. Recognizers → classifiers consuming the record; first-match-wins becomes
   class dispatch; the deferred-SR trick becomes a scheduling property of
   the class list, not a bespoke queue.

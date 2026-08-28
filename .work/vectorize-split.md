# vectorize.js structure map (pre-split)

Base: b05caa1a. `src/optimize/vectorize.js` is 8500 lines, a flat sequence of
162 top-level `function`/`const`/`let` declarations (verified: the only other
top-level statements are the 4 header imports and one `registerResetHook(...)`
call — no top-level class/if/for). Dependency edges below were extracted with
a comment/string-stripped scan (`node --check`-clean) so they reflect real
code references, not doc-comment mentions of sibling function names.

External contract (the ONLY thing outside this file that matters): exactly
four names are `export`ed and exactly one consumer imports them —
`src/optimize/index.js:38` `import { vectorizeLaneLocal, inlinePureCallExpr } from './vectorize.js'`
and `src/optimize/index.js:40` `export { SIMD_PINNED, inlinePureFnsInFn } from './vectorize.js'`.
Everything else in the file is module-private. Grepped test/, scripts/,
module/, src/ for any other direct `from '.../vectorize.js'` import: none.

## Shared infrastructure vs. per-pattern recognizers

The file is: generic AST predicates → NaN-canon/int-minmax idiom matchers →
a self-contained straight-line SLP/dot-product packer → the lane op-whitelist
tables ("single source of truth", per the file's own header doc) → the
BodyModel address/alias analysis → inner loop-scaffold matcher
(`matchBlockLoop`) → **eleven `try*` recognizers** dispatched in a fixed `??`
chain from `vectorizeLaneLocal` → AoS gather + pure-call-inline helpers → the
mechanical SIMD lift engine (`liftExprV`/`liftStmt`, called by most
recognizers' rewrite half) → outer pixel-loop scaffold (`matchOuterPixelLoop`,
shared by the 5 "outer" recognizers) → cost/profitability model (shared by
the 3 `tryGeneral*` fallbacks) → the entry dispatcher.

Dispatch order in `vectorizeLaneLocal` (load-bearing, first match wins):
`tryDivergentEscapeVectorize ?? tryMemCopyFill ?? tryVectorize ?? tryReduce ??
tryStencil ?? tryRampMap ?? tryChannelReduce ?? tryOuterStripRest ??
tryToneMap ?? tryButterfly ?? tryGeneralMap ?? tryGeneralStencil ??
tryGeneralReduce`, then a deferred scalar `tryStrengthReduceIV` fallback for
loops no recognizer took. `slpPairsIn`/`hoistReductionInvariantsIn` run once
per function, before the per-loop walk, unconditionally.

## Module plan (`src/optimize/vectorize/`, topological order — later modules
may import earlier ones, never the reverse)

Shared/infra (no recognizer logic):

| # | file | original lines | contents |
|---|------|----------------|----------|
| 1 | `node-utils.js` | 51-78 | `isArr`, `forEachLocalDef`, `localGetName`, `f64Zero`, `isSplatConst` — used by nearly every other module |
| 2 | `lane-tables.js` | 596-863, **+5669-5699** | the op-whitelist data: `LANE_INFO`, `LOAD_OPS`, `STORE_OPS`, `LANE_PURE`, `INT_WIDEN_F32`, `F64_TO_F32X4`, `REDUCE_OPS`, `WIDEN_LOADS`, `MINMAX_WIDEN`, `MINMAX_CVT`, `REDUCE_OP_LOOKUP`, `REDUCE_CANON`, `LANE_COMPARE`, plus `PPC_CALL2`/`SIMD_PINNED` (pulled from their original spot next to `tryPerPixelColor` — `liftExprV` itself rewrites calls through `PPC_CALL2`, so it is lift-engine shared state, not per-pixel-color-private; confirmed by direct call-site read, not just proximity) |
| 3 | `addr-model.js` | 864-1439, **+2891-2926** | the BodyModel address/alias analysis: `isLocalGet`…`hasImpureCall`, plus `_isAddressLocal`/`_isPixelIndexLocal` (pulled forward from next to the AoS helpers — `assertBodyModelSound` calls them, and they call `matchLaneAddr`/`matchConstMulIV` back, so leaving them where they physically sat would make `addr-model.js` and `aos.js` import each other; moving them here makes both one-directional) |
| 4 | `idioms.js` | 79-175 | `matchCanonSelect`, `normTee`, `matchIntMinMaxReduce`, `matchCanonBlock` — the NaN-canon-select / int-minmax-reduce idiom matchers; used by the lift engine + reduce + stencil families. Ordered after addr-model.js: `matchIntMinMaxReduce` itself calls `isLocalGet`/`isI32Const` |
| 5 | `dot-slp.js` | 176-595 | straight-line f64 dot-product / SLP store-pairing packer, self-contained; only `hoistReductionInvariantsIn` and `slpPairsIn` are called from outside (by the dispatcher) |
| 6 | `scaffold.js` | 1440-1643 | `normalizeTransparentBlocks`, `foldVecIdentities`, `canonicalizeIfBr`, `matchLoopBrEnd`, `bodyFacts`, `matchBlockLoop` — matches the canonical `(block (loop))` scaffold ONCE per candidate loop |
| 7 | `outer-scaffold.js` | 4963-5101 | `CMP_NEG`, `CMP_LANE`, `readsVar`, `writesName`, `epilogueIsSafe`, `matchPixelInc`, `matchPixelExit`, `matchOuterPixelLoop`, `bumpPixelIV`, `rampPixelIV` — the outer pixel-loop scaffold, shared by blur/channel-reduce, divergent-escape, per-pixel-color, and the outer-strip family |
| 8 | `aos.js` | 2927-2972 | `getOrAllocLanedLocal`, `aosAddrPair`, `aosLoad`, `aosStore`, `aosGather` — AoS de-interleave gather, used by the lift engine |
| 9 | `inline-pure.js` | 2973-3158 | `nodeWasmType`, `inlinePureCallExpr` (public), `INLINE_STMT_CTX`, `inlinePureFnsInFn` (public) — pure user-function-call inliner, reused by the lift engine |
| 10 | `lift.js` | 3159-3870, **+4543-4611** | the mechanical lift engine: `liftCanon`, lift-diagnostic state, `liftFail`, `tryLiftLaneIf`, `liftStmt`, `liftAddSubOfConverts`, `liftExprV`, plus `peelNarrowConv`/`PACK_I32_TO_I16`/`PACK_I32_TO_I8`/`narrowStore` (pulled from next to ramp-map — used by both `tryVectorize` and `liftStmt`, i.e. lift-engine shared, not ramp-private). **Mutable state note**: `_whyNotActive`/`_whyNotReason`/`_relaxF32`/`_crPow` were bare module-private `let`s; the dispatcher (`index.js`) writes 3 of them and reduce.js reads `_relaxF32` — ES modules forbid assigning through an imported binding, so these are bundled into one exported mutable object `vecState = { whyNotActive, whyNotReason, relaxF32, crPow }`; every read/write site became `vecState.x`. Behavior-identical (same reads/writes, same order), called out here because it is the one place the split is more than a textual cut-and-paste move |
| 11 | `cost-model.js` | 7147-7316 | `COST_WEIGHT`, `_COST_ARITH_RE`, `opCostWeight`, `weighTree`, `COST_OVERHEAD_PROLOGUE`, `COST_OVERHEAD_PER_GUARD`, `isProfitable`, `ALIAS_VERSION_MAX_BODY_NODES`, `gmNodeCount` — profitability model, used only by the 3 `tryGeneral*` fallbacks |

Recognizer families (each = the named `try*` + its non-shared local helpers):

| # | file | original lines | contents |
|---|------|----------------|----------|
| 12 | `strength-reduce.js` | 3871-3947 | `matchAffineAddr`, `tryStrengthReduceIV` — scalar IV fallback, deferred to after the main walk |
| 13 | `map.js` | 1644-2053, 7317-7655 | `tryVectorize` (410 ln) + `tryGeneralMap` (339 ln, its generalized fallback) |
| 14 | `stencil.js` | 2054-2381, 7656-8019 | `tryStencil` (328 ln) + `tryGeneralStencil` (364 ln) |
| 15 | `reduce.js` | 2382-2890, 8020-8282 | `tryReduceReassoc` (404 ln), `tryReduceBitExact`, `tryReduce` + `tryGeneralReduce` (263 ln) |
| 16 | `memcpy.js` | 3948-4101 | `MEMOP_STORES`, `tryMemCopyFill` |
| 17 | `ramp.js` | 4207-4542, 4612-4638 | `tryRampMap` (336 ln) + `buildRampStore` |
| 18 | `blur-channel.js` | 4102-4206, 4639-4691, 4692-4962 | `matchChannelAccum`/`matchChannelGroup`/`matchChannelReducePixelLoop` (channel-group scan — used only here, NOT by ramp-map despite sitting next to it in the original) + `buildPivotCoeff` + `tryBlurMultiPixel`, `tryChannelReduce1px`, `tryChannelReduce` |
| 19 | `divergent-escape.js` | 5102-5668 | `tryDivergentEscapeVectorize` (567 ln — the largest function in the file) |
| 20 | `per-pixel-color.js` | 5700-5969 | `tryPerPixelColor` (270 ln); `PPC_CALL2`/`SIMD_PINNED` moved out to `lane-tables.js` (see above) |
| 21 | `outer-strip.js` | 5970-6544 | `tryOuterStrip`, `tryIteratedReduce`, `tryConvColumn`, `tryOuterStripRest` — the last is the family's own internal `??` dispatcher, called by the top-level one |
| 22 | `tone-map.js` | 6545-6943 | tone-idiom matchers (`_toneStripTee`…`_toneFirstWrite`) + `tryToneMap` |
| 23 | `butterfly.js` | 6944-7146 | `tryButterfly` |
| 24 | `index.js` | 8283-8501 | `assertLoopPlanAgrees`, `vectorizeLaneLocal` — the entry dispatcher |

`src/optimize/vectorize.js` becomes a re-export shim (`export { vectorizeLaneLocal } from './vectorize/index.js'` etc.), keeping every external import path stable.

## Verified cross-checks (grep, not assumption)

- `matchLaneAddr`/`matchLaneOffset`/BodyModel family: called from map, stencil,
  reduce, ramp, memcpy, strength-reduce, general-map — genuinely file-wide,
  confirms `addr-model.js` as shared infra rather than any one family's.
- `matchChannelAccum`/`matchChannelGroup`/`matchChannelReducePixelLoop`: called
  ONLY from `tryChannelReduce` (blur-channel family), never from `tryRampMap`
  — physical proximity to ramp-map in the original was misleading.
  `peelNarrowConv`/`narrowStore`: called from `liftStmt` (lift engine) AND
  `tryVectorize` (map) — not ramp-private either, despite sitting next to
  `buildRampStore` in the original.
- `readsVar`/`writesName`/`epilogueIsSafe`/`bumpPixelIV`/`CMP_LANE`: called
  from blur-channel, divergent-escape, per-pixel-color, and all of the
  outer-strip family — confirms `outer-scaffold.js`.
- `isProfitable`/`weighTree`/`gmNodeCount`: called ONLY from the 3
  `tryGeneral*` fallbacks, not from the non-general recognizers.
- `_isAddressLocal`/`_isPixelIndexLocal` vs. `aosAddrPair`/`aosGather`: despite
  sitting in the same contiguous original block (2891-2993), these are two
  different concerns with opposite dependency directions (see `addr-model.js`
  row above) — split into two modules, not one.
- Only `src/optimize/index.js` imports directly from `vectorize.js`; every
  other `optimize/vectorize`/`vectorizeLaneLocal` hit across `src/`, `test/`,
  `module/` is either a config-flag property access (`cfg.vectorizeLaneLocal`)
  or a comment, not an import.

## Outlier decomposition candidates (phase 3, after the pure-move split)

- `tryDivergentEscapeVectorize` (567 ln) — largest function; look for a
  match-scaffold vs. rewrite-body seam once it's isolated in its own file.
- `tryGeneralStencil` (364), `tryGeneralMap` (339), `tryGeneralReduce` (263) —
  share the alias-versioning/profitability-check shape; check whether the
  shared shape is identical enough to hoist without speculative abstraction.
- `tryReduceReassoc` (404), `tryStencil` (328), `tryToneMap` (304),
  `tryRampMap` (336) — evaluate match/rewrite split per-function once moved.

Plan authored before any code was moved; decomposition specifics get filled
in as each family module is actually split (phase 3 commits).

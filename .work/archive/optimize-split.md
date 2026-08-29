# optimize/index.js split map

Source: `src/optimize/index.js` @ ed2b6ac7, 5537 lines. Sibling files already in
`src/optimize/` (established pattern to follow): `recurse.js` (230L, one pass:
`recursionUnroll`), `vectorize.js` (8500L, owned by a sibling session — DO NOT
TOUCH), `watr-tail.js` (338L, imports `SIMD_PINNED, collectReachableGlobalWrites,
hoistGlobalPtrOffset, stablePtrGlobalNames` from `./index.js`).

## Pass order (the driver, `optimizeFunc`, line 3887)

foldStaticConstArrayReads → recursionUnroll → hoistPtrType → hoistInvariantPtrOffset
→ narrowLoopBound → hoistInvariantLoop → fusedRewrite → [unswitchStringRepLoop?]
→ [boolConvertToSelect?] → hoistAddrBase → hoistInvariantLoop → cseScalarLoad →
promoteGlobals → [unswitchTypedParamLoop → vectorizeLaneLocal → foldV128Memargs]?
→ [inlinePtrOffsetFastPass]? → [splitLoopPrivateScratch + hoistInvariantLoop]? →
propagateSingleUse → foldSetToTee → [splitLoopPrivateScratch + hoistInvariantLoop]?
→ devirtConstFnArrayCalls → devirtSchemaReads → [rotateLoops]? → simplifyBoolContexts
→ sortLocalsByUse.

Whole-module passes (called from `src/wat/assemble.js`, not `optimizeFunc` — off
limits, do not touch): `treeshake`, `hoistConstantPool`, `specializeMkptr`,
`arenaRewindModule`, `collectVolatileGlobals`, `collectReachableGlobalWrites`,
`collectReachableMemoryWrites`, `stablePtrGlobalNames`, `buildPureFuncMap`,
`hasIROp` (via `guardMaskedVectorSuffix`'s early-out).

## Shared-helper seams found (drives the split)

- `regionTrackCSE` (341-461) is a generic region-tracking CSE skeleton used by
  BOTH `hoistPtrType` and `hoistAddrBase` — genuine shared walker, own family.
- `SAFE_OFFSET_CALLS/READONLY_MEM_CALLS/NON_MUTATING_CALLS/PURE_CALL_I32/
  isPureFnCall/CMP_MANTISSA` (609-675) are used by `hoistInvariantPtrOffset`
  AND `loopInvariance`/`hoistInvariantLoop` (883,903,920,951-957,1238-1241,
  1251) — one LICM family, not independent passes.
- `CELL_PREFIX/HARD_OPS/hasHardOp/isPtrBaseDecode/PURE_LICM_OPS/
  buildBaseParamOf/loopInvariance` (771-989) are the shared LICM predicate
  consumed by both `splitLoopPrivateScratch` and `hoistInvariantLoop`.
- `containsV128` (49-57) is used by THREE otherwise-unrelated families:
  `propagateSingleUse`/`foldSetToTee` (locals), `rotateLoops` (peephole).
  `hasIROp` (61-71) is used by `guardMaskedVectorSuffix` (globals) and by
  external consumers (wat/assemble.js). Neither belongs to one family →
  extracted to `ir-scan.js`, a 2-function shared leaf module.
- `buildPureFuncMap` (3365) calls `foldStrDispatchF64(clone)` (3384) directly
  — these two must stay in one file (`pure-funcs.js`), separate from
  `specializeMkptr` (3116-3308, same neighborhood, no shared code: call-site
  literal-signature specialization vs. pure-function detection for the
  vectorizer's inliner).
- `promoteGlobals` (2907-2988) calls `simplifyBoolContexts(fn)` at its tail
  (2987) — a genuine cross-family edge: `globals.js` → `peephole.js`.
  `simplifyBoolContexts` must be **exported** from `peephole.js` (it isn't
  exported today — file-private) for `globals.js` to import it.
- `toI32`/`MEMOP`/`NAN_BITS`/`NULL_BITS`/`UNDEF_BITS`/`FALSE_BITS`/
  `STR_INTERN_BIT` are used ONLY inside `walkRewrite`; `walkRewrite` is called
  ONLY from `fusedRewrite` (4341, 4397) — `fusedRewrite`+`walkRewrite` are one
  inseparable unit for the pure-move step (`walkRewrite` is also the outlier
  targeted for step-3 decomposition — see below).
- `rotateLoops` and `simplifyBoolContexts`/`boolSimp`/`ROT_NEG` are pipeline-
  adjacent by design (driver comment: simplifyBoolContexts runs "after
  rotateLoops so its fused back-edges get cleaned too" — tied together on
  purpose) → both live in `peephole.js` alongside `fusedRewrite`/`walkRewrite`.
- `devirtSchemaReads`, `foldStaticConstArrayReads`, `devirtConstFnArrayCalls`
  share no code but share a TECHNIQUE (compile-time-known-table devirt via
  `ctx.scope.*` facts) and cross-reference each other in comments (5328: "the
  same never-resized/never-aliased gate as foldStaticConstArrayReads") → one
  `devirt.js` family.
- `devirtConstFnArrayCalls` imports `inlinePureCallExpr` from the
  sibling-owned `vectorize.js` (already in the top-of-file import list) —
  carried forward unchanged, no edit to vectorize.js needed.
- `narrowLoopBound` declares its OWN function-local `const I32_MIN =
  -2147483648` (line 1529) — it does NOT use the top-level `I32_MIN` import
  from `ir.js`. Only `walkRewrite` (line 4600) uses the imported `I32_MIN`/
  `I32_MAX`. Getting this wrong would silently leave a dead import in
  `licm.js` — confirmed via grep before moving.

## Found defect (not fixed by a pure move alone — flagged, not touched here)

`sortLocalsByUse`'s docstring ("Reorder non-param local decls by reference
count…", lines 4867-4872) is physically stranded 537 lines before its function
(actual def at 5404), immediately before `devirtSchemaReads`'s own docstring —
almost certainly an artifact of past edits growing the file around it. The
module split fixes this as a side effect (the comment moves with the function
into `sort-locals.js`) — noted here since it's a real "confusion" this
refactor resolves, not because it changes behavior.

## Target modules

| file | lines (src) | contents | new top-level imports needed |
|---|---|---|---|
| `ir-scan.js` | 49-71 | `containsV128`, `hasIROp` | `walkAst` (ast.js) |
| `config.js` | 123-282 | `LEVEL_PRESETS`,`ALL_ON`,`ALL_OFF`,`L2_PRESET`,`resolveOptimize`, OPTF coherence-check | `OPTF` (ctx.js), `PASS_NAMES,TUNING_KEYS` (passes.js) |
| `cse-address.js` | 284-530 | `regionTrackCSE`,`hoistPtrType`,`PURE_I32_ADDR_OPS`,`pureI32AddrKey`,`hoistAddrBase` | `findBodyStart` (ir.js) |
| `licm.js` | 541-1789 | `boolConvertToSelect`,`BOOL_RESULT_OPS`,call-whitelists,`hoistInvariantPtrOffset`,`CELL_PREFIX`,`HARD_OPS`,`hasHardOp`,`isPtrBaseDecode`,`PURE_LICM_OPS`,`buildBaseParamOf`,`loopInvariance`,`splitLoopPrivateScratch`,`hoistInvariantLoop`,`narrowLoopBound`,`cseScalarLoad` | `LAYOUT`(ctx.js); `findBodyStart,buildRefcount,nextLocalId,cloneIR`(ir.js); `T,isLeaf,walkAst,stableNodeKey`(ast.js) |
| `locals.js` | 1789-2026 | `localRefTallies`,`propagateSingleUse`,`foldSetToTee` | `findBodyStart`(ir.js); `walkAst`(ast.js); `containsV128`(./ir-scan.js) |
| `globals.js` | 2028-3025 | `collectVolatileGlobals`,`collectReachableGlobalWrites`,`STABLE_PTR_VALS`,`stablePtrGlobalNames`,`hoistGlobalPtrOffset`,`typedGlobalByteLengths`,`irI32Const`,`globalBaseAliases`,`memAddress`,`plainLoadOp`,`memGlobal`,`collectReachableMemoryWrites`,`hoistStableGlobalConstLoads`,`guardMaskedVectorSuffix`,`hoistLoopGlobalPtrOffset`,`promoteGlobals`,`inferTypeFromContext` | `LAYOUT,ctx`(ctx.js); `VAL`(reps.js); `findBodyStart,cloneIR`(ir.js); `walkAst`(ast.js); `hasIROp`(./ir-scan.js); `simplifyBoolContexts`(./peephole.js) |
| `const-pool.js` | 3027-3092 | `f64BitsKey`,`hoistConstantPool` | `walkAst`(ast.js) |
| `specialize-mkptr.js` | 3094-3308 | `specializeMkptr` | `walkAst`(ast.js); `ptrBits,i64Hex,PTR`(../../layout.js) |
| `pure-funcs.js` | 3310-3518 | `buildPureFuncMap`,`foldStrDispatchF64` | `findBodyStart,cloneIR`(ir.js); `walkAst`(ast.js) |
| `unswitch.js` | 3520-3867 | `unswitchTypedParamLoop`,`unswitchStringRepLoop`,`DBG_UNSWITCH` | `ctx`(ctx.js); `walkAst,cloneIR`; `nextLocalId`(ir.js); `PTR,TYPED_ELEM_CODE,TYPED_ELEM_VIEW_FLAG`(layout.js); `vectorizeLaneLocal`? (verify — likely NOT needed, driver calls it separately) |
| `driver.js` | 3869-4027 | `optimizeFunc`, `DBG_IR` | imports every family's exports + `recursionUnroll`(./recurse.js), `vectorizeLaneLocal`(./vectorize.js), `verifyFn`(ir.js) |
| `peephole.js` | 4028-4753 + `boolConvertToSelect` moved in from 557-596 | `foldV128Memargs`,`inlinePtrOffsetFastPass`,`ROT_NEG`,`boolSimp`,`simplifyBoolContexts`,`rotateLoops`,`toI32`,`fusedRewrite`,`walkRewrite`,`MEMOP`,`NAN_BITS`,`NULL_BITS`,`UNDEF_BITS`,`FALSE_BITS`,`boolConvertToSelect` | `LAYOUT,FORWARDING_MASK`(ctx.js); `findBodyStart,isLeaf?,cloneIR,I32_MIN,I32_MAX,isPureIR,hasExpensiveOp,f64Range`(ir.js); `walkAst,isLeaf`(ast.js); `nanPrefixHex,atomNanHex,STR_INTERN_BIT`(layout.js); `containsV128`(./ir-scan.js) |
| `treeshake.js` | 4755-4865 | `treeshake` | `walkAst`(ast.js) |
| `devirt.js` | 4867-5402 (docstring reunited with `devirtSchemaReads`) | `devirtSchemaReads`,`foldStaticConstArrayReads`,`devirtConstFnArrayCalls`,`DBG_DSR` | `ctx`(ctx.js); `PTR`(layout.js); `nextLocalId,cloneIR,isPureIR`(ir.js); `walkAst`(ast.js); `inlinePureCallExpr`(./vectorize.js) |
| `sort-locals.js` | 4867(docstring)+5404-5445 | `sortLocalsByUse` | `walkAst`(ast.js) |
| `arena-rewind.js` | 5447-5537 | `arenaRewindModule` | `findBodyStart`(ir.js); `walkAst`(ast.js) |
| `index.js` (stable barrel) | file-level doc comment + re-exports only | — | re-exports from every file above + existing `vectorize.js`/`recurse.js`/`watr-tail.js` re-exports |

## Execution order (one commit per move, index.js re-exports kept green throughout)

1. `ir-scan.js` (no internal deps — pure leaf)
2. `config.js` (no internal deps)
3. `cse-address.js`
4. `pure-funcs.js`, `specialize-mkptr.js` (independent of each other)
5. `treeshake.js`, `sort-locals.js`, `arena-rewind.js`, `const-pool.js` (independent leaves)
6. `peephole.js` (needs ir-scan.js's `containsV128`)
7. `locals.js` (needs ir-scan.js's `containsV128`)
8. `licm.js`
9. `globals.js` (needs peephole.js's `simplifyBoolContexts` export + ir-scan.js's `hasIROp`)
10. `unswitch.js`
11. `devirt.js` (needs vectorize.js's `inlinePureCallExpr`, already imported today)
12. `driver.js` (needs everything above)
13. Shrink `index.js` to the barrel; verify byte-identical re-export surface.

Step 3 (decompose outliers) targets after all moves land: `walkRewrite` (351L,
peephole.js) into match/dispatch vs rewrite halves if a real seam exists;
`devirtSchemaReads` (306L, devirt.js) similarly; `unswitchTypedParamLoop` (270L,
unswitch.js). Only if the oracle stays clean — else record why not.

# Fold ledger

Campaign: make the compiler smaller in concepts and cheaper to run with every
compiled byte, test and product metric equal or better. Branch `fold`, own worktree.

## Baseline (d98a122f)

| metric | value |
|---|---|
| dist/jz.js | 2,732,874 B (gzip -9: 754,245 B) |
| dist/jz.wasm | 20,121,459 B |
| dist/interop.js | 37,927 B |
| build-dist wall | 88 s |
| oracle | 580 entries (145 specs × O0/O2/O3/size), 2 m 36 s, deterministic (second run CLEAN); watr specimen pinned (JZ_ORACLE_WATR → a copy of watr d09bd06) |
| compile budget (loaded machine, ±20 % noise) | jessie 3995 ms / 365 MB, watr 10474 ms / 524 MB |
| jz-own compile time (total minus watr's optimizer and encoder, min of 9, `.work/fold-time.mjs`) | jessie 590 ms, watr 2992 ms |
| supplementary oracle at O1 and 'fast' (watr off, `.work/fold-oracle-extra.mjs`) | 290 entries |

Where compile time goes (CPU profile, oracle corpus): watr's optimizer ~53 %;
jz's single hottest function is the vectorizer's `liveOutOf` scan (8.3 s of
219 s, computed eagerly for every block: quadratic), then `walkAst` (8.4 s),
interval-proof (7.2 s).

## Candidates

candidate | evidence | est. saving | files | status
---|---|---|---|---
ClosureEnvPlan: a pre-emission record of what `ctx.closure.make` derives again at emission | plan and emission derivation asserted equal under DBG_INVARIANTS; `id`/`bindingId` never read; oracle CLEAN with the plan deleted | 1 file, 2 ctx fields, a walk and a free-var scan per arrow; ~280 lines, ~2 KB dist | closure-plan.js, function.js, analyze-for-emit.js, closure-emit.js, call.js, ctx.js | folded
Vectorizer `liveOutOf` computed eagerly for every block | 8.3 s self time on the oracle corpus, 1.6 s of 3.8 s jz time on watr | ~10 % of jz compile time; not a concept | vectorize/index.js | done (cost)
ctx fields nobody reads: `types.loopGuardLo`, `plans.start`, `types.dictKinds`, `schema._byKey`, `schema.errorClassesUsed` | grep: written (or read) once, never the other | ~20 lines | ctx.js, i32-bounds.js, start-fn.js, plan/index.js, schema.js | pending
Unused exports (knip): `intExprChecker`, `litBoundArrIdx`/`affineIdxOfIV`/`bodyAffineEnv` re-exports, `ENUM_SET`, `BINDING_USE_SELF`, `runsAccessor`, `seedSummaryShape` | `npm run audit:files` exports view | small | type.js, int-certain.js, … | pending
Barrels (`narrow.js`, `analyze.js`, `representation-plan.js`, `program-facts.js`, `emit.js`, `ir.js`, `optimize/index.js`, `wat/assemble.js`, `kind.js`, `type.js`): re-export-only files kept so imports survived splits | 0 own exports each, ~500 lines | 10 files; touches most importers | many | pending, low rank (many files per concept)
Grouping parens after prepare: 20 post-prepare `op === '()' && n.length === 2` arms | prepare's `'()'` handler returns `prep(callee)` for a grouping | ~20 lines, one concept | summary, interval-proof, inline, … | pending coverage
`LEVEL_PRESETS[3]` and `.speed` are the same literal twice | config.js | 1 line | config.js | pending, below threshold

## Folds

fold | concept | Δsrc lines | Δdist bytes | Δcompile time, RSS | commit
---|---|---|---|---|---
1 | ClosureEnvPlan, a second derivation of a closure's captures | −279 | −1,948 | noise (loaded machine) | 9d5d53d4
2 | (cost) vectorizer live-out scan runs only when a recognizer asks | +3 | +41 | jz time on watr −30 % (2992 → 2092 ms), jessie ±0 | this commit

## Rejections and owner decisions

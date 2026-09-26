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
| `npm test` (default leg) | 4837 tests, 131,189 assertions, all pass; 38.7 min on the loaded machine, peak RSS 2.6 GB |
| widened oracle (`test/_hashes.mjs`), default leg | 16,144 compile keys |

Where compile time goes (CPU profile, oracle corpus): watr's optimizer ~53 %;
jz's single hottest function is the vectorizer's `liveOutOf` scan (8.3 s of
219 s, computed eagerly for every block: quadratic), then `walkAst` (8.4 s),
interval-proof (7.2 s).

## Candidates

candidate | evidence | est. saving | files | status
---|---|---|---|---
ClosureEnvPlan: a pre-emission record of what `ctx.closure.make` derives again at emission | plan and emission derivation asserted equal under DBG_INVARIANTS; `id`/`bindingId` never read; oracle CLEAN with the plan deleted | 1 file, 2 ctx fields, a walk and a free-var scan per arrow; ~280 lines, ~2 KB dist | closure-plan.js, function.js, analyze-for-emit.js, closure-emit.js, call.js, ctx.js | folded
Vectorizer `liveOutOf` computed eagerly for every block | 8.3 s self time on the oracle corpus, 1.6 s of 3.8 s jz time on watr | ~10 % of jz compile time; not a concept | vectorize/index.js | done (cost)
DictKindIndex (dict-kind-index.js): `resolveDictKind` has no caller since d6a219ca moved parameter kinds to the summary | `git log -S 'resolveDictKind('`; oracle CLEAN at all six levels with it deleted | 539 lines, a whole-program walk, a ctx field | dict-kind-index.js, plan/index.js, freeze.js, phase-marks.js | folded
emitFunc re-applied the call-site parameter facts analyzeFuncForEmit had seeded into the FunctionPlan (its own comment: "duplicates that seeding"), and kept a ctx.schema.vars overlay no emission-time writer uses | knockout: oracle CLEAN at all six levels; only `maybeNullish` is seeded nowhere else, so it stays | ~65 lines | emit-func.js | folded
Functions with no caller outside their own body (`.work/fold-uncalled.mjs`, verified by grep over src, tests, scripts, bench, examples) | eleven found; the rest of the scan's hits were parse noise | ~110 lines | ten files | folded
`opts.profile.memory`: GC-forcing heap and table-size sampling around each phase; no test, script, CLI or bench sets it | grep over test, scripts, bench, examples | ~40 lines | index.js | folded
Phantom AST ops `for-in`/`for-of`/`for-await`/`do-while`: 38 checks across 23 files and `ctx.core.emit['for-in']` (module/collection.js, ~90 lines), none reachable (subscript's feature/loop.js emits `for`/`for await`/`do`; prepare lowers in/of heads; grep finds no constructor) | function coverage: the emitter never ran in tests or corpus | ~160 lines, ~3.7 KB dist | 23 files | folded
Destructuring patterns after prepare: summary `destructure` (+`entriesOf`), slot-write-hazards `patternTargets`, declare-written-keys `patternNames` | function coverage: none ran in the suite or corpus; a throwing probe in `destructure` never fired across 1005 destructuring-heavy tests; prepare's pushPatternAssign lowers every pattern | ~50 lines | 3 files | folded
State nobody reads (`srcPtrAux`, `elemWidth`, `schema._byKey`, `schema.errorClassesUsed`, `types.loopGuardLo` never written), constants nobody references (`bitEq`, `FINISH_SIGNIFICAND`, `AUTO_CFG_*`), a tuning key nobody sets (`valKindDominance`) | `.work/fold-ctxfields.mjs`, `.work/fold-unrefconst.mjs`, grep; `ctx.plans.start` stays (tests read it) | ~40 lines | 10 files | folded
Unused exports (knip): `intExprChecker`, `litBoundArrIdx`/`affineIdxOfIV`/`bodyAffineEnv` re-exports, `ENUM_SET`, `BINDING_USE_SELF`, `runsAccessor`, `seedSummaryShape` | `npm run audit:files` exports view | small | type.js, int-certain.js, … | pending
Barrels (`narrow.js`, `analyze.js`, `representation-plan.js`, `program-facts.js`, `emit.js`, `ir.js`, `optimize/index.js`, `wat/assemble.js`, `kind.js`, `type.js`): re-export-only files kept so imports survived splits | 0 own exports each, ~500 lines | 10 files; touches most importers | many | pending, low rank (many files per concept)
Grouping parens after prepare: 20 post-prepare `op === '()' && n.length === 2` arms | prepare's `'()'` handler returns `prep(callee)` for a grouping | ~20 lines, one concept | summary, interval-proof, inline, … | pending coverage
`LEVEL_PRESETS[3]` and `.speed` are the same literal twice | config.js | 1 line | config.js | folded with the row above

## Folds

fold | concept | Δsrc lines | Δdist bytes | Δcompile time, RSS | commit
---|---|---|---|---|---
1 | ClosureEnvPlan, a second derivation of a closure's captures | −279 | −1,948 | noise (loaded machine) | 9d5d53d4
2 | (cost) vectorizer live-out scan runs only when a recognizer asks | +3 | +41 | jz time on watr −30 % (2992 → 2092 ms), jessie ±0 | 022ef049
3 | DictKindIndex, a whole-program per-key kind index nothing has read since the summary took over its one consumer (d6a219ca) | −561 | −6,822 | one whole-program walk less (4 ms on watr) | a28aa172
4 | emission-time re-seeding of parameter facts the FunctionPlan already carries from analysis, and the empty schema-binding overlay it once needed | −64 | −828 | one per-parameter pass less per function | 18dcf984
5 | functions nothing calls (`containsEffect`, `dictValueKindSet`, `mapValueKindSet`, `localOf`, `callFree`, `literalOf`, `hasLoopJump`, `retargetLoopJumps`, `hashCapFor`, `linearIndexOf`, `intExprChecker`) and type.js re-exports nothing imports | −111 | −12 (esbuild already dropped them) | — | 7a26016a
6 | the compile profiler's `profile.memory` sampling mode, set by no caller (its own comment: "Never set by any real caller") | −39 | −590 | — | 40e43f8b
7 | the phantom loop ops `for-in`, `for-of`, `for-await`, `do-while`: the parser emits `for`/`for await` with an `in`/`of` head and `do`, prepare lowers the heads, and nothing synthesizes the hyphenated ops; 38 checks for them and the unreachable `for-in` emitter go | −137 | −3,726 | — | 7ebcaf07
8 | destructuring patterns in compile passes: prepare lowers every declaration and assignment pattern (pushPatternAssign), so the summary's `destructure`, the slot-hazard `patternTargets` and the written-keys `patternNames` never run | −48 | −1,099 | — | d323b3b2
9 | state, constants and a knob nothing reads: `srcPtrAux`, `elemWidth`, `ctx.schema._byKey`, `ctx.schema.errorClassesUsed`, the never-written `ctx.types.loopGuardLo`, `bitEq`, `FINISH_SIGNIFICAND`, the removed auto-tuner's `AUTO_CFG_*`, the `valKindDominance` tuning key; `3` and `speed` share one preset | −36 | −445 | — | this commit

## Rejections and owner decisions

# Scout report: pass plumbing in jz v1 + watr

Model: Sonnet 5.5 (claude-sonnet-5-5). Read-only; nothing in any repo or worktree was modified.

Tree read: `/Users/div/projects/jz/.claude/worktrees/v1` (branch `v1`, HEAD b33e45ec7). Its `node_modules` is a symlink to `../watrbump/node_modules`, i.e. **watr 5.13.4**, byte-identical to the dev checkout `/Users/div/projects/watr/src`. `/Users/div/projects/jz/node_modules/watr` is 5.13.3; its optimize.js differs by one propagate fix (loop back-edge in `substGets`, ~18 lines), irrelevant to the findings. All watr line numbers below are 5.13.4 (`/Users/div/projects/jz/.claude/worktrees/v1/node_modules/watr/src/optimize.js`).

Evidence marks: **[V]** verified (read the code, or ran it); **[I]** inferred.
Scratch scripts (all in `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/`): `trace.mjs` (ctx access tracer), `purity.mjs` (same input, same output?), `helpers.mjs` (helper text across compiles), `final.mjs` (post-watr helper text), `split.mjs`, `prof.mjs`, `prof2.mjs`, `levels.mjs`.

---

## 0. Two findings that change the framing

**0.1 The "90 ms" is a cold-process number. [V]** Same 7-line allocating program, same process (`prof2.mjs`):

| run | total | compile | watOptimize | optMod:optimizeFuncs |
|---|---|---|---|---|
| 1st compile in process | 160-173 ms | 90-93 ms | 40-47 ms | 26-29 ms |
| 3rd/4th compile of it (warm) | 29 ms | 11 ms | 15 ms | 5.8 ms |
| a different tiny program, warm | 6 ms | 4 ms | 0.8 ms | 0.8 ms |

A per-process memo cannot help the first compile (nothing is memoized yet) and cannot remove JIT warm-up of the optimizer code that user functions still run. It helps compile 2..N. A memo that survives the process (precomputed at build time, shipped as data) would help the cold case; a per-process one would not.

**0.2 Helper-heavy programs are where the time is. [V timings, I attribution of watOptimize]** `split.mjs`, warm (5th compile of a program in-process):

| program | total | optimizeFunc on helpers | optimizeFunc on user fns | watOptimize | optimizeModule |
|---|---|---|---|---|---|
| `a.push` loop (14 helpers, 4 user fns incl. `$f$exp`,`$_alloc$exp`) | 30.7 ms | 3.9 ms | 0.5 ms | 16.9 ms | 5.0 ms |
| same at `speed` | 32.5 ms | 7.1 ms | 0.5 ms | 15.2 ms | 8.2 ms |
| `s.split(",").map(trim).join("-")` (109 helpers, 5 user fns) | **420 ms** | 76 ms | 16 ms | **263 ms** | 104 ms |
| same at `speed` | 450 ms | 78 ms | 14 ms | 259 ms | 102 ms |

For the string program the user code is 5 functions, so nearly all of watOptimize is helper code (inference). The upside of a helper memo is much larger there than in the 7-line example.

---

## 1. optimizeFunc purity (jz side)

### 1.1 Method

1. Read `src/optimize/driver.js` (212 lines) and every file it imports; grepped each for `ctx.`, module-level `let`/caches, fresh-name schemes, node tags. [V]
2. Ran an access tracer (`trace.mjs`): replaced each top-level key of the `ctx` singleton with an accessor returning a recording Proxy, switched on only while `ctx.scope.headerSafeFuncs` is non-null (that is exactly the window of `eachChecked(allFuncs, optimizeFunc)` in `src/wat/assemble/optimize-module.js:113-120`). Programs: alloc, typed-array loops, object/string, bench aos/dict/fft/blur/hash/biquad/dispatch/base64/conv2d/crc32/entity, at default and `speed`. **Zero ctx writes were observed in any run**; the read set is the table in 1.3. Limitation: only paths the corpus reached are seen; static reads were cross-checked by grep. [V]
3. Ran an input/output purity experiment (`purity.mjs`): hooked `ctx.transform.phaseEach` (a real hook, `src/ctx.js:1141-1144`), recorded JSON of each stdlib helper before and after `optimizeFunc`, 7 programs x 3 tiers. For helper bodies that were byte-identical before the call: **identical output in 95/95 groups (default), 95/95 (speed), 51/51 (size); 0 counterexamples.** 65 of 77 helpers seen in >=2 compiles had an identical pre-optimizeFunc body in all compiles at default/speed (45/47 at size). [V; a sample, not a proof]

### 1.2 Things outside the arguments that touch every call

| item | where | note |
|---|---|---|
| `cfg` is `ctx.transform.optimize` itself | `optimize-module.js:36`, tracer shows `ctx.transform.optimize.*` reads | The ~60 `cfg.x` reads in driver.js read the live resolved config. [V] |
| fresh local/label names | every minting pass | **All counters are per function**: `nextLocalId(fn, prefix)` (`src/ir/control.js:46`, high-water of existing locals), a local `uid`/`next` with a taken-set (`forward-store.js:43`, `sink-stores.js:58`, `lead-*`, `jump-pointers.js:181`, `ring-laps.js:134`, `pointer-exits.js:129`, `issue-order.js:207`), `$_pgN` (high-water over fn, `globals.js:937-945`), `freshIdRef = {next: 0}` per function (`vectorize/index.js:158`), specialize `tag = .f${id++}` (`specialize.js:446`). The module-wide counter `ctx.func.uniq` (`freshEmitId`, `compile/active-function.js:125`) is reached only via `temp()` in `src/ir/locals.js`, which no optimizeFunc pass calls (int-narrow, forward-hops, to-int32 define their own local `temp`). [V] |
| module-level caches | `ir/vars.js:103` `DOLLAR` (interned `'$'+name`, content-addressed, pure), `ast.js:253-280` scratch Map/Set pool (re-entrancy only), `ast.js:349` `assignedMemo` (emit-only window), `optimize/fn.js:40` `fxCache` (per tape symbol table, tape only), `arena-rewind.js:99` `escNotes` (debug), env debug flags (`JZ_DBG_*`) | none changes output [V] |
| node tags / fn props stamped by emit | `.saArr/.saBits` (`module/array.js:1533,1536`), `.dvProp/.dvObject` (`compile/emit/own-method.js:42`, `module/core.js:2302,2336`), `.dvArr/.dvOpen` (`compile/emit/call.js:383`), `.mem` (`ir/mem-alias.js:36,53`, derived from `ctx.summary` at emit, not at optimize), fn-level `cseLoadBases`, `distinctParams` (`compile/emit-func.js:185-186`), `presentArrays/stableHeaderNames/viewNames/presentTyped` (read `licm.js`, `globals.js:970-974`), `irange` (read-only in `int-range.js:933,1011`; no setter found) | Stamped only on user IR. **Stdlib helpers are parsed from WAT text (`parseWat`) and carry none of them.** `cloneIR` (`ir/coerce.js:72`) preserves only `.schemaSid`, so any rebuilding pass strips the rest. [V] |
| cfg fields mutated during the run | `cfg._pureFuncMap` set once before the loop (`optimize-module.js:74`, module-wide map of pure functions' IR, read `driver.js:133`); `cfg._vectorizedFnNames` **written** per function (`driver.js:138`), read later by `programPins` (`watr-tail.js:98-99`) | The write is a cross-function side effect a memo must replay. [V] |

### 1.3 Pass table (order as in driver.js)

"ext reads" = state outside `(fn, cfg flags)`. "ext writes" = state outside `fn`. "diff?" = could output for the same function differ between two compiles.

| # | pass (file) | ext reads | ext writes | output differs between compiles? |
|---|---|---|---|---|
| 1 | `foldStaticConstArrayReads` (devirt.js:442-518) | `ctx.scope.staticArrs`, `ctx.types.arrResized`, `ctx.types.nameEscapes`; tags `.saArr/.saBits` | none | only for tagged user nodes (declares per-compile array facts). No-op on helpers. |
| 1a | `holdWordNumbers` (peephole.js) | tag `.wordOf` (emit: a field of a schema whose every write is a word, an element of a dense array of words) | none | only for tagged nodes: the tag is the program's census, so a function's reads carry it in one compile and not in another |
| 2 | `stripDeadCanons` (nan-canon.js) | none | none | no |
| 3 | `hoistPtrType` (cse-address.js) | none (fn-local ids) | none | no |
| 4 | `hoistInvariantPtrOffset`, `hoistPtrOffset` (licm.js, cse-address.js) | none | none | no |
| 5 | `narrowLoopBound` (licm.js:966) | none | none | no |
| 6 | `hoistInvariantLoop` (licm.js:765, 536) | `ctx.scope.freshTypedGlobals` (313, 324), `ctx.scope.headerSafeFuncs` (539; module-wide call-graph fixpoint `collectHeaderSafeFuncs`, licm.js:67, built from all funcs' pre-opt IR), fn props `distinctParams/presentArrays/stableHeaderNames/viewNames/presentTyped` | none | helper bodies: yes **iff** a callee's header-safety/alloc flag differs between compiles. Callee-closure dependent. |
| 7 | `fusedRewrite(fn, hasBigint, !leanRuntime)` (peephole.js) | `representationProgramHasBigint(ctx)` -> `ctx.plans.representationData` (module bool); `peephole.js:525` `ctx.plans.loweringLinks.get(block)` (identity-keyed WeakMap, user loops only) | none | helper: only via the bigint bool |
| 8 | `unswitchStringRepLoop` (unswitch.js, speed only) | `ctx.funcs.list.length <= 64` (driver.js:92) | none | module-size gate; also needs a `$ccsso` local, so user-only |
| 9 | `foldShiftRemainder` | none | none | no |
| 10 | `boolConvertToSelect` (off by default) | none | none | no |
| 11 | `hoistAddrBase` | none | none | no |
| 12 | `hoistInvariantLoop` (2nd), `cseScalarLoad` (licm.js:1163) | as #6; `fn.cseLoadBases` | none | as #6 |
| 13 | `forwardStores` (forward-store.js) | `.mem` tags via `mayAlias` | none | tags are per-compile summary cell ids (`'e<cell>'`); user-only |
| 14 | `sinkStores`, `earlyStores` (speed) | `.mem`, `fn.distinctParams` | none | as #13 |
| 15 | `promoteGlobals(fn, globalTypes, reachableWrites)` (globals.js:896) | `globalTypes` (module map), `reachableWrites.has(fn, g)` and `.has(callee, g)` (transitive global-write closure over the module's pre-opt IR, **plus** `later` = compaction kernels `COMPACT_KERNELS` when `ctx.plans.compactLoopLabels` is non-empty, `optimize-module.js:55`), `hasIndirect` | mutates `fn.presentArrays` etc. | **yes, for helpers**: whether a global read >=3 times is promoted depends on whether any callee (or the compaction kernels) writes it, and that depends on the program. Capturable as an input (see 1.4). |
| 16 | `unswitchTypedParamLoop` (unswitch.js; speed) | `ctx.linkDemand.f16` | none | bool input |
| 17 | `vectorizeLaneLocal` (vectorize/index.js, 24 files, 10.6k lines) | `cfg._pureFuncMap` (**other functions' IR**), `ctx.plans.loweringLinks.get(loop)` (index.js:85,260; user loops), `ctx.linkDemand.typedView` (dot-slp.js:508), `ctx.scope.dvArmFns` (`inline-pure.js:40`, other functions' IR) | `cfg._vectorizedFnNames`; `warn('simd-why-not')` -> `ctx.warnings` (only with `whyNotSimd`) | helper loops calling pure callees: depends on callee IR. Replayable effects. (`ctx.*` counts in lift.js/tone-map.js etc. are a local `liftCtx`, not the singleton.) |
| 18 | `foldV128Memargs` | none | none | no |
| 19 | `foldGuardedUpdates` | none | none | no |
| 20 | `hoistTypedDecode` | `ctx.features.resizable` | none | bool input |
| 21 | `splitLoopPrivateScratch` (gated off) | none | none | no |
| 22 | `devirtConstFnArrayCalls(fn, cfg)` (devirt.js:598-720) | `ctx.scope.constFnArrays`, `ctx.scope.dvArmFns` (**other functions' IR**, built `optimize-module.js:108-112`), `ctx.scope.staticArrs`, `ctx.types.arrResized/nameEscapes`; tags `.dvArr/.dvOpen` | none | user-only (tagged); reads read-only maps built before the loop |
| 23 | `devirtSchemaReads` (devirt.js:44-420) | `ctx.schema.list`, `ctx.schema._byProp`, `ctx.core.includes.has('__ptr_type'/'__jp_obj')`, `ctx.summary.fieldKind`, `ctx.transform.optimize.leanRuntime`; tag `.dvProp` | **`ctx.runtime.icSites++` (devirt.js:195) and `declGlobal(__ic_hiN, __ic_slotN)`** -> `ctx.scope.globals`; emits `global.set $__ic_found_slot`; later `__clear` is patched (`optimize-module.js:123-126`) | **Yes, impure in the strict sense**: output names depend on a module-wide counter and it declares module globals. Only fires on tagged user reads (`hasReads` false -> early return, devirt.js:59), never on helpers. Not capturable as an input; the memo must exclude tagged IR. |
| 24 | `lowerToInt32Tails` | none | none | no |
| 25 | `specializeLoops` (speed), `narrowInts`, `narrowWrappedWords`, `refoldMemargs`, `combineGuards` | cfg only (`inlineToNum`, `wordTruncation`); `irange` tag read | none | no |
| 26 | `wideAccumulator` (speed), `narrowFloat32`, `recursionUnroll` (speed) | none | none | no |
| 27 | `foldLoadCasts`, `reuseLoads`, `narrowByteLoads` (speed), `dropSettledTests`, `inlinePtrOffsetFastPass` (speed) | `.mem` (mayAlias) | none | no (per-compile `.mem` only on user IR) |

Not in optimizeFunc but in the same `optimizeModule` and also stdlib-aware: `dropStaticRoots`, `scalarizeStaticScratch`, `specializeMkptr` (adds new helper bodies to `sec.stdlib`), `hoistGlobalPtrOffset/hoistLoopGlobalPtrOffset`, `quietOptimizedLoops` (writes `ctx.plans.quietLoopNodes`, `quiet-loops.js:272`), `insertLoopRewinds/Compacts` (writes `ctx.plans.hasCompactLoops`, `loop-compact.js:258`, nulls `ctx.plans.*LoopLabels`), `hoistForwardHops`, `hoistStableGlobalConstLoads`, `outlineToInt32`, `appendLateStdlib`, `declGlobal('__heap'...)` (`optimize-module.js:183-185`).

### 1.4 Verdict (question 1)

A per-function memo of `optimizeFunc` **can be sound for stdlib helpers**, with these extra inputs beyond `(fn IR)`:

1. `cfg`: the resolved optimize config, hashed with the private `_` fields excluded. [V]
2. Four module bools: `representationProgramHasBigint`, `linkDemand.f16`, `linkDemand.typedView`, `features.resizable`. (`funcs.list.length<=64` is user-only.) [V]
3. For `promoteGlobals`: per global read >=3x and not written in `fn`: `(globalTypes.get(g), promotable?)` where promotable = not (`hasIndirect` or `reachableWrites.has(fn,g)` or any callee writes g). This is a function of the callee closure plus the `later` kernel set. [V]
4. For `hoistInvariantLoop`/`cseScalarLoad`: for each callee called in a loop, `(headerSafe?, alloc?)`; and `fn.name`-independent. Also `freshTypedGlobals` intersected with names the fn references (never for helpers in practice). [V]
5. Only if the vectorizer or devirt are on and `fn` has a call to a user pure function: that callee's pre-opt IR (`_pureFuncMap`, `dvArmFns`). Practically never for helpers; to be safe key on the callee's content hash. [I]
6. Effects to replay on a hit: add `fn[1]` to `cfg._vectorizedFnNames` if the vectorizer fired. [V]

Equivalent simpler formulation: key = hash(fn IR) + hash(cfg) + 4 bools + a Merkle hash of the callee closure's *pre-opt* IR (that determines #3, #4, #5 at once). Empirically (1.1 step 3) same input gave same output 241 of 241 times, so the extra inputs were not needed in that sample; the sample is small (7 programs) and does not stress promoteGlobals variation, so keep #3/#4 in the key.

Breaks purity in a way that cannot be captured as an input: `devirtSchemaReads` (global counter `icSites`, `declGlobal`). It does not touch untagged helper IR. Anything with expando tags (`.saArr .dvProp .dvArr .mem`) is not memoizable by structural hash, because the tags are per-compile ids (`.mem = 'e<cell>'`) and are invisible to `JSON.stringify`/array equality. Memoize only IR that came from `parseWat` (stdlib templates, `parseTemplate` in stdlib-pull.js:25).

Required debug check (the user's idea): re-run `optimizeFunc` on a clone and `deepEqual` against the memo, including `fn.length`, local declaration order and `cfg._vectorizedFnNames` delta. `DBG_INVARIANTS` already brackets `optimizeFunc` with `verifyFn` (driver.js:61,211), a natural place.

---

## 2. Where helper functions come from

**Static text, thunks, and post-hoc text patches. [V]**

- Registry: `ctx.core.stdlib[name]` is a string or a thunk `() => string`, registered when modules load (`module/*.js`, e.g. `module/array.js:735` `__arr_push1`; `module/core.js:1002-1068` `__alloc`). About 520 assignment sites in module/*.js.
- Parameterization: templates interpolate layout constants (`LAYOUT.*`, `HEAP.*`) and branch on options: `ctx.memory.atomic` (two `__alloc` bodies), `place = ctx.transform.optimize.placeLargeBlocks` (`core.js:1040`), `leanRuntime` via `followForwardingWat` (`ctx.js:95`), `hasExt`-style feature gates in thunks (`resolveIncludes` comment `ctx.js:309-313`), `ctx.runtime.*` tables.
- Realization points in `pullStdlib` (`wat/assemble/stdlib-pull.js:249-263` and the sweep at ~455): thunks are expanded once and memoized back into the registry ("Thunked templates expand ONCE by contract").
- **Per-compile text patches after expansion** (so the same name can have several bodies): `__clear` gets restores/caches/heal calls appended (`stdlib-pull.js` ~600-640); `__gc_move` has `;; rekey:dyn` replaced; `__park_rewind_to` extended; `__catch_error` regenerated per error-code set (`catchErrorArms`); math kernel constant offsets renumbered per program (`ctx.runtime.mathKc`, ~ line 395); `specializeMkptr`/`outlineToInt32`/`appendLateStdlib` add helper bodies; `instrumentHelperCounter` wraps on parse (`helper-counters.js`).
- Join point: `sec.stdlib.push(...[...ctx.core.includes].map(n => instrumentHelperCounter(n, parseTemplate(stdlibStr(n)))))` (`stdlib-pull.js:~688`). `parseTemplate = src => parseWat(src, {loc:false})`. Final module order `...sec.stdlib, ...sec.funcs, startFn` (`compile/index.js:1063-1066`).

**How much do helper texts vary? [V, `helpers.mjs`]** 11 compiles (6 programs, default/speed/size): of 118 helper names seen in >=2 compiles, 104 had byte-identical expanded text in all of them. The 14 that varied: `__alloc`, `__memgrow`, `__arr_push1`, `__arr_grow_known`, `__ptr_offset` (all `size` tier: leanRuntime/Os variants), `__clear` (6 variants: per-program resets), `__gc_begin/walk/move/mark`, `__len`, `__typed_idx`, `__str_join`, `__to_str` (feature-driven: ext/compaction/map features). The decider is (tier flags, feature set, memory mode, program-specific table/reset injection). So "same name, different body" is real but shallow: key the memo by content, never by name.

**optimizeModule treats helpers and user fns identically. [V]** `allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]` (`optimize-module.js:50`), `eachChecked(allFuncs, func => optimizeFunc(func, cfg, globalTypesMap, writes))` (118). Differences are only data-driven: helpers have no emit tags, no fn props, are not in `ctx.funcs.list`, and name-keyed policies apply (`pureKernel(name)` in `pure-funcs.js`, `OUT_OF_LINE`, `SIMD_PINNED`, `NON_MUTATING_CALLS` tables, `user(name)` in `watr-tail.js:763` using `ctx.funcs.map`).

---

## 3. watr side (5.13.4)

### 3.1 Structure [V]

`optimizeModule` (`optimize.js:10744`): `ast = clone(ast)` (whole module), `CALLFX = computeCallEffects(ast)` (module-global, line 3044), strip comments, `nanFoldNode` walk, `constF64 = constF64Globals(ast)`, then **pre-round whole-module passes** `deadset`, `lazySelect`, `valueNumber`, `schedule` (not dirty-gated), then `runRounds` (up to 6), then `finish`: `inlineWrappers/inline`, `unroll2`, `devirt`, `licm`, `lsr`, `cse`, `poolConstants`, `outline`, `sortLocals` (whole-module, once). `snapshots` starts empty and `dirty = null` (= everything), so **round 1 runs every pass on every function**; `hashNode` (10707) snapshots end-of-round, later rounds visit only functions whose hash changed (`dirty`). `MODULE_SCOPE` (10868): stripmut, globals, guardRefine, macro, spec, inlineOnce, dedupe, dedupTypes, packData, treeshake, minifyImports, reorder, unbranch, rettail.

PASSES order in a round (10510): stripmut, globals, fold/identity/peephole/strength/bool (fused `simplify`), narrow, guardRefine, unclamp, intguard, branch, zeroinit, ifset, propagate, merge, chainTable, seltree, macro, spec, dedupe, inlineOnce, offset, unbranch, loopify, brif, tailmerge, rettail, foldarms, deadcode, vacuum, mergeBlocks, coalesce, locals, dedupTypes, packData, treeshake ...

### 3.2 Inputs besides the function node [V]

| input | who reads it | scope |
|---|---|---|
| `opts.constF64` (immutable f64 const globals, `constF64Globals` 1691) | `intguard` (1705); per-function pass | module fact; refreshed each round; if its size grows `dirty = null` (10920) |
| `CALLFX` (callee effect summary: `wMem rMem wGlob rGlob unknown`, transitive; computed once at entry from the *pre-round* module, "stale stays sound") | `propagate` via `callFx` (3860 `readsCallableState`, 4701 `sinkSets`); `valueNumber`/`schedule` via `callKinds`; `cse` (5133, 5303) | `propagate` is the most expensive per-function pass and reads callee effects: it is **not** a function of the fn alone |
| `opts.pure` (caller-vouched pure callees) | `valueNumber`, `schedule` only (pre-rounds) | module list (jz: `pureKernel(name)`, `watr-tail.js:704`) |
| `opts.pin` | `inlineOnce`, `inline`, `inlineWrappers`, `dedupe`, `macro` | module-scope only |
| callee result sigs `sigT`, type table `typeDefs`, global decls | `cse` (5195-5203, finish), `devirt` (7019), `globals`/`stripmut`/`constF64` | module-scope or once-after-rounds |
| name counters `ctUid` (2230, chainTable, off by default), `tmUid` (5922, `tailmerge`, a **per-function pass**, default ON; jz's default and speed tiers pass `watrProfile:'speed'` which turns it off, the size tier keeps it), `outUid` (5793, `outline`, module, creates `$__outN` funcs), `inlineUid` (6474, `$__inlN` locals in inline/inlineOnce) | | monotone across the whole compile; reset per compile by `resetNameUids()` from jz `session.js:272`. Label/local names a function gets therefore depend on how many functions were processed before it. `hashNode` canonicalizes local indices but not label names |

So watr's rounds for a function are **not** a function of that function alone: `propagate` needs `CALLFX` entries for its callees; `intguard` needs `constF64`; `tailmerge` (size tier) names depend on a global counter; and module-scope passes rewrite bodies across functions.

### 3.3 Module-scope passes that change a helper body [V code read, I that these fire on specific helpers]

| pass | when it changes a helper |
|---|---|
| `stripmut` (8632), `globals` (8263) | a never-written mutable global becomes immutable; every read of an immutable const-init global is replaced by the constant when `refs*constSize <= refs*2 + declSize` (counts reads module-wide). jz declares data-layout offsets as immutable const i32 globals (`injectTable` -> `declGlobal(global,'i32',base,{mut:false})`, `stdlib-pull.js:~330`), so a helper reading a table gets a compile-specific offset folded in. |
| `macro` (`inlineMacro` 5433) | callee is a single-expression function: expanded at all call sites (changes callers) |
| `spec` (`specializeParams` 5529) | a param every call site passes the same constant is dropped, from callee and all callers: depends on all callers in the module |
| `dedupe` (8841) | identical functions merge; callers' targets renamed |
| `inlineOnce` (7382) | single-caller callee is spliced into its caller; the caller count is module-wide; pinned by export/start/elem/ref.func/`opts.pin` |
| `inline`, `inlineWrappers` (speed) | tiny / wrapper callees duplicated into callers |
| `guardRefine` (2531) | listed as module-scope but loops over functions calling `refineGuards(fn)`/`foldStrProbes(fn)`: per function in effect, not dirty-gated |
| `treeshake`, `dedupTypes`, `packData`, `rettail`, `unbranch`, `reorder`, `minifyImports` | do not change a surviving helper's body (except `unbranch`/`rettail` read module func facts) |
| `finish`: `devirt`, `licm`, `lsr`, `cse`, `poolConstants`, `outline` | whole-module, once; `poolConstants`/`outline` create or share module-level globals/functions |

**Empirical check of the consequence [V, `final.mjs`]**: final (post-watr) helper text across 6 programs: default 19 of 46 helper names byte-identical in all programs that contain them, speed 26 of 41. Differences seen: `$__alloc` 5 variants in 6 programs (e.g. `(global.get $__fc0)` vs `(global.get $__fc10)`: pooled float-constant global names from jz's `poolFloatConstants`, a post-watr module-wide pass), `$__start`, `$__mkptr`, gc kernels, `$__ryu_pow5`. **A memo of post-watr helper bodies is not sound without canonicalizing or excluding module-wide naming/pooling/inlining.** A memo of what happens before watr's module-scope passes (jz `optimizeFunc`, section 1) is.

### 3.4 Can a caller tell watr "these are at a fixpoint"? [V]

No. No `settled`/`skip`/`only`/`funcs`/`dirty` option exists (the whole option list: `constF64`, `pure`, `pin`, `propagate`, `inline`, `tolerance`, `log`, `cse`, `trim`, `regionMark/regionExit`, `profile`, `locals`, `inlineOnce`, `coalesce`, `guard`, per-pass booleans). `dirty`, `snapshots` are closure locals of `optimizeModule`.

Minimal API (inferred design, not built):
- `opts.settled: Map<funcNode, hash>` or `Set<funcNode>` of function nodes the caller vouches are at the per-function fixpoint **for this options set**. In `optimizeModule`, after computing `snapshots`, pre-seed `snapshots.set(f, hashNode(f))` and `dirty = new Set(allFuncs minus settled)`, so round 1's per-function passes skip them. Module-scope passes still run on everything and re-dirty a settled function by the existing hash compare.
- Needed to make it effective: apply the same filter to the pre-round whole-module passes (`deadset`, `lazySelect`, `valueNumber`, `schedule`, `nanFoldNode` walk) and to `finish` (`licm`, `lsr`, `cse`, `poolConstants`, `outline`, `sortLocals`); today they scan every function regardless of `dirty`.
- Needed for soundness: the vouching key must cover the `CALLFX` entries of the function's callees and `constF64` (3.2); and `tmUid/inlineUid` naming should be made per-function (or labels canonicalized) so a replayed body does not collide with names minted later.
- Cheaper alternative with no watr change: a jz-side pre-pass that runs watr's *exported* per-function passes (`propagate`, `fold`, `vacuum`, `coalesceLocals`, ... exported at `optimize.js:11089`) on each helper before module assembly, memoized. Not equivalent to the round loop and not verified.

### 3.5 How jz calls watr: `watrTail` (`src/optimize/watr-tail.js:678`) in order [V]

Before watr's own rounds (on the assembled WAT-array module, `module` after the tape link):
1. `legalizeForTarget` (WASI/JS-host init entry rewrite)
2. `shareSplitSlots` per function (`cfg.splitBindings`)
3. `resolveWatrOpts` (builds watr options; `pure` list from `pureKernel`; `pin` = SIMD_PINNED, LANE_PINS, OUT_OF_LINE + `programPins`)
4. `foldWrappedWords`
5. `narrowBoxedLocals` per function
6. `hoistStillLoads` (speed)

watr:
7. `watOptimize(legalized, watrOpts)` (the fixpoint, once), or `watCleanup` (`conditions`, `propagate`, `mergeLocals`, `bool`, `vacuum`, `mergeBlocks`, `coalesceLocals`, `localReuse`, `poolConstants`) when `cfg.watr` is off

After watr (all whole-module, each over every function):
8. `hoistGlobalPtrOffset` (+ `collectReachableGlobalWrites`) 9. `guardToInt32` 10. `foldWrappedWords` (2nd) 11. `narrowFlagLocals` 12. `forwardCheckedElements` 13. `stripDeadLateData` 14. `unrollTrips` 15. `ringLaps` 16. `pointerExits` 17. `jumpPointers` 18. `leadChains` 19. `issueOrder` 20. `maskOperands` 21. `truncChoice` 22. `selectArms` 23. `shareQuotients` 24. `foldTestedChoices` 25. `selectBits` 26. `searchLoops` 27. `leadGathers` 28. `carryStores` 29. `skipLatches` 30. `guardExtremes` 31. `pairTests` 32. `inlineTiny` 33. `unsignedDivision` 34. `constBases` 35. `poolFloatConstants` 36. `loopPasses` 37. `splitFuncs` 38. `relaxExtremes` 39. `hoistVectorConsts`

So 6 steps before, 1 watr call (or 9 cleanup calls when `cfg.watr` is off), 32 steps after (39 distinct steps, `foldWrappedWords` appears twice). About 20 of the 32 post-watr steps are gated `cfg.x === true` (speed tier or explicit opt-in); the rest (`hoistGlobalPtrOffset`, `forwardCheckedElements`, `truncChoice`, `selectArms`, `shareQuotients`, `unsignedDivision`, `constBases`, `stripDeadLateData`, `narrowFlagLocals`) run at the default tier too. Each re-walks the whole module including helpers, so memoizing watr alone does not remove their cost. I count 39, not the ~29 in the brief.

Pipeline order overall [V]: `compile` (emit, `pullStdlib`, `optimizeModule` -> per-function `optimizeFunc` + module passes) -> `link` (tape) -> `watrTail` (`src/compiler.js:340`).

---

## 4. The tape (`src/ir/tape.js`, 258 lines)

**Representation [V].** Seven parallel typed arrays (struct of arrays) in one module-global `T`: `op` (Int32: interned op name id for instructions; negative marker for atoms: STR=-1, NUM=-2, BIG, NULL, UNDEF, BOOL, BYTES), `a` (first child), `next` (next sibling), `ty` (interned result-type id, 0 none), `imm` (Float64 payload for numbers/bool/bigint-index/blob-index), `sym` (interned string id for atoms), `sid` (schema id, -1 none); plus `syms/symId` (intern tables), `bigs`, `blobs`, `locations` (Map node -> sourceLoc). It is **not a linear instruction stream with control columns**: control structure is the s-expression tree itself (a `block`/`if`/`loop` node's children are its statements; `then`/`else` are child nodes), encoded as first-child/next-sibling lists. Operands are children; **immediates and names are atom nodes** (`i32.const` has an `OP_NUM` child, `local.get` a `OP_STR` child whose `sym` id is the local's interned name). No parent pointers (the walker supplies the parent). A tree, not a DAG (`verify` rejects a node reached twice).

**API [V].** Build: `node(op)`, `str`, `sym`, `num`, `bytes`, `intern`, `reserve`, `fromWat(x)` (decode). Edit: `push`, `remove`, `replace`, `insertAfter`, `clone`. Read: `walk(root, fn(id,parent))` (iterative preorder), `text(id)`, `verify(root)`. Decode back: `toWat(id)` (fresh arrays; re-attaches only `.type`, `.schemaSid`, `.sourceLoc`). Hosting: `resetTape`, `tapeColumns/tapeState/restoreTape` (self-host checkpoint).

**Passes that run on it today [V].** All in `link/index.js` `linkPasses` (called from `compile/index.js:113` `link(module, options)`, after `optimizeModule`, before `watrTail`): `fold` (optimize/fold.js), `rotateLoops` (rotate-loops.js, speed), `reduceThrowHelpers`, `arenaRewind` (arena-rewind.js, 1225 lines, the biggest), `treeshake`, `schemaSections`, `releaseSection`, `pruneUnusedThrowRuntime`, `sortLocalsByUse` (only when watr is off), `orderFuncs`, `stripLocalRenameSuffixes`. **None reads `ctx`** (grep over `src/link/*`, `fold.js`, `rotate-loops.js`, `arena-rewind.js`, `sort-locals.js`: no `ctx`); they take an explicit `facts` object built in `compile/index.js` (~line 800-1100). This is the existing instance of the "(IR, facts)" shape (B). `scripts/self.js:438-445` runs the same `linkPasses`. The ~40 optimizeFunc passes, the 24 vectorize files, `optimizeModule`, `forwardHops` etc. are all WAT-array code.

**What a WAT-array pass has to change to run on it [V by reading fold.js/fn.js/rotate-loops.js].**
- `n[0]` -> `T.op[id]` compared to ids interned once per pass (`ops()` in fn.js; symbols reset per compile). Strings atoms -> `T.sym[child]` ids or `text(id)`.
- Children loops -> `for (c = T.a[n]; c !== NONE; c = T.next[c])`; no `n.length`, no index access: `second(n)`/`third(n)` helpers.
- Numeric immediates read through the atom child (`i32Const(id)`), created as `num(k)` then `node(op)` with `T.a[n] = v`.
- Any `node()` can reallocate the columns: re-read `T.op` etc. after allocations (fold.js comment "a node may grow the tape").
- No expando tags beyond `.type`, `.schemaSid`, `.sourceLoc`; `.mem/.saArr/.dvProp/...` are dropped at the `fromWat` boundary (so they must be consumed before link). A pass needing per-node facts keeps a side table keyed by node id or symbol id (fold.js `finiteLocals: Map<symbolId, bool>`).
- Tree-ness: shared subtrees are decoded as copies; passes that duplicate must `clone`.

**How far from "emit builds the tape directly" [V counts, I judgement].** One decode site for the whole module (`link()` -> `fromWat(module)`, `src/link/index.js:48`, plus `fromWat(k)` for kernels in `arena-rewind.js:1223`) and one encode (`toWat`). Everything before link produces WAT arrays: `src/ir/*` constructors (`ir.js` barrel, ~76 importers), emit under `compile/emit/*`, `module/*.js` (WAT text templates parsed by `parseWat`), 40+ optimizeFunc passes (src/optimize is 23.0k lines; only 5 files import the tape: fold, rotate-loops, arena-rewind, sort-locals, fn). Far: it would mean rewriting the constructors and every array pass, not changing the decoder. The header's plan (each ported pass deletes its array version) has ported 4 body passes so far.

**SSA / def-use [V].** Not SSA: locals are mutable wasm locals named by an atom. There is **no persistent def-use index anywhere** (tape or arrays). Each pass rebuilds its own: `writtenLocals`/`buildRefcount` (`ir/control.js:29,109`), `localGetCounts` (`vectorize/access.js:149`), `forEachLocalDef` (`vectorize/node-utils.js:5`), `guardDefinitions` (demand-driven reaching defs, `guard-defs.js`), `liveness.js` (backward liveness), licm's `definitions` map, fold.js `finiteLocals`. About 20 files each re-walk the function. On the tape a one-pass index is cheap because local names are small interned ints (`T.sym` of the atom child): per-symbol arrays of set/tee/get node ids in one preorder walk, O(nodes), invalidated by any edit (no incremental maintenance; no parent pointers, so edits needing a parent need the walk's parent). [I]

---

## 5. Pass registry

- `src/passes.js` (235 lines): `PASS_NAMES` (**132** unique, not 168; plus `TUNING_KEYS` **63** = 195 names), `HOT_PASSES` (6, bitmask `OPTF` in ctx.js). Pure data: names with one-line comments. [V]
- `src/optimize/config.js`: `LEVEL_PRESETS` 0,1,2,3,`fast`,`size`,`speed` (`speed` = L3). A pass is on at a level iff its boolean in the preset object is true; call sites test `cfg.x !== false` (default-on style) or `cfg.x === true` (opt-in/speed style), inconsistently, so a missing key can mean on or off depending on the site. [V]

Counts of `PASS_NAMES` booleans (`levels.mjs`) [V]:

| tier | true | false | other |
|---|---|---|---|
| `false`/0 | 0 | 132 | 0 |
| 1 | 10 | 122 | 0 |
| default (2) | 115 | 16 | 1 (`nestedSmallConstForUnroll: 'auto'`) |
| `speed` (3) | 131 | 1 (`hoistConstantPool`) | 0 |
| `size` | 78 | 54 | 0 |

Speed-only PASS_NAMES (true at speed, false at default), 17: `speculateSchemaBranches guardedToInt32 inlinePtrOffsetFast boolConvertToSelect unswitchStringRepLoop nestedSmallConstForUnroll splitScratch recursionUnroll copySmallStates splitFuncs loopPasses unrollScalarChain selectArmUpdates guardedUpdate typedDecode inlinePush pairIterations`. Plus 35 non-`PASS_NAMES` keys set only in the speed preset (tuning keys: poolFloats selectBits maskOperands searchLoops carryStores sinkStores skipLatches guardExtremes relaxExtremes joinExitTests stillLoads pairTests testedChoices unrollTrips hoistVectorConsts leadGathers pointerExits jumpPointers ringLaps earlyStores leadChains issueOrder jamItems arrayMinCap reduceUnroll relaxedFloat relaxedSimd inlineFns inlineTiny rotateLoops watrLicm watrLsr watrGuard carryKeys wordTruncation, watrProfile), i.e. many post-watr passes and the loop-shape passes are speed-only. `size` turns 37 default-on passes off.

**Dependency/order metadata: none in jz. [V]** Order is only the call sequence in `optimize/driver.js` (comments name the constraints: "structural hoists before the fused walk", "devirt before value numbering"), `wat/assemble/optimize-module.js` (module phases), `optimize/watr-tail.js` (39 hand-ordered calls, each preceded by a comment stating what it must follow), `compile/plan/index.js` (31 `t('name', ...)` calls, hand order), `compile/analyze-for-emit.js`. watr is the only place with a table: `PASSES = [key, fn, defaultOn, doc]` whose array order is execution order, plus `MODULE_SCOPE`, `SIMPLIFY_KEYS` and a hard-coded exclusion list for "once" passes in the dispatch loop (10910-10930); ordering constraints are comments ("ORDER IS LOAD-BEARING"). There is no machine-readable `requires/after/invalidates`.

---

## 6. ctx

Whole repo for scale [V]: 7,896 `ctx.<field>` references in 269 files (`src`, `module`, root js), matching the user's 7,900/272 (includes locals named `ctx`: `liftCtx` in vectorize, a parameter in split-funcs.js/early-stores.js). Inside the two requested directories, counting only files that import the singleton and excluding import lines and comments (`src/optimize`: 74 refs, 38 paths; `src/compile/plan`: 406 refs, 59 paths). Caveat: plan files that receive `ctx` as a parameter (e.g. `releaseLiftedAddressTakenNames(ctx, ...)`) or mutate records by reference (`func.sig = ...`) are not counted. Writes are direct-path writes only.

Top 25 combined (refs; W = direct write sites; stage-relative read/write):

| # | path | refs (opt+plan) | W | read-only in this stage? |
|---|---|---|---|---|
| 1 | `ctx.funcs.list` | 70 (1+69) | 1 (`plan/scope.js:1019`) | read-only in optimize; plan appends once |
| 2 | `ctx.transform.optimize` | 40 (0+40) | 0 | read-only (the config) |
| 3 | `ctx.scope.globals` | 42 (4+38) | 0 | read-only here (`declGlobal` writes via helper: devirt.js:199, optimize-module.js:183-185) |
| 4 | `ctx.summary.at` | 34 (0+34) | 0 | read-only (`ctx.summary` itself is assigned 13x in `plan/index.js:161-170`) |
| 5 | `ctx.module.moduleInits` | 28 | 0 | read-only |
| 6 | `ctx.funcs.map` | 26 (3+23) | 1 (`plan/scope.js:1020`) | read-only in optimize |
| 7 | `ctx.funcs.names` | 20 | 0 | read-only |
| 8 | `ctx.summary` | 16 | 13 | **written** (plan/index.js: builds the summary) |
| 9 | `ctx.scope.userGlobals` | 12 | 0 | read-only |
| 10 | `ctx.scope.consts` | 11 | 0 | read-only |
| 11 | `ctx.core.includes` | 8 (opt) | 0 | read-only in optimize (devirt.js:47,213; watr-tail; quiet-loops) |
| 12 | `ctx.scope.globalValTypes` | 10 | 0 | read-only |
| 13 | `ctx.funcs.exports` | 10 | 0 | read-only |
| 14 | `ctx.schema.vars` | 8 | 3 (`declare-written-keys.js:266`, `declare-unseen-keys.js:134`, `scope.js:193`) | written by plan |
| 15 | `ctx.scope.globalTypedElem` | 8 | 2 (`scope.js:167,189`) | written by plan |
| 16 | `ctx.scope.constInts` | 7 | 0 | read-only |
| 17 | `ctx.schema.register` | 6 | 0 | method call, mutates the schema registry |
| 18 | `ctx.scope.constNums` | 6 | 0 | read-only |
| 19 | `ctx.scope.freshTypedGlobals` | 4 | 1 (plan: `analyzeFreshTypedGlobals`) | read in optimize (licm.js:313,324) |
| 20 | `ctx.schema.list` | 4 | 0 | read-only |
| 21 | `ctx.types.arrResized` / `nameEscapes` | 4 / 4 | 1 / 1 | read in optimize (devirt.js:446,699); written upstream |
| 22 | `ctx.warnings` | 4 | 0 | pushed via `warn()` |
| 23 | `ctx.scope.globalTypedLen` | 3 | 1 | read in optimize |
| 24 | `ctx.plans.loweringLinks` | 3 | 0 here (set in `compile/emit/control-flow.js:1485`) | read-only in optimize |
| 25 | `ctx.plans.quietLoopNodes` | 3 | 1 (`quiet-loops.js:272`) | **written** by optimize |

**ctx fields written by optimization passes [V]** (`optimize/*`, `wat/assemble/optimize-module.js`): `ctx.runtime.icSites` and `ctx.scope.globals` via `declGlobal` (devirt.js:195-199; optimize-module.js:183-185 `__heap`, `__heap_reset`, `__heap_start`); `ctx.scope.dvArmFns` (optimize-module.js:111), `ctx.scope.headerSafeFuncs` (116, 119); `ctx.plans.quietLoopNodes` (quiet-loops.js:272), `ctx.plans.hasCompactLoops` (loop-compact.js:258), `ctx.plans.rewindLoopLabels = null`, `ctx.plans.compactLoopLabels = null` (optimize-module.js:131-132); `ctx.warnings` via `warn()` (vectorize/index.js:335); and the config object's private fields `cfg._pureFuncMap`, `cfg._vectorizedFnNames` (that is `ctx.transform.optimize`). Mutations by reference through node tags/fn props also exist (promoteGlobals writes `fn.presentArrays` etc.). No other direct ctx writes found in optimizeFunc's pass set.

### Distance to (IR, facts) for passes [V/I]

- Already there: `src/link` + the four tape body passes (no `ctx`, take `facts`); `linkAssembled` documents "nothing here reads ctx".
- Very close for **optimizeFunc**: the whole per-function pass set reads `ctx` in only ~17 sites in 7 files (driver.js 4, devirt.js ~20 lines but 1 function's worth, licm.js 4, peephole.js 1-2, vectorize/index.js 3 + dot-slp.js 1, globals.js via parameters). The facts are enumerable (1.4): cfg, 4 bools, `reachableWrites`, `globalTypes`, `headerSafeFuncs`, `freshTypedGlobals`, `staticArrs/constFnArrays/dvArmFns/arrResized/nameEscapes` (devirt/fold), `schema` registry (devirt), `loweringLinks` (identity-keyed WeakMap), and one writer (`icSites`+`declGlobal`).
- Far for everything that runs *before* it (emit, plan, summary): 7.9k refs. And `watrTail` is not yet pure: line 763 reads `ctx.funcs.map` (`user` predicate), `programPins` reads ctx (called from `tailFacts`, so outside).

---

## 7. What I could not determine

- Whether any helper's optimizeFunc output varies with `promoteGlobals`/`headerSafeFuncs` inputs in real programs: my 7 programs x 3 tiers gave 0 counterexamples but never produced a case where the same helper saw different callee-write closures. The extra-input list in 1.4 is derived from code, not observed to matter.
- Exact share of `watOptimize` time spent on helpers vs user code (only inferred from the string program, where user code is 5 functions).
- Bench-corpus coverage of the tracer: `blur`/`biquad` initially failed under an earlier tracer version (proxy identity artifacts), later fine; `jessie`, `watr`, `decode-*` cases not traced (module imports / `var`). Reads on paths those would exercise (e.g. `ctx.summary` via `ir/mem-alias.js` `markElem/markField` at emit) are by static reading only.
- Where `irange` is set (read at `int-range.js:933,1011`, no setter found by grep).
- Whether 168 in the brief refers to another tree: this tree has 132 `PASS_NAMES` (+63 `TUNING_KEYS`).
- Sizes of the stdlib at the cases the user measured (30 to 57 functions): I saw 12-17 optimized functions for `a.push` here and 109 for the string case; I did not reproduce 57.

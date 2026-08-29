# assemble.js map (pipeline-minimality slice)

Inventory of `src/wat/assemble.js` (1,713 lines at branch base `ad4c7022`)
before any split/decomposition. Written first, committed standalone, so a
restart loses no analysis — same discipline as `.work/archive/analyze-traversals.md`
for the analyze.js slice (its module-split section, §4, is the direct
precedent this plan follows).

## 1. Assembly order (from `src/compile/index.js`, the sole real caller)

`compile/index.js` is off-limits to edit this session (owned by another
in-flight session), but reading its call sites (grep, not guessed) gives the
authoritative phase order:

| # | call site (compile/index.js line) | function | sec fields touched |
|---|---|---|---|
| 1 | 2865 | `buildStartFn(ast, sec, closureFuncs, compilePendingClosures)` | writes `sec.start` |
| 2 | 2892 | `syncImports(sec)` | writes `sec.imports` |
| 3 | 2894 | `dedupClosureBodies(closureFuncs, sec)` | rewrites `sec.funcs`, `ctx.closure.table` |
| 4 | 2896 | `finalizeClosureTable(sec)` | writes `sec.types`/`sec.table`/`sec.elem`, ABI-shrinks `sec.funcs` |
| 5 | 2991 | `pullStdlib(sec)` | writes `sec.stdlib`, `sec.extStdlib`, `sec.memory`/`sec.imports`, prunes `ctx.core.includes` |
| 6 | 3050 | `stripStaticDataPrefix(sec)` | rewrites the data segment + every literal pointer offset in `sec.funcs`/`sec.stdlib`/`sec.start` |
| 7 | 3052 | `optimizeModule(sec, profiler, regionHooks)` | mutates `sec.funcs`/`sec.stdlib`/`sec.start` in place (whole-module + per-function optimize) |
| 8 | 3065 | `hoistConstGlobalInits(sec)` | rewrites `sec.start`, may delete the start func/directive entirely |
| 9 | 3086 | `stripDeadLazyTables(sec)` | rewrites the data-segment tail |
| 10 | 3093 | `stripDeadInternedSpans(sec)` | rewrites the data-segment tail |
| 11 | 3430 | `stripLocalRenameSuffixes(sortedFuncs)` | textual local-name cleanup, much later (post section-ordering) |

`clearStdlibParseCache` is NOT part of this per-compile sequence — it is a
warm-instance reset hook called once per compile loop iteration by
`src/session.js`/`scripts/self.js`, outside `compile/index.js` entirely.

## 2. Exported surface and consumers (grep-verified, not guessed)

`compile/index.js:93-98` imports exactly:
`buildStartFn, dedupClosureBodies, finalizeClosureTable, pullStdlib,
syncImports, optimizeModule, stripStaticDataPrefix, hoistConstGlobalInits,
stripDeadLazyTables, stripDeadInternedSpans, stripLocalRenameSuffixes,
stdlibParseCacheMap, setStdlibParseCacheMap`.

`clearStdlibParseCache` is imported by `src/session.js:20` and
`scripts/self.js:23` (both outside compile/index.js).

`appendLateStdlib` is exported but its only real caller is internal
(`optimizeModule`, same file, line 1384) — every other file that mentions it
(`test/self-compile.js`) does so only in a comment, not an import. Not dead
(has a live in-file caller) — kept exported for parity with its current
surface, homed with `pullStdlib` (its sibling stdlib-template concern).

`test/invariants.js:444` dynamically `import()`s `dedupClosureBodies`
directly from `'../src/wat/assemble.js'` — the barrel path, so it is
unaffected by an internal module split as long as the barrel keeps
re-exporting the name.

Every other file that mentions "assemble.js" (grep across the repo) does so
only in a comment/doc-string cross-reference, not an import — confirmed by
inspecting every hit (`layout-kinds.js`, `module/core.js`, `module/timer.js`,
`module/function.js`, `src/ctx.js`, `src/optimize/*.js`,
`src/session-views.js`, `test/*.js`). No hidden consumer.

**Dead import found**: `strPoolString` (imported from `../static-data.js`
at the top of the file) has zero real uses anywhere in assemble.js — every
other imported symbol has at least one call site; this one has none (grep-
verified with a clean, unfiltered search). Dropped mechanically: none of the
split files re-import it.

## 3. Function inventory, in file order, with true dependency edges

Traced by direct read (not grep alone — grep with a line-range filter
mis-hid several early-file usages during a first pass; every edge below was
re-confirmed by re-reading the exact source lines).

| lines | name | exported? | calls (in-file) | needs (imports) |
|---|---|---|---|---|
| 27-52 | stdlib parse cache (`stdlibParseCache`, `cloneTemplate`, `parseTemplate`, `clearStdlibParseCache`, `stdlibParseCacheMap`, `setStdlibParseCacheMap`) | 3 of 6 | — | `parseWat` |
| 70-80 | `heapUsesMem`/`heapGetIR`/`heapSetIR` | no | — | `assembleView`, `HEAP` |
| 82-86 | `ARENA_SAFE_CALLS` | no | — | — |
| 88-150 | `applyArenaRewind` | no | `heapGetIR`/`heapSetIR` (local) | `ctx`, `VAL`, `findBodyStart`, `walkAst`, `T` |
| 152 | `normalizeEmittedIR` | no | — | — |
| 156-159 | `seedStartGeneratedLocals` | no | — | `analyzeBody`, `T`, `ctx` |
| 162-202 | `analyzeStartForEmit` | no | `seedStartGeneratedLocals`(no, only buildStartFn calls it) | `enterActiveFunction`, `restoreActiveFunction`, `ctx`, `findMutations`, `analyzeValTypes`, `mintTypedStoragePlan`, `representationProgramHasBigint`, `mintRepresentationPlan`, `publishPreparedFunctionPlan`, `T` |
| 204-467 | `buildStartFn` | **yes** | `analyzeStartForEmit`, `seedStartGeneratedLocals`, `normalizeEmittedIR` (local) | + `functionPlanOf`, `enterPreparedFunction`, `assertCtxInvariants`, `emit`, `emitVoid`, `inc`, `dataLen`, `staticArrayPtr`, `extractF64Bits`, `asF64`, `declGlobal`, `PTR`, `mkPtrIR`, `strPoolLen`, `retireFunctionPlan`, `restoreActiveFunction` |
| 481-513 | `hoistConstGlobalInits` | **yes** | — | `ctx`, `walkAst`, `findBodyStart` |
| 523-535 | dedup helpers (`dedupIsSentinel`, `mix`, `mixStr`) | no | — | — (module-scope on purpose: self-host closure-capture hazard, see file header comment — do not re-nest into `dedupClosureBodies`) |
| 537-644 | `dedupClosureBodies` | **yes** | dedup helpers (local) | `walkAst`, `ctx` |
| 649-763 | `finalizeClosureTable` | **yes** | — | `some`, `walkAst`, `ctx`, `resolveIncludes`, `MAX_CLOSURE_ARITY` |
| 774-805 | `reachableStdlib` | no | — | `ctx`, `walkAst` |
| 812-819 | `LATE_VEC_HELPERS` | no | — | — |
| 825-849 | `appendLateStdlib` | **yes** | `parseTemplate` (local) | `ctx`, `walkAst` |
| 854-1200 | `pullStdlib` | **yes** | `reachableStdlib`, `parseTemplate`/`stdlibStr` (local) | `installHelperCounters`, `resolveIncludes`, `ctx`, `strPoolLen`, `some`, `MEM_OPS`, `dataLen`, `declGlobal`, `inc`, `walkAst`, `dataAlign`, `dataPush`, `err`, `findBodyStart`, `instrumentHelperCounter` |
| 1202-1206 | `syncImports` | **yes** | — | `ctx` |
| 1221-1249 | `isDigit`, `stripRenameRuns` | no | `isDigit` (local) | `T` |
| 1251-1272 | `stripLocalRenameSuffixes` | **yes** | `stripRenameRuns` (local) | `walkAst` |
| 1274-1431 | `optimizeModule` | **yes** | `appendLateStdlib` (cross-seam), `applyArenaRewind` (local) | `ctx`, `parseWat`, `specializeMkptr`, `collectVolatileGlobals`, `collectReachableGlobalWrites`, `hoistGlobalPtrOffset`, `stablePtrGlobalNames`, `hoistLoopGlobalPtrOffset`, `buildPureFuncMap`, `walkAst`, `inlinePureFnsInFn`, `optimizeFunc`, `hasIROp`, `collectReachableMemoryWrites`, `hoistStableGlobalConstLoads`, `guardMaskedVectorSuffix`, `arenaRewindModule`, `hoistConstantPool`, `declGlobal`, `dataLen` |
| 1450-1506 | `stripDeadLazyTables` | **yes** | — | `ctx`, `walkAst`, `dataReset`, `dataString`, `dataAlign`, `dataLen`, `dataPush` |
| 1543-1579 | `stripDeadInternedSpans` | **yes** | — | `ctx`, `walkAst`, `dataLen`, `dataReset`, `dataString` |
| 1584-1713 | `stripStaticDataPrefix` | **yes** | — | `ctx`, `PTR`, `LAYOUT`, `dataString`, `declGlobal`, `dataReset`, `i64Hex` |

**Exactly one cross-seam call edge in the whole file**: `optimizeModule` →
`appendLateStdlib` (late-vectorizer stdlib top-up). Every other function
group is fully self-contained — no other function in the file calls into a
different group. This makes the split a clean DAG, not a cycle: one new
module (`optimize-module.js`) imports one named export from another
(`stdlib-pull.js`); nothing imports back.

## 4. Module split plan (pure moves, step 2) — same barrel pattern as analyze.js

`src/wat/assemble.js` becomes a **stable barrel** (re-exports only, no
logic) — every current external import path (`from '../wat/assemble.js'` in
compile/index.js, session.js, scripts/self.js; the dynamic `import()` in
test/invariants.js) keeps working unchanged. Real content moves into
`src/wat/assemble/`:

| new file | contents (current line ranges) | rationale |
|---|---|---|
| `assemble/closure-table.js` | dedup helpers + `dedupClosureBodies` (523-644), `finalizeClosureTable` (649-763) | both are the "closure funcs section" phases, adjacent in call order (dedup → finalize, compile/index.js:2894-2896) |
| `assemble/static-data.js` | `stripDeadLazyTables` (1450-1506), `stripDeadInternedSpans` (1543-1579), `stripStaticDataPrefix` (1584-1713) | all three are data-segment-tail lifecycle phases (inject-time over-approximation → exact-reachability reclaim); none calls another in this group but all share the same `dataString`/`dataReset`/`dataAlign`/`dataPush` substrate |
| `assemble/rename-locals.js` | `isDigit`/`stripRenameRuns` (1221-1249), `stripLocalRenameSuffixes` (1251-1272) | standalone late-stage (compile/index.js:3430) WAT-display-name cleanup, unrelated to every other group |
| `assemble/start-fn.js` | `normalizeEmittedIR` (152), `seedStartGeneratedLocals` (156-159), `analyzeStartForEmit` (162-202), `buildStartFn` (204-467), `hoistConstGlobalInits` (481-513) | everything that builds or later simplifies the synthetic `$__start` function |
| `assemble/stdlib-pull.js` | parse-cache block (27-52), `reachableStdlib` (774-805), `LATE_VEC_HELPERS`+`appendLateStdlib` (807-849), `pullStdlib` (854-1200), `syncImports` (1202-1206) | stdlib-template realization + reachability + the memory/import decisions that ride on it |
| `assemble/optimize-module.js` | heap helpers + `ARENA_SAFE_CALLS` (70-86), `applyArenaRewind` (88-150), `optimizeModule` (1274-1431) | the whole-module optimize orchestration; imports `appendLateStdlib` from `./stdlib-pull.js` (the one real cross-seam edge, §3) |

`assemble.js` (barrel): re-exports every current export, verbatim names,
from the six files above — nothing else. Per-file imports are trimmed to
what each file actually calls (§3's "needs" column) — this mechanically
drops the dead `strPoolString` import (§2) since no split file calls it.

## 5. Outliers named in the task — decomposition candidates (step 3, after the moves)

- **`pullStdlib`** (347 lines) — candidate seams inside it, to re-examine
  once it has its own file: the `injectTable` closure (EL/Ryū/pow-transcend
  tables — 3 near-identical call sites), and the large `needsAlloc &&
  needsMemory` block's "collect `runtimeWritten` names then decide
  `resets`/`globalRestores`" shape, which has 4 structurally-repeated
  `if (ctx.core.includes.has(X)) { inc(Y); resets.push(...) }` guards
  (`__durable_fwd_log`/`__durable_arr_snap`/`__durable_slot_log` + the
  `__dyn_set` block) — a repeated-guard-block fusion candidate per the task
  brief, to confirm is genuinely identical in intent (not just shape) before
  touching.
- **`buildStartFn`** (264 lines) — candidate seams: the `boxInit` block, the
  `needsSchemaTbl` block (itself ~80 lines with a static/dynamic fork), the
  `strPoolInit`/`typeofInit`/`closureEnvInit` blocks — each builds one
  independent IR list later spliced into the start func in a fixed order;
  order of the *pushes into `startFn`* (line ~452) is part of the byte-
  identity contract (the oracle/kernel-parity gate), so any split must keep
  that push order textually identical, only moving the *construction* of
  each list into a named helper.
- **`stripStaticDataPrefix`**'s `shift()` closure — already bounded
  (`prefix <= off < buf.length`) this session per `.work/archive/region-release-
  notes.md`'s Group-1 fix (`ae5dc024`); pinned by `test/pointers.js`. Not a
  decomposition target — a correctness-critical closure, touched only if a
  real duplicate-shape seam appears against `finalizeClosureTable`'s ABI-
  shrink `rewriteCalls` (both are "walk every func, pattern-match a specific
  op shape, mutate in place" — but the shapes they match are unrelated, so
  likely NOT a fusable pair; re-examine after the move, not before).
- **`finalizeClosureTable`** — already lean and heavily doc-commented with
  hard-won invariants (`.work/archive/region-release-notes.md`'s Class-1 sessions);
  not named as an outlier by the task brief. No decomposition planned unless
  the move itself surfaces a seam.

Decomposition is step 3, done AFTER the moves land (this doc is written
before step 2 starts, per the task's own ordering) — actual outcomes
(decomposed / declined, with reasons) go in the final session report, not
here, so this map doesn't go stale mid-execution.

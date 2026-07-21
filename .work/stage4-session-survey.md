# Stage 4 opening survey — session + final-optimizer ground truth (2026-07-21)

## ctx importer census
60 production importers (34 src/, 25 module//jzify//root; plan's "61" ≈ right).
Sub-objects: core module scope func types schema closure runtime memory error
transform abi bridge features. Heaviest: emit.js (361 refs, func R/W owner),
compile/index.js (283), prepare/index.js (259 — heaviest scope/module WRITER),
assemble.js (187), module/collection.js (170 — 104 are load-time
ctx.core.emit[]= registrations; same pattern date.js/typedarray.js/array.js/
core.js: the module/ tier's ctx.core writes are almost all REGISTRY installs,
not phase state). module/function.js INSTALLS ctx.closure wholesale (the
capability-hook pattern).
PRECEDENTS already in-tree for phase-scoped views:
- vectorize.js: 164/166 ctx refs are a LOCAL shadow ctx (per-call
  vectorization context) — only 2 touch the global.
- narrow.js narrowSignatures: explicit save/restore swap of
  ctx.func.{localReps,locals,current} per function.

## Phase sequence (as executed)
compile(): foldAggregates → plan → analyzeFuncs → structInline → unionInline
→ unionClones → emitFuncs → emitClosures → buildStart → resolveDynFnTables
→ syncImports/dedup/finalizeClosureTable/internTable → pullStdlib →
optimizeModule → globals/data/schema sections.
assemble.js optimizeModule(): specializeMkptr → volatileGlobals →
reachableWrites → hoistGlobalPtr → hoistLoopGlobalPtr → inlinePureFns
(gated) → optimizeFuncs → hoistGlobalConstLoads (wraps
hoistStableGlobalConstLoads + guardMaskedVectorSuffix) → appendLateStdlib →
arenaRewind → hoistConstantPool → heap decls.

## Post-watr rewrites (THE Stage-4 migration item)
Final watr = watOptimize at index.js:766 ("sole final optimizer, once").
hoistGlobalPtrOffset / hoistStableGlobalConstLoads / guardMaskedVectorSuffix
(defined src/optimize/index.js:2168/2433/2557) run TWICE: pre-watr in
optimizeModule AND post-watr at index.js:770-790 ("narrow idempotent
fail-closed proof repairs"). index.js:24-25 already names them "phase-2
watr-migration candidates". snapshotInit (src/snapshot.js) runs at
index.js:799 after the repairs, before print/compile — Stage 4 moves it
earlier, grouped with the repairs.
audit:fixpoint = scripts/audit-fixpoint.mjs: re-runs watr/optimize on
finished output, asserts loop-body op-count idempotence over 10 kernels
(NEUTRAL brif filtering). NOT currently a battery/CI gate.

## Target legalization
No target enum. Only ctx.transform.host 'js'|'wasi' (validated index.js:549).
wasi branch sites: index.js:678, compile/index.js:2100/2347 (command-mode
export shaping), emit.js:2963/3003/5033, emit-assign.js:510/858/880,
narrow.js:2021, assemble.js:348/479, module/{timer,console,fs,crypto,
navigator,math,web,core}.js syscall selection. noTailCall (ctx.js:467) is
the ONE wasm2c-shaped hook (generic option, not target-keyed).
Native lane = external script chain (scripts/native/build.sh: wasm-opt →
wasm2c --enable-exceptions → clang -O3 -flto PGO; guard-page/mmap flags =
the profile's "guard-page assumptions"; -fno-exceptions = "no-EH").
Stage-4 choice: (a) formalize target enum gating EH/guard/trap choices, or
(b) keep the lane external but feed it a session-derived profile instead of
ad hoc env vars.

## Increment order (chosen)
1. audit:fixpoint as a battery leg (hard-fail on hot-loop delta) — small,
   dbg-leg pattern.
2. Post-watr rewrite migration: move the three repairs + snapshotInit before
   the final watr run (or watr plugins) — kills the double-run; index.js's
   "no post-watr pass" claim becomes literally true.
3. CompileSession: mechanical extraction AFTER 1-2; start from the two
   in-tree precedents (vectorize local ctx, narrow save/restore); the
   module/ tier's ctx.core registry installs are load-time and stay.
4. Target profiles: host enum grows 'wasm2c'|'wasmtime' rows gating the
   existing branch sites + noTailCall; native lane consumes the profile.

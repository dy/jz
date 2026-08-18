/**
 * Phase-view facades (see .work/session-survey.md). Plain, read-only
 * destructured views over the subtrees ctx.js's own header table (lines
 * 34-48) and the survey's §2 already document as phase-disciplined:
 * `features`, `abi`, `bridge`, `memory`, `linkDemand` (upgraded to
 * disciplined by slice (b)'s setLinkDemand() tripwire), `inspect`,
 * `warnings`. `error` gets no view here — its only reader is ctx.js's own
 * err() (internal); nothing outside ctx.js ever reads ctx.error as data, so
 * there is no external read contract to make structural.
 *
 * SUBSET-SAFE BY CONSTRUCTION (survey §4, ABSOLUTE): built with ctx.js's own
 * `derive()` (Object.create(null) + assign) — never a Proxy (jz registers no
 * Proxy global at all, in any module/*.js) and never a getter/accessor (the
 * parser has no path recognizing accessor syntax). This file sits in the
 * self-compiled kernel's own module graph — two adopters below
 * (optimize/vectorize.js, src/wat/assemble.js) are reachable from
 * scripts/self.js — so it is compiled THROUGH jz, not merely run by it.
 *
 * Construct FRESH at every call site, never memoize across a reset(): ctx.abi
 * and ctx.bridge are REPLACED (new object identity), not mutated in place,
 * by every reset() (ctx.js: `ctx.abi = makeAbi()`, `ctx.bridge = bridge`) —
 * a view snapshot taken once at module load would read a stale, pre-reset
 * object for the rest of the process.
 *
 * READ-ONLY: nothing here mutates a subtree. Writes keep their existing path
 * — setFeature()/setLinkDemand() where a tripwire exists, plain assignment
 * where the subtree is already write-once-at-reset or single-owner (abi,
 * bridge, memory, inspect, warnings — survey §2).
 *
 * ADOPTION is selective, not mechanical (see call sites below and
 * .work/todo.md for the left-on-ctx list with reasons). In particular,
 * `abi`/`bridge`'s REAL external readers (ir.js, compile/emit.js,
 * compile/emit-assign.js, module/*.js's emit handlers, optimize/index.js's
 * peephole fold) all run once per AST/IR node — sometimes thousands of times
 * per compile. `derive()` allocates a fresh object per call, so wrapping
 * those sites would add real per-node allocation to the hottest part of the
 * compiler for zero behavioral gain. `emitView()` below is still defined: it
 * documents the real read contract even with zero adopted call sites today,
 * the same way ctx.js's own header table documents contracts nothing
 * enforces — a future non-hot-path consumer (or a hot one, once the
 * allocation is proven to not matter) has a real facade to adopt.
 */
import { ctx, derive, DBG_INVARIANTS } from './ctx.js'

/** Coarse mid-compile check: `ctx.transform.sessionPhase` only tracks the
 *  three top-level phases (post-reset/post-prepare/post-compile —
 *  PHASE_ORDER in ctx.js), not the finer post-analyze/pre-assemble
 *  checkpoints (those live behind ctx.js-private flags, not exported) — so
 *  this is the coarsest correct assertion available outside ctx.js: emit,
 *  assemble, and the optimizer all run strictly between 'post-prepare' and
 *  'post-compile'. Cheap (one property read + string compare); only runs
 *  under JZ_DEBUG_INVARIANTS. */
const assertMidCompile = (view) => {
  if (DBG_INVARIANTS && ctx.transform.sessionPhase !== 'post-prepare')
    throw new Error(`[session-view] ${view}: constructed outside the compile window (ctx.transform.sessionPhase='${ctx.transform.sessionPhase}', expected 'post-prepare')`)
}

/** emit-phase read view (ctx.js table: abi readers "ir.js codegen,
 *  optimizer"; bridge readers "bridge.js → emit, modules"; features readers
 *  "compile, optimizer, stdlib factories"). Zero adopted call sites today —
 *  see the file doc above; kept as the documented contract for
 *  ir.js/compile/emit*.js/module/*.js's emit handlers, none of which are
 *  cheap to wrap per-call. */
export function emitView() {
  if (DBG_INVARIANTS) assertMidCompile('emitView')
  return derive({ abi: ctx.abi, bridge: ctx.bridge, features: ctx.features })
}

/** assemble+-phase read view (ctx.js table: linkDemand readers
 *  "resolveIncludes()+, assemble"; memory readers "compile", concretely
 *  wat/assemble.js's own memory-layout reads). Adopted: optimize/vectorize.js's
 *  SLP store-pairing bail (runs inside optimizeModule, itself proven — per
 *  ctx.linkDemand's own doc in ctx.js — to run after pre-assemble, once per
 *  function, not per node) and wat/assemble.js's heapUsesMem()/heapGetIR()/
 *  heapSetIR() (module-init save/restore helpers, called a handful of times
 *  per compile). */
export function assembleView() {
  if (DBG_INVARIANTS) assertMidCompile('assembleView')
  return derive({ memory: ctx.memory, linkDemand: ctx.linkDemand })
}

/** Advisory-sink read view: ctx.warnings's own doc — write-only via
 *  initWarnings()/warn()/warnDeopt(), read externally only as a presence
 *  guard ("is a warnings sink installed at all") at scattered call sites
 *  (plan/advise.js, plan/scope.js, compile/narrow.js). Those sites span
 *  plan through narrow — not one of the pipeline's big phases — so this
 *  stands alone rather than folding into emitView/assembleView, and gets no
 *  phase assertion (no single sessionPhase value covers all its readers). */
export function warningsView() {
  return derive({ warnings: ctx.warnings })
}

/** Inspection-sink read view: ctx.inspect's own doc — populated by
 *  compile/index.js only when transform.inspect is set, read externally only
 *  by the host boundary (index.js, after compile() returns the wat/wasm). No
 *  phase assertion for the same reason as warningsView — its one adopted
 *  reader runs post-compile, outside the mid-compile window entirely. */
export function inspectView() {
  return derive({ inspect: ctx.inspect })
}

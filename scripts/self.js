/**
 * self.js — the jz compiler packaged as a single `source → wasm bytes` function,
 * the exact form compiled to wasm for self-hosting. `npm run build` compiles THIS
 * to dist/jz.wasm; the resulting module's `default(source)` is jz, compiled by jz.
 *
 * It bundles the whole pipeline — parse (jessie) → jzify → prepare → compile →
 * watr-encode — so the wasm takes a source string and returns wasm bytes with no
 * host help. index.js's host-facing `compile()` wraps the same pipeline with
 * imports/memory/profiling/interop, none of which the self-host wasm needs (or can
 * run); this is why the self-host entry is its own minimal, interop-free module and
 * lives in the build layer rather than in the sealed compiler source.
 */
import { parse } from '../src/parse.js'
import { compile as watrCompile } from 'watr'
import watrPrint from 'watr/print'
import { ctx, reset, initWarnings } from '../src/ctx.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import { frontHalf } from '../src/front.js'
import { beginSession } from '../src/session.js'
import compileAst from '../src/compile/index.js'
import { resetProgramFactsCache } from '../src/compile/program-facts.js'
import { clearDollar } from '../src/ir.js'
import { clearStdlibParseCache } from '../src/wat/assemble.js'
import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads, emitIdentitySafe,
} from '../src/compile/emit.js'
import { resolveOptimize } from '../src/optimize/index.js'
import { watrTail } from '../src/optimize/watr-tail.js'
import jzify from '../jzify/index.js'

// Final-optimizer tail: the EXACT module index.js's host pipeline uses
// (src/optimize/watr-tail.js — watr options + watr once + the one post-watr
// proof repair). Previously a hand-mirrored subset lived here and drifted
// (missing ifset tiering, inlineWrappers, watr LICM, guard policy, the
// large-module unroll2 rule, boundary pins, and the pointer repair), so
// kernel O2/O3 output diverged from native on identical source.
// Region-arena Slice 1 (.work/research.md §Region arena): this file is the ONLY
// caller that supplies watrTail's `regionHooks` — it is NEVER imported/run as
// native JS (npm run build feeds it to jz's OWN compiler as source text, to
// become dist/jz.wasm), so these literal `__region_mark()`/`__region_exit()`
// calls only ever exist as compiled wasm calls (module/core.js's intrinsics),
// never as bare identifiers evaluated by a native JS engine.
// DORMANT (2026-08-06, re-audited same day): a kernel-oracle regression
// surfaced with regions live (kernel traps compiling the dvnested-mechanism
// source at O2/O3). Root-caused in THREE confirmed layers, all fixed in
// module/core.js's __region_copy_rec/__region_exit (a relocated ARRAY's
// off-16 dyn-props sidecar was silently dropped — src/compile/index.js's
// `fn.cseLoadBases = new Set(...)` is exactly the "watr internal array gets
// a dynamic property" case the original scope comment wrongly called
// unreachable; `$__dyn_props`'s own backing table is a global outside
// [ast,dirty,snapshots] and needs the SAME implicit-root treatment
// dirty/snapshots already got; the props-hash's own VALUES need recursive
// relocation, not a verbatim pointer copy). Those three fixes landed and
// fully closed the O2 failure AS OF that session — see the 2026-08-06
// follow-up session below, which found O2 is NOT durably closed.
//
// 2026-08-06 follow-up session (`_eqFast` candidate confirm-or-refute):
// REFUTED cleanly — a `optimize.dbgEqFastOff`-shaped ablation (temp, not
// landed) that disabled JUST node._eqFast's stamp + both its inline arms,
// leaving the rest of fusedRewrite on, left the O3 trap fully reproducing.
// Real O3 mechanism (bisected the same way, one fusedRewrite sub-rewrite at
// a time): fusedRewrite's ptr-helper inline (`$__ptr_type`/`$__ptr_aux`
// call→expression substitution) is JOINTLY necessary — disabling EITHER
// one alone (leaving the other on) already clears the O3 trap; `$__is_null`
// alone does not. Confirmed via a native `--wat` dump that at O3 both
// `$__ptr_type` and `$__ptr_aux` end up with ZERO remaining func defs AND
// zero call sites (every site got inlined) — plausible mechanism: full
// disappearance interacting with watr's OWN per-round `treeshake` pass
// (MODULE_SCOPE, runs every round with regions live) in a way region_exit
// doesn't see, since __region_dbg_stage/rounds instrumentation (temp, not
// landed) confirmed AGAIN this session that __region_exit reaches its own
// final instruction cleanly (rounds=2, stage=4) every time — the trap is
// downstream, same finding as the prior session, just re-verified. NOT a
// dyn-props-sidecar hazard (no property gets stamped by ptr_type/ptr_aux's
// inline — the class named in the design's own inventory does not fit this
// specific mechanism). One fix attempt (pruning `watr`'s `snapshots` Map of
// keys for treeshaken-away funcs, since it never drops a stale key today —
// a real, separately-confirmed leak, independently worth fixing someday but
// NOT reverted-and-kept this session) made kernel-parity O2 fail NEWLY (a
// previously-passing row), so it was reverted — the mental model is
// incomplete, not ready to ship a fix.
//
// SEPARATE, NEWLY DISCOVERED regression this session: kernel-oracle's
// dvnested-mechanism row now ALSO traps at O2 on a fresh rebuild — the PRIOR
// session's "O2 fully green, 4 reps, zero flakes" claim no longer holds.
// Four unrelated "carrier program" commits (00c9abc4/7eeeea36/705a35d9/
// 286626fa, all flag-gated JZ_CARRIER_BOX/JZ_DEBUG_INVARIANTS default OFF,
// claimed byte-identical) landed in the ~90 minutes between that session's
// O2-green verdict and this session's first rebuild. O2's failure is NOT
// deterministic across otherwise-identical rebuilds — adding 5 debug globals
// (pure static-layout noise, unrelated code) to module/core.js made an
// O2 baseline that had JUST failed (identical source, identical debug-flag
// values) pass again, 3/3 repeat. That points at an address/layout-boundary-
// sensitive heisenbug, not a clean single-cause mechanism — CONSISTENT with
// a coverage gap similar to fixes 1-3 above, just not yet caught because it
// only bites at specific allocation offsets. NOT bisected further; time
// did not allow it this session.
//
// Per the stop-on-fail tripwire the hooks stay OFF: O3's real mechanism is
// narrowed but not fixed (2 sub-rewrites confirmed jointly necessary, no
// verified patch), and O2 is a live, unresolved, non-deterministic
// regression the original task framing didn't know about. Re-wire by
// restoring the regionHooks line below (AND flipping REGION_HOOKS_ACTIVE, next);
// the warm checkpoint then gates SHIP.
//
// Explicit region-hooks-active marker (architecture re-audit item 2,
// .work/todo.md) — read as a literal string match by scripts/build-profile.mjs's
// resolveSelfhostBuild, replacing build-dist.mjs's old regex-over-source
// detection (`/^\s*regionHooks:\s*\{/m`). A single-purpose toggle instead of a
// structural guess: TOGGLE THIS *and* the regionHooks line inside optimizeTail
// TOGETHER — both must agree, or resolveSelfhostBuild's derived flag disagrees
// with what optimizeTail actually wires. A caller of resolveSelfhostBuild may
// also override the derivation explicitly via its own `regionArena` profile
// field (see that helper's doc) — this marker is only the DEFAULT-derivation
// source when a caller doesn't override.
export const REGION_HOOKS_ACTIVE = false
function optimizeTail(module, cfg) {
  return watrTail(module, cfg, {
    funcCount: ctx.func.list.length,
    boundaryPins: cfg._vectorizedFnNames?.size
      ? [...cfg._vectorizedFnNames].filter(name => ctx.func.map.get(name.slice(1))?.exported)
      : [],
    targetProfile: ctx.transform.targetProfile,
    // regionHooks: { mark: () => __region_mark(), exit: (mark, root) => __region_exit(mark, root) },
  })
}

// Shared front half of every kernel entry: reset ctx, apply the option JSON,
// parse + lower. `optJSON` is the one options channel across the wasm ABI —
// a JSON string of the host-facing `opts.optimize` value (level number, alias
// string, or per-pass object via resolveOptimize), falsy → optimize off.
// Every entry takes the same (source, strict, optJSON) triple.
//
// clearDollar/clearStdlibParseCache: unlike resetProgramFactsCache (a WeakMap +
// generation counter — stale entries just go unreachable), DOLLAR and
// stdlibParseCache are plain Maps whose keys AND values are built fresh each
// compile. Natively that's inert extra retention across repeated compile() calls
// (real GC heap). In-kernel the arena is a bump allocator that `_clear` rewinds
// between compiles (warm-instance reuse, see bench-selfhost.mjs JZ_BENCH_WARM) —
// a post-`_clear` allocation can overwrite a dangling entry's bytes, so any entry
// surviving a `_clear` is a correctness bug (wrong bytes read back), not just
// waste. Must run every compile (not just after the first `_clear`) since it's
// cheap and callers may `_clear` in any pattern.
function setupSelf(strict, optJSON, modulesJSON, host) {
  // Session lifecycle — the SAME beginSession native setupCtx runs
  // (src/session.js): ctx reset, every cache clear, watr name-uids, warnings,
  // strict/host/optimize normalization, post-reset invariants. Only the wasm-ABI
  // unmarshaling (JSON strings, 0-defaults) and the kernel's transform
  // injections remain here.
  beginSession({
    emitter, globals: GLOBALS,
    hooks: { emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads, emitIdentitySafe },
    optimize: optJSON ? JSON.parse(optJSON) : false,
    strict: !!strict, host: host || undefined,
  })
  ctx.transform.jzify = jzify
  ctx.transform.parse = parse    // module bundling (prepareModule) parses imported sources — same injection native does
  // Bundled-module sources (the native opts.modules channel): one JSON dict
  // over the wasm ABI — prepare's import resolution reads importSources the
  // same way native does.
  if (modulesJSON) ctx.module.importSources = JSON.parse(modulesJSON)
}

// The canonical front half (src/front.js) — the SAME function index.js's
// jzCompileInner runs: parse -> reserved-prefix guard -> liftIIFEs -> jzify ->
// prepare -> preEval. The kernel previously composed prepare(lower(...)) per
// entry WITHOUT preEval, so statically-foldable programs compiled to different
// bits than native (audit P0 2026-07-25: 0.1+0.2-0.3 fold, Math.sqrt(9) at O0).
function front(source, strict) {
  return frontHalf(source, { strict, jzify })
}

/**
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @param {string} [optJSON] - optimize config as JSON (level / alias / per-pass object)
 * @returns {Uint8Array} compiled wasm bytes
 */
export default function compileSelf(source, strict, optJSON, modulesJSON, host) {
  setupSelf(strict, optJSON, modulesJSON, host)
  return watrCompile(optimizeTail(compileAst(front(source, strict)), ctx.transform.optimize))
}

/**
 * WAT-text variant of the self-host pipeline: source → WAT string (watr/print of the
 * same `compileAst(prepare(ast))` tree compileSelf encodes to bytes). Lets the
 * `JZ_TEST_TARGET=jz.wasm` leg satisfy white-box `compile(src,{wat:true}).match(...)`
 * codegen-shape assertions — the self-host produces the same WAT IR as native, so the
 * shape checks validate self-host codegen instead of failing as a feature gap. No
 * watr-level WAT optimization runs (matches optimize:false), mirroring native
 * `compile({wat:true, optimize:false})`.
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @returns {string} WAT text
 */

/**
 * Compile-time advisories variant: runs the same pipeline with the advisory sink
 * enabled and returns the collected warning entries as JSON. The advise passes
 * (plan/advise.js, plan/scope.js, narrow.js) all fire inside compileAst, gated on
 * `ctx.warnings`, so the kernel computes the exact same advisories native does — it
 * just surfaces them through this entry instead of the host's `opts.warnings` sink.
 * Lets the self-host leg satisfy the `warningsFor()` tests faithfully.
 * @returns {string} JSON array of `{ code, message, ... }` entries
 */
export function compileWarnings(source, strict, optJSON, modulesJSON, host) {
  setupSelf(strict, optJSON, modulesJSON, host)
  const sink = { entries: [] }
  initWarnings(sink)
  optimizeTail(compileAst(front(source, strict)), ctx.transform.optimize)
  initWarnings(null)
  return JSON.stringify(sink.entries)
}

export function compileWat(source, strict, optJSON, modulesJSON, host) {
  setupSelf(strict, optJSON, modulesJSON, host)
  return watrPrint(optimizeTail(compileAst(front(source, strict)), ctx.transform.optimize))
}

/**
 * Self-host divergence diagnostics: run the same pipeline with the internal
 * diagnostic sink armed (resolveIncludes + assemble's global-snapshot sweep
 * record what they resolved) and return the records as JSON. Running this
 * HOST-side and KERNEL-side on the same input and diffing the two JSON
 * strings names the first divergent fact behind a host/kernel byte drift —
 * the archaeology channel for the parity work (.work/todo.md, jz.wasm item).
 * @returns {string} JSON of { resolve: [...], sweep: {...} }
 */
/**
 * Per-stage wall-time profile of one kernel compile: front / compileAst /
 * optimizeTail / encode, as a JSON dict of ms. The warm-margin probe channel:
 * run this in-kernel AND mirror the same stages natively (index.js
 * opts.profile), compare SHARES -- the stage whose share is relatively worse
 * in-wasm is the warm-ratio lever (absolute times are machine-speed; shares
 * are the signal). Date.now() lowers to __time_ms in-kernel.
 */
export function compileProfile(source, strict, optJSON, modulesJSON, host) {
  setupSelf(strict, optJSON, modulesJSON, host)
  const t0 = Date.now()
  const ast = front(source, strict)
  const t1 = Date.now()
  const ir = compileAst(ast)
  const t2 = Date.now()
  const opted = optimizeTail(ir, ctx.transform.optimize)
  const t3 = Date.now()
  watrCompile(opted)
  const t4 = Date.now()
  return JSON.stringify({ front: t1 - t0, compileAst: t2 - t1, optimizeTail: t3 - t2, encode: t4 - t3 })
}


export function compileDiag(source, strict, optJSON) {
  setupSelf(strict, optJSON)
  ctx.core.diagSink = {}
  compileAst(front(source, strict))
  return JSON.stringify(ctx.core.diagSink)
}


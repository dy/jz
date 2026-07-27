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
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads,
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
function optimizeTail(module, cfg) {
  return watrTail(module, cfg, {
    funcCount: ctx.func.list.length,
    boundaryPins: cfg._vectorizedFnNames?.size
      ? [...cfg._vectorizedFnNames].filter(name => ctx.func.map.get(name.slice(1))?.exported)
      : [],
    targetProfile: ctx.transform.targetProfile,
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
    hooks: { emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads },
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


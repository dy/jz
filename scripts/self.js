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
import { ctx, reset, initWarnings, optFlagsOf } from '../src/ctx.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import { liftIIFEs } from '../src/prepare/lift-iife.js'
import compileAst from '../src/compile/index.js'
import { resetProgramFactsCache } from '../src/compile/program-facts.js'
import { resetBodyFactsCache } from '../src/compile/analyze.js'
import { resetBindingUsesCache } from '../src/compile/analyze-scans.js'
import { clearDollar } from '../src/ir.js'
import { clearStdlibParseCache } from '../src/wat/assemble.js'
import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads,
} from '../src/compile/emit.js'
import { resolveOptimize } from '../src/optimize/index.js'
import { watrTail } from '../src/optimize/watr-tail.js'
import { resetNameUids } from 'watr/optimize'
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
function setupSelf(strict, optJSON, modulesJSON) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  resetBodyFactsCache()
  resetBindingUsesCache()
  clearDollar()
  clearStdlibParseCache()
  ctx.transform.jzify = jzify
  ctx.transform.parse = parse    // module bundling (prepareModule) parses imported sources — same injection native does
  ctx.transform.optimize = optJSON ? resolveOptimize(JSON.parse(optJSON)) : resolveOptimize(false)
  ctx.transform.optFlags = optFlagsOf(ctx.transform.optimize)
  ctx.transform.strict = !!strict
  // Bundled-module sources (the native opts.modules channel, index.js:450):
  // marshalled as one JSON dict over the wasm ABI — prepare's import
  // resolution reads ctx.module.importSources the same way native does.
  if (modulesJSON) ctx.module.importSources = JSON.parse(modulesJSON)
}
function lower(source, strict) {
  const parsed = liftIIFEs(parse(source))   // mirror index.js: lift IIFEs before jzify
  return strict ? parsed : jzify(parsed)
}

/**
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @param {string} [optJSON] - optimize config as JSON (level / alias / per-pass object)
 * @returns {Uint8Array} compiled wasm bytes
 */
export default function compileSelf(source, strict, optJSON, modulesJSON) {
  setupSelf(strict, optJSON, modulesJSON)
  // Per-compile watr name-uid reset (mirrors index.js's call): the kernel is a
  // long-lived instance compiling many programs — without this, watr's inline/
  // outline counters grow monotonically across compiles and the kernel's text
  // output becomes history-dependent (the warm-drift class, in-wasm edition).
  // Required since watr ^5.7.11 (locked) — see index.js.
  resetNameUids()
  return watrCompile(optimizeTail(compileAst(prepare(lower(source, strict))), ctx.transform.optimize))
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
export function compileWarnings(source, strict, optJSON, modulesJSON) {
  setupSelf(strict, optJSON, modulesJSON)
  const sink = { entries: [] }
  initWarnings(sink)
  optimizeTail(compileAst(prepare(lower(source, strict))), ctx.transform.optimize)
  initWarnings(null)
  return JSON.stringify(sink.entries)
}

export function compileWat(source, strict, optJSON, modulesJSON) {
  setupSelf(strict, optJSON, modulesJSON)
  return watrPrint(optimizeTail(compileAst(prepare(lower(source, strict))), ctx.transform.optimize))
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
export function compileDiag(source, strict, optJSON) {
  setupSelf(strict, optJSON)
  ctx.core.diagSink = {}
  compileAst(prepare(lower(source, strict)))
  return JSON.stringify(ctx.core.diagSink)
}


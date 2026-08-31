/**
 * self.js — the jz compiler packaged as a single `source → wasm bytes` function,
 * the exact form compiled to wasm for self-compiling. `npm run build` compiles THIS
 * to dist/jz.wasm; the resulting module's `default(source)` is jz, compiled by jz.
 *
 * It bundles the whole pipeline — parse (jessie) → jzify → prepare → compile →
 * watr-encode — so the wasm takes a source string and returns wasm bytes with no
 * host help. index.js's host-facing `compile()` wraps the same pipeline with
 * imports/memory/profiling/interop, none of which the self-compile wasm needs (or can
 * run); this is why the self-compile entry is its own minimal, interop-free module and
 * lives in the build layer rather than in the sealed compiler source.
 */
import { parse } from '../src/parse.js'
import { compile as watrCompile } from 'watr'
import watrPrint from 'watr/print'
import { ctx, initWarnings, assertCtxInvariants, DBG_INVARIANTS } from '../src/ctx.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import { frontHalf } from '../src/front.js'
import { beginSession } from '../src/session.js'
import compileAst from '../src/compile/index.js'

import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads, emitIdentitySafe,
} from '../src/compile/emit.js'
import { watrTail } from '../src/optimize/watr-tail.js'
import jzify from '../jzify/index.js'

// Final-optimizer tail shared with the host pipeline. Keep the live compile
// context refinements here; watr option policy remains owned by watr-tail.js.
function optimizeTail(module, cfg) {
  return watrTail(module, cfg, {
    funcCount: ctx.funcs.list.length,
    boundaryPins: [
      ...(cfg._vectorizedFnNames?.size
        ? [...cfg._vectorizedFnNames].filter(name => ctx.funcs.map.get(name.slice(1))?.exported)
        : []),
      ...(ctx.linkDemand.typedRuntime
        ? ['$__typed_idx', '$__typed_set_idx', '$__typed_idx_tagged', '$__typed_set_idx_tagged', '$__arr_typed_set_idx', '$__arr_typed_obj_set_idx']
          .filter(name => ctx.core.includes.has(name.slice(1))) : []),
    ],
    targetProfile: ctx.transform.targetProfile,
    lazyDataSpans: ctx.runtime.lazySpans,
    staticDataSpan: ctx.runtime.staticPrefixSpan,
  })
}

// Shared front half of every kernel entry: reset ctx, apply the option JSON,
// parse + lower. `optJSON` is the one options channel across the wasm ABI —
// a JSON string of the host-facing `opts.optimize` value (level number, alias
// string, or per-pass object via resolveOptimize), falsy → optimize off.
// Every public compile entry also accepts sourceType as its final ABI argument.
//
// clearDollar/clearStdlibParseCache: unlike resetProgramFactsCache (a WeakMap +
// generation counter — stale entries just go unreachable), DOLLAR and
// stdlibParseCache are plain Maps whose keys AND values are built fresh each
// compile. Natively that's inert extra retention across repeated compile() calls
// (real GC heap). In-kernel the arena is a bump allocator that `_clear` rewinds
// between compiles (warm-instance reuse, see bench-self-compile.mjs JZ_BENCH_WARM) —
// a post-`_clear` allocation can overwrite a dangling entry's bytes, so any entry
// surviving a `_clear` is a correctness bug (wrong bytes read back), not just
// waste. Must run every compile (not just after the first `_clear`) since it's
// cheap and callers may `_clear` in any pattern.
function setupSelf(strict, optJSON, modulesJSON, host, buildJSON) {
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
  // reset() already clears the source-graph authority. Populate it only when
  // this compile actually received opts.modules; never inherit the compiler's
  // own build graph into a later user compile.
  if (modulesJSON) ctx.module.importSources = JSON.parse(modulesJSON)
  if (buildJSON) {
    const build = JSON.parse(buildJSON)
    if (typeof build.memory === 'number') ctx.memory.pages = build.memory
    if (build.compactCollections) ctx.transform.compactCollections = true
  }
}

// The canonical front half shared with index.js. preEval must run: omitting it
// changes constant-folded result bits and output shape between host and kernel.
function front(source, strict, sourceType) {
  return frontHalf(source, {
    strict, sourceType: sourceType || 'jz', jzify,
    afterPrepare: DBG_INVARIANTS ? () => assertCtxInvariants('post-prepare') : undefined,
  })
}

function emitIR(ast) {
  const module = compileAst(ast)
  if (DBG_INVARIANTS) assertCtxInvariants('post-compile')
  return module
}

const PARK_NULL = 0
const PARK_UNDEFINED = 1
const PARK_FALSE = 2
const PARK_TRUE = 3
const PARK_NUMBER = 4
const PARK_STRING = 5
const PARK_BIGINT = 6
const PARK_ARRAY = 7
const PARK_OBJECT = 8

function parkValue(value) {
  if (value === null) { __park_write_u8(PARK_NULL); return }
  if (value === undefined) { __park_write_u8(PARK_UNDEFINED); return }
  if (value === false) { __park_write_u8(PARK_FALSE); return }
  if (value === true) { __park_write_u8(PARK_TRUE); return }
  if (typeof value === 'number') { __park_write_u8(PARK_NUMBER); __park_write_f64(value); return }
  if (typeof value === 'string') { __park_write_u8(PARK_STRING); __park_write_str(value); return }
  if (typeof value === 'bigint') { __park_write_u8(PARK_BIGINT); __park_write_i64(value); return }
  if (Array.isArray(value)) {
    __park_write_u8(PARK_ARRAY)
    __park_write_u32(value.length)
    for (let i = 0; i < value.length; i++) parkValue(value[i])
    return
  }
  if (value != null && typeof value === 'object') {
    const keys = Object.keys(value)
    __park_write_u8(PARK_OBJECT)
    __park_write_u32(keys.length)
    for (let i = 0; i < keys.length; i++) {
      __park_write_str(keys[i])
      parkValue(value[keys[i]])
    }
    return
  }
  throw new TypeError(`Cannot checkpoint WAT IR value of type ${typeof value}`)
}

function unparkValue() {
  const tag = __park_read_u8()
  if (tag === PARK_NULL) return null
  if (tag === PARK_UNDEFINED) return undefined
  if (tag === PARK_FALSE) return false
  if (tag === PARK_TRUE) return true
  if (tag === PARK_NUMBER) return __park_read_f64()
  if (tag === PARK_STRING) return __park_read_str()
  if (tag === PARK_BIGINT) return __park_read_i64()
  if (tag === PARK_ARRAY) {
    const len = __park_read_u32() >>> 0
    const out = new Array(len)
    for (let i = 0; i < len; i++) out[i] = unparkValue()
    return out
  }
  if (tag === PARK_OBJECT) {
    const len = __park_read_u32() >>> 0
    const out = {}
    for (let i = 0; i < len; i++) out[__park_read_str()] = unparkValue()
    return out
  }
  throw new TypeError(`Invalid parked WAT IR tag ${tag}`)
}

function checkpointIR(module) {
  __park_begin()
  parkValue(module)
  __park_finish()
  __park_rewind()
  return unparkValue()
}

/**
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @param {string} [optJSON] - optimize config as JSON (level / alias / per-pass object)
 * @returns {Uint8Array} compiled wasm bytes
 */
export default function compileSelf(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON) {
  const heapMark = __heap_mark()
  setupSelf(strict, optJSON, modulesJSON, host, buildJSON)
  const optimized = optimizeTail(emitIR(front(source, strict, sourceType)), ctx.transform.optimize)
  return watrCompile(__heap_large(heapMark) ? checkpointIR(optimized) : optimized)
}

/**
 * WAT-text variant of the self-compile pipeline: source → WAT string (watr/print of the
 * same `compileAst(prepare(ast))` tree compileSelf encodes to bytes). Lets the
 * `JZ_TEST_TARGET=jz.wasm` leg satisfy white-box `compile(src,{wat:true}).match(...)`
 * codegen-shape assertions — the self-compile produces the same WAT IR as native, so the
 * shape checks validate self-compile codegen instead of failing as a feature gap. No
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
 * Lets the self-compile leg satisfy the `warningsFor()` tests faithfully.
 * @returns {string} JSON array of `{ code, message, ... }` entries
 */
export function compileWarnings(source, strict, optJSON, modulesJSON, host, sourceType) {
  setupSelf(strict, optJSON, modulesJSON, host)
  const sink = { entries: [] }
  initWarnings(sink)
  optimizeTail(emitIR(front(source, strict, sourceType)), ctx.transform.optimize)
  initWarnings(null)
  return JSON.stringify(sink.entries)
}

export function compileWat(source, strict, optJSON, modulesJSON, host, sourceType) {
  setupSelf(strict, optJSON, modulesJSON, host)
  return watrPrint(optimizeTail(emitIR(front(source, strict, sourceType)), ctx.transform.optimize))
}

/**
 * Self-compile divergence diagnostics: run the same pipeline with the internal
 * diagnostic sink armed (resolveIncludes + assemble's global-snapshot sweep
 * record what they resolved) and return the records as JSON. Running this
 * HOST-side and KERNEL-side on the same input and diffing the two JSON
 * strings names the first divergent fact behind a host/kernel byte drift —
 * the archaeology channel for the parity work (.work/archive/todo.md, jz.wasm item).
 * @returns {string} JSON of { resolve: [...], sweep: {...} }
 */
export function compileDiag(source, strict, optJSON) {
  setupSelf(strict, optJSON)
  ctx.core.diagSink = {}
  emitIR(front(source, strict))
  return JSON.stringify(ctx.core.diagSink)
}


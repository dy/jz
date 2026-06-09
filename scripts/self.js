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
import compileAst from '../src/compile/index.js'
import { resetProgramFactsCache } from '../src/compile/program-facts.js'
import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads,
} from '../src/compile/emit.js'
import { resolveOptimize, optimizeFunc, collectVolatileGlobals } from '../src/optimize/index.js'
import watOptimize from '../src/wat/optimize.js'
import jzify from '../jzify/index.js'

// Optimization tail, identical to index.js's host-facing compile(): watOptimize
// (CSE/DCE/const-fold/vectorize-lane SIMD at the WAT level) then the optimizeFunc
// 'post' pass that re-folds the rebox/unbox roundtrips watr's inliner reintroduces
// at closure boundaries. Gated on cfg.watr, so an optimize:false config is a no-op
// and the byte leg (compileSelf, resolveOptimize(false)) stays untouched. Running it
// here is what keeps the self-host kernel's codegen on par with native — the SIMD/
// narrowing/SROA shape tests validate exactly this output.
function optimizeTail(module, cfg) {
  let watrOpts = typeof cfg.watr === 'object' ? { ...cfg.watr } : true
  if (cfg.vectorizeLaneLocal) {
    if (watrOpts === true) watrOpts = { loopify: false }
    else if (typeof watrOpts === 'object' && watrOpts.loopify === undefined) watrOpts.loopify = false
  }
  if (!cfg.watr) return module
  const optimized = watOptimize(module, watrOpts)
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  const funcs = optimized.filter(node => Array.isArray(node) && node[0] === 'func')
  const volatileGlobals = collectVolatileGlobals(funcs)
  for (const node of funcs) optimizeFunc(node, cfg, globalTypesMap, volatileGlobals, 'post')
  return optimized
}

/**
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @returns {Uint8Array} compiled wasm bytes
 */
export default function compileSelf(source, strict) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  ctx.transform.jzify = jzify
  ctx.transform.optimize = resolveOptimize(false)
  ctx.transform.strict = !!strict
  const parsed = parse(source)
  const ast = strict ? parsed : jzify(parsed)
  return watrCompile(optimizeTail(compileAst(prepare(ast)), ctx.transform.optimize))
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
export function compileWarnings(source, strict, optJSON) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  ctx.transform.jzify = jzify
  ctx.transform.optimize = optJSON ? resolveOptimize(JSON.parse(optJSON)) : resolveOptimize(false)
  ctx.transform.strict = !!strict
  const sink = { entries: [] }
  initWarnings(sink)
  const parsed = parse(source)
  const ast = strict ? parsed : jzify(parsed)
  optimizeTail(compileAst(prepare(ast)), ctx.transform.optimize)
  initWarnings(null)
  return JSON.stringify(sink.entries)
}

export function compileWat(source, strict, optJSON) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  ctx.transform.jzify = jzify
  ctx.transform.optimize = optJSON ? resolveOptimize(JSON.parse(optJSON)) : resolveOptimize(false)
  ctx.transform.strict = !!strict
  const parsed = parse(source)
  const ast = strict ? parsed : jzify(parsed)
  return watrPrint(optimizeTail(compileAst(prepare(ast)), ctx.transform.optimize))
}

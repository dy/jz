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
import { parse } from 'subscript/feature/jessie'
import { compile as watrCompile } from 'watr'
import watrPrint from 'watr/print'
import { ctx, reset } from '../src/ctx.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import compileAst from '../src/compile/index.js'
import { resetProgramFactsCache } from '../src/compile/program-facts.js'
import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads,
} from '../src/compile/emit.js'
import { resolveOptimize } from '../src/optimize/index.js'
import jzify from '../jzify/index.js'

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
  return watrCompile(compileAst(prepare(ast)))
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
export function compileWat(source, strict) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  ctx.transform.jzify = jzify
  ctx.transform.optimize = resolveOptimize(false)
  ctx.transform.strict = !!strict
  const parsed = parse(source)
  const ast = strict ? parsed : jzify(parsed)
  return watrPrint(compileAst(prepare(ast)))
}

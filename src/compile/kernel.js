/**
 * Self-host compile kernel: parsed AST → watr IR.
 *
 * This is the in-wasm half of the jz pipeline. The host keeps the two pieces jz
 * cannot yet run on itself — the JS parser (subscript/jessie) and watr's IR→wasm
 * backend — and hands this kernel a parsed AST:
 *
 *     host:   ast = parse(source)
 *     kernel: ir  = compileParsed(ast, moduleAsts)   // reset → jzify → prepare → compile
 *     host:   wasm = watrCompile(ir)
 *
 * For a multi-module entry, the host pre-parses the whole graph (the kernel has no
 * parser) and passes `moduleAsts` as an array of `[specifier, ast]` pairs — the
 * shape prepareModule's linear scan reads back off the marshalled argument.
 *
 * `reset` must run first: it installs the emitter table, GLOBALS, and scope maps
 * the prepare/compile phases read from the shared `ctx` singleton. Mirrors the
 * setup index.js's jzCompileInner does before its own prepare/compile calls.
 */
import { ctx, reset } from '../ctx.js'
import prepare, { GLOBALS } from '../prepare/index.js'
import compile from './index.js'
import { resetProgramFactsCache } from './program-facts.js'
import {
  emit, emitter, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads,
} from './emit.js'
import { resolveOptimize } from '../optimize/index.js'
import jzify from '../../jzify/index.js'

export default function compileParsed(parsedAst, moduleAsts) {
  reset(emitter, GLOBALS, {
    emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads,
  })
  resetProgramFactsCache()
  ctx.transform.jzify = jzify
  ctx.transform.optimize = resolveOptimize(false)
  ctx.module.importAsts = moduleAsts || null
  return compile(prepare(jzify(parsedAst)))
}

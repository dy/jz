/**
 * jz - JS subset → WASM compiler.
 *
 * Pipeline: parse(subscript) → prepare(AST) → compile(AST) → watr → binary
 * State: shared ctx object (src/ctx.js), reset per call
 * Extension: modules register emitters on ctx.emit (see module/)
 *
 * @module jz
 */

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint } from 'watr'
import { ctx } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'

/**
 * Compile JS code to WASM binary (or WAT text).
 * @param {string} code - JavaScript source code
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @returns {Uint8Array|string} WASM binary or WAT text if opts.wat
 * @example
 * const wasm = jz('export let add = (a, b) => a + b')
 * const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
 */
export default function jz(code, opts = {}) {
  ctx.emit = Object.create(emitter)
  ctx.stdlib = {}
  ctx.includes = new Set()
  ctx.imports = []
  ctx.scope = Object.create(GLOBALS)
  ctx.memory = false
  ctx.modules = {}
  ctx.exports = {}
  ctx.funcs = []
  ctx.globals = []
  ctx.schemas = []
  ctx.varSchemas = new Map()
  ctx.depth = 0
  ctx.fnTypes = null
  ctx.fnTable = null
  ctx.closureBodies = null
  ctx.makeClosure = null
  ctx.callClosure = null

  const ast = prepare(parse(code))
  const module = compile(ast)

  return opts.wat ? watrPrint(module) : watrCompile(module)
}

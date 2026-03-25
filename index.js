/**
 * jz - JavaScript subset compiler to WebAssembly
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
  ctx.vars = {}
  ctx.exports = {}
  ctx.funcs = []
  ctx.globals = []

  const ast = prepare(parse(code))
  const module = compile(ast)

  return opts.wat ? watrPrint(module) : watrCompile(module)
}

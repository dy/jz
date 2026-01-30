/**
 * jz - JavaScript subset compiler to WebAssembly
 * @module jz
 */

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint } from 'watr'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'

/**
 * Global compilation context. Reset on each jz() call.
 * @type {CompileContext}
 */
export let ctx

/**
 * @typedef {Object} CompileContext
 * @property {Record<string, Function>} emit - Emitter table: name → (args) => WasmNode
 * @property {Record<string, string>} stdlib - included functions: name → WAT string
 * @property {Set<string>} includes - Included stdlib names (deduped)
 * @property {Array} imports - WASM import declarations
 * @property {Record<string, string>} scope - Name resolution: sin→math.sin, m→math
 * @property {boolean} memory - Whether memory section is needed
 * @property {Record<string, {type: string, mutable: boolean}>} vars - Variable type info
 * @property {Record<string, boolean>} exports - Exported function names
 * @property {Array<{name: string, params: string[], body: any, exported: boolean}>} funcs - Function defs
 */

/**
 * @typedef {Object} CompileOptions
 * @property {Function[]} [modules] - Module initializers
 * @property {boolean} [wat] - Return WAT text instead of binary
 */

/**
 * Compile JS code to WASM binary (or WAT text).
 * @param {string} code - JavaScript source code
 * @returns {Uint8Array|string} WASM binary or WAT text if opts.wat
 * @example
 * const wasm = jz('export let add = (a, b) => a + b')
 * const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
 */
export default function jz(code, opts = {}) {
  ctx = {
    emit: Object.create(emitter),
    stdlib: {},
    includes: new Set(),
    imports: [],              // WASM imports
    scope: Object.create(GLOBALS), // name resolution: sin→math.sin, m→math
    memory: false,
    modules: {},              // loaded module init guards
    vars: {},
    exports: {},              // name → true for exported functions
    funcs: [],                // {name, params, body, exported} - body is AST ref
  }

  // Parse → Prepare → Compile
  const ast = prepare(parse(code))
  const module = compile(ast)

  return opts.wat ? watrPrint(module) : watrCompile(module)
}

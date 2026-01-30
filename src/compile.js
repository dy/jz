/**
 * Compile prepared AST to WASM module.
 * Emitters in ctx.emit handle AST nodes → WASM IR.
 * Modules register emitters for custom ops (e.g., math.sin).
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx } from '../index.js'

const err = msg => { throw Error(msg) }

/**
 * @typedef {Array} WasmNode - watr-compatible S-expression
 */

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {WasmNode} Complete WASM module as S-expression
 */
export default function compile(ast) {
  // Emit functions (may call include() for stdlib deps)
  const funcs = ctx.funcs.map(({ name, params, body, exported }) => {
    const fn = ['func']
    if (exported) fn.push(['export', `"${name}"`])
    else fn.push(`$${name}`)
    fn.push(...params.map(p => ['param', `$${p}`, 'f64']))
    fn.push(['result', 'f64'])
    fn.push(emit(body))
    return fn
  })

  const sections = [
    ...ctx.imports,
    ...(ctx.memory ? [['memory', ['export', '"memory"'], 1]] : []),
    ...(ctx.globals || []).map(g => parseWat(g)),
    ...[...ctx.includes].map(n => parseWat(ctx.stdlib[n])),
    ...funcs
  ]

  // Start function if there's init code
  const init = emit(ast)
  if (init?.length) {
    sections.push(['func', '$__start', ...init])
    sections.push(['start', '$__start'])
  }

  return ['module', ...sections]
}

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * Modules extend ctx.emit (inherits from emitter) for custom ops.
 * E.g., math module adds ctx.emit['math.sin'] = (a) => [...]
 * @type {Record<string, (...args: any[]) => WasmNode>}
 */
export const emitter = {
  // Statements
  ';': (...args) => args.map(emit).filter(x => x != null),
  'let': () => null,    // declarations handled by defFunc in prepare
  'const': () => null,
  'export': () => null,

  // Arithmetic
  '+': (a, b) => ['f64.add', emit(a), emit(b)],
  '-': (a, b) => b === undefined ? ['f64.neg', emit(a)] : ['f64.sub', emit(a), emit(b)],
  'u+': a => emit(a),
  'u-': a => ['f64.neg', emit(a)],
  '*': (a, b) => ['f64.mul', emit(a), emit(b)],
  '/': (a, b) => ['f64.div', emit(a), emit(b)],
  '%': (a, b) => ['f64.rem', emit(a), emit(b)],

  // Comparisons
  '==': (a, b) => ['f64.eq', emit(a), emit(b)],
  '!=': (a, b) => ['f64.ne', emit(a), emit(b)],
  '<': (a, b) => ['f64.lt', emit(a), emit(b)],
  '>': (a, b) => ['f64.gt', emit(a), emit(b)],
  '<=': (a, b) => ['f64.le', emit(a), emit(b)],
  '>=': (a, b) => ['f64.ge', emit(a), emit(b)],
  // Logical
  '!': a => ['f64.eq', emit(a), ['f64.const', 0]],
  '?:': (a, b, c) => ['select', emit(b), emit(c), ['f64.ne', emit(a), ['f64.const', 0]]],
  '(': a => emit(a),

  // Call
  '()': (callee, callArgs) => {
    const argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Check for custom emitter first (modules)
    if (ctx.emit[callee]) return ctx.emit[callee](...argList)

    return ['call', `$${callee}`, ...argList.map(emit)]
  },
}

/**
 * Emit single AST node to WASM IR.
 * Strings check ctx.emit first (for constants like math.PI).
 * Arrays dispatch to ctx.emit[op] (modules register custom emitters).
 * @param {import('./prepare.js').ASTNode} node - Prepared AST node
 * @returns {WasmNode} watr-compatible S-expression
 */
export function emit(node) {
  if (node == null) return null
  if (typeof node === 'number') return ['f64.const', node]
  if (typeof node === 'string') {
    // Constants (e.g., math.PI) have emitters
    if (ctx.emit[node]) return ctx.emit[node]()
    return ['local.get', `$${node}`]
  }
  if (!Array.isArray(node)) return ['f64.const', 0]

  const [op, ...args] = node

  // literals [,value]
  if (op == null && args.length === 1) return emit(args[0])

  const handler = ctx.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}

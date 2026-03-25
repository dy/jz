/**
 * Compile prepared AST to WASM module.
 * Emitters in ctx.emit handle AST nodes → WASM IR.
 * Modules register emitters for custom ops (e.g., math.sin).
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx } from './ctx.js'

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

  const funcs = ctx.funcs.map(({ name, params, body, exported }) => {
    // Reset per-function state
    ctx.locals = new Set()
    ctx.stack = []
    ctx.uid = 0

    const fn = ['func']
    if (exported) fn.push(['export', `"${name}"`])
    else fn.push(`$${name}`)
    fn.push(...params.map(p => ['param', `$${p}`, 'f64']))
    fn.push(['result', 'f64'])

    const block = Array.isArray(body) && body[0] === '{}'

    if (block) {
      collectLocals(body)
      const stmts = emitBody(body)
      for (const l of ctx.locals) fn.push(['local', `$${l}`, 'f64'])
      fn.push(...stmts, ['f64.const', 0])
    } else {
      const ir = emit(body)
      for (const l of ctx.locals) fn.push(['local', `$${l}`, 'f64'])
      fn.push(ir)
    }

    return fn
  })

  const sections = [
    ...ctx.imports,
    ...(ctx.memory ? [['memory', ['export', '"memory"'], 1]] : []),
    ...(ctx.globals || []).map(g => parseWat(g)),
    ...[...ctx.includes].map(n => parseWat(ctx.stdlib[n])),
    ...funcs
  ]

  const init = emit(ast)
  if (init?.length) {
    sections.push(['func', '$__start', ...init])
    sections.push(['start', '$__start'])
  }

  return ['module', ...sections]
}

/** Collect all let/const variable names from AST (recursive). */
function collectLocals(node) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === 'let' || op === 'const')
    for (const a of args)
      if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string')
        ctx.locals.add(a[1])
  for (const a of args) collectLocals(a)
}

/** Emit block body as flat list of WASM instructions. */
function emitBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  for (const s of stmts) out.push(...flat(emit(s)))
  return out
}

/** Normalize emitter output to flat node array. */
const flat = ir => ir == null ? [] : Array.isArray(ir) && Array.isArray(ir[0]) ? ir : [ir]

/** Convert AST condition to i32 for br_if/if. */
function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (['>', '<', '>=', '<=', '==', '!=', '!'].includes(op)) return emit(node)
  return ['f64.ne', emit(node), ['f64.const', 0]]
}

/** Allocate a temp local, returns name without $. */
function temp() {
  const name = `__${ctx.uid++}`
  ctx.locals.add(name)
  return name
}

/** Get current loop labels or throw. */
function loopTop() {
  const top = ctx.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}

/** Emit let/const initializations as local.set instructions. */
function emitDecl(...inits) {
  const result = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name === 'string' && init != null)
      result.push(['local.set', `$${name}`, emit(init)])
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * Modules extend ctx.emit (inherits from emitter) for custom ops.
 * @type {Record<string, (...args: any[]) => WasmNode>}
 */
export const emitter = {
  // === Statements ===

  ';': (...args) => args.map(emit).filter(x => x != null),
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  'return': expr => ['return', emit(expr)],

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string') return ['local.set', `$${name}`, emit(val)]
    err(`Assignment to non-variable: ${JSON.stringify(name)}`)
  },

  ...Object.fromEntries([['+=','f64.add'],['-=','f64.sub'],['*=','f64.mul'],['/=','f64.div'],['%=','f64.rem']]
    .map(([op, wasm]) => [op, (name, val) => ['local.set', `$${name}`, [wasm, ['local.get', `$${name}`], emit(val)]]])),

  // === Arithmetic ===

  '+': (a, b) => ['f64.add', emit(a), emit(b)],
  '-': (a, b) => b === undefined ? ['f64.neg', emit(a)] : ['f64.sub', emit(a), emit(b)],
  'u+': a => emit(a),
  'u-': a => ['f64.neg', emit(a)],
  '*': (a, b) => ['f64.mul', emit(a), emit(b)],
  '/': (a, b) => ['f64.div', emit(a), emit(b)],
  '%': (a, b) => ['f64.rem', emit(a), emit(b)],

  // === Comparisons (return i32) ===

  '==': (a, b) => ['f64.eq', emit(a), emit(b)],
  '!=': (a, b) => ['f64.ne', emit(a), emit(b)],
  '<': (a, b) => ['f64.lt', emit(a), emit(b)],
  '>': (a, b) => ['f64.gt', emit(a), emit(b)],
  '<=': (a, b) => ['f64.le', emit(a), emit(b)],
  '>=': (a, b) => ['f64.ge', emit(a), emit(b)],

  // === Logical ===

  '!': a => ['f64.eq', emit(a), ['f64.const', 0]],
  '?:': (a, b, c) => ['select', emit(b), emit(c), ['f64.ne', emit(a), ['f64.const', 0]]],

  '&&': (a, b) => {
    const t = temp()
    return ['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, emit(a)], ['f64.const', 0]],
      ['then', emit(b)],
      ['else', ['local.get', `$${t}`]]]
  },

  '||': (a, b) => {
    const t = temp()
    return ['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, emit(a)], ['f64.const', 0]],
      ['then', ['local.get', `$${t}`]],
      ['else', emit(b)]]
  },

  '(': a => emit(a),

  // === Control flow ===

  'if': (cond, then, els) => {
    const c = toBool(cond)
    if (els != null)
      return ['if', c, ['then', emit(then)], ['else', emit(els)]]
    return ['if', c, ['then', emit(then)]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')

    const id = ctx.uid++
    const brk = `$brk${id}`
    const loop = `$loop${id}`
    ctx.stack.push({ brk, loop })

    const result = []
    if (init != null) result.push(...flat(emit(init)))

    const loopBody = []
    if (cond) loopBody.push(['br_if', brk, ['i32.eqz', toBool(cond)]])
    loopBody.push(...flat(emit(body)))
    if (step) loopBody.push(...flat(emit(step)))
    loopBody.push(['br', loop])

    result.push(['block', brk, ['loop', loop, ...loopBody]])

    ctx.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'while': (cond, body) => emitter['for'](null, cond, null, body),
  'break': () => ['br', loopTop().brk],
  'continue': () => ['br', loopTop().loop],

  // === Call ===

  '()': (callee, callArgs) => {
    const argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []
    if (ctx.emit[callee]) return ctx.emit[callee](...argList)
    return ['call', `$${callee}`, ...argList.map(emit)]
  },
}

/**
 * Emit single AST node to WASM IR.
 * @param {import('./prepare.js').ASTNode} node - Prepared AST node
 * @returns {WasmNode} watr-compatible S-expression
 */
export function emit(node) {
  if (node == null) return null
  if (typeof node === 'number') return ['f64.const', node]
  if (typeof node === 'string') {
    if (ctx.emit[node]) return ctx.emit[node]()
    return ['local.get', `$${node}`]
  }
  if (!Array.isArray(node)) return ['f64.const', 0]

  const [op, ...args] = node
  if (op == null && args.length === 1) return emit(args[0])

  const handler = ctx.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}

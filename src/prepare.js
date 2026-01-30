/**
 * AST preparation: normalize, validate, analyze in single pass.
 * Resolves Math.X → math.X for module emitters.
 * @module prepare
 */

import { ctx } from '../index.js'
import * as mods from '../module/index.js'

/**
 * @typedef {null|number|string|ASTNode[]} ASTNode
 */


/**
 * Prepare AST node for compilation. Normalizes syntax, validates
 * prohibited features, tracks variables, and auto-imports modules.
 * @param {ASTNode} node - Raw AST from parser
 * @returns {ASTNode} Normalized AST
 */
export default function prep(node) {
  if (node == null) return node
  if (!Array.isArray(node)) return typeof node === 'string' && PROHIBITED[node] ?
    err(PROHIBITED[node]) :
    node

  const [op, ...args] = node
  if (op == null) return [, args[0]]
  return handlers[op]?.(...args) ?? [op, ...args.map(prep)]
}

// Prohibited identifiers (string nodes)
const PROHIBITED = {
  'this': '`this` not supported: use explicit parameter',
  'super': '`super` not supported: no class inheritance',
  'arguments': '`arguments` not supported: use rest params',
  'eval': '`eval` not supported'
}

// Global namespaces for module auto-import
const GLOBALS = {
  Math: 'math',
  Number: 'core',
  String: 'core',
  Boolean: 'core',
  Array: 'core',
  Object: 'core',
  JSON: 'core',
  Set: 'core',
  Map: 'core',
  RegExp: 'core',
  Float64Array: 'binary',
  Float32Array: 'binary',
  Int8Array: 'binary',
  Int16Array: 'binary',
  Int32Array: 'binary',
  Uint8Array: 'binary',
  Uint16Array: 'binary',
  Uint8ClampedArray: 'binary'
}

const handlers = {
  // Prohibited ops (actual parser node types)
  'async': () => err('async/await not supported: WASM is synchronous'),
  'await': () => err('async/await not supported: WASM is synchronous'),
  'class': () => err('class not supported: use object literals'),
  'yield': () => err('generators not supported: use loops'),
  'delete': () => err('delete not supported: object shape is fixed'),
  'in': () => err('`in` not supported: use optional chaining'),
  'instanceof': () => err('instanceof not supported: use typeof'),
  'with': () => err('`with` not supported: deprecated'),
  'import': () => err('dynamic import() not supported'),
  ':': () => err('labeled statements not supported'),
  'var': () => err('`var` not supported: use let/const'),
  'function': () => err('`function` not supported: use arrow functions'),

  // Statements
  ';': (...stmts) => [';', ...stmts.map(prep)],

  'let': (...inits) => ['let', ...inits.map(i => {
    if (!Array.isArray(i) || i[0] !== '=') return i
    const [, name, init] = i, normed = prep(init)
    if (typeof name === 'string') {
      ctx.vars[name] = { type: type(normed), mutable: true }
      if (Array.isArray(normed) && normed[0] === '=>')
        ctx.funcs.push({ name, body: normed, exported: false })
    }
    return ['=', name, normed]
  })],

  'const': (...inits) => ['const', ...inits.map(i => {
    if (!Array.isArray(i) || i[0] !== '=') return i
    const [, name, init] = i, normed = prep(init)
    if (typeof name === 'string') {
      ctx.vars[name] = { type: type(normed), mutable: false }
      if (Array.isArray(normed) && normed[0] === '=>')
        ctx.funcs.push({ name, body: normed, exported: false })
    }
    return ['=', name, normed]
  })],

  // TODO: handle imports that includes module from /module

  'export': decl => {
    const normed = prep(decl)
    if (Array.isArray(normed) && (normed[0] === 'let' || normed[0] === 'const'))
      for (const a of normed.slice(1))
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          ctx.exports[a[1]] = true
          // Mark function as exported
          const fn = ctx.funcs.find(f => f.name === a[1])
          if (fn) fn.exported = true
        }
    return ['export', normed]
  },

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? na : ['u+', na] }
    return ['+', prep(a), prep(b)]
  },
  '-'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? [, -na[1]] : ['u-', na] }
    return ['-', prep(a), prep(b)]
  },

  // ++/-- → compound assignment
  '++'(a, post) { return post === null ? ['-', ['+=', a, [, 1]], [, 1]] : ['+=', a, [, 1]] },
  '--'(a, post) { return post === null ? ['+', ['-=', a, [, 1]], [, 1]] : ['-=', a, [, 1]] },

  // auto-include math for ** operator
  '**'(a, b) { includeModule('math'); return ['**', prep(a), prep(b)] },

  // Function call - resolve Math.X to math.X
  '()'(callee, ...args) {
    if (typeof callee === 'string') {
      if (PROHIBITED[callee]) err(PROHIBITED[callee])
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      if (typeof obj === 'string' && GLOBALS[obj])
        callee = (includeModule(GLOBALS[obj]), GLOBALS[obj] + '.' + prop)
    }
    return ['()', callee, ...args.map(prep)]
  },

  // Array literal/indexing
  '[]'(...args) {
    if (args.length === 1) {
      const inner = args[0]
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',') return ['[', ...inner.slice(1).map(prep)]
      return ['[', prep(inner)]
    }
    return ['[]', prep(args[0]), prep(args[1])]
  },

  // Object literal / block
  '{}'(inner) {
    // FIXME: shouldn't it be handled by subscript?
    if (inner == null) return ['{']
    if (Array.isArray(inner) && [';', '=', 'let', 'const', 'var', 'for', 'while', 'return', 'if'].includes(inner[0]))
      return ['{}', prep(inner)]
    if (typeof inner === 'string') return ['{', [inner, inner]]
    if (Array.isArray(inner) && inner[0] === ':') return ['{', [inner[1], prep(inner[2])]]
    if (Array.isArray(inner) && inner[0] === ',') {
      return ['{', ...inner.slice(1).map(p => {
        if (typeof p === 'string') return [p, p]
        if (Array.isArray(p) && p[0] === ':') return [p[1], prep(p[2])]
        err(`Invalid object property: ${JSON.stringify(p)}`)
      })]
    }
    err(`Invalid block/object: ${JSON.stringify(inner)}`)
  },

  // For loop
  'for'(head, body) {
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      // FIXME: feels like belonging to subscript
      return ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? prep(step) : null, prep(body)]
    }
    return ['for', prep(head), prep(body)]
  },

  // Property access - resolve Math.X to math.X string
  '.'(obj, prop) {
    if (typeof obj === 'string' && GLOBALS[obj])
      return includeModule(GLOBALS[obj]), GLOBALS[obj] + '.' + prop
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules
  'new'(ctor, ...args) {
    let name = ctor
    if (Array.isArray(ctor) && ctor[0] === '()') name = ctor[1]
    if (typeof name === 'string' && GLOBALS[name]) includeModule(GLOBALS[name])
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

/**
 * Include module to compilation context
 * @param {*} name
 */
function includeModule(name) {
  let init = mods[name]
  if (!init) return err(`Module not found: ${name}`)
    if (ctx.modules[name]) return
  init(ctx)
  ctx.modules[name] = true
}

/**
 * Infer type from expression (compile-time only).
 * @param {ASTNode} expr
 * @returns {'f64'|'func'} Inferred WASM type
 */
function type(expr) {
  if (typeof expr === 'number') return 'f64'
  if (typeof expr === 'string') {
    if (ctx.types[expr]) return ctx.types[expr][1] || 'f64'  // [params, returns]
    if (ctx.vars[expr]) return ctx.vars[expr].type
    return 'f64'
  }
  if (Array.isArray(expr) && expr[0] === '=>') return 'func'
  return 'f64'
}

const err = msg => { throw Error(msg) }
const isLit = n => Array.isArray(n) && n[0] == null

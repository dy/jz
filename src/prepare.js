/**
 * AST preparation: normalize, validate, analyze in single pass.
 * Resolves Math.X → math.X for module emitters.
 * @module prepare
 */

import { ctx } from './ctx.js'
import * as mods from '../module/index.js'

/**
 * @typedef {null|number|string|ASTNode[]} ASTNode
 */

/**
 * Prepare AST node for compilation.
 * @param {ASTNode} node - Raw AST from parser
 * @returns {ASTNode} Normalized AST
 */
export default function prepare(node) {
  return prep(node)
}

function prep(node) {
  if (node == null) return node
  if (!Array.isArray(node)) {
    if (typeof node === 'string') {
      if (PROHIBITED[node]) err(PROHIBITED[node])
      const resolved = ctx.scope[node]
      if (resolved?.includes('.')) return resolved
    }
    return node
  }

  const [op, ...args] = node
  if (op == null) return [, args[0]]
  const handler = handlers[op]
  return handler ? handler(...args) : [op, ...args.map(prep)]
}

const PROHIBITED = {
  'this': '`this` not supported: use explicit parameter',
  'super': '`super` not supported: no class inheritance',
  'arguments': '`arguments` not supported: use rest params',
  'eval': '`eval` not supported'
}

// Global namespaces for module auto-import
export const GLOBALS = {
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

/** Prepare let/const declaration. */
function prepDecl(op, mutable, ...inits) {
  const rest = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') { rest.push(i); continue }
    const [, name, init] = i, normed = prep(init)
    if (typeof name === 'string') ctx.vars[name] = { type: type(normed), mutable }
    if (!defFunc(name, normed)) rest.push(['=', name, normed])
  }
  return rest.length ? [op, ...rest] : null
}

const handlers = {
  // Prohibited ops
  'async': () => err('async/await not supported: WASM is synchronous'),
  'await': () => err('async/await not supported: WASM is synchronous'),
  'class': () => err('class not supported: use object literals'),
  'yield': () => err('generators not supported: use loops'),
  'delete': () => err('delete not supported: object shape is fixed'),
  'in': () => err('`in` not supported: use optional chaining'),
  'instanceof': () => err('instanceof not supported: use typeof'),
  'with': () => err('`with` not supported: deprecated'),
  ':': () => err('labeled statements not supported'),
  'var': () => err('`var` not supported: use let/const'),
  'function': () => err('`function` not supported: use arrow functions'),

  // Import
  'import'(fromNode) {
    if (!Array.isArray(fromNode) || fromNode[0] !== 'from')
      return err('Dynamic import() not supported')
    return handlers['from'](fromNode[1], fromNode[2])
  },

  'from'(specifiers, source) {
    const mod = source?.[1]
    if (!mod || typeof mod !== 'string') return err('Invalid import source')
    includeModule(mod)

    const bind = (name, alias) => {
      const key = mod + '.' + name
      if (!ctx.emit[key]) err(`Unknown import: ${name} from '${mod}'`)
      ctx.scope[alias || name] = key
    }

    if (typeof specifiers === 'string') {
      ctx.scope[specifiers] = mod
      return null
    }
    if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') {
      ctx.scope[specifiers[2]] = mod
      return null
    }
    if (Array.isArray(specifiers) && specifiers[0] === '{}') {
      const inner = specifiers[1]
      if (inner == null) return null
      const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
      for (const item of items) {
        if (typeof item === 'string') bind(item)
        else if (Array.isArray(item) && item[0] === 'as') bind(item[1], item[2])
        else err(`Invalid import specifier: ${JSON.stringify(item)}`)
      }
    }
    return null
  },

  // Statements
  ';': (...stmts) => [';', ...stmts.map(prep).filter(x => x != null)],
  'let': (...inits) => prepDecl('let', true, ...inits),
  'const': (...inits) => prepDecl('const', false, ...inits),

  'export': decl => {
    if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const'))
      for (const i of decl.slice(1))
        if (Array.isArray(i) && i[0] === '=' && typeof i[1] === 'string')
          ctx.exports[i[1]] = true
    return prep(decl)
  },

  // Arrow: don't prep params (they're declarations, not expressions)
  '=>': (params, body) => ['=>', params, prep(body)],

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? na : ['u+', na] }
    return ['+', prep(a), prep(b)]
  },
  '-'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? [, -na[1]] : ['u-', na] }
    return ['-', prep(a), prep(b)]
  },

  // ++/-- → compound assignment (no post/pre value distinction for now)
  '++'(a) { return ['+=', a, [, 1]] },
  '--'(a) { return ['-=', a, [, 1]] },

  // auto-include math for ** operator
  '**'(a, b) { includeModule('math'); return ['**', prep(a), prep(b)] },

  // Function call - resolve scope bindings and namespaces
  '()'(callee, ...args) {
    if (typeof callee === 'string') {
      if (PROHIBITED[callee]) err(PROHIBITED[callee])
      const resolved = ctx.scope[callee]
      if (resolved?.includes('.')) callee = resolved
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      const mod = ctx.scope[obj]
      if (typeof obj === 'string' && mod && !mod.includes('.'))
        callee = (includeModule(mod), mod + '.' + prop)
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

  // Block statement
  '{'(inner) { return ['{', prep(inner)] },

  // Object literal - flatten comma, expand shorthand
  '{}'(inner) {
    if (inner == null) return ['{}']
    const prop = p => typeof p === 'string' ? [':', p, p] : prep(p)
    if (Array.isArray(inner) && inner[0] === ',') return ['{}', ...inner.slice(1).map(prop)]
    return ['{}', prop(inner)]
  },

  // For loop
  'for'(head, body) {
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      return ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? prep(step) : null, prep(body)]
    }
    return ['for', prep(head), prep(body)]
  },

  // Property access - resolve namespaces
  '.'(obj, prop) {
    const mod = ctx.scope[obj]
    if (typeof obj === 'string' && mod && !mod.includes('.'))
      return includeModule(mod), mod + '.' + prop
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules
  'new'(ctor, ...args) {
    let name = ctor
    if (Array.isArray(ctor) && ctor[0] === '()') name = ctor[1]
    const mod = ctx.scope[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

function includeModule(name) {
  const init = mods[name]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.modules[name]) return
  init(ctx)
  ctx.modules[name] = true
}

function type(expr) {
  if (typeof expr === 'number') return 'f64'
  if (typeof expr === 'string') {
    if (ctx.vars[expr]) return ctx.vars[expr].type
    return 'f64'
  }
  if (Array.isArray(expr) && expr[0] === '=>') return 'func'
  return 'f64'
}

function defFunc(name, node) {
  if (!Array.isArray(node) || node[0] !== '=>') return false
  const [, rawParams, body] = node
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  const params = Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : p ? [p] : []
  ctx.funcs.push({ name, params, body, exported: !!ctx.exports[name] })
  return true
}

const err = msg => { throw Error(msg) }
const isLit = n => Array.isArray(n) && n[0] == null

/**
 * AST preparation: normalize, validate, analyze in single pass.
 *
 * Responsibilities:
 * - Validate: reject prohibited features (this, class, async, var...)
 * - Resolve: Math.sin → math.sin, import bindings → module.name
 * - Extract: arrow functions → ctx.funcs with sig (params, results)
 * - Normalize: ++/-- → +=/-=, unary ± disambiguation, for head flattening
 * - Auto-import: Math/Array/etc usage triggers module loading
 *
 * Handler table mirrors compile's emitter table — same dispatch pattern.
 * Unhandled ops fall through to recursive prep of children.
 *
 * @module prepare
 */

import { ctx, err } from './ctx.js'
import * as mods from '../module/index.js'

let depth = 0  // arrow nesting depth (0=top-level, >0=inside function)

/**
 * @typedef {null|number|string|ASTNode[]} ASTNode
 */

/**
 * Prepare AST node for compilation.
 * @param {ASTNode} node - Raw AST from parser
 * @returns {ASTNode} Normalized AST
 */
export default function prepare(node) {
  depth = 0
  return prep(node)
}

// Named constants → numeric literals
const CONSTANTS = { 'true': 1, 'false': 0, 'null': 0, 'undefined': 0 }
// NaN/Infinity stay as special f64 values in emit()
const F64_CONSTANTS = { 'NaN': NaN, 'Infinity': Infinity }

function prep(node) {
  if (Array.isArray(node) && node.loc != null) ctx.loc = node.loc
  if (node == null) return [, 0] // null/undefined → 0 literal
  if (node === true) return [, 1]
  if (node === false) return [, 0]
  if (!Array.isArray(node)) {
    if (typeof node === 'string') {
      if (node in CONSTANTS) return [, CONSTANTS[node]]
      if (node in F64_CONSTANTS) return [, F64_CONSTANTS[node]]
      if (PROHIBITED[node]) err(PROHIBITED[node])
      const resolved = ctx.scope[node]
      if (resolved?.includes('.')) return resolved
    }
    return node
  }

  const [op, ...args] = node
  if (op == null) {
    if (typeof args[0] === 'string') {
      includeModule('ptr')
      includeModule('string')
      includeModule('number')
      return ['str', args[0]]  // string literal
    }
    return [, args[0]]  // number literal
  }
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
  Number: 'Number',
  Array: 'Array',
  Object: 'Object',
  Symbol: 'Symbol',
}

/** Prepare let/const declaration. */
function prepDecl(op, ...inits) {
  const rest = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') { rest.push(i); continue }
    const [, name, init] = i, normed = prep(init)

    // Array destructuring: let [a, b] = expr → let __tmp = expr; let a = __tmp[0]; let b = __tmp[1]
    if (Array.isArray(name) && name[0] === '[]') {
      const items = name[1]?.[0] === ',' ? name[1].slice(1) : [name[1]]
      const tmp = `__d${ctx.uniq || 0}`; if (!ctx.uniq) ctx.uniq = 0; ctx.uniq++
      rest.push(['=', tmp, normed])
      for (let j = 0; j < items.length; j++)
        if (items[j] != null) rest.push(['=', items[j], ['[]', tmp, [, j]]])
      continue
    }

    // Object destructuring: let {x, y} = expr → let __tmp = expr; let x = __tmp.x; let y = __tmp.y
    if (Array.isArray(name) && name[0] === '{}') {
      const items = name[1]?.[0] === ',' ? name[1].slice(1) : [name[1]]
      const tmp = `__d${ctx.uniq || 0}`; if (!ctx.uniq) ctx.uniq = 0; ctx.uniq++
      rest.push(['=', tmp, normed])
      for (const item of items) {
        if (typeof item === 'string') rest.push(['=', item, ['.', tmp, item]])
        // Alias: {x: a} → a = tmp.x
        else if (Array.isArray(item) && item[0] === ':') rest.push(['=', item[2], ['.', tmp, item[1]]])
      }
      continue
    }

    // Track object schemas for property access
    if (typeof name === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
      const props = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
      if (props.length && ctx.schema.register) ctx.schema.vars.set(name, ctx.schema.register(props))
    }
    if (!defFunc(name, normed)) rest.push(['=', name, normed])
  }
  return rest.length ? [op, ...rest] : null
}

const handlers = {
  // Spread operator: [...expr] in arrays, f(...args) in calls, {...obj} in objects
  '...'(expr) {
    // Spread is valid in arrays, calls, and objects - just prep the inner expression
    includeModule('array')
    return ['...', prep(expr)]
  },

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

  // try/catch/throw
  'catch'(tryNode, errName, handler) {
    const body = Array.isArray(tryNode) && tryNode[0] === 'try' ? tryNode[1] : tryNode
    return ['catch', prep(body), errName, prep(handler)]
  },
  'try'(body) { return ['try', prep(body)] },
  'throw'(expr) { return ['throw', prep(expr)] },
  'finally'() { err('finally not supported: use catch') },

  // Template literal: [``, part, ...] → chain of str_concat calls
  // First node is always a string (empty if template starts with ${...}) so concat dispatches correctly.
  '`'(...parts) {
    includeModule('ptr')
    includeModule('string')
    includeModule('number')
    const nodes = parts.map(p =>
      Array.isArray(p) && p[0] == null && typeof p[1] === 'string' ? ['str', p[1]] : prep(p))
    // Ensure first element is a string so concat chain starts with string dispatch
    if (nodes.length && !(Array.isArray(nodes[0]) && nodes[0][0] === 'str'))
      nodes.unshift(['str', ''])
    return nodes.reduce((acc, n) => ['()', ['.', acc, 'concat'], n])
  },

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
  'let': (...inits) => prepDecl('let', ...inits),
  'const': (...inits) => prepDecl('const', ...inits),

  'export': decl => {
    if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const'))
      for (const i of decl.slice(1))
        if (Array.isArray(i) && i[0] === '=' && typeof i[1] === 'string')
          ctx.exports[i[1]] = true
    return prep(decl)
  },

  // Arrow: don't prep params. Track depth for nested function detection.
  '=>': (params, body) => {
    if (depth > 0) { includeModule('ptr'); includeModule('fn') }
    depth++
    const result = ['=>', params, prep(body)]
    depth--
    return result
  },

  // Switch: prep discriminant and case values/bodies
  // Parser appends fall-through flag (number) to case bodies — strip it
  'switch'(discriminant, ...cases) {
    const prepCase = body => {
      if (Array.isArray(body) && body[0] === ';')
        return prep([';', ...body.slice(1).filter(s => typeof s !== 'number')])
      return prep(body)
    }
    return ['switch', prep(discriminant), ...cases.map(c => {
      if (c[0] === 'case') return ['case', prep(c[1]), prepCase(c[2])]
      if (c[0] === 'default') return ['default', prep(c[1])]
      return prep(c)
    })]
  },

  // Optional chaining / typeof — need ptr module
  '?.'(obj, prop) { includeModule('ptr'); return ['?.', prep(obj), prop] },
  '?.[]'(obj, idx) { includeModule('ptr'); includeModule('array'); return ['?.[]', prep(obj), prep(idx)] },
  'typeof'(a) { includeModule('ptr'); return ['typeof', prep(a)] },

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? na : ['u+', na] }
    return ['+', prep(a), prep(b)]
  },
  '-'(a, b) {
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' ? [, -na[1]] : ['u-', na] }
    return ['-', prep(a), prep(b)]
  },

  // Ternary: parser emits '?' not '?:'
  '?'(cond, then, els) { return ['?:', prep(cond), prep(then), prep(els)] },

  // ++/-- prefix vs postfix: parser sends trailing null for postfix
  // Postfix i++ = (++i) - 1: increment happens, arithmetic recovers old value
  '++'(a, _post) { return _post !== undefined ? ['-', ['++', a], [, 1]] : ['++', a] },
  '--'(a, _post) { return _post !== undefined ? ['+', ['--', a], [, 1]] : ['--', a] },

  // auto-include math for ** operator
  '**'(a, b) { includeModule('math'); return ['**', prep(a), prep(b)] },

  // Function call or grouping parens
  '()'(callee, ...args) {
    // Grouping parens: (expr) with no args, callee is an expression not a name
    if (!args.length && typeof callee !== 'string') return prep(callee)

    if (typeof callee === 'string') {
      if (PROHIBITED[callee]) err(PROHIBITED[callee])
      const resolved = ctx.scope[callee]
      if (resolved?.includes('.')) callee = resolved
      // Bare constructor call: Symbol('foo') → include module, keep callee as-is
      else if (resolved && !resolved.includes('.')) includeModule(resolved)
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      // console.log/warn/error → WASI module
      if (obj === 'console' && (prop === 'log' || prop === 'warn' || prop === 'error')) {
        includeModule('ptr'); includeModule('string'); includeModule('number'); includeModule('wasi')
        callee = `console.${prop}`
      } else {
        const mod = ctx.scope[obj]
        if (typeof obj === 'string' && mod && !mod.includes('.'))
          callee = (includeModule(mod), mod + '.' + prop)
        else
          callee = prep(callee)  // prep method callee (triggers . handler → module loading)
      }
    }
    // Auto-include number module for Number methods and String() coercion
    if (Array.isArray(callee) && callee[0] === '.') {
      const method = callee[2]
      if (method === 'toString' || method === 'toFixed' || method === 'toPrecision' || method === 'toExponential') {
        includeModule('ptr'); includeModule('string'); includeModule('number')
      }
    }
    if (callee === 'String') { includeModule('ptr'); includeModule('string'); includeModule('number') }
    const result = ['()', callee, ...args.filter(a => a != null).map(prep)]

    // Object.assign(target, ...sources): merge source schemas into target
    if (callee === 'Object.assign' && ctx.schema.register) {
      // After prep, args may be comma-grouped: ['()', callee, [',', target, s1, s2]]
      let assignArgs = result.slice(2)
      if (assignArgs.length === 1 && Array.isArray(assignArgs[0]) && assignArgs[0][0] === ',')
        assignArgs = assignArgs[0].slice(1)
      const [target, ...sources] = assignArgs
      if (typeof target === 'string') {
        const existingId = ctx.schema.vars.get(target)
        const merged = existingId != null ? [...ctx.schema.list[existingId]] : []
        for (const src of sources) {
          // Source is object literal: extract props directly
          let srcProps
          if (Array.isArray(src) && src[0] === '{}')
            srcProps = src.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
          // Source is variable with known schema
          else if (typeof src === 'string') {
            const srcId = ctx.schema.vars.get(src)
            if (srcId != null) srcProps = ctx.schema.list[srcId]
          }
          if (srcProps) for (const p of srcProps) if (!merged.includes(p)) merged.push(p)
        }
        if (merged.length) ctx.schema.vars.set(target, ctx.schema.register(merged))
      }
    }

    return result
  },

  // Array literal/indexing — auto-include ptr + array modules
  '[]'(...args) {
    if (args.length === 1) {
      const inner = args[0]
      includeModule('ptr')
      includeModule('array')
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',') return ['[', ...inner.slice(1).map(prep)]
      return ['[', prep(inner)]
    }
    includeModule('ptr')
    includeModule('array')
    return ['[]', prep(args[0]), prep(args[1])]
  },

  // Block statement
  '{'(inner) { return ['{', prep(inner)] },

  // Object literal - flatten comma, expand shorthand
  '{}'(inner) {
    // Detect block body vs object literal
    if (Array.isArray(inner) && [';', 'return', 'if', 'for', 'while', 'let', 'const', 'break', 'continue', 'switch'].includes(inner[0]))
      return ['{}', prep(inner)]  // block body, pass through

    includeModule('ptr')
    includeModule('object')
    if (inner == null) return ['{}']
    // Process properties: shorthand 'x' → [':', 'x', 'x'], or [':', key, val] → prep val only
    const prop = p => {
      if (typeof p === 'string') return [':', p, prep(p)]
      if (Array.isArray(p) && p[0] === ':') return [':', p[1], prep(p[2])]
      return prep(p)
    }
    const result = Array.isArray(inner) && inner[0] === ','
      ? ['{}', ...inner.slice(1).map(prop)]
      : ['{}', prop(inner)]
    // Register schema so property access works for function params (duck typing)
    const props = result.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    if (props.length && ctx.schema.register) ctx.schema.register(props)
    return result
  },

  // For loop
  'for'(head, body) {
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      return ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? prep(step) : null, prep(body)]
    }
    return ['for', prep(head), prep(body)]
  },

  // Property access - resolve namespaces or object/array properties
  '.'(obj, prop) {
    const mod = ctx.scope[obj]
    if (typeof obj === 'string' && mod && !mod.includes('.'))
      return includeModule(mod), mod + '.' + prop
    includeModule('ptr')
    includeModule('object')
    includeModule('array')
    includeModule('string')
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }

    // TypedArray constructors
    const typedArrays = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array']
    if (typedArrays.includes(name)) {
      includeModule('ptr'); includeModule('typed')
      return ['()', `new.${name}`, ...ctorArgs.map(prep)]
    }
    // Set/Map constructors
    if (name === 'Set' || name === 'Map') {
      includeModule('ptr'); includeModule('collection')
      return ['()', `new.${name}`, ...ctorArgs.map(prep)]
    }

    const mod = ctx.scope[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

// Namespace → module mapping (namespaces that share a module)
const MOD_ALIAS = { Number: 'core', Array: 'core', Object: 'core', Symbol: 'symbol' }
// Modules that must be loaded before another module
const MOD_DEPS = { core: ['ptr'], symbol: ['ptr'] }

function includeModule(name) {
  const modName = MOD_ALIAS[name] || name
  const init = mods[modName]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.modules[modName]) return
  for (const dep of MOD_DEPS[modName] || []) includeModule(dep)
  init(ctx)
  ctx.modules[modName] = true
}

function defFunc(name, node) {
  if (!Array.isArray(node) || node[0] !== '=>') return false
  // Only extract top-level functions, not nested (closures stay as values)
  if (depth > 0) return false
  const [, rawParams, body] = node
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  const raw = Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : p ? [p] : []

  // Extract param names and defaults: 'x' or ['=', 'x', default] or ['...', 'args']
  const params = [], defaults = {}, hasRest = []
  for (const r of raw) {
    if (Array.isArray(r) && r[0] === '...') {
      // Rest param: ['...', 'name'] → array parameter
      hasRest.push(r[1])
      params.push({ name: r[1], type: 'f64', rest: true })
    } else if (Array.isArray(r) && r[0] === '=') {
      params.push({ name: r[1], type: 'f64' })
      defaults[r[1]] = prep(r[2])
    } else {
      params.push({ name: r, type: 'f64' })
    }
  }

  const sig = { params, results: detectResults(body) }
  const hasDefaults = Object.keys(defaults).length > 0
  const funcInfo = { name, body, exported: !!ctx.exports[name], sig, ...(hasDefaults && { defaults }) }
  if (hasRest.length) funcInfo.rest = hasRest[0]  // track rest param name
  ctx.funcs.push(funcInfo)
  return true
}

// Multi-value threshold: ≤8 elements = tuple (multi-value return), >8 = memory array
const MAX_MULTI = 8

/** Detect return arity from function body. */
function detectResults(body) {
  // Expression body: [e1, e2, ...] → multi-return if ≤ threshold
  if (Array.isArray(body) && body[0] === '[' && body.length > 2) {
    const n = body.length - 1
    if (n <= MAX_MULTI) return Array(n).fill('f64')
  }
  // Block body: scan return statements
  if (Array.isArray(body) && body[0] === '{}') {
    const rets = []
    collectReturns(body, rets)
    if (rets.length) {
      const n = rets[0]
      if (n > 1 && n <= MAX_MULTI && rets.every(r => r === n)) return Array(n).fill('f64')
    }
  }
  return ['f64']
}

/** Collect return value arities from block AST. */
function collectReturns(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === 'return') {
    const val = node[1]
    out.push(Array.isArray(val) && val[0] === '[' && val.length > 2 ? val.length - 1 : 1)
    return
  }
  for (let i = 1; i < node.length; i++) collectReturns(node[i], out)
}

const isLit = n => Array.isArray(n) && n[0] == null

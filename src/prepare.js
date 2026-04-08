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

import { parse } from 'subscript/jessie'
import { ctx, err, derive } from './ctx.js'
import { T } from './compile.js'
import * as mods from '../module/index.js'

let depth = 0  // arrow nesting depth (0=top-level, >0=inside function)
let scopes = []  // block scope stack: [{names: Set, renames: Map}]

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
  scopes = []
  return prep(node)
}

// Named constants → numeric literals
export const JZ_NULL = Symbol('null')
const CONSTANTS = { 'true': 1, 'false': 0, 'null': JZ_NULL, 'undefined': JZ_NULL }
// NaN/Infinity stay as special f64 values in emit()
const F64_CONSTANTS = { 'NaN': NaN, 'Infinity': Infinity }

/** Resolve variable name through block scope chain (innermost rename wins). */
function resolveScope(name) {
  for (let i = scopes.length - 1; i >= 0; i--)
    if (scopes[i].has(name)) return scopes[i].get(name)
  return name
}

/** Check if name is declared in any current scope level. */
function isDeclared(name) {
  return scopes.some(s => s.has(name))
}

/** Map JS typeof strings to jz type checks. */
const TYPEOF_MAP = { 'number': -1, 'string': -2, 'object': 6, 'undefined': -3, 'boolean': -4 }
function resolveTypeof(node) {
  const [op, a, b] = node
  // typeof x == 'string' → type check
  if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null && typeof b[1] === 'string') {
    const code = TYPEOF_MAP[b[1]]
    if (code != null) return [op, ['typeof', a[1]], [, code]]
  }
  // 'string' == typeof x
  if (Array.isArray(b) && b[0] === 'typeof' && Array.isArray(a) && a[0] == null && typeof a[1] === 'string') {
    const code = TYPEOF_MAP[a[1]]
    if (code != null) return [op, ['typeof', b[1]], [, code]]
  }
  return node
}

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
      // Block scope: resolve renames
      if (scopes.length) return resolveScope(node)
    }
    return node
  }

  const [op, ...args] = node
  if (op == null) {
    if (typeof args[0] === 'string') {
      includeModule('core')
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
  JSON: 'JSON',
  isNaN: 'number',
  isFinite: 'number',
  parseInt: 'number',
  Error: 'Error',
  BigInt: 'BigInt',
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
      const tmp = `${T}d${ctx.uniq++}`
      rest.push(['=', tmp, normed])
      for (let j = 0; j < items.length; j++)
        if (items[j] != null) rest.push(['=', items[j], ['[]', tmp, [, j]]])
      continue
    }

    // Object destructuring: let {x, y} = expr → let __tmp = expr; let x = __tmp.x; let y = __tmp.y
    if (Array.isArray(name) && name[0] === '{}') {
      const items = name[1]?.[0] === ',' ? name[1].slice(1) : [name[1]]
      const tmp = `${T}d${ctx.uniq++}`
      rest.push(['=', tmp, normed])
      for (const item of items) {
        if (typeof item === 'string') rest.push(['=', item, ['.', tmp, item]])
        // Alias: {x: a} → a = tmp.x
        else if (Array.isArray(item) && item[0] === ':') rest.push(['=', item[2], ['.', tmp, item[1]]])
        // Default: {x = val} → x = tmp.x ?? val (use nullish coalescing)
        else if (Array.isArray(item) && item[0] === '=' && typeof item[1] === 'string')
          rest.push(['=', item[1], ['??', ['.', tmp, item[1]], item[2]]])
      }
      continue
    }

    if (!defFunc(name, normed)) {
      let declName = name
      // Block scope: rename if shadowing an outer declaration
      if (typeof name === 'string' && scopes.length > 0 && isDeclared(name)) {
        declName = `${name}${T}${ctx.uniq++}`
        scopes[scopes.length - 1].set(name, declName)
      } else if (typeof name === 'string' && scopes.length > 0) {
        scopes[scopes.length - 1].set(name, name)
      }
      // Track object schemas
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
        const props = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (props.length && ctx.schema.register) ctx.schema.vars.set(declName, ctx.schema.register(props))
      }
      // Track const for reassignment checks
      if (op === 'const' && typeof declName === 'string') {
        if (!ctx.consts) ctx.consts = new Set()
        ctx.consts.add(declName)
      }
      // Module-scope variable → WASM global (mark as user-declared)
      if (depth === 0 && typeof declName === 'string') {
        ctx.globals.set(declName, `(global $${declName} (mut f64) (f64.const 0))`)
        ctx.userGlobals.add(declName)
      }
      rest.push(['=', declName, normed])
    }
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

  // Function property assignment: fn.prop = arrow → extract as top-level function fn$prop
  '='(lhs, rhs) {
    if (depth === 0 && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string'
      && ctx.funcs.some(f => f.name === lhs[1]) && Array.isArray(rhs) && rhs[0] === '=>') {
      const name = `${lhs[1]}$${lhs[2]}`
      if (defFunc(name, prep(rhs))) return null  // extracted as function, no assignment needed
    }
    return ['=', prep(lhs), prep(rhs)]
  },

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
    includeModule('core')
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

    // Tier 1: Built-in module
    if (mods[MOD_ALIAS[mod] || mod]) {
      includeModule(mod)
      const bind = (name, alias) => {
        const key = mod + '.' + name
        if (!ctx.emit[key]) err(`Unknown import: ${name} from '${mod}'`)
        ctx.scope[alias || name] = key
      }
      if (typeof specifiers === 'string') { ctx.scope[specifiers] = mod; return null }
      if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') { ctx.scope[specifiers[2]] = mod; return null }
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
        for (const item of items)
          if (typeof item === 'string') bind(item)
          else if (Array.isArray(item) && item[0] === 'as') bind(item[1], item[2])
          else err(`Invalid import specifier: ${JSON.stringify(item)}`)
      }
      return null
    }

    // Tier 2: Source module (bundling)
    if (ctx.importSources?.[mod]) {
      const resolved = prepareModule(mod, ctx.importSources[mod])
      // Default import: import name from 'mod' → bind to default export
      if (typeof specifiers === 'string') {
        const mangled = resolved.exports.get('default')
        if (!mangled) err(`'${mod}' has no default export`)
        ctx.scope[specifiers] = mangled
        return null
      }
      // Named imports: import { a, b } from 'mod'
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const mangled = resolved.exports.get(name)
          if (!mangled) err(`'${name}' is not exported from '${mod}'`)
          ctx.scope[alias] = mangled
        }
      }
      return null
    }

    // Tier 3: Host imports
    if (ctx.hostImports?.[mod]) {
      const hostMod = ctx.hostImports[mod]
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (!spec) err(`'${name}' not declared in host module '${mod}'`)
          const nParams = typeof spec === 'function' ? spec.length : (spec?.params || 0)
          const params = Array(nParams).fill(['param', 'f64'])
          ctx.imports.push(['import', `"${mod}"`, `"${name}"`, ['func', `$${alias}`, ...params, ['result', 'f64']]])
        }
      }
      return null
    }

    err(`Unknown module '${mod}'. Provide it via { modules: { '${mod}': source } } or { imports: { '${mod}': {...} } }`)
  },

  // === is == in jz (all comparisons are strict). Also handle typeof x === 'type' patterns.
  '==='(a, b) { return prep(resolveTypeof(['==', a, b])) },
  '!=='(a, b) { return prep(resolveTypeof(['!=', a, b])) },

  // Statements
  ';': (...stmts) => [';', ...stmts.map(prep).filter(x => x != null)],
  'let': (...inits) => prepDecl('let', ...inits),
  'const': (...inits) => prepDecl('const', ...inits),

  // Block-scoped control flow: push scope for bodies so inner let/const shadows correctly
  'if': (cond, then, els) => {
    const c = prep(cond)
    scopes.push(new Map()); const t = prep(then); scopes.pop()
    if (els != null) { scopes.push(new Map()); const e = prep(els); scopes.pop(); return ['if', c, t, e] }
    return ['if', c, t]
  },
  'while': (cond, body) => {
    const c = prep(cond)
    scopes.push(new Map()); const b = prep(body); scopes.pop()
    return ['while', c, b]
  },

  'export': decl => {
    if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const'))
      for (const i of decl.slice(1))
        if (Array.isArray(i) && i[0] === '=' && typeof i[1] === 'string')
          ctx.exports[i[1]] = true
    // export default expr → mark 'default' export, rewrite to assignment
    if (Array.isArray(decl) && decl[0] === 'default') {
      const val = decl[1]
      // export default name → export existing name as 'default'
      if (typeof val === 'string' && (ctx.funcs.some(f => f.name === val) || ctx.globals.has(val))) {
        ctx.exports['default'] = val  // alias
        return null
      }
      // export default arrow → create function named 'default'
      ctx.exports['default'] = true
      if (Array.isArray(val) && val[0] === '=>') {
        if (defFunc('default', val)) return null
      }
      // export default expr → create global 'default'
      ctx.globals.set('default', `(global $default (mut f64) (f64.const 0))`)
      ctx.userGlobals.add('default')
      return ['=', 'default', prep(val)]
    }
    return prep(decl)
  },

  // Arrow: don't prep params. Track depth for nested function detection.
  '=>': (params, body) => {
    if (depth > 0) { includeModule('core'); includeModule('fn') }
    depth++
    // Push function scope with param names
    const fnScope = new Map()
    const rawP = Array.isArray(params) && params[0] === '()' ? params[1] : params
    const pList = rawP == null ? [] : Array.isArray(rawP) ? (rawP[0] === ',' ? rawP.slice(1) : [rawP]) : [rawP]
    for (const p of pList) {
      const name = Array.isArray(p) && p[0] === '=' ? p[1] : Array.isArray(p) && p[0] === '...' ? p[1] : p
      if (typeof name === 'string') fnScope.set(name, name)
    }
    scopes.push(fnScope)
    const result = ['=>', params, prep(body)]
    scopes.pop()
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
  '?.'(obj, prop) { includeModule('core'); includeModule('string'); includeModule('collection'); return ['?.', prep(obj), prop] },
  '?.[]'(obj, idx) { includeModule('core'); includeModule('array'); return ['?.[]', prep(obj), prep(idx)] },
  'typeof'(a) { includeModule('core'); return ['typeof', prep(a)] },

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
  '++'(a, _post) { const n = prep(a); return _post !== undefined ? ['-', ['++', n], [, 1]] : ['++', n] },
  '--'(a, _post) { const n = prep(a); return _post !== undefined ? ['+', ['--', n], [, 1]] : ['--', n] },

  // Regex literal: ['//','pattern','flags?'] → include regex module, pass through
  '//'(pattern, flags) {
    includeModule('core'); includeModule('string'); includeModule('regex')
    return ['//', pattern, flags]
  },

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
      // Bundled import: resolved name is a known function → use as callee directly
      else if (resolved && ctx.funcs.some(f => f.name === resolved)) callee = resolved
      // Bare constructor call: Symbol('foo') → include module, keep callee as-is
      else if (resolved && !resolved.includes('.')) includeModule(resolved)
      // Calling an unknown name inside a function body (e.g. a parameter) → needs call_indirect
      else if (depth > 0 && !resolved && !ctx.exports[callee]
        && !ctx.imports.some(i => i[3]?.[1] === `$${callee}`))
        { includeModule('core'); includeModule('fn') }
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      // console.log/warn/error → WASI module
      if (obj === 'console' && (prop === 'log' || prop === 'warn' || prop === 'error')) {
        includeModule('core'); includeModule('string'); includeModule('number'); includeModule('console')
        callee = `console.${prop}`
      // Date.now / performance.now → WASI clock_time_get
      } else if ((obj === 'Date' && prop === 'now') || (obj === 'performance' && prop === 'now')) {
        includeModule('core'); includeModule('console')
        callee = `${obj}.${prop}`
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
        includeModule('core'); includeModule('string'); includeModule('number')
      }
    }
    if (callee === 'String') { includeModule('core'); includeModule('string'); includeModule('number') }
    if (callee === 'Number') { includeModule('number') }
    if (callee === 'Error') { includeModule('core'); includeModule('string') }
    if (callee === 'BigInt') { includeModule('number') }
    // String.fromCharCode / fromCodePoint → include string module
    if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'String'
      && (callee[2] === 'fromCharCode' || callee[2] === 'fromCodePoint')) {
      includeModule('core'); includeModule('string')
      callee = `String.${callee[2]}`
    }
    // BigInt.asIntN / BigInt.asUintN → include number module
    if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'BigInt' && (callee[2] === 'asIntN' || callee[2] === 'asUintN')) {
      includeModule('number')
      callee = `BigInt.${callee[2]}`
    }
    // TypedArray.from → include typedarray module
    if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'from') {
      const typedArrays = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array']
      if (typedArrays.includes(callee[1])) {
        includeModule('core'); includeModule('typedarray'); includeModule('array')
        callee = `${callee[1]}.from`
      }
    }
    const preppedArgs = args.filter(a => a != null).map(prep)
    // If any argument is a known top-level function name, include fn module for call_indirect
    for (const a of preppedArgs)
      if (typeof a === 'string' && ctx.funcs.some(f => f.name === a))
        { includeModule('core'); includeModule('fn'); break }
    const result = ['()', callee, ...preppedArgs]

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
      includeModule('core')
      includeModule('array')
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',') return ['[', ...inner.slice(1).map(prep)]
      return ['[', prep(inner)]
    }
    includeModule('core')
    includeModule('array')
    return ['[]', prep(args[0]), prep(args[1])]
  },

  // Bare block statement: push scope for let/const shadowing
  '{'(inner) {
    scopes.push(new Map())
    const result = ['{', prep(inner)]
    scopes.pop()
    return result
  },

  // Object literal - flatten comma, expand shorthand
  '{}'(inner) {
    // Detect block body vs object literal
    if (Array.isArray(inner) && [';', 'return', 'if', 'for', 'while', 'let', 'const', 'break', 'continue', 'switch'].includes(inner[0])) {
      // Block body: push block scope for let/const shadowing
      scopes.push(new Map())
      const result = ['{}', prep(inner)]
      scopes.pop()
      return result
    }

    includeModule('core')
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
    scopes.push(new Map())
    let r
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      r = ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? prep(step) : null, prep(body)]
    } else if (Array.isArray(head) && head[0] === 'of') {
      // for (let x of arr) → for (let __i=0; __i<arr.length; __i++) { let x = arr[__i]; body }
      const [, decl, src] = head
      const varName = Array.isArray(decl) && decl[0] === 'let' ? decl[1] : decl
      const idx = `${T}i${ctx.uniq++}`
      const init = ['let', ['=', idx, [, 0]]]
      const cond = ['<', idx, ['.', src, 'length']]
      const step = ['++', idx]
      const inner = [';', ['let', ['=', varName, ['[]', src, idx]]], body]
      r = prep(['for', [';', init, cond, step], inner])
    } else if (Array.isArray(head) && head[0] === 'in') {
      // for (let k in obj) → unroll at compile time with string keys
      const [, decl, src] = head
      const varName = Array.isArray(decl) && decl[0] === 'let' ? decl[1] : decl
      const sid = typeof src === 'string' && ctx.schema.vars.get(src)
      if (sid == null) err(`for...in requires a known object schema — declare the shape first`)
      const keys = ctx.schema.list[sid]
      if (!keys || !keys.length) { scopes.pop(); return null }
      includeModule('core'); includeModule('string')
      // Unroll: for each key, bind k as string, execute body
      const stmts = []
      for (let i = 0; i < keys.length; i++) {
        stmts.push(i === 0
          ? ['let', ['=', varName, [, keys[i]]]]  // string literal
          : ['=', varName, [, keys[i]]])
        stmts.push(body)
      }
      r = prep([';', ...stmts])
    } else {
      r = ['for', prep(head), prep(body)]
    }
    scopes.pop()
    return r
  },

  // Property access - resolve namespaces or object/array properties
  '.'(obj, prop) {
    const mod = ctx.scope[obj]
    if (typeof obj === 'string' && mod && !mod.includes('.'))
      return includeModule(mod), mod + '.' + prop
    includeModule('core')
    includeModule('object')
    includeModule('array')
    includeModule('string')
    includeModule('collection')
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }

    // TypedArray constructors
    const typedArrays = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array']
    if (typedArrays.includes(name)) {
      includeModule('core'); includeModule('typedarray')
      return ['()', `new.${name}`, ...ctorArgs.map(prep)]
    }
    // Set/Map constructors
    if (name === 'Set' || name === 'Map') {
      includeModule('core'); includeModule('collection')
      return ['()', `new.${name}`, ...ctorArgs.map(prep)]
    }

    const mod = ctx.scope[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

// Namespace → module mapping (namespaces that share a module)
const MOD_ALIAS = { Number: 'number', Array: 'array', Object: 'object', Symbol: 'symbol', JSON: 'json', BigInt: 'number', Error: 'core' }
const MOD_DEPS = {
  number: ['core', 'string'],
  string: ['core', 'number'],
  array: ['core'],
  object: ['core'],
  symbol: ['core'],
  json: ['core', 'string', 'number', 'collection'],
  console: ['core', 'string', 'number'],
  regex: ['core', 'string', 'array'],
}

function includeModule(name) {
  const modName = MOD_ALIAS[name] || name
  const init = mods[modName]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.modules[modName]) return
  ctx.modules[modName] = true  // guard before deps (prevents circular)
  for (const dep of MOD_DEPS[modName] || []) includeModule(dep)
  init(ctx)
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
      const defVal = prep(r[2])
      defaults[r[1]] = defVal
      // Object literal default → register schema for param (explicit shape declaration)
      if (Array.isArray(defVal) && defVal[0] === '{}' && defVal.length > 1 && ctx.schema.register) {
        const props = defVal.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (props.length) ctx.schema.vars.set(r[1], ctx.schema.register(props))
      }
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

/** Compile-time bundling: parse + prepare an imported module, collect exports. */
function prepareModule(specifier, source) {
  // Cycle detection
  if (ctx.moduleStack.includes(specifier))
    err(`Circular import: ${ctx.moduleStack.join(' -> ')} -> ${specifier}`)
  // Already resolved
  if (ctx.resolvedModules.has(specifier)) return ctx.resolvedModules.get(specifier)

  ctx.moduleStack.push(specifier)

  // Name mangling prefix: ./math.jz → _math_jz
  const prefix = specifier.replace(/[^a-zA-Z0-9]/g, '_')

  // Save caller state
  const savedScope = ctx.scope, savedExports = ctx.exports
  ctx.scope = derive(savedScope)  // inherit parent scope
  ctx.exports = {}

  // Parse + prepare imported source (may trigger recursive imports)
  let ast = parse(source)
  if (ctx.jzify) ast = ctx.jzify(ast)
  const savedDepth = depth; depth = 0
  prep(ast)
  depth = savedDepth

  // Collect exports: rename exported funcs with prefix
  const moduleExports = new Map()
  for (const name of Object.keys(ctx.exports)) {
    const val = ctx.exports[name]
    // Default export alias: export default existingName → map 'default' to that name's mangled form
    if (name === 'default' && typeof val === 'string') {
      // Will resolve after all named exports are mangled
      continue
    }
    const mangled = `${prefix}$${name}`
    moduleExports.set(name, mangled)
    // Rename the function in ctx.funcs
    const func = ctx.funcs.find(f => f.name === name)
    if (func) func.name = mangled
    // Rename globals
    if (ctx.globals.has(name)) {
      const wat = ctx.globals.get(name).replace(`$${name}`, `$${mangled}`)
      ctx.globals.delete(name)
      ctx.globals.set(mangled, wat)
      if (ctx.userGlobals.has(name)) { ctx.userGlobals.delete(name); ctx.userGlobals.add(mangled) }
      if (ctx.globalTypes.has(name)) { ctx.globalTypes.set(mangled, ctx.globalTypes.get(name)); ctx.globalTypes.delete(name) }
    }
  }
  // Resolve default export alias after named exports are mangled
  if (typeof ctx.exports['default'] === 'string') {
    const alias = ctx.exports['default']
    if (moduleExports.has(alias)) {
      // Already renamed as a named export
      moduleExports.set('default', moduleExports.get(alias))
    } else {
      // Not a named export — rename the function/global
      const mangled = `${prefix}$${alias}`
      moduleExports.set('default', mangled)
      const func = ctx.funcs.find(f => f.name === alias)
      if (func) func.name = mangled
      if (ctx.globals.has(alias)) {
        const wat = ctx.globals.get(alias).replace(`$${alias}`, `$${mangled}`)
        ctx.globals.delete(alias)
        ctx.globals.set(mangled, wat)
        if (ctx.userGlobals.has(alias)) { ctx.userGlobals.delete(alias); ctx.userGlobals.add(mangled) }
      }
    }
  }

  // Restore caller state
  ctx.scope = savedScope
  ctx.exports = savedExports
  ctx.moduleStack.pop()

  const result = { exports: moduleExports }
  ctx.resolvedModules.set(specifier, result)
  return result
}

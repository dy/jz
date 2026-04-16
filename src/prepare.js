/**
 * AST preparation: single-pass traversal that validates, resolves, and normalizes.
 *
 * Distinct concerns, applied per-node via a handler table:
 *   1. Validate      — reject prohibited features (this, class, async, var, delete, ...)
 *   2. Resolve       — scope chain + import bindings (Math.sin → math.sin, etc.)
 *   3. Extract       — arrow functions → ctx.func.list with sig
 *   4. Normalize     — ++/-- → +=/-=, unary ± disambiguation, for-head flattening
 *   5. Auto-import   — Math/Array/etc usage triggers includeModule(...)
 *   6. Track schemas — object literals, Object.assign inference (inferAssignSchema)
 *
 * Each handler may touch multiple concerns, but helpers keep each concern self-contained.
 * Unhandled ops fall through to recursive prep() of their children.
 *
 * @module prepare
 */

import { parse } from 'subscript/jessie'
import { ctx, err, derive, PTR } from './ctx.js'
import { T, extractParams, collectParamNames, classifyParam } from './compile.js'
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
  includeModule('core')
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
const TYPEOF_MAP = { 'number': -1, 'string': -2, 'object': PTR.OBJECT, 'undefined': -3, 'boolean': -4 }
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

const OP_MODULES = {
  '.': ['core', 'object', 'array', 'string', 'collection'],
  '?.': ['core', 'string', 'collection'],
  '?.[]': ['core', 'array', 'collection'],
  '?.()': ['core'],
  'u+': ['number', 'string'],
  'in': ['core', 'collection', 'string'],
  '==': ['core', 'string'],
  '!=': ['core', 'string'],
  'typeof': ['core'],
  '[': ['core', 'array'],
  '{': ['core', 'object', 'string', 'collection'],
  '//': ['core', 'string', 'regex'],
}

const BUILTIN_MODULES = {
  'ArrayBuffer': ['core', 'typedarray'],
  'DataView': ['core', 'typedarray'],
  'BigInt64Array': ['core', 'typedarray'],
  'BigUint64Array': ['core', 'typedarray'],
  'parseFloat': ['number', 'string'],
  'parseInt': ['number', 'string'],
  'String': ['core', 'string', 'number'],
  'Number': ['number', 'string'],
  'Boolean': ['number'],
  'TextEncoder': ['core', 'string'],
  'TextDecoder': ['core', 'string'],
  'Error': ['core', 'string'],
  'BigInt': ['number'],
  'Object.fromEntries': ['collection', 'string'],
  'Object.keys': ['string'],
  'Object.entries': ['string']
}

const dict = obj => Object.assign(Object.create(null), obj)

const cloneNode = (node) => {
  if (!Array.isArray(node)) return node
  const copy = node.map(cloneNode)
  if (node.loc != null) copy.loc = node.loc
  return copy
}

const STATIC_METHOD_MODULES = dict({
  'console': dict({ 'log': ['core', 'string', 'number', 'console'], 'warn': ['core', 'string', 'number', 'console'], 'error': ['core', 'string', 'number', 'console'] }),
  'Object': dict({ 'fromEntries': ['collection', 'string'], 'keys': ['string'], 'entries': ['string'] }),
  'Date': dict({ 'now': ['core', 'console'] }),
  'performance': dict({ 'now': ['core', 'console'] }),
  'String': dict({ 'fromCharCode': ['core', 'string'], 'fromCodePoint': ['core', 'string'] }),
  'BigInt': dict({ 'asIntN': ['number'], 'asUintN': ['number'] }),
  'Float64Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Float32Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Int32Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Uint32Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Int16Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Uint16Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Int8Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'Uint8Array': dict({ 'from': ['core', 'typedarray', 'array'] }),
  'ArrayBuffer': dict({ 'isView': ['core', 'typedarray'] })
})

const GENERIC_METHOD_MODULES = dict({
  'toString': ['core', 'string', 'number'],
  'toFixed': ['core', 'string', 'number'],
  'toPrecision': ['core', 'string', 'number'],
  'toExponential': ['core', 'string', 'number'],
})

const CTORS = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','BigInt64Array','BigUint64Array','Set','Map']

function prep(node) {
  if (Array.isArray(node) && OP_MODULES[node[0]]) includeMods(...OP_MODULES[node[0]])
  if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
  if (node == null) return [, 0] // null/undefined → 0 literal
  if (node === true) return [, 1]
  if (node === false) return [, 0]
  if (!Array.isArray(node)) {
    if (typeof node === 'string') {
      if (node in CONSTANTS) return [, CONSTANTS[node]]
      if (node in F64_CONSTANTS) return [, F64_CONSTANTS[node]]
      if (PROHIBITED[node]) err(PROHIBITED[node])
      // Boolean/Number as value → identity arrow (for .filter(Boolean), .map(Number) etc.)
      if (node === 'Boolean' || node === 'Number') { includeMods('core', 'fn'); return ['=>', 'x', 'x'] }
      const resolved = ctx.scope.chain[node]
      if (resolved?.includes('.')) return resolved
      // Cross-module import: mangled name (e.g. __util_js$clone)
      if (resolved && resolved !== node) return resolved
      // Block scope: resolve renames
      if (scopes.length) return resolveScope(node)
    }
    return node
  }

  const [op, ...args] = node
  if (op == null) {
    if (typeof args[0] === 'string') {
      includeMods('core', 'string', 'number')
      return ['str', args[0]]  // string literal
    }
    return [, args[0]]  // number literal
  }
  const handler = handlers[op]
  return handler ? handler(...args) : [op, ...args.map(prep)]
}

const PROHIBITED = { 'with': '`with` not supported', 'class': '`class` not supported', 'yield': '`yield` not supported',
  'this': '`this` not supported: use explicit parameter',
  'super': '`super` not supported: no class inheritance',
  'arguments': '`arguments` not supported: use rest params',
  'eval': '`eval` not supported'
}

// Global namespaces for scope resolution (value = scope alias used in ctx.core.emit[])
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
  parseFloat: 'number',
  Error: 'Error',
  BigInt: 'BigInt',
  TextEncoder: 'TextEncoder',
  TextDecoder: 'TextDecoder',
}

/** Prepare let/const declaration. */
function prepDecl(op, ...inits) {
  const rest = []
  for (const i of inits) {
    if (!Array.isArray(i) || i[0] !== '=') { rest.push(i); continue }
    const [, name, init] = i, normed = prep(init)

    // Array destructuring: let [a, b] = expr → let __tmp = expr; let a = __tmp[0]; let b = __tmp[1]
    if (Array.isArray(name) && name[0] === '[]') {
      includeMods('core', 'array', 'collection')
      const items = name[1]?.[0] === ',' ? name[1].slice(1) : [name[1]]
      const tmp = `${T}d${ctx.func.uniq++}`
      rest.push(['=', tmp, normed])
      for (let j = 0; j < items.length; j++) {
        if (items[j] == null) continue
        // Default: [a = val] → a = __tmp[j] ?? val
        if (Array.isArray(items[j]) && items[j][0] === '=' && typeof items[j][1] === 'string')
          rest.push(['=', items[j][1], ['??', ['[]', tmp, [, j]], prep(items[j][2])]])
        // Rest: [...a] → a = __tmp.slice(j)
        else if (Array.isArray(items[j]) && items[j][0] === '...')
          rest.push(['=', items[j][1], ['()', ['.', tmp, 'slice'], [, j]]])
        else if (Array.isArray(items[j]) && (items[j][0] === '[]' || items[j][0] === '{}')) {
          const nested = prepDecl(op, ['=', items[j], ['[]', tmp, [, j]]])
          if (nested) rest.push(...nested.slice(1))
        }
        else
          rest.push(['=', items[j], ['[]', tmp, [, j]]])
      }
      continue
    }

    // Object destructuring: let {x, y} = expr → let __tmp = expr; let x = __tmp.x; let y = __tmp.y
    if (Array.isArray(name) && name[0] === '{}') {
      includeMods('core', 'object', 'string', 'collection')
      const items = name[1]?.[0] === ',' ? name[1].slice(1) : [name[1]]
      const tmp = `${T}d${ctx.func.uniq++}`
      rest.push(['=', tmp, normed])
      for (const item of items) {
        if (typeof item === 'string') rest.push(['=', item, ['.', tmp, item]])
        // Alias: {x: a} → a = tmp.x
        else if (Array.isArray(item) && item[0] === ':') rest.push(['=', item[2], ['.', tmp, item[1]]])
        // Default: {x = val} → x = tmp.x ?? val (use nullish coalescing)
        else if (Array.isArray(item) && item[0] === '=' && typeof item[1] === 'string')
          rest.push(['=', item[1], ['??', ['.', tmp, item[1]], prep(item[2])]])
      }
      continue
    }

    if (!defFunc(name, normed)) {
      let declName = name
      // Block scope: rename if shadowing an outer declaration
      if (typeof name === 'string' && scopes.length > 0 && isDeclared(name)) {
        declName = `${name}${T}${ctx.func.uniq++}`
        scopes[scopes.length - 1].set(name, declName)
      } else if (typeof name === 'string' && scopes.length > 0) {
        scopes[scopes.length - 1].set(name, name)
      }
      // Track const for reassignment checks — only module-scope consts (depth 0)
      if (typeof declName === 'string' && depth === 0) {
        if (ctx.module.currentPrefix) {
          declName = `${ctx.module.currentPrefix}$${declName}`
          ctx.scope.chain[name] = declName
        }
        if (op === 'const') {
          if (!ctx.scope.consts) ctx.scope.consts = new Set()
          ctx.scope.consts.add(declName)
        } else if (op === 'let' && ctx.scope.consts?.has(declName)) {
          ctx.scope.consts.delete(declName)
        }
      }
      // Track object schemas (after prefix so schema is keyed to final name)
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
        const props = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (props.length && ctx.schema.register) ctx.schema.vars.set(declName, ctx.schema.register(props))
      }
      // Module-scope variable → WASM global (mark as user-declared)
      if (depth === 0 && typeof declName === 'string') {
        if (ctx.scope.globals.has(declName)) err(`'${declName}' conflicts with a compiler internal — choose a different name`)
        ctx.scope.globals.set(declName, `(global $${declName} (mut f64) (f64.const 0))`)
        ctx.scope.userGlobals.add(declName)
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
  'in'(key, obj) { return ['in', prep(key), prep(obj)] },
  'instanceof': () => err('instanceof not supported: use typeof'),
  'with': () => err('`with` not supported: deprecated'),
  ':': () => err('labeled statements not supported'),
  'var': () => err('`var` not supported: use let/const'),
  'function': () => err('`function` not supported: use arrow functions'),

  // Destructuring assignment: [a, ...b] = expr or {x, y} = expr
  '='(lhs, rhs) {
    // Array destructuring assignment: [a, b, ...rest] = expr (not arr[idx] = val)
    // Distinguishing: destructuring has ['[]', [',', ...items]] or ['[]', name], index has ['[]', arr, idx]
    if (Array.isArray(lhs) && lhs[0] === '[]' && lhs.length === 2) {
      includeMods('core', 'array')
      const items = lhs[1]?.[0] === ',' ? lhs[1].slice(1) : [lhs[1]]
      const normed = prep(rhs)
      const tmp = `${T}d${ctx.func.uniq++}`
      const stmts = [['let', ['=', tmp, normed]]]
      for (let j = 0; j < items.length; j++) {
        if (items[j] == null) continue
        if (Array.isArray(items[j]) && items[j][0] === '...')
          stmts.push(['=', items[j][1], ['()', ['.', tmp, 'slice'], [, j]]])
        else
          stmts.push(['=', items[j], ['[]', tmp, [, j]]])
      }
      return prep([';', ...stmts])
    }
    // Parser ambiguity: }[pattern] = rhs mis-parsed as subscript when it's stmt; [pattern] = rhs
    // Detect: ['[]', stmtExpr, commaExpr] with spread in comma → split into stmt + destructuring
    if (Array.isArray(lhs) && lhs[0] === '[]' && lhs.length === 3) {
      const hasSpr = n => Array.isArray(n) && (n[0] === '...' || n.some(hasSpr))
      if (hasSpr(lhs[2])) {
        const preStmt = lhs[1]
        const pattern = ['[]', lhs[2]]
        return prep([';', preStmt, ['=', pattern, rhs]])
      }
    }
    // Function property assignment: fn.prop = arrow → extract as top-level function fn$prop
    if (depth === 0 && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string'
      && ctx.func.list.some(f => f.name === lhs[1]) && Array.isArray(rhs) && rhs[0] === '=>') {
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
    includeMods('core', 'string', 'number')
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
        if (!ctx.core.emit[key]) err(`Unknown import: ${name} from '${mod}'`)
        ctx.scope.chain[alias || name] = key
      }

      if (typeof specifiers === 'string') { ctx.scope.chain[specifiers] = mod; return null }
      if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') { ctx.scope.chain[specifiers[2]] = mod; return null }

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
    if (ctx.module.importSources?.[mod]) {
      const resolved = prepareModule(mod, ctx.module.importSources[mod])
      // Default import: import name from 'mod' → bind to default export
      if (typeof specifiers === 'string') {
        const mangled = resolved.exports.get('default')
        if (!mangled) err(`'${mod}' has no default export`)
        ctx.scope.chain[specifiers] = mangled
        return null
      }
      // Namespace import: import * as X from 'mod' → bind X.prop to mangled names
      if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') {
        const alias = specifiers[2]
        // Store namespace mapping so '.' handler can resolve X.prop → mangled name
        if (!ctx.module.namespaces) ctx.module.namespaces = {}
        ctx.module.namespaces[alias] = resolved.exports
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
          ctx.scope.chain[alias] = mangled
        }
      }
      return null
    }

    // Tier 3: Host imports
    if (ctx.module.hostImports?.[mod]) {
      const hostMod = ctx.module.hostImports[mod]
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
          ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, ['func', `$${alias}`, ...params, ['result', 'f64']]])
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
          ctx.func.exports[i[1]] = true
    // export { name1, name2 as alias } → register named exports
    if (Array.isArray(decl) && decl[0] === '{}') {
      const inner = decl[1]
      if (inner == null) return null
      const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
      for (const item of items) {
        if (typeof item === 'string') {
          const resolved = ctx.scope.chain[item]
          ctx.func.exports[item] = (resolved && resolved !== item) ? resolved : item
        } else if (Array.isArray(item) && item[0] === 'as') {
          const [, source, alias] = item
          const resolved = ctx.scope.chain[source]
          ctx.func.exports[alias] = (resolved && resolved !== source) ? resolved : source
        }
      }
      return null
    }
    // export default expr → mark 'default' export, rewrite to assignment
    if (Array.isArray(decl) && decl[0] === 'default') {
      const val = decl[1]
      // export default name → export existing name as 'default'
      if (typeof val === 'string' && (ctx.func.list.some(f => f.name === val) || ctx.scope.globals.has(val))) {
        ctx.func.exports['default'] = val  // alias
        return null
      }
      // export default arrow → create function named 'default'
      ctx.func.exports['default'] = true
      if (Array.isArray(val) && val[0] === '=>') {
        if (defFunc('default', prep(val))) return null
      }
      // export default expr → create global 'default'
      ctx.scope.globals.set('default', `(global $default (mut f64) (f64.const 0))`)
      ctx.scope.userGlobals.add('default')
      return ['=', 'default', prep(val)]
    }
    return prep(decl)
  },

  // Arrow: don't prep params. Track depth for nested function detection.
  '=>': (params, body) => {
    if (depth > 0) { includeMods('core', 'fn') }
    const raw = extractParams(params)
    const fnScope = new Map()
    for (const n of collectParamNames(raw)) fnScope.set(n, n)

    depth++
    scopes.push(fnScope)

    const nextParams = []
    const bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'rest') {
        nextParams.push(r)
        if (typeof c.name === 'string') fnScope.set(c.name, c.name)
      } else if (c.kind === 'plain') {
        nextParams.push(c.name)
      } else if (c.kind === 'default') {
        nextParams.push(['=', c.name, prep(c.defValue)])
      } else {
        const tmp = `${T}p${ctx.func.uniq++}`
        fnScope.set(tmp, tmp)
        nextParams.push(c.kind === 'destruct-default' ? ['=', tmp, prep(c.defValue)] : tmp)
        bodyPrefix.push(prep(['let', ['=', c.pattern, tmp]]))
      }
    }
    let preparedBody = prep(body)
    if (bodyPrefix.length) {
      const prefix = bodyPrefix.filter(x => x != null)
      if (Array.isArray(preparedBody) && preparedBody[0] === '{}' && Array.isArray(preparedBody[1]) && preparedBody[1][0] === ';')
        preparedBody = ['{}', [';', ...prefix, ...preparedBody[1].slice(1)]]
      else if (Array.isArray(preparedBody) && preparedBody[0] === '{}')
        preparedBody = ['{}', [';', ...prefix, preparedBody[1]]]
      else
        preparedBody = ['{}', [';', ...prefix, ['return', preparedBody]]]
    }
    const inner = nextParams.length === 0 ? null : nextParams.length === 1 ? nextParams[0] : [',', ...nextParams]
    const result = ['=>', Array.isArray(params) && params[0] === '()' ? ['()', inner] : inner, preparedBody]
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
  '?.'(obj, prop) { return ['?.', prep(obj), prop] },
  '?.[]'(obj, idx) { return ['?.[]', prep(obj), prep(idx)] },
  '?.()'(callee, ...args) { return ['?.()', prep(callee), ...args.filter(a => a != null).map(prep)] },
  'typeof'(a) { return ['typeof', prep(a)] },

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
  // Property increment: obj.prop++ → obj.prop = obj.prop + 1
  '++'(a, _post) {
    const n = prep(a)
    if (Array.isArray(n) && (n[0] === '.' || n[0] === '[]')) return ['=', n, ['+', n, [, 1]]]
    return _post !== undefined ? ['-', ['++', n], [, 1]] : ['++', n]
  },
  '--'(a, _post) {
    const n = prep(a)
    if (Array.isArray(n) && (n[0] === '.' || n[0] === '[]')) return ['=', n, ['-', n, [, 1]]]
    return _post !== undefined ? ['+', ['--', n], [, 1]] : ['--', n]
  },

  // Regex literal: ['//','pattern','flags?'] → include regex module, pass through
  '//'(pattern, flags) {
    return ['//', pattern, flags]
  },

  // auto-include math for ** operator
  '**'(a, b) { includeModule('math'); return ['**', prep(a), prep(b)] },

  // Function call or grouping parens
'()'(callee, ...args) {
    // Grouping: (expr) → ['()', expr] with no args. Call: f() → ['()', 'f', null] with null arg.
    if (args.length === 0) return prep(callee)

    const hasRealArgs = args.some(a => a != null)

    if (typeof callee === 'string') {
      if (PROHIBITED[callee]) err(PROHIBITED[callee])
      if (CTORS.includes(callee)) return handlers['new'](['()', callee, ...args])

      const builtin = BUILTIN_MODULES[callee]
      if (builtin) {
        includeMods(...builtin)
        if (callee === 'BigInt64Array' || callee === 'BigUint64Array') {
          return ['()', callee, ...args.filter(a => a != null).map(prep)]
        }
      }

      const resolved = ctx.scope.chain[callee]
      if (resolved?.includes('.')) callee = resolved
      else if (resolved && ctx.func.list.some(f => f.name === resolved)) callee = resolved
      else if (resolved && !resolved.includes('.')) includeModule(resolved)
      else if (depth > 0 && !resolved && !ctx.func.exports[callee] && !ctx.module.imports.some(i => i[3]?.[1] === `$${callee}`)) {
        includeMods('core', 'fn')
      }
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      if (STATIC_METHOD_MODULES[obj]?.[prop]) {
        includeMods(...STATIC_METHOD_MODULES[obj][prop])
        callee = `${obj}.${prop}`
      } else if (GENERIC_METHOD_MODULES[prop]) {
        includeMods(...GENERIC_METHOD_MODULES[prop])
        callee = prep(callee)
      } else {
        const mod = ctx.scope.chain[obj]
        if (typeof obj === 'string' && mod && !mod.includes('.') && mods[MOD_ALIAS[mod] || mod]) {
          callee = (includeModule(mod), mod + '.' + prop)
        } else {
          callee = prep(callee)
        }
      }
    } else {
      includeMods('core', 'fn')
      callee = prep(callee)
    }

    const preppedArgs = args.filter(a => a != null).map(prep)
    for (const a of preppedArgs) {
      if (typeof a === 'string' && ctx.func.list.some(f => f.name === a)) {
        includeMods('core', 'fn'); break
      }
    }
    const result = ['()', callee, ...preppedArgs]

    if (callee === 'Object.assign' && ctx.schema.register) inferAssignSchema(result)

    return result
  },

  // Array literal/indexing — auto-include ptr + array modules
  '[]'(...args) {
    if (args.length === 1) {
      const inner = args[0]
      includeMods('core', 'array')
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',') { const items = inner.slice(1); if (items.length && items[items.length - 1] === null) items.pop(); return ['[', ...items.map(item => item == null ? [, JZ_NULL] : prep(item))] }
      return ['[', prep(inner)]
    }
    if (typeof args[0] === 'string' && ctx.module.namespaces?.[args[0]]) {
      includeMods('core', 'string')
      const key = prep(args[1])
      const exports = [...ctx.module.namespaces[args[0]].entries()]
      let fallback = [, undefined]
      for (let i = exports.length - 1; i >= 0; i--) {
        const [name, resolved] = exports[i]
        fallback = ['?:', ['==', key, ['str', name]], resolved, fallback]
      }
      return fallback
    }
    includeMods('core', 'array', 'collection')
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
    if (Array.isArray(inner) && [';', 'return', 'if', 'for', 'while', 'let', 'const', 'break', 'continue', 'switch', 'throw', 'try', 'catch', '=', '+=', '-=', '*=', '/=', '%=', '++', '--'].includes(inner[0])) {
      // Block body: push block scope for let/const shadowing
      scopes.push(new Map())
      const result = ['{}', prep(inner)]
      scopes.pop()
      return result
    }

    includeMods('core', 'object')
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
      // for (let x of arr) → hoist arr (if non-trivial) and arr.length once, iterate by index.
      // Divergence from JS: mutating arr during iteration won't extend/shorten the loop.
      // jz philosophy: explicit > implicit; mutation during iteration is a code smell.
      const [, decl, src] = head
      const varName = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const') ? decl[1] : decl
      const idx = `${T}i${ctx.func.uniq++}`
      const lenVar = `${T}len${ctx.func.uniq++}`
      const trivial = typeof src === 'string'
      const arrVar = trivial ? src : `${T}arr${ctx.func.uniq++}`
      const decls = trivial
        ? ['let', ['=', idx, [, 0]], ['=', lenVar, ['.', arrVar, 'length']]]
        : ['let', ['=', arrVar, src], ['=', idx, [, 0]], ['=', lenVar, ['.', arrVar, 'length']]]
      const cond = ['<', idx, lenVar]
      const step = ['++', idx]
      const inner = [';', ['let', ['=', varName, ['[]', arrVar, idx]]], body]
      r = prep(['for', [';', decls, cond, step], inner])
    } else if (Array.isArray(head) && head[0] === 'in') {
      // for (let k in obj) → unroll at compile time when schema known, else HASH runtime iteration
      const [, decl, src] = head
      const varName = Array.isArray(decl) && decl[0] === 'let' ? decl[1] : decl
      const srcName = typeof src === 'string' ? (ctx.scope.chain[src] || src) : null
      const sid = typeof srcName === 'string' && ctx.schema.vars.get(srcName)
      if (sid != null) {
        // Known schema → compile-time unrolling with string keys
        const keys = ctx.schema.list[sid]
        if (!keys || !keys.length) { scopes.pop(); return null }
        includeMods('core', 'string')
        const stmts = []
        for (let i = 0; i < keys.length; i++) {
          stmts.push(i === 0
            ? ['let', ['=', varName, [, keys[i]]]]
            : ['=', varName, [, keys[i]]])
          stmts.push(cloneNode(body))
        }
        r = prep([';', ...stmts])
      } else {
        // Dynamic object → HASH runtime iteration
        includeMods('core', 'string', 'collection')
        r = ['for-in', varName, prep(src), prep(body)]
      }
    } else {
      r = ['for', prep(head), prep(body)]
    }
    scopes.pop()
    return r
  },

  // Property access - resolve namespaces or object/array properties
  '.'(obj, prop) {
    const mod = ctx.scope.chain[obj]
    // Only treat as module namespace if it's a known built-in module (not a mangled import name)
    if (typeof obj === 'string' && mod && !mod.includes('.') && mods[MOD_ALIAS[mod] || mod])
      return includeModule(mod), mod + '.' + prop
    // Source module namespace: import * as X → X.prop resolved to mangled name
    if (typeof obj === 'string' && ctx.module.namespaces?.[obj]) {
      const mangled = ctx.module.namespaces[obj].get(prop)
      if (mangled) return mangled
    }
    // Typed-array/buffer properties auto-include typedarray module
    if (prop === 'byteLength' || prop === 'byteOffset' || prop === 'buffer') {
      includeMods('core', 'typedarray')
    }
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }
    // Flatten comma-grouped args: [',', a, b, c] → [a, b, c]
    if (ctorArgs.length === 1 && Array.isArray(ctorArgs[0]) && ctorArgs[0][0] === ',')
      ctorArgs = ctorArgs[0].slice(1)

    // Wrap multi-arg ctor arg lists back into a single comma-group — the '()' op
    // expects callArgs as a single element (possibly comma-grouped).
    const wrapArgs = (args) => args.length === 0 ? [null]
      : args.length === 1 ? [prep(args[0])]
      : [[',', ...args.map(prep)]]
    // TypedArray / buffer constructors
    const typedArrays = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','BigInt64Array','BigUint64Array','ArrayBuffer','DataView']
    if (typedArrays.includes(name)) {
      includeMods('core', 'typedarray')
      return ['()', `new.${name}`, ...wrapArgs(ctorArgs)]
    }
    // Set/Map constructors
    if (name === 'Set' || name === 'Map') {
      includeMods('core', 'collection')
      return ['()', `new.${name}`, ...wrapArgs(ctorArgs)]
    }

    const mod = ctx.scope.chain[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    // Unknown constructor: treat as function call (jzify already strips new for known safe ones)
    if (typeof name === 'string') return ['()', name, ...ctorArgs.map(prep)]
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

// Namespace → module mapping (namespaces that share a module)
const MOD_ALIAS = { Number: 'number', Array: 'array', Object: 'object', Symbol: 'symbol', JSON: 'json', BigInt: 'number', Error: 'core', TextEncoder: 'string', TextDecoder: 'string' }
/** Auto-inclusion graph: loading a module also loads its listed prerequisites.
 *  Not a strict ordering: module init() functions only register emitters/stdlib entries,
 *  so relative init order does not affect correctness — emitters are looked up lazily
 *  at compile time. Cycles (e.g. number ↔ string) are broken via the in-progress guard. */
const MOD_DEPS = {
  number: ['core', 'string'],
  string: ['core', 'number'],
  array: ['core'],
  object: ['core'],
  collection: ['core', 'number'],
  symbol: ['core'],
  json: ['core', 'string', 'number', 'collection'],
  console: ['core', 'string', 'number'],
  regex: ['core', 'string', 'array'],
}

const includeMods = (...names) => names.forEach(includeModule)

/** Register a module and its transitive deps. Idempotent; cycle-safe via early-mark. */
function includeModule(name) {
  const modName = MOD_ALIAS[name] || name
  const init = mods[modName]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.module.modules[modName]) return
  ctx.module.modules[modName] = true  // mark before deps so cycles terminate
  for (const dep of MOD_DEPS[modName] || []) includeModule(dep)
  init(ctx)
}

/** Merge source schemas into target via Object.assign for compile-time schema inference. */
function inferAssignSchema(callNode) {
  // After prep, args may be comma-grouped: ['()', callee, [',', target, s1, s2]]
  let assignArgs = callNode.slice(2)
  if (assignArgs.length === 1 && Array.isArray(assignArgs[0]) && assignArgs[0][0] === ',')
    assignArgs = assignArgs[0].slice(1)
  const [target, ...sources] = assignArgs
  if (typeof target !== 'string') return
  const existingId = ctx.schema.vars.get(target)
  const merged = existingId != null ? [...ctx.schema.list[existingId]] : []
  for (const src of sources) {
    let srcProps
    if (Array.isArray(src) && src[0] === '{}')
      srcProps = src.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    else if (typeof src === 'string') {
      const srcId = ctx.schema.vars.get(src)
      if (srcId != null) srcProps = ctx.schema.list[srcId]
    }
    if (srcProps) for (const p of srcProps) if (!merged.includes(p)) merged.push(p)
  }
  if (merged.length) ctx.schema.vars.set(target, ctx.schema.register(merged))
}

function defFunc(name, node) {
  if (!Array.isArray(node) || node[0] !== '=>') return false
  // Only extract top-level functions, not nested (closures stay as values)
  if (depth > 0) return false
  let [, rawParams, body] = node
  const raw = extractParams(rawParams)

  // Extract param names and defaults via shared classifier.
  // Destructured params desugar to fresh tmp + let-binding prefix in body.
  const params = [], defaults = {}, hasRest = [], bodyPrefix = []
  for (const r of raw) {
    const c = classifyParam(r)
    if (c.kind === 'rest') { hasRest.push(c.name); params.push({ name: c.name, type: 'f64', rest: true }) }
    else if (c.kind === 'plain') params.push({ name: c.name, type: 'f64' })
    else if (c.kind === 'default') {
      params.push({ name: c.name, type: 'f64' })
      const defVal = prep(c.defValue)
      defaults[c.name] = defVal
      if (Array.isArray(defVal) && defVal[0] === '{}' && defVal.length > 1 && ctx.schema.register) {
        const props = defVal.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (props.length) ctx.schema.vars.set(c.name, ctx.schema.register(props))
      }
    } else {
      const tmp = `${T}p${ctx.func.uniq++}`
      params.push({ name: tmp, type: 'f64' })
      if (c.kind === 'destruct-default') defaults[tmp] = prep(c.defValue)
      bodyPrefix.push(['let', ['=', c.pattern, tmp]])
    }
  }

  // Prepend destructuring to body (body is already prepped, so prefix needs prep too)
  if (bodyPrefix.length) {
    const preppedPrefix = bodyPrefix.map(prep).filter(x => x != null)
    if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
      body = ['{}', [';', ...preppedPrefix, ...body[1].slice(1)]]
    else if (Array.isArray(body) && body[0] === '{}')
      body = ['{}', [';', ...preppedPrefix, body[1]]]
    else
      body = ['{}', [';', ...preppedPrefix, ['return', body]]]
  }

  const sig = { params, results: detectResults(body) }
  const hasDefaults = Object.keys(defaults).length > 0
  const funcInfo = { name, body, exported: !!ctx.func.exports[name], sig, ...(hasDefaults && { defaults }) }
  if (hasRest.length) funcInfo.rest = hasRest[0]  // track rest param name
  ctx.func.list.push(funcInfo)
  return true
}

// Multi-value threshold: ≤8 elements = tuple (multi-value return), >8 = memory array
const MAX_MULTI = 8

/** Detect return arity from function body. */
function detectResults(body) {
  // Expression body: [e1, e2, ...] → multi-return if ≤ threshold and no spreads
  if (Array.isArray(body) && body[0] === '[' && body.length > 2 && !body.some(e => Array.isArray(e) && e[0] === '...')) {
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
    // Array return: count elements, but only if no spreads (spreads → runtime array, not multi-value)
    if (Array.isArray(val) && val[0] === '[' && val.length > 2 && !val.some(e => Array.isArray(e) && e[0] === '...'))
      out.push(val.length - 1)
    else out.push(1)
    return
  }
  for (let i = 1; i < node.length; i++) collectReturns(node[i], out)
}

const isLit = n => Array.isArray(n) && n[0] == null

const LENIENT_ENDERS = new Set([')', ']', '"', "'", '`', '$', '}', ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'])
const COMMENT_ONLY_LINE = /^\s*(?:\/\/.*)?$/
const BANG_LINE = /^\s*!/
const CONTROL_HEADER_LINE = /^\s*(?:if|while|for|catch)\b.*\)\s*$/

function lastCodeChar(line) {
  let quote = null
  let escape = false
  let last = ''

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]

    if (quote) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === quote) {
        last = ch
        quote = null
      }
      continue
    }

    if (ch === '/' && next === '/') break
    if (ch === '/' && next === '*') {
      i += 2
      while (i < line.length && !(line[i] === '*' && line[i + 1] === '/')) i++
      i += (i < line.length ? 1 : 0)
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      last = ch
      continue
    }
    if (ch !== ' ' && ch !== '\t') last = ch
  }

  return last
}

export function patchLenientASI(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source
    .replace(/\}\s*\n(\s*)\[/g, '};\n$1[')
    .replace(/\r\n/g, '\n')
    .split('\n')

  for (let i = 1; i < lines.length; i++) {
    if (!BANG_LINE.test(lines[i])) continue

    let prev = i - 1
    while (prev >= 0 && COMMENT_ONLY_LINE.test(lines[prev])) prev--
    if (prev < 0) continue
    if (CONTROL_HEADER_LINE.test(lines[prev])) continue

    const last = lastCodeChar(lines[prev])
    if (LENIENT_ENDERS.has(last)) lines[prev] += ';'
  }

  return lines.join(eol)
}

/** Compile-time bundling: parse + prepare an imported module, collect exports. */
function prepareModule(specifier, source) {
  includeModule('core')
  // Cycle detection
  if (ctx.module.moduleStack.includes(specifier))
    err(`Circular import: ${ctx.module.moduleStack.join(' -> ')} -> ${specifier}`)
  // Already resolved
  if (ctx.module.resolvedModules.has(specifier)) return ctx.module.resolvedModules.get(specifier)

  ctx.module.moduleStack.push(specifier)

  // Name mangling prefix: ./math.jz → _math_jz
  const prefix = specifier.replace(/[^a-zA-Z0-9]/g, '_')

  // Save caller state
  const savedScope = ctx.scope.chain, savedExports = ctx.func.exports
  const savedFuncCount = ctx.func.list.length  // track new funcs from this module
  const savedModulePrefix = ctx.module.currentPrefix
  ctx.scope.chain = derive(savedScope)  // inherit parent scope
  ctx.func.exports = {}
  ctx.module.currentPrefix = prefix

  // Parse + prepare imported source (may trigger recursive imports)
  if (ctx.transform.lenient) source = patchLenientASI(source)
  let ast = parse(source)
  if (ctx.transform.jzify) ast = ctx.transform.jzify(ast)
  const savedDepth = depth; depth = 0
  const moduleInit = prep(ast)
  depth = savedDepth

  // Collect exports: rename exported funcs with prefix
  const moduleExports = new Map()
  for (const name of Object.keys(ctx.func.exports)) {
    const val = ctx.func.exports[name]
    // Default export alias: export default existingName → map 'default' to that name's mangled form
    if (name === 'default' && typeof val === 'string') {
      // Will resolve after all named exports are mangled
      continue
    }
    const mangled = `${prefix}$${name}`
    moduleExports.set(name, mangled)
    // Rename the function in ctx.func.list
    const func = ctx.func.list.find(f => f.name === name)
    if (func) func.name = mangled
    // Rename globals
    if (ctx.scope.globals.has(name)) {
      const wat = ctx.scope.globals.get(name).replace(`$${name}`, `$${mangled}`)
      ctx.scope.globals.delete(name)
      ctx.scope.globals.set(mangled, wat)
      if (ctx.scope.userGlobals.has(name)) { ctx.scope.userGlobals.delete(name); ctx.scope.userGlobals.add(mangled) }
      if (ctx.scope.globalTypes.has(name)) { ctx.scope.globalTypes.set(mangled, ctx.scope.globalTypes.get(name)); ctx.scope.globalTypes.delete(name) }
    }
  }
  // Resolve default export alias after named exports are mangled
  if (typeof ctx.func.exports['default'] === 'string') {
    const alias = ctx.func.exports['default']
    if (moduleExports.has(alias)) {
      // Already renamed as a named export
      moduleExports.set('default', moduleExports.get(alias))
    } else {
      // Not a named export — rename the function/global
      const mangled = `${prefix}$${alias}`
      moduleExports.set('default', mangled)
      const func = ctx.func.list.find(f => f.name === alias)
      if (func) func.name = mangled
      if (ctx.scope.globals.has(alias)) {
        const wat = ctx.scope.globals.get(alias).replace(`$${alias}`, `$${mangled}`)
        ctx.scope.globals.delete(alias)
        ctx.scope.globals.set(mangled, wat)
        if (ctx.scope.userGlobals.has(alias)) { ctx.scope.userGlobals.delete(alias); ctx.scope.userGlobals.add(mangled) }
      }
    }
  }

  // Rename ALL non-exported functions created during this module's prep
  // (fn property assignments like f32.parse, internal helpers like cleanInt)
  for (let i = savedFuncCount; i < ctx.func.list.length; i++) {
    const func = ctx.func.list[i]
    if (func.raw || func.name.startsWith(prefix + '$')) continue
    // Skip functions from sub-imports (already prefixed with another module's prefix)
    if (func.name.includes('__') && func.name.includes('$')) continue
    const mangled = `${prefix}$${func.name}`
    moduleExports.set(func.name, mangled)
    func.name = mangled
  }

  // Add mangled non-exported globals to moduleExports for walk renaming
  // (e.g., module-level const/let used by functions declared before the global)
  for (const [mangled, wat] of ctx.scope.globals) {
    if (mangled.startsWith(prefix + '$')) {
      const original = mangled.slice(prefix.length + 1)
      if (!moduleExports.has(original)) moduleExports.set(original, mangled)
    }
  }

  // Rename references in function bodies — walk ALL functions created during this module's prep
  if (moduleExports.size) {
    const walk = (node, skip) => {
      if (!Array.isArray(node)) return typeof node === 'string' && !skip?.has(node) && moduleExports.has(node) ? moduleExports.get(node) : node
      if (node[0] === 'str' || node[0] == null || node[0] === '`' || node[0] === '//') return node
      if (node[0] === ':') { node[2] = walk(node[2], skip); return node }
      if (node[0] === '=>') {
        node[2] = walk(node[2], collectParamNames(extractParams(node[1]), new Set(skip)))
        return node
      }
      for (let j = 0; j < node.length; j++) node[j] = walk(node[j], skip)
      return node
    }
    for (let i = savedFuncCount; i < ctx.func.list.length; i++) {
      const func = ctx.func.list[i]
      if (!func.body) continue
      const funcParams = new Set(func.sig?.params?.map(p => p.name) || [])
      walk(func.body, funcParams)
      if (func.defaults) for (const [k, v] of Object.entries(func.defaults)) func.defaults[k] = walk(v, funcParams)
    }
    // Also rename init code AST
    if (moduleInit) walk(moduleInit)
  }

  // Collect sub-module init code (variable initializations) for __start
  if (moduleInit) {
    if (!ctx.module.moduleInits) ctx.module.moduleInits = []
    ctx.module.moduleInits.push(moduleInit)
  }

  // Restore caller state
  ctx.scope.chain = savedScope
  ctx.func.exports = savedExports
  ctx.module.currentPrefix = savedModulePrefix
  ctx.module.moduleStack.pop()

  const result = { exports: moduleExports }
  ctx.module.resolvedModules.set(specifier, result)
  return result
}

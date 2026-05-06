/**
 * AST preparation: single-pass traversal that validates, resolves, and normalizes.
 *
 * # Stage contract
 *   IN:  raw jessie AST from subscript/jessie (possibly jzified).
 *   OUT: normalized AST + populated `ctx.func.list`, `ctx.module.imports`, `ctx.schema.list`,
 *        `ctx.scope.consts`, `ctx.module.moduleInits`.
 *   POST: no `var`/`function`/`class`/`this` remain; ++/-- rewritten as +=/-=; arrow
 *        bodies carry no type metadata yet (that's analyze/compile's job).
 *
 * # Concerns (per-node handler table, applied together per op)
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
import { ctx, err, derive } from './ctx.js'
import { T, STMT_OPS, VAL, valTypeOf, typedElemCtor, extractParams, collectParamNames, classifyParam, observeNodeFacts } from './analyze.js'
import { staticPropertyKey } from './key.js'
import { isFuncRef } from './ir.js'
import { normalizeSource } from './source.js'
import {
  CTORS, TIMER_NAMES,
  hasModule, includeModule,
  includeForArrayAccess, includeForArrayLiteral, includeForArrayPattern, includeForCallableValue,
  includeForGenericMethod, includeForKnownKeyIteration, includeForNamedCall, includeForNumericCoercion,
  includeForObjectLiteral, includeForObjectPattern, includeForOp, includeForProperty, includeForRuntimeCtor,
  includeForRuntimeKeyIteration, includeForStringOnly, includeForStringValue, includeForTimerRuntime,
} from './autoload.js'

let depth = 0  // arrow nesting depth (0=top-level, >0=inside function)
let scopes = []  // block scope stack: [{names: Set, renames: Map}]

const hostReturnValType = spec => {
  if (!spec || typeof spec === 'function') return null
  const ret = spec.returns ?? spec.return ?? spec.result
  if (ret === 'number' || ret === 'f64' || ret === Number) return VAL.NUMBER
  if (ret === 'string' || ret === String) return VAL.STRING
  if (ret === 'bigint' || ret === BigInt) return VAL.BIGINT
  return null
}

const addHostImport = (mod, name, alias, spec) => {
  const nParams = typeof spec === 'function' ? spec.length : (spec?.params || 0)
  const params = Array(nParams).fill(['param', 'f64'])
  if (!ctx.module.imports.some(i => i[3]?.[1] === `$${alias}`)) {
    ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, ['func', `$${alias}`, ...params, ['result', 'f64']]])
  }
  ctx.scope.chain[alias] = alias
  const vt = hostReturnValType(spec)
  if (vt) ctx.module.hostImportValTypes.set(alias, vt)
}

const isImportMeta = node => Array.isArray(node) && node[0] === '.' && node[1] === 'import' && node[2] === 'meta'
const isImportMetaProp = (node, prop) => Array.isArray(node) && node[0] === '.' && isImportMeta(node[1]) && node[2] === prop
const stringValue = node => Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
const flatArgs = args => args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args

function staticString(value) {
  includeForStringValue()
  return ['str', value]
}

function importMetaUrl() {
  if (!ctx.transform.importMetaUrl) err('`import.meta.url` requires compile option `importMetaUrl`')
  return ctx.transform.importMetaUrl
}

function resolveImportMeta(spec) {
  const base = importMetaUrl()
  try { return new URL(spec, base).href }
  catch { err(`Cannot resolve import.meta specifier '${spec}' from '${base}'`) }
}

function recordGlobalValueFact(name, expr) {
  if (typeof name !== 'string') return
  const vt = valTypeOf(expr)
  if (vt) {
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, vt)
    if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(name, expr)
  }
  const ctor = typedElemCtor(expr)
  if (ctor) (ctx.scope.globalTypedElem ||= new Map()).set(name, ctor)
}

function recordModuleInitFacts(root) {
  const facts = ctx.module.initFacts ||= {
    dynVars: new Set(), anyDyn: false, hasSchemaLiterals: false,
    hasFuncValue: false, timerNames: new Set(),
    maxDef: 0, maxCall: 0, hasRest: false, hasSpread: false,
  }
  const visitFuncValue = (node) => {
    if (facts.hasFuncValue || !Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '()') {
      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (isFuncRef(a, ctx.func.names)) { facts.hasFuncValue = true; return }
        visitFuncValue(a)
      }
      return
    }
    if (op === '.' || op === '?.') {
      if (isFuncRef(args[0], ctx.func.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(args[0])
      return
    }
    if (op === '=>') { visitFuncValue(args[1]); return }
    for (const a of args) {
      if (isFuncRef(a, ctx.func.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(a)
    }
  }
  const walk = (node) => {
    if (!Array.isArray(node)) {
      if (typeof node === 'string' && TIMER_NAMES.has(node)) facts.timerNames.add(node)
      return
    }
    observeNodeFacts(node, facts)
    for (const a of node.slice(1)) walk(a)
  }
  visitFuncValue(root)
  walk(root)
}

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
  fuseSparseMapReads(node)
  const ast = prep(node)
  // Top-level functions referenced as first-class values (e.g. `let o = { fn: g }`,
  // `arr.push(g)`, `return g`) need trampoline emission, which depends on the fn
  // module's closure.table machinery. defFunc paths don't trigger fn-module load,
  // so scan post-prep and include `fn` if any user func appears in a value position.
  if (!ctx.module.modules.fn && ctx.func.list.length) {
    const funcNames = new Set(ctx.func.list.map(f => f.name))
    const visit = (n) => {
      if (!Array.isArray(n)) return false
      const [op, ...args] = n
      if (op === '()') {
        // callee at args[0]: skip if it's a bare func name (direct call); recurse rest
        if (typeof args[0] !== 'string' || !funcNames.has(args[0])) {
          if (visit(args[0])) return true
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (typeof a === 'string' && funcNames.has(a)) return true
          if (visit(a)) return true
        }
        return false
      }
      if (op === '.' || op === '?.') {
        // obj at args[0] can be a func ref; prop at args[1] is a name, never a ref
        if (typeof args[0] === 'string' && funcNames.has(args[0])) return true
        return visit(args[0])
      }
      if (op === '=>') {
        // body only — params are bindings, not refs
        return visit(args[1])
      }
      for (const a of args) {
        if (typeof a === 'string' && funcNames.has(a)) return true
        if (visit(a)) return true
      }
      return false
    }
    let needs = visit(ast)
    if (!needs) for (const f of ctx.func.list) if (f.body && visit(f.body)) { needs = true; break }
    if (!needs && ctx.module.initFacts?.hasFuncValue) needs = true
    if (needs) includeForCallableValue()
  }

  // Native timers: inline WASM timer queue when referenced (no host imports needed)
  const usedTimers = new Set(ctx.module.initFacts?.timerNames || [])
  const scanTimers = (n) => {
    if (!Array.isArray(n)) {
      if (typeof n === 'string' && TIMER_NAMES.has(n)) usedTimers.add(n)
      return
    }
    for (let i = 0; i < n.length; i++) scanTimers(n[i])
  }
  const allNodes = [ast, ...ctx.func.list.map(f => f.body)]
  for (const node of allNodes) scanTimers(node)
  if (usedTimers.size) {
    includeForTimerRuntime()
  }

  return ast
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

const hasFunc = name => ctx.func.names.has(name)

const renameFunc = (func, nextName) => {
  ctx.func.names.delete(func.name)
  func.name = nextName
  ctx.func.names.add(nextName)
}

/** Map JS typeof strings to jz type checks. Codes < 0 trigger specialized emitTypeofCmp paths. */
const TYPEOF_MAP = { 'number': -1, 'string': -2, 'undefined': -3, 'boolean': -4, 'object': -5, 'function': -6 }
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

const cloneNode = (node) => {
  if (!Array.isArray(node)) return node
  const copy = node.map(cloneNode)
  if (node.loc != null) copy.loc = node.loc
  return copy
}

/** Sparse-read .map fusion: rewrite `const b = a.map(arrow); for(...; j<b.length; ...) USE(b[j])`
 *  into a fused for-loop that inlines `arrow(a[j])` at the read site, eliminating the materialized
 *  intermediate array. Pre-prep AST mutation; only fires on shapes where every use of `b` is a
 *  numeric `b[idx]` read or a `b.length` read, the arrow is pure with a single named param, and
 *  `b` is not referenced after the consumer for-loop. Preserves observable behavior because the
 *  arrow's pure-expression body has no order-dependent effects. */
function fuseSparseMapReads(root) {
  walkSparse(root)
}
function walkSparse(node) {
  if (!Array.isArray(node)) return
  for (let i = 1; i < node.length; i++) walkSparse(node[i])
  if (node[0] === ';') tryFuseInBlock(node)
}
function tryFuseInBlock(seq) {
  for (let i = 1; i < seq.length - 1; i++) {
    const fused = tryFusePair(seq[i], seq[i + 1], seq, i)
    if (fused) {
      seq.splice(i, 2, ...fused)
      i--  // re-examine same position (chained fusions)
    }
  }
}
function tryFusePair(decl, forNode, seq, declIdx) {
  if (!Array.isArray(decl) || (decl[0] !== 'const' && decl[0] !== 'let')) return null
  if (decl.length !== 2) return null  // single binding only
  const bind = decl[1]
  if (!Array.isArray(bind) || bind[0] !== '=' || typeof bind[1] !== 'string') return null
  const NAME = bind[1], rhs = bind[2]
  if (!Array.isArray(rhs) || rhs[0] !== '()') return null
  const callee = rhs[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'map') return null
  const RECV = callee[1]
  if (typeof RECV !== 'string' || RECV === NAME) return null
  const arrow = rhs[2]
  if (!Array.isArray(arrow) || arrow[0] !== '=>') return null
  // Single-name param only: `x => …` or `(x) => …`
  const ap = arrow[1]
  const PARAM = typeof ap === 'string' ? ap :
    (Array.isArray(ap) && ap[0] === '()' && typeof ap[1] === 'string' ? ap[1] : null)
  if (!PARAM || PARAM === NAME || PARAM === RECV) return null
  // Body: single-expression arrow only (block bodies skipped — could extend later).
  const aBody = arrow[2]
  if (Array.isArray(aBody) && aBody[0] === '{}') return null
  if (!isPureSparseArrowBody(aBody, PARAM)) return null
  // For-loop: ['for', [';', initStmt, cond, inc], body]
  if (!Array.isArray(forNode) || forNode[0] !== 'for' || forNode.length !== 3) return null
  const head = forNode[1]
  if (!Array.isArray(head) || head[0] !== ';' || head.length !== 4) return null
  const cond = head[2], forBody = forNode[2]
  // Verify `NAME` is used only as `NAME[idx]` or `NAME.length` inside cond+forBody.
  if (!hasOnlySparseUses(cond, NAME)) return null
  if (!hasOnlySparseUses(forBody, NAME)) return null
  if (!hasAnyIndexedRead(forBody, NAME) && !hasAnyIndexedRead(cond, NAME)) return null
  // `NAME` must not be read after the for-loop in the same block.
  for (let k = declIdx + 2; k < seq.length; k++) {
    if (refsName(seq[k], NAME)) return null
  }
  // RECV must not be reassigned inside the for-loop (would invalidate substitution).
  if (assignsName(forNode, RECV) || assignsName(forNode, NAME)) return null
  // PARAM must not collide with any binding inside forBody (otherwise substitution shadows wrongly).
  if (bindsName(forNode, PARAM)) return null
  // Apply substitution: NAME.length → RECV.length; NAME[idx] → arrowBody[PARAM ← RECV[idx]].
  const newCond = substSparse(cond, NAME, RECV, PARAM, aBody)
  const newBody = substSparse(forBody, NAME, RECV, PARAM, aBody)
  const newHead = [';', head[1], newCond, head[3]]
  return [['for', newHead, newBody]]
}
function isPureSparseArrowBody(n, PARAM) {
  if (typeof n === 'string') return true
  if (!Array.isArray(n)) return true
  const op = n[0]
  // Calls / new / assignments / increments are unsafe for repeated-substitution semantics.
  if (op === '()' || op === '?.()' || op === 'new' || op === '++' || op === '--') return false
  if (op === '=>') return false  // nested closure is opaque
  if (typeof op === 'string' && op !== '=>' && op !== '===' && op !== '!==' && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=' && op.endsWith('=') && op !== '=') return false
  if (op === '=') return false
  for (let i = 1; i < n.length; i++) if (!isPureSparseArrowBody(n[i], PARAM)) return false
  return true
}
function hasOnlySparseUses(n, NAME) {
  if (typeof n === 'string') return n !== NAME
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op === '[]' && n.length === 3 && n[1] === NAME) return hasOnlySparseUses(n[2], NAME)  // NAME[idx] — idx must not reference NAME
  if (op === '.' && n[1] === NAME) {
    if (n[2] === 'length') return true
    return false  // any other property access on NAME is opaque
  }
  for (let i = 1; i < n.length; i++) if (!hasOnlySparseUses(n[i], NAME)) return false
  return true
}
function hasAnyIndexedRead(n, NAME) {
  if (!Array.isArray(n)) return false
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (hasAnyIndexedRead(n[i], NAME)) return true
  return false
}
function refsName(n, NAME) {
  if (typeof n === 'string') return n === NAME
  if (!Array.isArray(n)) return false
  for (let i = 1; i < n.length; i++) if (refsName(n[i], NAME)) return true
  return false
}
function assignsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === '=' || op === '++' || op === '--' ||
       (typeof op === 'string' && op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>='))
      && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (assignsName(n[i], NAME)) return true
  return false
}
function bindsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'let' || op === 'const')) {
    for (let i = 1; i < n.length; i++) {
      const bind = n[i]
      if (Array.isArray(bind) && bind[0] === '=' && bind[1] === NAME) return true
    }
  }
  if (op === '=>') {
    const p = n[1]
    if (p === NAME) return true
    if (Array.isArray(p)) {
      if (p[0] === '()' && p[1] === NAME) return true
      // skip deeper destructuring forms — conservative
    }
  }
  for (let i = 1; i < n.length; i++) if (bindsName(n[i], NAME)) return true
  return false
}
function substSparse(n, NAME, RECV, PARAM, arrowBody) {
  if (typeof n !== 'object' || n === null || !Array.isArray(n)) return n
  if (n[0] === '.' && n[1] === NAME && n[2] === 'length') return ['.', RECV, 'length']
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) {
    const idx = substSparse(n[2], NAME, RECV, PARAM, arrowBody)
    return cloneAndBind(arrowBody, PARAM, ['[]', RECV, idx])
  }
  return n.map((c, i) => i === 0 ? c : substSparse(c, NAME, RECV, PARAM, arrowBody))
}
function cloneAndBind(node, PARAM, replacement) {
  if (node === PARAM) return replacement
  if (!Array.isArray(node)) return node
  return node.map((c, i) => i === 0 ? c : cloneAndBind(c, PARAM, replacement))
}

function prep(node) {
  if (Array.isArray(node)) includeForOp(node[0])
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
      if (node === 'Boolean' || node === 'Number') { includeForCallableValue(); return ['=>', 'x', 'x'] }
      // Block locals shadow module imports/globals, even when the local keeps the same name.
      if (scopes.length && isDeclared(node)) return resolveScope(node)
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
  if (op === 'void' && ctx.transform.strict) err('strict mode: `void` is prohibited. It diverges from JS by evaluating to 0.')
  if (op == null) {
    if (typeof args[0] === 'string') {
      includeForStringValue()
      return ['str', args[0]]  // string literal
    }
    return [, args[0]]  // number literal
  }
  const handler = handlers[op]
  return handler ? handler(...args) : [op, ...args.map(prep)]
}

// FIXME: can we jzify some of these?
const PROHIBITED = { 'with': '`with` not supported', 'class': '`class` not supported', 'yield': '`yield` not supported',
  'this': '`this` not supported: use explicit parameter',
  'super': '`super` not supported: no class inheritance',
  'arguments': '`arguments` not supported: use rest params',
  'eval': '`eval` not supported'
}

// Predefined globals seeded into scope.chain at ctx.reset(). Value is the scope alias
// used in ctx.core.emit[]. Dotted lookups (Math.sin) go through the '.' handler which
// resolves via scope.chain → module 'math' → registers 'math.sin' emitter.
// Not actually "implicit imports" — these are ambient globals that exist in every jz/JS
// program (they do not live in any module). jzify auto-injecting imports would still
// need a list of these names to know what to emit, so the table lives here either way.
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

const patternItems = (node) => node?.[0] === ',' ? node.slice(1) : [node]
const isDestructPattern = (node) => Array.isArray(node) && (node[0] === '[]' || node[0] === '{}')

function pushPatternAssign(target, valueExpr, out, decls = null) {
  if (Array.isArray(target) && target[0] === '=') {
    pushPatternAssign(target[1], ['??', valueExpr, prep(target[2])], out, decls)
    return
  }

  if (isDestructPattern(target)) {
    const tmp = `${T}d${ctx.func.uniq++}`
    if (decls) decls.push(['=', tmp, valueExpr])
    else out.push(['=', tmp, valueExpr])
    expandDestruct(target, tmp, out, decls)
    return
  }

  out.push(['=', target, valueExpr])
}

function expandDestruct(pattern, source, out, decls = null) {
  if (!isDestructPattern(pattern)) return

  if (pattern[0] === '[]') {
    includeForArrayPattern()
    const items = patternItems(pattern[1])
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      if (item == null) continue

      if (Array.isArray(item) && item[0] === '...') {
        pushPatternAssign(item[1], ['()', ['.', source, 'slice'], [, j]], out, decls)
        continue
      }

      pushPatternAssign(item, ['[]', source, [, j]], out, decls)
    }
    return
  }

  includeForObjectPattern()
  const items = patternItems(pattern[1])

  // Collect explicit keys and detect rest pattern
  let restTarget = null
  const explicitKeys = []
  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') { restTarget = item[1]; continue }
    if (typeof item === 'string') explicitKeys.push(item)
    else if (Array.isArray(item) && item[0] === '=') { if (typeof item[1] === 'string') explicitKeys.push(item[1]) }
    else if (Array.isArray(item) && item[0] === ':') explicitKeys.push(item[1])
  }

  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') continue  // handled below

    if (typeof item === 'string') {
      pushPatternAssign(item, ['.', source, item], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === '=') {
      if (typeof item[1] === 'string')
        pushPatternAssign(item[1], ['??', ['.', source, item[1]], prep(item[2])], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === ':') {
      pushPatternAssign(item[2], ['.', source, item[1]], out, decls)
      continue
    }
  }

  // Object rest: {x, ...rest} = obj → rest = {remaining props from source schema}
  if (restTarget) {
    const srcSchema = typeof source === 'string' && ctx.schema.resolve(source)
    if (srcSchema) {
      const remaining = srcSchema.filter(k => !explicitKeys.includes(k))
      if (remaining.length) {
        const restProps = remaining.map(k => [':', k, ['.', source, k]])
        const restObj = ['{}', remaining.length === 1 ? restProps[0] : [',', ...restProps]]
        // Register schema for the rest variable so property access works
        if (typeof restTarget === 'string') ctx.schema.vars.set(restTarget, ctx.schema.register(remaining))
        pushPatternAssign(restTarget, restObj, out, decls)
      } else {
        pushPatternAssign(restTarget, ['{}'], out, decls)
      }
    } else {
      err('Object rest (...) requires source with known schema — destructure the object before passing to function, or use explicit property access')
    }
  }
}

/** Prepare let/const declaration. */
function prepDecl(op, ...inits) {
  const rest = []
  for (const i of inits) {
    if (Array.isArray(i) && i[0] === '()' && typeof i[1] === 'string' && Array.isArray(i[2]) && i[2][0] === '=' && isDestructPattern(i[2][1])) {
      if (rest.length === 0 && inits.length === 1) return [';', [op, i[1]], prep(i[2])]
      err('destructuring assignment after declaration must be a separate statement')
    }

    if (!Array.isArray(i) || i[0] !== '=') { rest.push(i); continue }
    const [, name, init] = i, normed = prep(init)

    if (isDestructPattern(name)) {
      const tmp = `${T}d${ctx.func.uniq++}`
      rest.push(['=', tmp, normed])
      // Propagate schema to temp so rest destructuring can resolve it
      if (typeof normed === 'string' && ctx.schema.vars.has(normed))
        ctx.schema.vars.set(tmp, ctx.schema.vars.get(normed))
      else if (Array.isArray(normed) && normed[0] === '{}') {
        const p = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (p.length) ctx.schema.vars.set(tmp, ctx.schema.register(p))
      }
      expandDestruct(name, tmp, rest)
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
          if (Array.isArray(normed) && normed[0] === 'str' && typeof normed[1] === 'string')
            (ctx.scope.constStrs ||= new Map()).set(declName, normed[1])
        } else if (op === 'let' && ctx.scope.consts?.has(declName)) {
          ctx.scope.consts.delete(declName)
          ctx.scope.constStrs?.delete(declName)
        }
        recordGlobalValueFact(declName, normed)
      }
      // Track object schemas (after prefix so schema is keyed to final name)
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
        const props = []
        for (const p of normed.slice(1)) {
          if (Array.isArray(p) && p[0] === ':') props.push(p[1])
          else if (Array.isArray(p) && p[0] === '...') {
            // Merge spread source schema into this object's schema
            const srcSchema = typeof p[1] === 'string' && ctx.schema.resolve(p[1])
            if (srcSchema) for (const n of srcSchema) { if (!props.includes(n)) props.push(n) }
          }
        }
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
    includeForArrayLiteral()
    return ['...', prep(expr)]
  },

  // Prohibited ops — duplicated from jzify deliberately: .jz source bypasses jzify,
  // so prepare is the actual defense. Messages here fire for both .js and .jz.
  'async': () => err('async/await not supported: WASM is synchronous'),
  'await': () => err('async/await not supported: WASM is synchronous'),
  'class': () => err('class not supported: use object literals'),
  'yield': () => err('generators not supported: use loops'),
  'debugger': () => null,
  'delete': () => err('delete not supported: object shape is fixed'),
  'in'(key, obj) { return ['in', prep(key), prep(obj)] },
  'instanceof': () => err('instanceof not supported: use typeof'),
  'with': () => err('`with` not supported: deprecated'),
  ':': () => err('labeled statements not supported'),
  'var': () => err('`var` not supported: use let/const'),
  'function': () => err('`function` not supported: use arrow functions'),

  // Destructuring assignment: [a, ...b] = expr or {x, y} = expr
  '='(lhs, rhs) {
    // Destructuring assignment: [a, ...r] = expr or ({x: a} = expr)
    // Distinguishing from index assignment: destructuring patterns have exactly one payload node.
    if (isDestructPattern(lhs) && lhs.length === 2) {
      const normed = prep(rhs)
      const tmp = `${T}d${ctx.func.uniq++}`
      const decls = [['=', tmp, normed]]
      // Propagate schema to temp so rest destructuring can resolve it
      if (typeof normed === 'string' && ctx.schema.vars.has(normed))
        ctx.schema.vars.set(tmp, ctx.schema.vars.get(normed))
      const stmts = []
      expandDestruct(lhs, tmp, stmts, decls)
      return prep([';', ['let', ...decls], ...stmts])
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
      && hasFunc(lhs[1]) && Array.isArray(rhs) && rhs[0] === '=>') {
      const name = `${lhs[1]}$${lhs[2]}`
      if (defFunc(name, prep(rhs))) return ['=', prep(lhs), name]
    }
    return ['=', prep(lhs), prep(rhs)]
  },

  // try/catch/throw
  // Parser produces ['try', body, ['catch', param, handler]?, ['finally', cleanup]?]
  'try'(body, ...clauses) {
    const catchClause = clauses.find(c => Array.isArray(c) && c[0] === 'catch')
    const finallyClause = clauses.find(c => Array.isArray(c) && c[0] === 'finally')
    const tryBody = prep(body)
    const caught = catchClause
      ? (() => {
          const [, errName, handler] = catchClause
          return ['catch', tryBody, errName, prep(handler)]
        })()
      : tryBody
    if (finallyClause) return ['finally', caught, prep(finallyClause[1])]
    if (catchClause) {
      const [, errName, handler] = catchClause
      return ['catch', tryBody, errName, prep(handler)]
    }
    return tryBody
  },
  'throw'(expr) { return ['throw', prep(expr)] },

  // Template literal: [``, part, ...] → fused single-allocation string concat.
  '`'(...parts) {
    includeForStringValue()
    const nodes = parts.map(p =>
      Array.isArray(p) && p[0] == null && typeof p[1] === 'string' ? ['str', p[1]] : prep(p))
    return ['strcat', ...nodes]
  },

  // Tagged template: tag`a${x}b` → tag(['a','b'], x)
  // Parser drops empty string segments; reinsert them to satisfy the strings.length === exprs.length + 1 invariant.
  '``'(tag, ...parts) {
    const strs = [], exprs = []
    let prev = false
    for (const p of parts) {
      const isStr = Array.isArray(p) && p[0] == null && typeof p[1] === 'string'
      if (isStr) { strs.push(p); prev = true }
      else { if (!prev) strs.push([null, '']); exprs.push(p); prev = false }
    }
    if (!prev) strs.push([null, ''])
    const arr = strs.length === 1 ? ['[]', strs[0]] : ['[]', [',', ...strs]]
    const callArgs = exprs.length === 0 ? arr : [',', arr, ...exprs]
    return prep(['()', tag, callArgs])
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

    // Host imports override built-ins for named imports
    const hostMod = ctx.module.hostImports?.[mod]
    let remaining = specifiers
    if (hostMod && Array.isArray(specifiers) && specifiers[0] === '{}') {
      const inner = specifiers[1]
      if (inner != null) {
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        const builtinItems = []
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (spec) {
            addHostImport(mod, name, alias, spec)
          } else {
            builtinItems.push(item)
          }
        }
        if (builtinItems.length === 0) return null
        if (!hasModule(mod)) {
          const name = typeof builtinItems[0] === 'string' ? builtinItems[0] : builtinItems[0][1]
          err(`'${name}' not declared in host module '${mod}'`)
        }
        remaining = ['{}', builtinItems.length === 1 ? builtinItems[0] : [',', ...builtinItems]]
      } else {
        return null
      }
    }

    // Tier 1: Built-in module
    if (hasModule(mod)) {
      includeModule(mod)
      const bind = (name, alias) => {
        const key = mod + '.' + name
        if (!ctx.core.emit[key]) err(`Unknown import: ${name} from '${mod}'`)
        ctx.scope.chain[alias || name] = key
      }

      if (typeof remaining === 'string') { ctx.scope.chain[remaining] = mod; return null }
      if (Array.isArray(remaining) && remaining[0] === 'as' && remaining[1] === '*') { ctx.scope.chain[remaining[2]] = mod; return null }

      if (Array.isArray(remaining) && remaining[0] === '{}') {
        const inner = remaining[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
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
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
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

    // Tier 3: Host imports (non-built-in modules)
    if (hostMod) {
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (!spec) err(`'${name}' not declared in host module '${mod}'`)
          addHostImport(mod, name, alias, spec)
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
    // export { name, name as alias } from './mod' or export * from './mod'
    if (Array.isArray(decl) && decl[0] === 'from') {
      const mod = decl[2]?.[1]
      if (!mod || typeof mod !== 'string') return null
      // Source module re-export
      if (ctx.module.importSources?.[mod]) {
        const resolved = prepareModule(mod, ctx.module.importSources[mod])
        if (decl[1] === '*') {
          // export * from './mod' → register all exports
          for (const [name, mangled] of resolved.exports) {
            if (name !== 'default') ctx.func.exports[name] = mangled
          }
        } else if (Array.isArray(decl[1]) && decl[1][0] === '{}') {
          // export { a, b as c } from './mod'
          const inner = decl[1][1]
          if (inner == null) return null
          const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
          for (const item of items) {
            const name = typeof item === 'string' ? item : item[1]
            const alias = typeof item === 'string' ? item : item[2]
            const mangled = resolved.exports.get(name)
            if (!mangled) err(`'${name}' is not exported from '${mod}'`)
            ctx.func.exports[alias] = mangled
          }
        }
      }
      return null
    }
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
      if (typeof val === 'string' && (hasFunc(val) || ctx.scope.globals.has(val))) {
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
    if (depth > 0) { includeForCallableValue() }
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
  '?.()'(callee, callArgs) {
    // Parser wraps multi-args in a comma list, like '()'. Unwrap so emit gets flat positional args.
    const items = callArgs == null ? []
      : Array.isArray(callArgs) && callArgs[0] === ',' ? callArgs.slice(1)
      : [callArgs]
    return ['?.()', prep(callee), ...items.map(prep)]
  },
  // Boolean literals NaN-box as f64 — typeof at runtime returns 'number'. Fold here so the JS-spec value survives.
  'typeof'(a) {
    if (Array.isArray(a) && a[0] == null && typeof a[1] === 'boolean') { includeForStringOnly(); return ['str', 'boolean'] }
    return ['typeof', prep(a)]
  },

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) {
      const na = prep(a)
      if (isLit(na) && typeof na[1] === 'number') return na
      includeForNumericCoercion()
      return ['u+', na]
    }
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

  '**'(a, b) { return ['**', prep(a), prep(b)] },

  // Function call or grouping parens
'()'(callee, ...args) {
    // Grouping: (expr) → ['()', expr] with no args. Call: f() → ['()', 'f', null] with null arg.
    if (args.length === 0) return prep(callee)

    if (isImportMetaProp(callee, 'resolve')) {
      const callArgs = flatArgs(args).filter(a => a != null)
      if (callArgs.length !== 1) err('`import.meta.resolve` requires one string literal argument')
      const spec = stringValue(callArgs[0])
      if (spec == null) err('`import.meta.resolve` supports only string literal arguments')
      return staticString(resolveImportMeta(spec))
    }

    const hasRealArgs = args.some(a => a != null)

    if (typeof callee === 'string') {
      if (PROHIBITED[callee]) err(PROHIBITED[callee])
      if (CTORS.includes(callee)) return handlers['new'](['()', callee, ...args])

      if (includeForNamedCall(callee)) {
        if (callee === 'BigInt64Array' || callee === 'BigUint64Array') {
          return ['()', callee, ...args.filter(a => a != null).map(prep)]
        }
      }

      const local = scopes.length && isDeclared(callee)
      const resolved = local ? null : ctx.scope.chain[callee]
      if (local) callee = resolveScope(callee)
      else if (resolved?.includes('.')) callee = resolved
      else if (resolved && hasFunc(resolved)) callee = resolved
      else if (resolved && !resolved.includes('.')) {
        if (hasModule(resolved) && !ctx.module.imports.some(i => i[3]?.[1] === `$${resolved}`)) includeModule(resolved)
      }
      else if (depth > 0 && !resolved && !ctx.func.exports[callee] && !ctx.module.imports.some(i => i[3]?.[1] === `$${callee}`)) {
        includeForCallableValue()
      }
    } else if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, prop] = callee
      const key = typeof obj === 'string' && typeof prop === 'string' ? `${obj}.${prop}` : null
      if (key && ctx.module.hostImports?.[obj]?.[prop]) {
        const spec = ctx.module.hostImports[obj][prop]
        const alias = `${obj}$${prop}`
        addHostImport(obj, prop, alias, spec)
        callee = alias
      } else if (key && includeForNamedCall(key)) {
        callee = key
      } else if (includeForGenericMethod(prop)) {
        callee = prep(callee)
      } else {
        const mod = ctx.scope.chain[obj]
        if (typeof obj === 'string' && mod && !mod.includes('.') && hasModule(mod)) {
          callee = (includeModule(mod), mod + '.' + prop)
        } else {
          callee = prep(callee)
        }
      }
    } else {
      includeForCallableValue()
      callee = prep(callee)
    }

    // Drop trailing-comma sentinel inside a comma group: `f(a, b,)` parses as
    // ['()', 'f', [',', a, b, null]] — without trimming, the trailing null
    // becomes a [, 0] literal and inflates arguments.length.
    if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',') {
      let end = args[0].length
      while (end > 1 && args[0][end - 1] == null) end--
      if (end < args[0].length) {
        args[0] = end === 2 ? args[0][1] : args[0].slice(0, end)
      }
    }
    const preppedArgs = args.filter(a => a != null).map(prep)
    for (const a of preppedArgs) {
      if (typeof a === 'string' && hasFunc(a)) {
        includeForCallableValue(); break
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
      includeForArrayLiteral()
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',') { const items = inner.slice(1); if (items.length && items[items.length - 1] === null) items.pop(); return ['[', ...items.map(item => item == null ? [, JZ_NULL] : prep(item))] }
      return ['[', prep(inner)]
    }
    if (typeof args[0] === 'string' && ctx.module.namespaces?.[args[0]]) {
      includeForStringOnly()
      const key = prep(args[1])
      const exports = [...ctx.module.namespaces[args[0]].entries()]
      let fallback = [, undefined]
      for (let i = exports.length - 1; i >= 0; i--) {
        const [name, resolved] = exports[i]
        fallback = ['?:', ['==', key, ['str', name]], resolved, fallback]
      }
      return fallback
    }
    includeForArrayAccess()
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
    if (Array.isArray(inner) && STMT_OPS.has(inner[0])) {
      // Block body: push block scope for let/const shadowing
      scopes.push(new Map())
      const result = ['{}', prep(inner)]
      scopes.pop()
      return result
    }

    includeForObjectLiteral()
    if (inner == null) return ['{}']
    // Process properties: shorthand 'x' → [':', 'x', 'x'], or [':', key, val] → prep val only
    const prop = p => {
      if (typeof p === 'string') return [':', p, prep(p)]
      if (Array.isArray(p) && p[0] === ':') {
        const key = typeof p[1] === 'string' ? p[1] : staticPropertyKey(p[1])
        if (key == null) err('computed property name not supported for fixed-shape object: use a compile-time string/number key')
        return [':', key, prep(p[2])]
      }
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
      let [, init, cond, step] = head
      // Hoist .length / .size / .byteLength from for-condition:
      //   `i < arr.length` → `let __len = arr.length | 0; ... i < __len`
      // The `| 0` forces i32 even for unknown-typed receivers (where __length
      // returns f64). NaN→0 via i32.trunc_sat matches JS semantics: a NaN bound
      // makes `i < NaN` false on both representations, so the loop is skipped
      // either way. Keeping the hoisted bound i32 lets the counter `i` stay i32
      // through the comparison and `i++`, eliminating the per-iteration
      // f64.convert_i32_s + f64.lt + f64.add + i32.trunc_sat_f64_s sequence.
      if (cond && Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || cond[0] === '>' || cond[0] === '>=')) {
        const lenExpr = cond[0] === '<' || cond[0] === '<=' ? cond[2] : cond[1]
        if (Array.isArray(lenExpr) && lenExpr[0] === '.' &&
            (lenExpr[2] === 'length' || lenExpr[2] === 'size' || lenExpr[2] === 'byteLength')) {
          const lenVar = `${T}len${ctx.func.uniq++}`
          const lenDecl = ['let', ['=', lenVar, ['|', lenExpr, [, 0]]]]
          init = init ? [';', init, lenDecl] : lenDecl
          if (cond[0] === '<' || cond[0] === '<=') cond = [cond[0], cond[1], lenVar]
          else cond = [cond[0], lenVar, cond[2]]
        }
      }
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
      // Wrap .length in `| 0` so the hoisted bound is i32 even for unknown
      // receivers (same rationale as the for-cond hoist above).
      const lenE = ['|', ['.', arrVar, 'length'], [, 0]]
      const decls = trivial
        ? ['let', ['=', idx, [, 0]], ['=', lenVar, lenE]]
        : ['let', ['=', arrVar, src], ['=', idx, [, 0]], ['=', lenVar, lenE]]
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
        includeForKnownKeyIteration()
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
        includeForRuntimeKeyIteration()
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
    if (prop === 'caller' || prop === 'callee') err('`.caller` and `.callee` are prohibited: deprecated stack introspection')
    if (prop === 'url' && isImportMeta(obj)) return staticString(importMetaUrl())
    const mod = ctx.scope.chain[obj]
    // Only treat as module namespace if it's a known built-in module (not a mangled import name)
    if (typeof obj === 'string' && mod && !mod.includes('.') && hasModule(mod)) {
      includeModule(mod)
      const key = mod + '.' + prop
      if (ctx.core.emit[key]?.length > 0) includeForCallableValue()
      return key
    }
    // Source module namespace: import * as X → X.prop resolved to mangled name
    if (typeof obj === 'string' && ctx.module.namespaces?.[obj]) {
      const mangled = ctx.module.namespaces[obj].get(prop)
      if (mangled) return mangled
    }
    includeForProperty(prop)
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }
    // Flatten comma-grouped args: [',', a, b, c] → [a, b, c]
    if (ctorArgs.length === 1 && Array.isArray(ctorArgs[0]) && ctorArgs[0][0] === ',')
      ctorArgs = ctorArgs[0].slice(1)

    if (name === 'URL') {
      const literalArgs = ctorArgs.filter(a => a != null)
      if (literalArgs.length === 2 && isImportMetaProp(literalArgs[1], 'url')) {
        const spec = stringValue(literalArgs[0])
        if (spec == null) err('`new URL(relative, import.meta.url)` supports only string literal relatives')
        return staticString(resolveImportMeta(spec))
      }
    }

    // Wrap multi-arg ctor arg lists back into a single comma-group — the '()' op
    // expects callArgs as a single element (possibly comma-grouped).
    const wrapArgs = (args) => args.length === 0 ? [null]
      : args.length === 1 ? [prep(args[0])]
      : [[',', ...args.map(prep)]]
    if (includeForRuntimeCtor(name)) {
      return ['()', `new.${name}`, ...wrapArgs(ctorArgs)]
    }

    const mod = ctx.scope.chain[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    // Unknown constructor: treat as function call (jzify already strips new for known safe ones)
    if (typeof name === 'string') return ['()', name, ...ctorArgs.map(prep)]
    return ['new', prep(ctor), ...args.map(prep)]
  }
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
  // Only main-module top-level exports become wasm-boundary exports.
  // Sub-module `export let X` is just a re-importable symbol — staying internal
  // unlocks treeshake + type specialization once main stops referencing it.
  const exported = !!ctx.func.exports[name] && ctx.module.moduleStack.length === 0
  const funcInfo = { name, body, exported, sig, ...(hasDefaults && { defaults }) }
  if (hasRest.length) funcInfo.rest = hasRest[0]  // track rest param name
  ctx.func.list.push(funcInfo)
  ctx.func.names.add(name)
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
  let ast = parse(normalizeSource(source))
  if (ctx.transform.jzify) ast = ctx.transform.jzify(ast)
  const savedDepth = depth; depth = 0
  const moduleInit = prep(ast)
  depth = savedDepth

  // Collect exports: rename exported funcs with prefix
  const moduleExports = new Map()
  const exportLocal = (exportName, localName) => {
    const mangled = `${prefix}$${localName}`
    moduleExports.set(exportName, mangled)
    const func = ctx.func.list.find(f => f.name === localName)
    if (func) renameFunc(func, mangled)
    if (ctx.scope.globals.has(localName)) {
      const wat = ctx.scope.globals.get(localName).replace(`$${localName}`, `$${mangled}`)
      ctx.scope.globals.delete(localName)
      ctx.scope.globals.set(mangled, wat)
      if (ctx.scope.userGlobals.has(localName)) { ctx.scope.userGlobals.delete(localName); ctx.scope.userGlobals.add(mangled) }
      if (ctx.scope.globalTypes.has(localName)) { ctx.scope.globalTypes.set(mangled, ctx.scope.globalTypes.get(localName)); ctx.scope.globalTypes.delete(localName) }
    }
  }
  for (const name of Object.keys(ctx.func.exports)) {
    const val = ctx.func.exports[name]
    // Default export alias: export default existingName → map 'default' to that name's mangled form
    if (name === 'default' && typeof val === 'string') {
      // Will resolve after all named exports are mangled
      continue
    }
    // Re-export alias: export { x } from './mod' → pass through inner module's mangled name
    if (typeof val === 'string') {
      if (val.startsWith(prefix + '$')) {
        moduleExports.set(name, val)
        continue
      }
      if (ctx.func.list.some(f => f.name === val || f.name === `${prefix}$${val}`) || ctx.scope.globals.has(val) || ctx.scope.globals.has(`${prefix}$${val}`)) {
        exportLocal(name, val)
        continue
      }
      moduleExports.set(name, val)
      continue
    }
    exportLocal(name, name)
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
      if (func) renameFunc(func, mangled)
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
    renameFunc(func, mangled)
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
    recordModuleInitFacts(moduleInit)
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

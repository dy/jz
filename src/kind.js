/**
 * Expression value KIND inference (STRING, ARRAY, …) + JSON shape propagation.
 *
 * Cycle-free w.r.t. analyze.js body walkers — reads ctx + reps only.
 *
 * @module kind
 */

import { ctx } from './ctx.js'
import { VAL, lookupValType } from './reps.js'
import {
  BOOL_OPS, NUMERIC_BINARY_OPS, NUMERIC_UNARY_OPS, COMPOUND_NUMERIC_OPS,
  calleeValType, methodValType, typedCtorElemValType,
} from './kind-traits.js'

export { typedCtorElemValType } from './kind-traits.js'

function literalTruthiness(expr) {
  if (typeof expr === 'number') return expr !== 0 && expr === expr
  if (typeof expr === 'boolean') return expr
  if (typeof expr === 'bigint') return expr !== 0n
  if (Array.isArray(expr)) {
    const [op, ...args] = expr
    if (op == null) {
      if (args.length === 0 || args[0] == null) return false
      return literalTruthiness(args[0])
    }
    if (op === 'bool') return literalTruthiness(args[0])
    if (op === 'nan') return false
    if (op === 'str' && typeof args[0] === 'string') return args[0].length !== 0
  }
  return null
}

export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'boolean') return VAL.BOOL
  if (typeof expr === 'bigint') return VAL.BIGINT
  if (typeof expr === 'string') return lookupValType(expr)
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) {
    // Literal forms: [] = undefined, [null, null] = null, [null, n] = number/bigint, [, bool] = boolean
    if (args.length === 0) return null              // undefined literal
    if (args[0] == null) return null                // null literal
    if (typeof args[0] === 'boolean') return VAL.BOOL
    if (typeof args[0] === 'symbol') return null    // prepared null sentinel
    return typeof args[0] === 'bigint' ? VAL.BIGINT : VAL.NUMBER
  }

  // Self-describing boolean literal from the host→kernel AST boundary (normalizeBigints).
  if (op === 'bool') return VAL.BOOL

  // Boolean-result operators: relational/equality compares and logical-not always
  // yield a boolean. (`&&`/`||` are value-preserving, not boolean — excluded.)
  if (BOOL_OPS.has(op)) return VAL.BOOL

  // Self-describing bigint literal (`normalizeBigints`) — same VAL as a raw `255n`.
  if (op === 'bigint') return VAL.BIGINT

  if (op === '[') return VAL.ARRAY
  if (op === 'str' || op === 'strcat') return VAL.STRING
  if (op === '=>') return VAL.CLOSURE
  if (op === '//') return VAL.REGEX
  if (op === '{}') {
    const hasSpread = args.some(p => Array.isArray(p) && p[0] === '...')
    if (!hasSpread) return args[0]?.[0] === ':' ? VAL.OBJECT : null
    // Spread literal — mirror emitObjectSpread (module/object.js). When every
    // spread source has a compile-time schema, emit builds a fixed-shape OBJECT
    // and the existing schema-by-name read path resolves props with no val-type
    // tag, so leave it untyped (tagging OBJECT here regresses it — the merged
    // schema isn't bound to this name). When any source's schema is unknown, emit
    // builds a dynamic HASH (emitDynamicSpread); that result carries no schema, so
    // the binding MUST be HASH-typed or computed/static reads silently misdispatch
    // (fixed-slot / array index) and return undefined — the bug this fixes.
    for (const p of args)
      if (Array.isArray(p) && p[0] === '...' && !spreadSchema(p[1])) {
        // `{ ...src }` with a single unknown spread aliases src — carry its type.
        return args.length === 1 ? valTypeOf(args[0][1]) : VAL.HASH
      }
    return null
  }
  if (op === '?:') {
    const truthy = literalTruthiness(args[0])
    if (truthy != null) return valTypeOf(truthy ? args[1] : args[2])
    const ta = valTypeOf(args[1]), tb = valTypeOf(args[2])
    return ta && ta === tb ? ta : null
  }
  // `[]` op covers both array literals (1 arg) and index access (2 args).
  // Array literal: `[]` → ['[]', null]; `[1,2]` → ['[]', [',', ...]]; `[x]` → ['[]', x].
  // Index access:  `arr[i]` → ['[]', arr, i].
  if (op === '[]') {
    if (args.length < 2) return VAL.ARRAY
    // Indexed read on a known typed-array receiver yields Number except for
    // BigInt64Array/BigUint64Array, whose i64 carriers must stay BigInt-typed.
    if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.TYPED)
      return typedCtorElemValType(ctx.types.typedElem?.get(args[0])) || VAL.NUMBER
    // Indexed read on a STRING returns a 1-char string (SSO at runtime).
    if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.STRING) return VAL.STRING
    if (Array.isArray(args[0]) && valTypeOf(args[0]) === VAL.STRING) return VAL.STRING
    // Indexed read on a known Array<VAL> receiver: bind by rep.arrayElemValType.
    // Set by analyzeValTypes from body observations + emitFunc preseed for params.
    if (typeof args[0] === 'string') {
      const elemVt = ctx.func.localReps?.get(args[0])?.arrayElemValType
      if (elemVt) return elemVt
    }
  }
  // Schema slot read: when `varName` has a bound schemaId and `.prop` resolves
  // to a slot whose VAL kind is monomorphic across program-wide observations,
  // return that kind. Lets `+`, `===`, method dispatch skip runtime str-key
  // checks on numeric properties of known shapes. Precise-only — see
  // ctx.schema.slotVT for why structural subtyping is intentionally off.
  if (op === '.' && typeof args[1] === 'string' && ctx.schema?.slotVT) {
    const slotVT = ctx.schema.slotVT(args[0], args[1])
    if (slotVT) return slotVT
  }
  // OBJECT `.prop` propagation: when the receiver chain roots at a binding
  // sourced from `JSON.parse(stringConst)`, walk the shape tree to recover the
  // child's val-type. Generic for any compile-time-known JSON literal.
  if (op === '.' && typeof args[1] === 'string') {
    const sh = shapeOf(args[0])
    if (sh?.val === VAL.OBJECT || sh?.val === VAL.HASH) {
      const child = sh.props[args[1]]
      if (child) return child.val
    }
  }
  // Arithmetic expressions: BigInt if either operand is BigInt, else number
  if (NUMERIC_BINARY_OPS.includes(op)) {
    if (valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (NUMERIC_UNARY_OPS.has(op)) {
    // `~`, `++`, `--`, `**` preserve/propagate BigInt; `>>>` and unary-plus throw
    // on bigint operands so they always yield Number.
    if (op === '>>>' || op === 'u+') return VAL.NUMBER
    if (valTypeOf(args[0]) === VAL.BIGINT || (args[1] != null && valTypeOf(args[1]) === VAL.BIGINT)) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (op === '+') {
    const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
    if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  // Assignment & compound-assign expressions return the rhs value. Without this,
  // `(a = x*x) + (b = y*y)` falls through to null and `+` emits the polymorphic
  // string-concat dispatch on two pure-numeric subexpressions.
  if (op === '=') return valTypeOf(args[1])
  if (op === '+=') {
    const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
    const tb = valTypeOf(args[1])
    if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (COMPOUND_NUMERIC_OPS.has(op)) {
    const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
    const tb = valTypeOf(args[1])
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }

  if (op === '()') {
    const callee = args[0]
    // __iter_arr normalizes an iterable to an index-iterable Array: Set→keys,
    // Map→[k,v], while Array/String/TypedArray pass through unchanged. The result
    // type drives the downstream arr[i]/.length dispatch, so a Set/Map source
    // becomes ARRAY and everything else keeps the source's own type.
    if (callee === '__iter_arr') {
      const t = valTypeOf(args[1])
      return t === VAL.SET || t === VAL.MAP ? VAL.ARRAY : t
    }
    // Ternary is parsed as call to '?' operator: ['()', ['?', cond, a, b]]
    if (Array.isArray(callee) && callee[0] === '?') {
      const ta = valTypeOf(callee[2]), tb = valTypeOf(callee[3])
      return ta && ta === tb ? ta : null
    }
    // Constructor results + user function return-type inference
    if (typeof callee === 'string') {
      if (callee === 'JSON.parse') {
        const src = jsonConstString(args[1])
        if (src != null) {
          const c = src.trimStart()[0]
          if (c === '{') return VAL.OBJECT
          if (c === '[') return VAL.ARRAY
          if (c === '"') return VAL.STRING
          if (c === 't' || c === 'f' || c === '-' || (c >= '0' && c <= '9')) return VAL.NUMBER
        }
      } else {
        const vt = calleeValType(callee, args, ctx)
        if (vt != null) return vt
      }
    }
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee
      const vt = methodValType(method, obj, valTypeOf(obj), ctx)
      if (vt != null) return vt
    }
  }
  return null
}

export function jsonConstString(expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'string') return expr[1]
  if (typeof expr === 'string') {
    return ctx.scope.shapeStrs?.get(expr) ?? ctx.scope.constStrs?.get(expr) ?? null
  }
  return null
}

function jsonShapeStrings(expr) {
  const single = jsonConstString(expr)
  if (single != null) return [single]
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') return ctx.scope.shapeStrArrays?.get(expr[1]) ?? null
  return null
}

/** Build a structural shape tree from a parsed JSON value. Each node is
 *  `{ val, props?, elem? }` — `val` is the inferred VAL kind (matches
 *  rep.val in localReps entries). Lets `valTypeOf` propagate VAL kinds
 *  through `.prop` chains and `[i]` reads on bindings sourced from
 *  `JSON.parse` of a compile-time-known string. Polymorphic arrays drop
 *  their `elem`. */
function shapeOfJsonValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { val: VAL.NUMBER }
  if (typeof v === 'string') return { val: VAL.STRING }
  if (typeof v === 'boolean') return { val: VAL.NUMBER }
  if (Array.isArray(v)) {
    let elem = null
    for (const x of v) {
      const s = shapeOfJsonValue(x)
      if (!s) { elem = null; break }
      if (!elem) elem = s
      else if (!shapeUnifies(elem, s)) { elem = null; break }
    }
    return { val: VAL.ARRAY, elem }
  }
  if (typeof v === 'object') {
    const props = Object.create(null)
    const names = Object.keys(v)
    for (const k of names) {
      const s = shapeOfJsonValue(v[k])
      if (s) props[k] = s
    }
    return { val: VAL.OBJECT, props, names }
  }
  return null
}

function shapeUnifies(a, b) {
  if (!a || !b || a.val !== b.val) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    const ak = Object.keys(a.props), bk = Object.keys(b.props)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!b.props[k] || !shapeUnifies(a.props[k], b.props[k])) return false
    }
  }
  if (a.val === VAL.ARRAY) {
    if ((a.elem == null) !== (b.elem == null)) return false
    if (a.elem && !shapeUnifies(a.elem, b.elem)) return false
  }
  return true
}

function shapeLayoutUnifies(a, b) {
  if (!shapeUnifies(a, b)) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    if (a.names?.length !== b.names?.length) return false
    for (let i = 0; i < a.names.length; i++) if (a.names[i] !== b.names[i]) return false
  }
  if (a.val === VAL.ARRAY && a.elem) return shapeLayoutUnifies(a.elem, b.elem)
  return true
}

function parseJsonShape(src) {
  if (typeof src !== 'string') return null
  let parsed
  try { parsed = JSON.parse(src) } catch { return null }
  return shapeOfJsonValue(parsed)
}

function parseUnifiedJsonShape(srcs) {
  if (!srcs?.length) return null
  let out = null
  for (const src of srcs) {
    const sh = parseJsonShape(src)
    if (!sh) return null
    if (!out) out = sh
    else if (!shapeLayoutUnifies(out, sh)) return null
  }
  return out
}

/** Resolve the json shape for an expression by walking name → rep.jsonShape and
 *  `.prop` / `[i]` indirection. Returns null when shape is unknown at this site. */
export function shapeOf(expr) {
  if (typeof expr === 'string')
    return ctx.func.localReps?.get(expr)?.jsonShape
        ?? ctx.scope.globalReps?.get(expr)?.jsonShape
        ?? null
  if (!Array.isArray(expr)) return null
  const [op, ...args] = expr
  if (op === '()' && args[0] === 'JSON.parse') {
    const srcs = jsonShapeStrings(args[1])
    if (srcs) return parseUnifiedJsonShape(srcs)
  }
  if (op === '.' && typeof args[1] === 'string') {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.OBJECT || parent?.val === VAL.HASH) return parent.props[args[1]] || null
  }
  if (op === '[]' && args.length === 2) {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.ARRAY) return parent.elem || null
  }
  return null
}

/** Spread source's static schema (key list) or null if unknown at compile time.
 *  Mirrors module/object.js `resolveSchema` so kind inference predicts the same
 *  OBJECT-vs-HASH decision emitObjectSpread makes (kept here to keep kind.js
 *  cycle-free — it must not import the object stdlib module). */
function spreadSchema(obj) {
  // A parameter's compile-time schema is an inferred/union guess (and is unbound
  // during this body's analysis but bound by emit) — see resolveSchema in
  // module/object.js. Treat params as unknown so the spread result is HASH-typed
  // consistently across analyze and emit; otherwise reads misdispatch.
  if (typeof obj === 'string') {
    if (ctx.func.current?.params?.some(p => p.name === obj)) return null
    return ctx.schema?.resolve?.(obj)
  }
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  const sh = shapeOf(obj)
  return (sh?.val === VAL.OBJECT && sh.names) ? sh.names : null
}

/** Build a structural shape from a `{}` AST node — recursive for nested
 *  object/array literals + propagating shapes through identifier references
 *  (so `let G = {…}; let H = {x: G}` carries G's shape under H.x). Returns
 *  null when any property breaks the static-shape contract (computed key,
 *  spread, non-shape value). Only called from `recordGlobalRep` — local
 *  bindings keep relying on `shapeOf` whose narrower contract (JSON.parse /
 *  traversal only) lets `Object.assign(a, …)` extend `a`'s schema without
 *  locking a static jsonShape onto it. */
export function shapeOfObjectLiteralAst(expr) {
  if (typeof expr === 'string') return shapeOf(expr)
  if (!Array.isArray(expr) || expr[0] !== '{}') return shapeOf(expr)
  const raw = expr.length === 2 && Array.isArray(expr[1]) && expr[1][0] === ','
    ? expr[1].slice(1)
    : expr.slice(1)
  const props = Object.create(null)
  const names = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1])
    const child = shapeOfObjectLiteralAst(p[2])
    if (child) props[p[1]] = child
  }
  return names.length ? { val: VAL.OBJECT, props, names } : null
}

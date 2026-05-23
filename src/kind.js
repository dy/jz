/**
 * Expression value KIND inference (STRING, ARRAY, …) + JSON shape propagation.
 *
 * Cycle-free w.r.t. analyze.js body walkers — reads ctx + reps only.
 *
 * @module kind
 */

import { ctx } from './ctx.js'
import { VAL, lookupValType } from './reps.js'

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

  // Boolean-result operators: relational/equality compares and logical-not always
  // yield a boolean. (`&&`/`||` are value-preserving, not boolean — excluded.)
  if (op === '!' || op === '<' || op === '<=' || op === '>' || op === '>=' ||
      op === '==' || op === '!=' || op === '===' || op === '!==' || op === 'in' || op === 'instanceof')
    return VAL.BOOL

  if (op === '[') return VAL.ARRAY
  if (op === 'str' || op === 'strcat') return VAL.STRING
  if (op === '=>') return VAL.CLOSURE
  if (op === '//') return VAL.REGEX
  if (op === '{}' && args[0]?.[0] === ':') return VAL.OBJECT
  if (op === '?:') {
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
  if (['-', 'u-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(op)) {
    if (valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (['**', '++', '--', '~', '>>>', 'u+'].includes(op)) return VAL.NUMBER
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
  if (['-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>='].includes(op)) {
    const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
    const tb = valTypeOf(args[1])
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }

  if (op === '()') {
    const callee = args[0]
    // Ternary is parsed as call to '?' operator: ['()', ['?', cond, a, b]]
    if (Array.isArray(callee) && callee[0] === '?') {
      const ta = valTypeOf(callee[2]), tb = valTypeOf(callee[3])
      return ta && ta === tb ? ta : null
    }
    // Constructor results + user function return-type inference
    if (typeof callee === 'string') {
      if (callee === 'new.Set') return VAL.SET
      if (callee === 'new.Map') return VAL.MAP
      if (callee === 'new.Date') return VAL.DATE
      if (callee === 'new.ArrayBuffer') return VAL.BUFFER
      // `new Array(...)` is a plain growable Array, not a TypedArray — index
      // stores must route through __arr_set_idx_ptr (grow + persist), so it
      // must NOT fall into the new.* → VAL.TYPED catch-all below.
      if (callee === 'new.Array') return VAL.ARRAY
      // `new DataView(...)` falls through to VAL.TYPED: a DataView is a proper
      // view object (TYPED|view ptr over a 16-byte descriptor), same shape as a
      // typed-array subview — see module/typedarray.js `new.DataView`.
      if (callee.startsWith('new.')) return VAL.TYPED
      if (callee === 'String.fromCharCode' || callee === 'String') return VAL.STRING
      if (callee === 'Boolean') return VAL.BOOL
      if (callee === 'BigInt' || callee === 'BigInt.asIntN' || callee === 'BigInt.asUintN') return VAL.BIGINT
      if (callee === 'JSON.parse') {
        const src = jsonConstString(args[1])
        if (src != null) {
          const c = src.trimStart()[0]
          // Objects emit as fixed-shape OBJECT (slot-based) — see
          // module/json.js:emitJsonConstValue. The downstream `.prop` reads
          // hit emitSchemaSlotRead via ctx.schema.find, bypassing hash probes.
          if (c === '{') return VAL.OBJECT
          if (c === '[') return VAL.ARRAY
          if (c === '"') return VAL.STRING
          if (c === 't' || c === 'f' || c === '-' || (c >= '0' && c <= '9')) return VAL.NUMBER
        }
      }
      // Math.* always returns Number — let `+` skip string-concat dispatch and
      // let exprType propagate i32 for the integer-returning subset.
      if (typeof callee === 'string' && callee.startsWith('math.')) return VAL.NUMBER
      // Clock helpers always return Number — lets `t0 = performance.now()` propagate
      // VAL.NUMBER through subsequent reads, eliding `__to_num` wrappers in arithmetic.
      if (callee === 'performance.now' || callee === 'Date.now') return VAL.NUMBER
      const hostVT = ctx.module.hostImportValTypes?.get(callee)
      if (hostVT) return hostVT
      // User-defined func with monomorphic VAL return (populated in compile.js E2 pass).
      const f = ctx.func.map?.get(callee)
      if (f?.valResult) return f.valResult
    }
    // Method return types
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee
      if (method === 'map' || method === 'filter') {
        // Typed-array .map/.filter preserve element type → return VAL.TYPED.
        // Unknown receiver: don't claim (stay null) — runtime-dispatched index handles both.
        const objType = valTypeOf(obj)
        if (objType === VAL.TYPED) return VAL.TYPED
        if (objType === VAL.ARRAY) return VAL.ARRAY
        return null
      }
      if (method === 'push') return VAL.ARRAY
      if ((method === 'shift' || method === 'pop') && typeof obj === 'string') {
        const elemVt = ctx.func.localReps?.get(obj)?.arrayElemValType
        if (elemVt) return elemVt
      }
      if (method === 'add' || method === 'delete') return VAL.SET
      if (method === 'set') return VAL.MAP
      // String-returning methods
      if (['toUpperCase', 'toLowerCase', 'toLocaleLowerCase', 'trim', 'trimStart', 'trimEnd',
        'repeat', 'padStart', 'padEnd', 'replace', 'replaceAll', 'charAt', 'substring'].includes(method)) return VAL.STRING
      // `charCodeAt`/`codePointAt` always yield a number (a UTF-16 code unit or
      // NaN for an out-of-range index — both VAL.NUMBER). Without this, the f64
      // OOB-NaN result has an unknown val-type and any reader (`+`, `-`, ...)
      // wraps it in a runtime `__to_num` coercion, pulling the whole number↔
      // string stdlib tree (`__ftoa`/`__str_concat`/…) for nothing.
      if (method === 'charCodeAt' || method === 'codePointAt') return VAL.NUMBER
      if (method === 'split') return VAL.ARRAY
      // slice/concat preserve caller type (string.slice → string, array.slice → array)
      if (method === 'slice' || method === 'concat') {
        const objType = valTypeOf(obj)
        if (objType === VAL.STRING || objType === VAL.ARRAY || objType === VAL.TYPED) return objType
        return null
      }
    }
  }
  return null
}

const typedCtorElemValType = (ctor) => {
  if (!ctor) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  return name === 'BigInt64Array' || name === 'BigUint64Array' ? VAL.BIGINT : VAL.NUMBER
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


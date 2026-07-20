/**
 * Compile-time static evaluation — literals, property keys, schema ids.
 * @module static
 */
import { I32_MIN, I32_MAX } from './ast.js'
import { ctx } from './ctx.js'
import { repOf, VAL } from './reps.js'

/** Extract integer value from AST literal node. Returns null if not a 32-bit integer. */
export function intLiteralValue(expr) {
  let v = null
  if (typeof expr === 'number') v = expr
  else if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number') v = expr[1]
  else if (Array.isArray(expr) && expr[0] === 'u-' && typeof expr[1] === 'number') v = -expr[1]
  else if (typeof expr === 'string') v = repOf(expr)?.intConst ?? ctx.scope.constInts?.get(expr) ?? null
  return v != null && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX ? v : null
}

/** Non-negative integer literal — used for string/typed-array index bounds. */
export const nonNegIntLiteral = (node) => { const n = intLiteralValue(node); return n != null && n >= 0 ? n : null }

/** Flat-array slot key for a *bare* non-negative integer index literal `[null, k]`
 *  — returns the stringified index ("0","1",…) so an array `a[k]` resolves through
 *  the same SRoA `name#i` machinery as an object `o.key`. Only a literal index
 *  qualifies (not a const-folded identifier): the key must be unambiguous at scan
 *  time, before any rep is known. Null for dynamic / non-integer / huge indices. */
export const staticIndexKey = (node) =>
  Array.isArray(node) && node[0] == null && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < 0x100000000
    ? String(node[1]) : null

/** Fold compile-time integer expressions (literals, const bindings, + - * <<). */
export function constIntExpr(node) {
  let lit = intLiteralValue(node)
  if (lit == null && typeof node === 'number' && Number.isInteger(node)) lit = node
  if (lit == null && Array.isArray(node) && node[0] == null && Number.isInteger(node[1])) lit = node[1]
  if (lit != null) return lit
  if (typeof node === 'string') return repOf(node)?.intConst ?? ctx.scope.constInts?.get(node) ?? null
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'u-') {
    const v = constIntExpr(node[1])
    return v == null ? null : -v
  }
  if (node.length !== 3) return null
  const a = constIntExpr(node[1]), b = constIntExpr(node[2])
  if (a == null || b == null) return null
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '<<') return a << b
  return null
}


/** Closed integer hull [lo, hi] of an int expression, or null. Resolves names
 *  through constIntExpr (module const-ints + per-function intConst reps) and
 *  models the range-bearing operators: masks (`x & m` ⇒ [0, m]), unsigned
 *  shifts, ternary hulls, and ± / * interval arithmetic. The canonical range
 *  evaluator — narrow's typed-value-range walk and emit's i32-provability
 *  (product safety, power-of-two division strength reduction) share it. */
export function intExprRange(n) {
  const c = constIntExpr(n)
  if (c != null && Number.isInteger(c)) return [c, c]
  if (typeof n === 'string') {
    // Branch-local range refinements (flow-types: `x >= 0 && x < W` inside the
    // guarded arm) intersect with the binding's durable range rep. Analyze-time
    // stamping never sees refinements (they install only during emit), so decl
    // range reps stay context-free.
    const rf = ctx.func?.refinements?.get(n)
    const rep = repOf(n)?.range
    let lo = rep ? rep[0] : -Infinity, hi = rep ? rep[1] : Infinity
    if (rf?.rlo != null && rf.rlo > lo) lo = rf.rlo
    if (rf?.rhi != null && rf.rhi < hi) hi = rf.rhi
    return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null
  }
  if (!Array.isArray(n)) return null
  const op = n[0]
  if (op === '?:' && n.length === 4) {
    const a = intExprRange(n[2]), b = intExprRange(n[3])
    return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null
  }
  if (op === '&' && n.length === 3) {
    const m = constIntExpr(n[1]) ?? constIntExpr(n[2])
    // `&` is ToInt32: for m ≥ 2^31 the mask bit is the SIGN bit, so the result
    // can be negative (x & 0x80000000 → 0 or -2^31) — only i31-safe masks
    // yield the [0, m] hull.
    if (m != null && m >= 0 && m <= 0x7fffffff) return [0, m]
  }
  if (op === '>>>' && n.length === 3) {
    const sh = constIntExpr(n[2])
    if (sh != null && (sh & 31) !== 0) return [0, 0xFFFFFFFF >>> (sh & 31)]
  }
  if ((op === 'u-' || op === '-') && n.length === 2) {
    const a = intExprRange(n[1])
    return a ? [-a[1], -a[0]] : null
  }
  if ((op === '+' || op === '-' || op === '*') && n.length === 3) {
    const a = intExprRange(n[1]), b = intExprRange(n[2])
    if (!a || !b) return null
    if (op === '+') return [a[0] + b[0], a[1] + b[1]]
    if (op === '-') return [a[0] - b[1], a[1] - b[0]]
    const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]
    return [Math.min(...p), Math.max(...p)]
  }
  return null
}

export const NO_VALUE = Symbol('no-static-property-key')

export function staticPropertyKey(node) {
  const value = staticValue(node)
  return value === NO_VALUE ? null : String(value)
}

export function staticValue(node) {
  if (node === undefined) return undefined
  if (node === null || typeof node === 'number' || typeof node === 'boolean') return node
  if (typeof node === 'string') return ctx.scope.constStrs?.get(node) ?? NO_VALUE
  if (!Array.isArray(node)) return NO_VALUE

  const [op, ...args] = node
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'str') return args[0]
  // Self-host kernel boundary marks a literal bool as `['bool', 1|0]` (interop
  // normalizeBigints), where native keeps `[, true]` (caught by op==null above).
  // Recover the boolean from its 0/1 carrier so const-folded keys/conditions
  // resolve on the kernel leg (e.g. `{ [true ? 3 : 4]: 5 }`).
  if (op === 'bool') { const c = staticValue(args[0]); return c === NO_VALUE ? NO_VALUE : !!c }
  if (op === '[]' && args.length === 1) return staticValue(args[0])
  if (op === '()' && args[0] === 'String' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : String(value)
  }
  if (op === '()' && args[0] === 'Number' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : Number(value)
  }
  if (op === '?:' || op === '?') {
    const cond = staticValue(args[0])
    return cond === NO_VALUE ? NO_VALUE : staticValue(cond ? args[1] : args[2])
  }
  if (op === '&&' || op === '||') {
    const left = staticValue(args[0])
    if (left === NO_VALUE) return NO_VALUE
    return op === '&&' ? (left ? staticValue(args[1]) : left) : (left ? left : staticValue(args[1]))
  }
  if (op === '??') {
    const left = staticValue(args[0])
    return left === NO_VALUE ? NO_VALUE : left == null ? staticValue(args[1]) : left
  }

  if (args.length === 1) {
    const value = staticValue(args[0])
    if (value === NO_VALUE) return NO_VALUE
    // Parser emits raw `-`/`+` for both unary and binary; prep later normalizes
    // unary to `u-`/`u+`, but staticPropertyKey runs on raw parser AST.
    if (op === 'u+' || op === '+') return +value
    if (op === 'u-' || op === '-') return -value
    if (op === '!') return !value
    if (op === '~') return ~value
    return NO_VALUE
  }

  if (args.length === 2) {
    const left = staticValue(args[0])
    const right = staticValue(args[1])
    if (left === NO_VALUE || right === NO_VALUE) return NO_VALUE
    switch (op) {
      case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
      case '-': return Number(left) - Number(right)
      case '*': return Number(left) * Number(right)
      case '/': return Number(left) / Number(right)
      case '%': return Number(left) % Number(right)
      case '**': return Number(left) ** Number(right)
      case '&': return Number(left) & Number(right)
      case '|': return Number(left) | Number(right)
      case '^': return Number(left) ^ Number(right)
      case '<<': return Number(left) << Number(right)
      case '>>': return Number(left) >> Number(right)
      case '>>>': return Number(left) >>> Number(right)
      default: return NO_VALUE
    }
  }

  return NO_VALUE
}

/** Decode a `['{}', ...]` AST's children into `{names, values}`, or null if any
 *  property is non-static-key (computed key, spread, shorthand). Matches the
 *  emitter's flatten rule for comma-grouped props. Used by collectProgramFacts,
 *  narrowSignatures, and objLiteralSchemaId; the emitter (module/object.js)
 *  does its own decoding because it must handle the spread/computed-key paths. */
export function staticObjectProps(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  const names = [], values = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1]); values.push(p[2])
  }
  return names.length ? { names, values } : null
}

export function staticArrayElems(expr) {
  if (!Array.isArray(expr)) return null
  if (expr[0] === '[') return expr.slice(1)
  if (expr[0] !== '[]' || expr.length >= 3) return null
  const arg = expr[1]
  if (arg == null) return []
  return Array.isArray(arg) && arg[0] === ',' ? arg.slice(1) : [arg]
}

/** Schema-id for an object literal expression. Returns null on dynamic keys, spread, shorthand. */
export function objLiteralSchemaId(expr) {
  if (!Array.isArray(expr) || expr[0] !== '{}' || !ctx.schema?.register) return null
  const parsed = staticObjectProps(expr.slice(1))
  return parsed ? ctx.schema.register(parsed.names) : null
}

/** Canonical content key for an inplace/structInline replace-store site —
 *  the ','-wrapper around literal props is normalized away between plan and
 *  emit, so flatten before serializing. Shared by scanInplaceStores (plan),
 *  analyzeStructInline (eligibility), and the emit arms; lives here so the
 *  three importers stay acyclic (the self-host resolver rejects cycles). */
export const inplaceKey = (arrName, lit) => {
  const props = lit.slice(1)
  const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ',' ? props[0].slice(1) : props
  return `${arrName}|${JSON.stringify(flat)}`
}

/** K schema-ordered field-value AST nodes of an object literal `{S}` — the
 *  cell-store order for a structInline `.push({S})` / `a[i] = {S}` — or null if
 *  `lit` is not a plain static-key `{}` literal carrying exactly schema `sid`'s
 *  fields. Mapped by name into schema order so sites with differing key order
 *  flatten to the same cell run. */
export function structLiteralFields(lit, sid) {
  if (!Array.isArray(lit) || lit[0] !== '{}') return null
  const parsed = staticObjectProps(lit.slice(1))
  const schema = ctx.schema.list[sid]
  if (!parsed || parsed.names.length !== schema.length) return null
  const byName = new Map()
  for (let i = 0; i < parsed.names.length; i++) byName.set(parsed.names[i], parsed.values[i])
  const out = []
  for (const name of schema) {
    if (!byName.has(name)) return null
    out.push(byName.get(name))
  }
  return out
}

/** Resolve schemaId of an expression, given a per-function schemaId map for locals.
 *  Used for both intra-function arr elem-schema observation and func.arrayElemSchema
 *  return inference. Recognizes: object literals, var names with bound schemaId,
 *  user fn calls with narrowed result schema, ?: / && / || when both branches agree. */
export function exprSchemaId(expr, localSchemaMap) {
  if (typeof expr === 'string') {
    if (localSchemaMap?.has(expr)) return localSchemaMap.get(expr)
    return ctx.schema?.idOf?.(expr) ?? null
  }
  if (!Array.isArray(expr)) return null
  const op = expr[0]
  if (op === '{}') return objLiteralSchemaId(expr)
  if (op === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.valResult === VAL.OBJECT && f.sig?.ptrAux != null) return f.sig.ptrAux
    return null
  }
  if (op === '?:') {
    const a = exprSchemaId(expr[2], localSchemaMap)
    const b = exprSchemaId(expr[3], localSchemaMap)
    return a != null && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = exprSchemaId(expr[1], localSchemaMap)
    const b = exprSchemaId(expr[2], localSchemaMap)
    return a != null && a === b ? a : null
  }
  return null
}

/** Closed-union inline carrier for `name` (Array of a packed heterogeneous
 *  union — analyzeUnionInline). Same function-local-only rule as
 *  inlineArraySid, keyed by the rep's canonical set. */
export function inlineArrayUnion(name) {
  if (typeof name !== 'string') return null
  if (ctx.scope.globals?.has(name)) return null
  const set = ctx.func.localReps?.get(name)?.arrayElemSchemaSet
  if (!set || set.length < 2) return null
  const key = set.join(',')              // canonical key — tiny join, no expando on the shared rep array
  const u = ctx.schema.inlineUnion?.get(key)
  return u ? { key, sids: u.sids, stride: u.stride } : null
}

export function inlineArraySid(name) {
  if (typeof name !== 'string') return null
  // structInline is keyed on the per-function `localReps` rep, so it is only
  // consistent for a *function-local* array — a write site and a read site in the
  // same frame agree. A module-global array is read across functions whose frames
  // carry no rep for it, so the carrier would diverge: `G.push({a,b})` in one
  // function flattens the struct into K cells, while `G.length` / `G[i].a` in
  // another sees a plain array (K=1) and reads garbage. Never inline a global's
  // element struct — the plain Array<ptr> representation is consistent everywhere.
  if (ctx.scope.globals?.has(name)) return null
  const sid = ctx.func.localReps?.get(name)?.arrayElemSchema
  return sid != null && ctx.schema.inlineArray?.has(sid) ? sid : null
}

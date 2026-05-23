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

export function inlineArraySid(name) {
  if (typeof name !== 'string') return null
  const sid = ctx.func.localReps?.get(name)?.arrayElemSchema
  return sid != null && ctx.schema.inlineArray?.has(sid) ? sid : null
}

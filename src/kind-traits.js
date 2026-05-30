/**
 * Declarative value-kind traits — tables consumed by kind.js valTypeOf.
 * @module kind-traits
 */

import { VAL } from './reps.js'

export const BOOL_OPS = new Set([
  '!', '<', '<=', '>', '>=', '==', '!=', '===', '!==', 'in', 'instanceof',
])

export const NUMERIC_BINARY_OPS = ['-', 'u-', '*', '/', '%', '&', '|', '^', '<<', '>>']
export const NUMERIC_UNARY_OPS = new Set(['**', '++', '--', '~', '>>>', 'u+'])
export const COMPOUND_NUMERIC_OPS = new Set([
  '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
])

export const STRING_METHODS = new Set([
  'toUpperCase', 'toLowerCase', 'toLocaleLowerCase', 'trim', 'trimStart', 'trimEnd',
  'repeat', 'padStart', 'padEnd', 'replace', 'replaceAll', 'charAt', 'substring',
])

export const NUMBER_METHODS = new Set(['charCodeAt', 'codePointAt'])

export const CALLEE_VAL = {
  'new.Set': VAL.SET,
  'new.Map': VAL.MAP,
  'new.Date': VAL.DATE,
  'new.ArrayBuffer': VAL.BUFFER,
  'new.Array': VAL.ARRAY,
  'String.fromCharCode': VAL.STRING,
  String: VAL.STRING,
  Boolean: VAL.BOOL,
  BigInt: VAL.BIGINT,
  'BigInt.asIntN': VAL.BIGINT,
  'BigInt.asUintN': VAL.BIGINT,
  'performance.now': VAL.NUMBER,
  'Date.now': VAL.NUMBER,
}

export function calleeValType(callee, _args, ctx) {
  if (typeof callee !== 'string') return null
  if (callee in CALLEE_VAL) return CALLEE_VAL[callee]
  if (callee.startsWith('new.')) return VAL.TYPED
  if (callee.startsWith('math.')) return VAL.NUMBER
  const hostVT = ctx.module.hostImportValTypes?.get(callee)
  if (hostVT) return hostVT
  const f = ctx.func.map?.get(callee)
  if (f?.valResult) return f.valResult
  return null
}

export function methodValType(method, obj, objType, ctx) {
  if (method === 'map' || method === 'filter') {
    if (objType === VAL.TYPED) return VAL.TYPED
    if (objType === VAL.ARRAY) return VAL.ARRAY
    return null
  }
  if (method === 'push') return VAL.ARRAY
  if ((method === 'shift' || method === 'pop') && typeof obj === 'string') {
    const elemVt = ctx.func.localReps?.get(obj)?.arrayElemValType
    if (elemVt) return elemVt
  }
  // `.add`/`.set` return their receiver (Set/Map, chainable) — but only when the
  // receiver is *proven* that collection. An unknown receiver is NOT assumed
  // Set/Map: a plain object, user class, or the self-host value-tracker `store`
  // carries an own `add`/`set` closure whose result is whatever it returns;
  // claiming SET/MAP would box that f64 result as a tagged pointer (corrupt read
  // on use). A genuine Map/Set value is proven VAL.MAP/SET and still chains; an
  // untyped Map's `.set` simply yields an untyped (but correct) pointer value.
  // Mirrors the objType guard on map/filter/slice/concat.
  if (method === 'add') return objType === VAL.SET ? VAL.SET : null
  if (method === 'set') return objType === VAL.MAP ? VAL.MAP : null
  if (STRING_METHODS.has(method)) return VAL.STRING
  if (NUMBER_METHODS.has(method)) return VAL.NUMBER
  if (method === 'split') return VAL.ARRAY
  if (method === 'slice' || method === 'concat') {
    if (objType === VAL.STRING || objType === VAL.ARRAY || objType === VAL.TYPED) return objType
    return null
  }
  return null
}

export function typedCtorElemValType(ctor) {
  if (!ctor) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  return name === 'BigInt64Array' || name === 'BigUint64Array' ? VAL.BIGINT : VAL.NUMBER
}

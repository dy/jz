/**
 * Declarative value-kind traits — tables consumed by kind.js valTypeOf.
 * @module kind-traits
 */

import { VAL } from './reps.js'

// Comparison / logical-not ops — result is a 0|1 boolean carried as i32. The one
// source of truth for "this operator yields a boolean": valTypeOf reads it as
// VAL.BOOL, exprType/isIntExpr read it as integer-certain. `in`/`instanceof` also
// yield a boolean but are membership ops, kept out of the integer-certainty set
// (they throw on BigInt operands and never reach numeric analysis).
export const CMP_OPS = new Set(['!', '<', '<=', '>', '>=', '==', '!=', '===', '!=='])
export const BOOL_OPS = new Set([...CMP_OPS, 'in', 'instanceof'])

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

// Methods whose result is a boolean. Classifying them VAL.BOOL lets the export
// boundary materialize the 0/1 carrier as a real boolean (host sees true/false,
// not 1/0) and lets typeof/String/JSON observe it faithfully — internal branch/
// arithmetic positions still ride the cheap 0/1 carrier. (`has`/`delete` are
// guarded on a proven Map/Set receiver below, like `add`/`set`.)
export const BOOL_METHODS = new Set([
  'includes', 'some', 'every', 'startsWith', 'endsWith', 'test',
])

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
  // ES2024 groupBy: a dictionary (HASH) keyed by ToPropertyKey strings, and a
  // real Map keyed by SameValueZero — result reads dispatch to the right table.
  'Object.groupBy': VAL.HASH,
  'Map.groupBy': VAL.MAP,
  'RegExp.escape': VAL.STRING,
  // Predicate builtins return booleans (raw 0/1 carrier) — same classification
  // BOOL_METHODS gives includes/some/every: without it `isFinite(x) === false`
  // falls to the unknown-identity path and bit-compares 0.0 against the FALSE
  // atom (always false). typeof/String/JSON/host boundary observe it faithfully.
  isNaN: VAL.BOOL,
  isFinite: VAL.BOOL,
  'Array.isArray': VAL.BOOL,
  'Number.isNaN': VAL.BOOL,
  'Number.isFinite': VAL.BOOL,
  'Number.isInteger': VAL.BOOL,
  'Number.isSafeInteger': VAL.BOOL,
  'Object.is': VAL.BOOL,
  'Object.hasOwn': VAL.BOOL,
  'Object.isFrozen': VAL.BOOL,
  'Object.isSealed': VAL.BOOL,
  'Object.isExtensible': VAL.BOOL,
  'ArrayBuffer.isView': VAL.BOOL,
  // jzify-synthesized `instanceof Map/Set/TypedArray` predicates (autoload
  // CALL_MODULES) — same boolean-carrier classification as the ops they lower.
  __is_map: VAL.BOOL,
  __is_set: VAL.BOOL,
  __is_typed: VAL.BOOL,
  // Atomics (module/atomics.js): numbers except wait (a result string) and
  // isLockFree (a predicate boolean).
  'Atomics.load': VAL.NUMBER, 'Atomics.store': VAL.NUMBER, 'Atomics.add': VAL.NUMBER,
  'Atomics.sub': VAL.NUMBER, 'Atomics.and': VAL.NUMBER, 'Atomics.or': VAL.NUMBER,
  'Atomics.xor': VAL.NUMBER, 'Atomics.exchange': VAL.NUMBER,
  'Atomics.compareExchange': VAL.NUMBER, 'Atomics.notify': VAL.NUMBER,
  'Atomics.wait': VAL.STRING, 'Atomics.isLockFree': VAL.BOOL,
}

export function calleeValType(callee, _args, ctx) {
  if (typeof callee !== 'string') return null
  if (callee in CALLEE_VAL) return CALLEE_VAL[callee]
  if (callee.startsWith('new.')) return VAL.TYPED
  if (callee.startsWith('math.')) return VAL.NUMBER
  const hostVT = ctx.module.hostImportValTypes?.get(callee)
  if (hostVT) return hostVT
  // A direct-dispatched local closure proven to return a plain number: its f64 result
  // is never a NaN-boxed pointer, so `toNumF64` can skip the `__to_num` wrapper at the
  // call site. (Populated by closure.make as bodies are emitted, in decl order.)
  const closBody = ctx.func.directClosures?.get(callee)
  if (closBody && ctx.closure?.numericReturn?.has(closBody)) return VAL.NUMBER
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
  // jz's valueOf is a receiver passthrough (module/string.js `.valueOf`), so the
  // result kind IS the receiver kind — `Boolean(x).valueOf() === true` needs it.
  if (method === 'valueOf') return objType ?? null
  if (BOOL_METHODS.has(method)) return VAL.BOOL
  if ((method === 'has' || method === 'delete') && (objType === VAL.MAP || objType === VAL.SET)) return VAL.BOOL
  // ES2025 Set algebra — proven-SET receiver only (same guard rationale as add/set).
  if ((method === 'union' || method === 'intersection' || method === 'difference' ||
    method === 'symmetricDifference') && objType === VAL.SET) return VAL.SET
  if ((method === 'isSubsetOf' || method === 'isSupersetOf' || method === 'isDisjointFrom') &&
    objType === VAL.SET) return VAL.BOOL
  if (STRING_METHODS.has(method)) return VAL.STRING
  if (NUMBER_METHODS.has(method)) return VAL.NUMBER
  if (method === 'split') return VAL.ARRAY
  if (method === 'slice' || method === 'concat') {
    if (objType === VAL.STRING || objType === VAL.ARRAY || objType === VAL.TYPED) return objType
    return null
  }
  // .subarray returns a typed-array view (no plain-array analog). The ES2023
  // change-by-copy trio return a fresh value of the RECEIVER's kind: a typed
  // array from a typed receiver, a plain array from a plain-array receiver.
  if (method === 'subarray') return objType === VAL.TYPED ? VAL.TYPED : null
  if (method === 'toReversed' || method === 'toSorted' || method === 'with')
    return objType === VAL.TYPED ? VAL.TYPED : objType === VAL.ARRAY ? VAL.ARRAY : null
  // copyWithin mutates and returns the receiver.
  if (method === 'copyWithin') return objType === VAL.TYPED || objType === VAL.ARRAY ? objType : null
  return null
}

// Built-in PROPERTY val-types — the property-read mirror of methodValType.
// These are language invariants: `.length` is always a number on the sized
// value kinds, `.size` on Set/Map, `.byteLength`/`.byteOffset` on typed arrays.
// Without this, `arr.length + x` sees `.length` as untyped and routes `+`
// through the __is_str_key string-concat dispatch — even though `.length` can
// never be a string on a known sized kind. (Object schema slots override this
// earlier in VT['.'], so `{length:'x'}.length` keeps its true slot type.)
//
// Gate on a known objType: an untyped receiver could be an object with a
// string-valued shadow of the same name, so leave it null there (conservative).
// null-proto: user code reads `.valueOf`, `.toString` etc. — a plain `{}` would
// expose inherited Object.prototype members as bogus "numeric props".
const NUMERIC_PROPS = Object.assign(Object.create(null), {
  length: new Set([VAL.STRING, VAL.ARRAY, VAL.TYPED]),
  byteLength: new Set([VAL.TYPED, VAL.BUFFER]),
  byteOffset: new Set([VAL.TYPED]),
  size: new Set([VAL.SET, VAL.MAP]),
})
export function propValType(prop, objType) {
  if (objType == null) return null
  const kinds = NUMERIC_PROPS[prop]
  return kinds && kinds.has(objType) ? VAL.NUMBER : null
}

export function typedCtorElemValType(ctor) {
  if (!ctor) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  return name === 'BigInt64Array' || name === 'BigUint64Array' ? VAL.BIGINT : VAL.NUMBER
}

/**
 * Pure typed-storage provenance.
 *
 * One cycle-free authority for the concrete TypedArray constructor carried by
 * an expression. Analysis, kind inference, and emission all consume this file;
 * none re-walk method chains independently. Constructor strings use the
 * compiler's canonical form (`new.Float32Array`, optional `.view`).
 */

export const TYPED_FAMILY_CTORS = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView',
])

const FRESH_TYPED_RESULT_METHODS = new Set([
  'map', 'filter', 'slice', 'toReversed', 'toSorted', 'with',
])
const RECEIVER_TYPED_RESULT_METHODS = new Set([
  'fill', 'reverse', 'copyWithin', 'sort',
])

export const stripTypedView = ctor =>
  typeof ctor === 'string' && ctor.endsWith('.view') ? ctor.slice(0, -5) : ctor

export const typedCtorName = ctor => {
  const base = stripTypedView(ctor)
  return typeof base === 'string' && base.startsWith('new.') ? base.slice(4) : null
}

export const isTypedArrayCtor = ctor => {
  const name = typedCtorName(ctor)
  return !!name && name.endsWith('Array') && name !== 'ArrayBuffer' && TYPED_FAMILY_CTORS.has(name)
}

/** Direct `new TypedArray(...)` / ArrayBuffer / DataView constructor fact. */
export function typedElemCtor(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  const name = rhs[1].slice(4)
  if (!TYPED_FAMILY_CTORS.has(name)) return null
  const args = rhs[2]
  const isView = name.endsWith('Array') && name !== 'ArrayBuffer' &&
    Array.isArray(args) && args[0] === ',' && args.length >= 4
  return isView ? rhs[1] + '.view' : rhs[1]
}

/**
 * Concrete typed-storage result of `expr`, or null when it is not closed.
 * `resolveName(name)` supplies body/global binding facts and is deliberately
 * injected so this leaf has no dependency on ambient compiler state.
 *
 * Copy-producing methods preserve species but clear view-ness; subarray makes
 * a view; mutating chain methods return the receiver and retain view-ness.
 */
export function typedResultCtor(expr, resolveName) {
  if (typeof expr === 'string') return resolveName?.(expr) ?? null
  const direct = typedElemCtor(expr)
  if (direct) return direct
  if (!Array.isArray(expr) || expr[0] !== '()') return null

  const callee = expr[1]
  if (typeof callee === 'string' && callee.endsWith('.from')) {
    const name = callee.slice(0, -5)
    return TYPED_FAMILY_CTORS.has(name) && name.endsWith('Array') && name !== 'ArrayBuffer'
      ? 'new.' + name : null
  }
  if (!Array.isArray(callee) || callee[0] !== '.' || typeof callee[2] !== 'string') return null

  const method = callee[2]
  if (method !== 'subarray' && !FRESH_TYPED_RESULT_METHODS.has(method) && !RECEIVER_TYPED_RESULT_METHODS.has(method)) return null
  const source = typedResultCtor(callee[1], resolveName)
  if (!isTypedArrayCtor(source)) return null
  if (method === 'subarray') return stripTypedView(source) + '.view'
  if (FRESH_TYPED_RESULT_METHODS.has(method)) return stripTypedView(source)
  return source
}

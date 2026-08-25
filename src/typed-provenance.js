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

/** Sticky disagreement. Public ctor readers collapse it to null; meet-style
 * trackers consume it to poison a binding instead of retaining stale width. */
export const TYPED_CTOR_CONFLICT = Symbol('typed ctor conflict')

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

const joinCtor = (a, b) => {
  if (a === TYPED_CTOR_CONFLICT || b === TYPED_CTOR_CONFLICT) return TYPED_CTOR_CONFLICT
  if (a == null || b == null) return null
  return a === b ? a : TYPED_CTOR_CONFLICT
}

/**
 * Detailed typed-storage result of `expr`: canonical ctor string, null (open),
 * or TYPED_CTOR_CONFLICT (closed disagreement).
 *
 * `sources` is the complete provenance boundary for this cycle-free leaf:
 * `{ name, call, field, index }`. Callers provide facts; this function owns
 * expression traversal and method/join semantics.
 */
export function typedStorageFact(expr, sources = {}) {
  if (typeof expr === 'string') return sources.name?.(expr) ?? null
  const direct = typedElemCtor(expr)
  if (direct) return direct
  if (!Array.isArray(expr)) return null

  const op = expr[0]
  if (op === '=') return typedStorageFact(expr[2], sources)
  if (op === ',') return typedStorageFact(expr[expr.length - 1], sources)
  if (op === '?:') return joinCtor(
    typedStorageFact(expr[2], sources), typedStorageFact(expr[3], sources))
  if (op === '&&' || op === '||' || op === '??') return joinCtor(
    typedStorageFact(expr[1], sources), typedStorageFact(expr[2], sources))
  if (op === '.' || op === '?.') return sources.field?.(expr[1], expr[2], expr) ?? null
  if (op === '[]' || op === '?.[]') return sources.index?.(expr[1], expr[2], expr) ?? null
  if (op !== '()') return null

  const callee = expr[1]
  if (typeof callee === 'string') {
    if (callee.endsWith('.from')) {
      const name = callee.slice(0, -5)
      if (TYPED_FAMILY_CTORS.has(name) && name.endsWith('Array') && name !== 'ArrayBuffer')
        return 'new.' + name
    }
    return sources.call?.(callee, expr) ?? null
  }
  if (!Array.isArray(callee) || (callee[0] !== '.' && callee[0] !== '?.') || typeof callee[2] !== 'string') return null

  const method = callee[2]
  if (method !== 'subarray' && !FRESH_TYPED_RESULT_METHODS.has(method) && !RECEIVER_TYPED_RESULT_METHODS.has(method))
    return sources.call?.(callee, expr) ?? null
  const source = typedStorageFact(callee[1], sources)
  if (source === TYPED_CTOR_CONFLICT) return source
  if (!isTypedArrayCtor(source)) return null
  if (method === 'subarray') return stripTypedView(source) + '.view'
  if (FRESH_TYPED_RESULT_METHODS.has(method)) return stripTypedView(source)
  return source
}

/** Concrete ctor only; open/conflicting results both fail closed to null. */
export function typedStorageCtor(expr, sources = {}) {
  const fact = typedStorageFact(expr, sources)
  return typeof fact === 'string' ? fact : null
}

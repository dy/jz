/** The summary's kind lattice and pure scalar transfer rules. No solver state. */
import { VAL } from '../reps.js'

export const K = {
  NONE: 0, NUMBER: 1, STRING: 2, BOOL: 3, BIGINT: 4, NULLISH: 5, TYPED: 6, ARRAY: 7,
  OBJECT: 8, CLOSURE: 9, MAP: 10, SET: 11, DATE: 12, REGEX: 13, HASH: 14, BUFFER: 15, ABSENT: 16, ANY: 17,
}
// A kind packs its tag set above its parameter. The parameter is UNKNOWN
// unless the set names one tag besides the nullish pair.
const PARAM_BITS = 16
export const UNKNOWN = (1 << PARAM_BITS) - 1
export const bitOf = tag => 1 << (PARAM_BITS + tag - 1)
export const TAGS = ~UNKNOWN, NULL_BITS = bitOf(K.NULLISH) | bitOf(K.ABSENT)
const TAGS_NOT_NULL = TAGS & ~NULL_BITS
export const kind = (tag, param = UNKNOWN) => tag === K.NONE ? 0 : tag === K.ANY ? TAGS | UNKNOWN : bitOf(tag) | (param & UNKNOWN)
/** The one non-nullish tag, ANY for several, or the nullish/empty tag. */
export const tagOf = k => { const m = k & TAGS_NOT_NULL; return m === 0 ? (k & bitOf(K.NULLISH) ? K.NULLISH : k & bitOf(K.ABSENT) ? K.ABSENT : K.NONE) : (m & (m - 1)) !== 0 ? K.ANY : 32 - Math.clz32(m) - PARAM_BITS }
export const paramOf = k => k & UNKNOWN
/** One non-nullish tag beside presence. ANY itself does not prove a payload. */
export const isNullable = k => (k & NULL_BITS) !== 0 && (k & TAGS_NOT_NULL) !== 0 && tagOf(k) !== K.ANY
export const tagsOf = k => k & TAGS
export const hasTag = (k, tag) => (k & bitOf(tag)) !== 0
export const ANY = kind(K.ANY), NUMBER = kind(K.NUMBER), STRING = kind(K.STRING), BOOL = kind(K.BOOL), BIGINT = kind(K.BIGINT), NULLISH = kind(K.NULLISH), ABSENT = kind(K.ABSENT)
export const core = k => k & ~NULL_BITS
const withTag = (k, tag) => (k & TAGS_NOT_NULL) === 0 ? (k & TAGS) | bitOf(tag) | UNKNOWN : k | bitOf(tag)
export const orNull = k => withTag(k, K.NULLISH)
export const orAbsent = k => withTag(k, K.ABSENT)

/** Union of tag sets. A parameter survives when both sides agree on it. */
export function join(a, b) {
  if (a === b) return a
  const m = (a | b) & TAGS, mn = m & ~NULL_BITS
  if (mn === 0) return m === 0 ? 0 : m | UNKNOWN
  if ((mn & (mn - 1)) !== 0) return m | UNKNOWN
  const pa = a & mn ? paramOf(a) : undefined, pb = b & mn ? paramOf(b) : undefined
  return m | (pa === undefined ? pb : pb === undefined || pa === pb ? pa : UNKNOWN)
}

const VAL_OF = [null, VAL.NUMBER, VAL.STRING, VAL.BOOL, VAL.BIGINT, null, VAL.TYPED, VAL.ARRAY, VAL.OBJECT, VAL.CLOSURE, VAL.MAP, VAL.SET, VAL.DATE, VAL.REGEX, VAL.HASH, VAL.BUFFER, null, null]
/** The single non-nullable value kind, or null; presence is a separate query. */
export const valOf = k => isNullable(k) ? null : VAL_OF[tagOf(k)] ?? null
export const kindOfVal = v => { const t = VAL_OF.indexOf(v); return v == null ? ANY : t < 0 ? ANY : kind(t) }
export const valsOf = k => { const out = []; for (let t = K.NUMBER; t < K.ANY; t++) if (t !== K.NULLISH && t !== K.ABSENT && hasTag(k, t)) out.push(VAL_OF[t]); return out }

export const TYPED_CTOR = /^new\.(\w+Array)(\.view)?$/
/** Count properties belong to their receiver family, not just their name. */
const COUNT_PROPS = new Map([['length', [K.ARRAY, K.TYPED, K.STRING]], ['size', [K.MAP, K.SET]], ['byteLength', [K.TYPED, K.BUFFER]], ['byteOffset', [K.TYPED]]])
export const isCount = (prop, t) => COUNT_PROPS.get(prop)?.includes(t) === true
// Other literal names on an array are dictionary entries, not prototype members.
export const ARRAY_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'indexOf', 'lastIndexOf', 'includes', 'join', 'concat', 'sort', 'reverse', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'fill', 'flat', 'flatMap', 'at', 'entries', 'keys', 'values', 'copyWithin', 'toString', 'toSorted', 'toReversed', 'with'])
export const NUMBER_OPS = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', '++', '--'])
export const BOOL_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', 'in', 'instanceof'])

const COERCION_UNKNOWN = bitOf(K.TYPED) | bitOf(K.ARRAY) | bitOf(K.OBJECT) |
  bitOf(K.CLOSURE) | bitOf(K.MAP) | bitOf(K.SET) | bitOf(K.DATE) |
  bitOf(K.REGEX) | bitOf(K.HASH) | bitOf(K.BUFFER)
const PLUS_NUMBER = bitOf(K.NUMBER) | bitOf(K.BOOL) | NULL_BITS
const plusModes = k => {
  if (tagOf(k) === K.NONE) return 0
  const tags = k & TAGS
  let modes = tags & PLUS_NUMBER ? 1 : 0
  if (tags & bitOf(K.BIGINT)) modes |= 2
  if (tags & bitOf(K.STRING)) modes |= 4
  // Object coercion may produce any primitive domain.
  if (tags & COERCION_UNKNOWN) modes |= 1 | 2 | 4
  return modes
}
/** Normal completions of +. A throwing Number/BigInt pairing adds no result. */
export const plus = (a, b) => {
  const ma = plusModes(a), mb = plusModes(b)
  if (!ma || !mb) return K.NONE
  let out = K.NONE
  if (ma & 1 && mb & 1) out = join(out, NUMBER)
  if (ma & 2 && mb & 2) out = join(out, BIGINT)
  if (ma & 4 || mb & 4) out = join(out, STRING)
  return out
}
const numericModes = k => {
  if (tagOf(k) === K.NONE) return 0
  let modes = hasTag(k, K.BIGINT) ? 2 : 0
  const nonBig = (k & TAGS) & ~bitOf(K.BIGINT)
  if (nonBig) { modes |= 1; if (nonBig & COERCION_UNKNOWN) modes |= 2 }
  return modes
}
/** Normal completions of a typed element store of `v` (the assignment's own
 *  value): a BigInt element's ToBigInt throws on a Number and on a nullish
 *  value, a Number element's ToNumber throws on a BigInt; an open element
 *  kind rejects nothing. `elem` is the receiver's element kind. */
export const typedStore = (elem, v) => {
  const rejected = elem === BIGINT ? bitOf(K.NUMBER) | NULL_BITS : elem === NUMBER ? bitOf(K.BIGINT) : 0
  return (v & TAGS & ~rejected) === 0 ? K.NONE : v & ~rejected
}
/** ToNumeric of one operand (`b` undefined) or two: only same-domain operands complete; unsigned shift excludes BigInt. */
export const arith = (op, a, b) => {
  let modes = numericModes(a)
  if (b !== undefined) { const mb = numericModes(b); modes = mb ? modes & mb : 0 }
  if (!modes) return K.NONE
  const number = (modes & 1) !== 0, bigint = (modes & 2) !== 0 && op !== '>>>' && op !== '>>>='
  return number ? (bigint ? join(NUMBER, BIGINT) : NUMBER) : bigint ? BIGINT : K.NONE
}

/**
 * The numbers a value can be, and one transfer rule per operator over them:
 * the table every level that bounds a number reads (the summary's array
 * elements, the source's integer hulls, the optimizer's intervals of locals).
 *
 * A value is `{ lo, hi, int, nz, nan, gap }`: every value that is not NaN lies
 * in `[lo, hi]` (an infinite end leaves that side open), is a finite integer
 * where `int` (so `int` with an infinite end is an integer of any magnitude,
 * never an infinity), is never -0 where `nz`, may be NaN where `nan`, and is
 * at least `gap` from zero. Null is any value at all (a string, an object, a
 * number the caller cannot bound). `NR_NONE` is the empty set, what a cell
 * holds before any number is stored in it; `NUMBER` is any number.
 *
 * No rule reads a name, a tree or a node: a caller converts at its edge
 * (`nrInts` and `nrSpan` for an integer hull `[lo, hi]`) and resolves its
 * constants before it asks.
 *
 * @module summary/num-range
 */

export const NR_NONE = Object.freeze({ lo: Infinity, hi: -Infinity, int: true, nz: true, nan: false, gap: Infinity })
export const NUMBER = Object.freeze({ lo: -Infinity, hi: Infinity, int: false, nz: false, nan: true, gap: 0 })
const NAN = Object.freeze({ lo: Infinity, hi: -Infinity, int: true, nz: true, nan: true, gap: Infinity })

const I32_MIN = -0x80000000, I32_MAX = 0x7fffffff

/** A value with its facts read off its ends: one sign alone keeps clear of zero,
 *  -0 among it. An end no arithmetic could name (an
 *  infinity less itself) leaves its side open. */
const make = (lo, hi, int, nz, nan, gap = 0) => {
  if (Number.isNaN(lo)) lo = -Infinity
  if (Number.isNaN(hi)) hi = Infinity
  if (Number.isNaN(gap)) gap = 0
  if (lo > hi) return nan ? NAN : NR_NONE
  const g = Math.max(gap, lo > 0 ? lo : hi < 0 ? -hi : 0)
  return { lo, hi, int, nz: nz || g > 0, nan, gap: g }
}
const empty = v => v.lo > v.hi
// (an infinity among the values: an open end of a value that is no integer)
const posInf = v => v.hi === Infinity && !v.int, negInf = v => v.lo === -Infinity && !v.int
const zero = v => v.lo <= 0 && v.hi >= 0 && v.gap === 0
// (a sum of integers that cannot round to an infinity: one operand below 2^969 in magnitude)
const small = v => v.lo > -(2 ** 969) && v.hi < 2 ** 969

/** A value of these facts, the edge a caller converts its own at. */
export const nrValue = (lo, hi, int, nz, nan) => make(lo, hi, int, nz, nan)

/** The integers from lo to hi: a counter's, an index's (-0 only where an end is). */
export const nrInts = (lo, hi) => make(lo, hi, true, !Object.is(lo, -0) && !Object.is(hi, -0), false)

/** The numbers from lo to hi, of any fraction (-0 where zero is): a hull no integrality is known of. */
export const nrReals = (lo, hi) => make(lo, hi, false, false, false)

export const nrPoint = (v) => typeof v !== 'number' ? null : Number.isNaN(v) ? NAN
  : make(v, v, Number.isInteger(v), !Object.is(v, -0), false, Math.abs(v))

/** Every value of either. */
export function nrJoin(a, b) {
  if (a === NR_NONE) return b
  if (b === NR_NONE) return a
  if (!a || !b) return null
  // (a holds b where every fact a states of its values holds of b's)
  if (a.lo <= b.lo && a.hi >= b.hi && (!a.int || b.int) && (!a.nz || b.nz) && (a.nan || !b.nan) && a.gap <= b.gap) return a
  return make(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi), a.int && b.int, a.nz && b.nz, a.nan || b.nan, Math.min(a.gap, b.gap))
}

export const nrEqual = (a, b) => a === b || !!a && !!b && a.lo === b.lo && a.hi === b.hi && a.int === b.int && a.nz === b.nz && a.nan === b.nan && a.gap === b.gap

/** A word: every value an integer of one signed 32-bit word, never -0 nor NaN. */
export const nrWord = (r) => !!r && !empty(r) && r.int && r.nz && !r.nan && r.lo >= I32_MIN && r.hi <= I32_MAX

/** The integer hull `[lo, hi]` of a value that is a finite integer and never NaN, or null. */
export const nrSpan = (r) => r && !empty(r) && r.int && !r.nan && Number.isFinite(r.lo) && Number.isFinite(r.hi) ? [r.lo, r.hi] : null

/** The hull `[lo, hi]` of a value that is never NaN and of finite ends, or null. */
export const nrHull = (r) => r && !empty(r) && !r.nan && Number.isFinite(r.lo) && Number.isFinite(r.hi) ? [r.lo, r.hi] : null

/** The value where its numbers are finite and never NaN, or null: a bound that
 *  holds every value it may be (the summary's elements and parameters). */
export const nrReal = (r) => r && (r === NR_NONE || !r.nan && Number.isFinite(r.lo) && Number.isFinite(r.hi)) ? r : null

const WORD = make(I32_MIN, I32_MAX, true, true, false)
const UWORD = make(0, 0xffffffff, true, true, false)
const nonNegative = v => v.lo >= 0 && v.nz

export function nrBinary(op, a, b) {
  if (a === NR_NONE || b === NR_NONE) return a && b ? NR_NONE : null
  // ToInt32 of anything is a word: the bitwise operators give one whatever they read
  if (op === '|' || op === '^' || op === '<<') return op === '|' && b && b.lo === 0 && b.hi === 0 && nrWord(a) ? a : WORD
  if (op === '&') {
    const m = b && b.lo === b.hi && b.lo >= 0 && b.lo <= I32_MAX ? b.lo : a && a.lo === a.hi && a.lo >= 0 && a.lo <= I32_MAX ? a.lo : -1
    return m >= 0 ? make(0, m, true, true, false) : WORD
  }
  if (op === '>>' || op === '>>>') {
    // (a count that may be NaN may be 0: ToUint32 of NaN)
    const k = b && b.lo === b.hi && b.int && !b.nan ? b.lo & 31 : -1
    if (op === '>>') return k < 0 ? WORD : nrWord(a) ? make(a.lo >> k, a.hi >> k, true, true, false) : make(I32_MIN >> k, I32_MAX >> k, true, true, false)
    return k <= 0 ? UWORD : make(0, 0xffffffff >>> k, true, true, false)
  }
  if (op === '**') return nrMath('pow', [a, b])
  if (!a || !b) return null
  // (NaN is what arithmetic makes of a NaN)
  if (empty(a) || empty(b)) return NAN
  const nan = a.nan || b.nan
  if (op === '+') return make(a.lo + b.lo, a.hi + b.hi, a.int && b.int && (small(a) || small(b)),
    a.nz || b.nz, nan || posInf(a) && negInf(b) || negInf(a) && posInf(b))
  // (x - y is -0 only of x -0 and y +0)
  if (op === '-') return make(a.lo - b.hi, a.hi - b.lo, a.int && b.int && (small(a) || small(b)),
    a.nz || b.gap > 0, nan || posInf(a) && posInf(b) || negInf(a) && negInf(b))
  if (op === '*') {
    const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
    // (a product is -0 only where it is a zero, an operand's or an underflow's, and the signs differ;
    // an integer's past every double is an infinity; a zero times an infinity is NaN)
    const lo = Math.min(...p), hi = Math.max(...p)
    return make(lo, hi, a.int && b.int && Number.isFinite(lo) && Number.isFinite(hi), a.gap * b.gap > 0 || nonNegative(a) && nonNegative(b),
      nan || zero(a) && (posInf(b) || negInf(b)) || zero(b) && (posInf(a) || negInf(a)), a.gap * b.gap)
  }
  if (op === '/') {
    if (!(b.gap > 0)) return NUMBER
    // (a divisor on both sides of zero is monotone on each side of its gap)
    const p = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi]
    if (b.lo < 0 && b.hi > 0) p.push(a.lo / b.gap, a.lo / -b.gap, a.hi / b.gap, a.hi / -b.gap)
    return make(Math.min(...p), Math.max(...p), false, nonNegative(a) && b.lo > 0, nan || (posInf(a) || negInf(a)) && (posInf(b) || negInf(b)))
  }
  // A remainder keeps the dividend's sign (a zero dividend, -0 among them, its own)
  // under the divisor's magnitude, one less between integers, whatever the
  // dividend's magnitude: NaN of a zero divisor and of an infinite dividend.
  if (op === '%') {
    if (b.lo === 0 && b.hi === 0) return NAN
    const m = Math.max(-b.lo, b.hi), top = a.int && b.int ? m - 1 : m
    return make(a.lo >= 0 ? 0 : Math.max(a.lo, -top), a.hi <= 0 ? 0 : Math.min(a.hi, top), a.int && b.int,
      nonNegative(a), nan || !(b.gap > 0) || posInf(a) || negInf(a))
  }
  return null
}

export function nrUnary(op, a) {
  if (a === NR_NONE) return NR_NONE
  if (op === '~') return WORD
  if (!a) return null
  if (op === 'u+') return a
  // (-x is -0 of a +0)
  if (op === 'u-') return make(-a.hi, -a.lo, a.int, !zero(a), a.nan, a.gap)
  return null
}

// A pow's ends as the host computes them, widened past any rounding an
// implementation within 2^-40 of the true power makes between them, the
// runtime kernel's among them (the host's own error, under 2^-52, inside the
// second 2^-40): the table imports no kernel, so a bounds proof that reads it
// imports no emission (test/passes.js).
const POW_SLACK = 2 ** -39
const powEnds = (x, y) => x ** y

/** `Math.<name>(...args)` over the arguments' ranges. */
export function nrMath(name, args) {
  if (args.some(a => a === NR_NONE)) return args.every(a => a) ? NR_NONE : null
  if (name === 'imul') return WORD
  if (name === 'clz32') return make(0, 32, true, true, false)
  const a = args[0]
  if (!a) return null
  if (name === 'pow') return pow(a, args)
  if (empty(a)) return NAN
  // (a rounding of a finite number is an integer; of an infinity, the infinity)
  const whole = !posInf(a) && !negInf(a)
  switch (name) {
    case 'abs': return args.length === 1 ? make(a.lo >= 0 ? a.lo : a.hi <= 0 ? -a.hi : 0, Math.max(-a.lo, a.hi), a.int, true, a.nan, a.gap) : null
    // (Math.sign(-0) is -0; a value clear of zero is one of -1 and 1)
    case 'sign': return args.length === 1 ? make(a.lo > 0 ? 1 : a.lo < 0 ? -1 : 0, a.hi < 0 ? -1 : a.hi > 0 ? 1 : 0, true, a.nz, a.nan, a.gap > 0 ? 1 : 0) : null
    // (rounding to -0: round of [-0.5, -0], ceil and trunc of (-1, -0], floor of -0 alone)
    case 'round': return args.length === 1 ? make(Math.round(a.lo), Math.round(a.hi), whole,
      nonNegative(a) || a.hi < -0.5 || a.gap > 0.5, a.nan, a.gap > 0.5 ? Math.ceil(a.gap - 0.5) : 0) : null
    case 'floor': return args.length === 1 ? make(Math.floor(a.lo), Math.floor(a.hi), whole, a.nz, a.nan, Math.floor(a.gap)) : null
    case 'ceil': case 'trunc': return args.length === 1 ? make(name === 'ceil' ? Math.ceil(a.lo) : Math.trunc(a.lo), name === 'ceil' ? Math.ceil(a.hi) : Math.trunc(a.hi), whole,
      nonNegative(a) || a.hi <= -1 || a.gap >= 1, a.nan, Math.floor(a.gap)) : null
    // (the root of a negative is NaN, of -0 itself)
    case 'sqrt': return args.length === 1 ? a.hi < 0 ? NAN : make(Math.sqrt(Math.max(0, a.lo)), Math.sqrt(a.hi), false, a.nz, a.nan || a.lo < 0, a.lo >= 0 ? Math.sqrt(a.gap) : 0) : null
    case 'min': case 'max': {
      if (args.length !== 2 || !args[1]) return null
      const b = args[1], min = name === 'min'
      if (empty(b)) return NAN
      return make(min ? Math.min(a.lo, b.lo) : Math.max(a.lo, b.lo), min ? Math.min(a.hi, b.hi) : Math.max(a.hi, b.hi), a.int && b.int, a.nz && b.nz, a.nan || b.nan, Math.min(a.gap, b.gap))
    }
    default: return null
  }
}

// A positive base to a constant finite power: monotone in the base (any base,
// NaN among them, to the power 0 is 1).
function pow(a, args) {
  const b = args[1]
  if (args.length !== 2 || !b || empty(b) || b.lo !== b.hi || !Number.isFinite(b.lo)) return null
  const y = b.lo
  if (y === 0) return make(1, 1, true, true, b.nan)
  if (empty(a) || !(a.lo > 0)) return null
  const p = powEnds(a.lo, y), q = powEnds(a.hi, y)
  const lo = Math.min(p, q) * (1 - POW_SLACK), hi = Math.max(p, q) * (1 + POW_SLACK)
  return make(lo, hi, false, true, a.nan || b.nan, lo)
}

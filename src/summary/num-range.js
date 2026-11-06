/**
 * The numbers a value can be, as the summary bounds an array's elements: a
 * finite interval `[lo, hi]`, whether every value is an integer (`int`),
 * whether none is -0 (`nz`) and the least magnitude any value has (`gap`, so
 * `|v| >= gap`). NaN and the infinities are outside every range: an operation
 * that may give one has no range (null). `NR_NONE` is the empty set, what a
 * cell holds before any number is stored in it.
 *
 * Pure transfer rules over that domain; the solver (index.js) resolves names.
 *
 * @module summary/num-range
 */
import { powRuntime } from '../prepare/math-kernel.js'

export const NR_NONE = Object.freeze({ lo: Infinity, hi: -Infinity, int: true, nz: true, gap: Infinity })

const I32_MIN = -0x80000000, I32_MAX = 0x7fffffff

/** A range with its magnitude floor read off its ends: one sign alone keeps clear of zero. */
const make = (lo, hi, int, nz, gap) => {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null
  const g = Math.max(gap, lo > 0 ? lo : hi < 0 ? -hi : 0)
  return { lo, hi, int, nz: nz || g > 0, gap: g }
}

/** The integers from lo to hi: a counter's, an index's (-0 only where an end is). */
export const nrInts = (lo, hi) => make(lo, hi, true, !Object.is(lo, -0) && !Object.is(hi, -0), 0)

export const nrPoint = (v) => typeof v === 'number' && Number.isFinite(v)
  ? make(v, v, Number.isInteger(v), !Object.is(v, -0), Math.abs(v)) : null

/** Every value of either. */
export function nrJoin(a, b) {
  if (a === NR_NONE) return b
  if (b === NR_NONE) return a
  if (!a || !b) return null
  // (a holds b where every fact a states of its values holds of b's)
  if (a.lo <= b.lo && a.hi >= b.hi && (!a.int || b.int) && (!a.nz || b.nz) && a.gap <= b.gap) return a
  return make(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi), a.int && b.int, a.nz && b.nz, Math.min(a.gap, b.gap))
}

export const nrEqual = (a, b) => a === b || !!a && !!b && a.lo === b.lo && a.hi === b.hi && a.int === b.int && a.nz === b.nz && a.gap === b.gap

/** A word: every value an integer of one signed 32-bit word, never -0. */
export const nrWord = (r) => !!r && r !== NR_NONE && r.int && r.nz && r.lo >= I32_MIN && r.hi <= I32_MAX

const WORD = make(I32_MIN, I32_MAX, true, true, 0)
const UWORD = make(0, 0xffffffff, true, true, 0)
const bothNonNegative = (a, b) => a.lo >= 0 && a.nz && b.lo >= 0 && b.nz

export function nrBinary(op, a, b) {
  if (a === NR_NONE || b === NR_NONE) return a && b ? NR_NONE : null
  // ToInt32 of anything is a word: the bitwise operators give one whatever they read
  if (op === '|' || op === '^' || op === '<<') return op === '|' && b && b.lo === 0 && b.hi === 0 && nrWord(a) ? a : WORD
  if (op === '&') {
    const m = b && b.lo === b.hi && b.lo >= 0 && b.lo <= I32_MAX ? b.lo : a && a.lo === a.hi && a.lo >= 0 && a.lo <= I32_MAX ? a.lo : -1
    return m >= 0 ? make(0, m, true, true, 0) : WORD
  }
  if (op === '>>' || op === '>>>') {
    const k = b && b.lo === b.hi && b.int ? b.lo & 31 : -1
    if (op === '>>') return k < 0 ? WORD : nrWord(a) ? make(a.lo >> k, a.hi >> k, true, true, 0) : make(I32_MIN >> k, I32_MAX >> k, true, true, 0)
    return k <= 0 ? UWORD : make(0, 0xffffffff >>> k, true, true, 0)
  }
  if (!a || !b) return null
  if (op === '+') return make(a.lo + b.lo, a.hi + b.hi, a.int && b.int, a.nz || b.nz, 0)
  // (x - y is -0 only of x -0 and y +0)
  if (op === '-') return make(a.lo - b.hi, a.hi - b.lo, a.int && b.int, a.nz || b.gap > 0, 0)
  if (op === '*') {
    const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
    // (a product is -0 only where it is a zero, an operand's or an underflow's, and the signs differ)
    return make(Math.min(...p), Math.max(...p), a.int && b.int, a.gap * b.gap > 0 || bothNonNegative(a, b), a.gap * b.gap)
  }
  if (op === '/' && b.gap > 0) {
    // (a divisor on both sides of zero is monotone on each side of its gap)
    const p = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi]
    if (b.lo < 0 && b.hi > 0) p.push(a.lo / b.gap, a.lo / -b.gap, a.hi / b.gap, a.hi / -b.gap)
    return make(Math.min(...p), Math.max(...p), false, a.lo >= 0 && a.nz && b.lo > 0, 0)
  }
  // a remainder keeps the dividend's sign (a zero dividend, -0 among them, its own) under the divisor's magnitude
  if (op === '%' && b.gap > 0) {
    const m = Math.max(-b.lo, b.hi), top = a.int && b.int ? m - 1 : m
    return make(a.lo >= 0 ? 0 : Math.max(a.lo, -top), a.hi <= 0 ? 0 : Math.min(a.hi, top), a.int && b.int, a.lo >= 0 && a.nz, 0)
  }
  return null
}

export function nrUnary(op, a) {
  if (a === NR_NONE) return NR_NONE
  if (op === '~') return WORD
  if (!a) return null
  if (op === 'u+') return a
  // (-x is -0 of a +0)
  if (op === 'u-') return make(-a.hi, -a.lo, a.int, a.gap > 0 || a.hi < 0, a.gap)
  return null
}

// A pow's ends as the runtime kernel computes them, widened past any rounding
// an implementation within 2^-40 of the true power makes between them.
const POW_SLACK = 2 ** -40
const powEnds = (x, y) => powRuntime(x, y)

/** `Math.<name>(...args)` over the arguments' ranges. */
export function nrMath(name, args) {
  if (args.some(a => a === NR_NONE)) return args.every(a => a) ? NR_NONE : null
  const a = args[0]
  if (!a) return null
  switch (name) {
    case 'abs': return args.length === 1 ? make(a.lo >= 0 ? a.lo : a.hi <= 0 ? -a.hi : 0, Math.max(-a.lo, a.hi), a.int, true, a.gap) : null
    // (Math.sign(-0) is -0; a value clear of zero is one of -1 and 1)
    case 'sign': return args.length === 1 ? make(a.lo > 0 ? 1 : a.lo < 0 ? -1 : 0, a.hi < 0 ? -1 : a.hi > 0 ? 1 : 0, true, a.nz, a.gap > 0 ? 1 : 0) : null
    // (rounding to -0: round of [-0.5, -0], ceil and trunc of (-1, -0], floor of -0 alone)
    case 'round': return args.length === 1 ? make(Math.round(a.lo), Math.round(a.hi), true,
      a.lo >= 0 && a.nz || a.hi < -0.5 || a.gap > 0.5, a.gap > 0.5 ? Math.ceil(a.gap - 0.5) : 0) : null
    case 'floor': return args.length === 1 ? make(Math.floor(a.lo), Math.floor(a.hi), true, a.nz, Math.floor(a.gap)) : null
    case 'ceil': case 'trunc': return args.length === 1 ? make(Math[name](a.lo), Math[name](a.hi), true,
      a.lo >= 0 && a.nz || a.hi <= -1 || a.gap >= 1, Math.floor(a.gap)) : null
    case 'sqrt': return args.length === 1 && a.lo >= 0 ? make(Math.sqrt(a.lo), Math.sqrt(a.hi), false, a.nz, Math.sqrt(a.gap)) : null
    case 'min': case 'max': {
      if (args.length !== 2 || !args[1]) return null
      const b = args[1], f = Math[name]
      return make(f(a.lo, b.lo), f(a.hi, b.hi), a.int && b.int, a.nz && b.nz, Math.min(a.gap, b.gap))
    }
    // a positive base to a constant power: monotone in the base
    case 'pow': {
      const b = args[1]
      if (args.length !== 2 || !b || b.lo !== b.hi || !(a.lo > 0)) return null
      const y = b.lo, p = powEnds(a.lo, y), q = powEnds(a.hi, y)
      const lo = Math.min(p, q) * (1 - POW_SLACK), hi = Math.max(p, q) * (1 + POW_SLACK)
      return make(lo, hi, false, true, lo)
    }
    case 'imul': return WORD
    case 'clz32': return make(0, 32, true, true, 0)
    default: return null
  }
}

/** Pure integer-span transfer shared by the solver and settled readers. */
import { nrBinary, nrInts, nrSpan } from './num-range.js'

export const SPAN_BINARY = new Set(['&', '+', '-', '*', '%', '|', '<<', '>>>', '>>'])
const maskSpan = m => m && m[0] === m[1] && m[0] >= 0 && m[0] <= 0x7fffffff ? [0, m[0]] : null

export function spanBinary(op, a, b) {
  // ToInt32 of the other operand keeps a mask inside its nonnegative bits.
  if (op === '&') return maskSpan(b) ?? maskSpan(a)
  // A shift by a constant count spans the word it leaves, whatever it shifts:
  // ToUint32 of anything for `>>>`, ToInt32 of anything for `>>`.
  if ((op === '>>>' || op === '>>') && b && b[0] === b[1] && b[0] >= 0 && b[0] <= 31) {
    const k = b[0]
    if (op === '>>') return [-0x80000000 >> k, 0x7fffffff >> k]
    return [0, a && a[0] >= 0 && a[1] <= 0xffffffff ? Math.floor(a[1] / 2 ** k) : 0xffffffff >>> k]
  }
  if (!a || !b) return null
  let lo, hi
  if (op === '+') { lo = a[0] + b[0]; hi = a[1] + b[1] }
  else if (op === '-') { lo = a[0] - b[1]; hi = a[1] - b[0] }
  else if (op === '*') { const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; lo = Math.min(...p); hi = Math.max(...p) }
  // (a span holds -0 at an end alone: a remainder that may be -0 inside has none)
  else if (op === '%') { const r = nrBinary('%', nrInts(a[0], a[1]), nrInts(b[0], b[1])), s = r.nz ? nrSpan(r) : null; if (!s) return null; lo = s[0]; hi = s[1] }
  else if (op === '|' && b[0] === 0 && b[1] === 0 && a[0] >= -0x80000000 && a[1] <= 0x7fffffff) { lo = a[0]; hi = a[1] }
  else if (op === '<<' && a[0] === a[1] && b[0] === b[1]) { lo = hi = a[0] << b[0] }
  else return null
  return Number.isSafeInteger(lo) && Number.isSafeInteger(hi) ? [lo, hi] : null
}

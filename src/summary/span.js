/** Pure integer-span transfer shared by the solver and settled readers. */
export const SPAN_BINARY = new Set(['&', '+', '-', '*', '%', '|', '<<'])
const maskSpan = m => m && m[0] === m[1] && m[0] >= 0 && m[0] <= 0x7fffffff ? [0, m[0]] : null

export function spanBinary(op, a, b) {
  // ToInt32 of the other operand keeps a mask inside its nonnegative bits.
  if (op === '&') return maskSpan(b) ?? maskSpan(a)
  if (!a || !b) return null
  let lo, hi
  if (op === '+') { lo = a[0] + b[0]; hi = a[1] + b[1] }
  else if (op === '-') { lo = a[0] - b[1]; hi = a[1] - b[0] }
  else if (op === '*') { const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; lo = Math.min(...p); hi = Math.max(...p) }
  else if (op === '%' && a[0] >= 0 && b[0] > 0) { lo = 0; hi = Math.min(a[1], b[1] - 1) }
  else if (op === '|' && b[0] === 0 && b[1] === 0 && a[0] >= -0x80000000 && a[1] <= 0x7fffffff) { lo = a[0]; hi = a[1] }
  else if (op === '<<' && a[0] === a[1] && b[0] === b[1]) { lo = hi = a[0] << b[0] }
  else return null
  return Number.isSafeInteger(lo) && Number.isSafeInteger(hi) ? [lo, hi] : null
}

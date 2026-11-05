// Class: an integer recurrence bounded by a clamp (acc = clamp(acc + int32, lo, hi)) is kept f64:
// the sum of two int32s may overflow, and the clamp's bound on acc is not fed back into the sum's range.
// QOA: r = qoa_clamp(predicted + dequantized, -32768, 32767) per sample. Control: the sum narrowed by hand (| 0).
const T = Int32Array.from([3, -3, 10, -10, 18, -18, 28, -28])
const B = new Uint8Array(1 << 20)
for (let i = 0, x = 1; i < B.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; B[i] = x >>> 24 }
export function clamp() { let b = B, t = T, acc = 0; for (let p = 0; p < b.length; p++) { let r = acc + t[b[p] & 7]; acc = r < -32768 ? -32768 : r > 32767 ? 32767 : r } return acc }
export function control() { let b = B, t = T, acc = 0; for (let p = 0; p < b.length; p++) { let r = (acc + t[b[p] & 7]) | 0; acc = r < -32768 ? -32768 : r > 32767 ? 32767 : r } return acc }

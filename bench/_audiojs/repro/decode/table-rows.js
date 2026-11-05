// Class: integer-valued elements of a plain Array (a table built by .map over Math.round) read as f64,
// which turns the arithmetic they feed into f64 (add, clamp, then a truncation back to the int store).
// QOA: dequantized = qoa_dequant_tab[sf][q] per sample. Control: the same rows as Int32Array.
const round = n => Math.sign(n) * Math.round(Math.abs(n))
const SF = Array(16).fill().map((_, s) => round(Math.pow(s + 1, 2.75)))
const DQ = [0.75, -0.75, 2.5, -2.5, 4.5, -4.5, 7, -7]
const PLAIN = SF.map(sf => DQ.map(d => round(d * sf)))
const TYPED = PLAIN.map(r => Int32Array.from(r))
const B = new Uint8Array(1 << 20), H = new Int16Array(1 << 20)
for (let i = 0, x = 1; i < B.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; B[i] = x >>> 24 }
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v
export function plain() { let b = B, h = H; for (let p = 4; p < b.length; p++) { let t = PLAIN[b[p] >>> 4], pred = (h[p - 1] * 3 - h[p - 2] * 2) >> 1; h[p] = clamp(pred + t[b[p] & 7], -32768, 32767) } return h[b.length - 1] }
export function typed() { let b = B, h = H; for (let p = 4; p < b.length; p++) { let t = TYPED[b[p] >>> 4], pred = (h[p - 1] * 3 - h[p - 2] * 2) >> 1; h[p] = clamp(pred + t[b[p] & 7], -32768, 32767) } return h[b.length - 1] }
// controls: one flat Int32Array of the same 128 values (length known), indexed in bounds by construction
const FLAT = new Int32Array(128); for (let s = 0; s < 16; s++) for (let q = 0; q < 8; q++) FLAT[s * 8 + q] = PLAIN[s][q]
export function flat() { let b = B, h = H; for (let p = 4; p < b.length; p++) { let pred = (h[p - 1] * 3 - h[p - 2] * 2) >> 1; h[p] = clamp(pred + FLAT[(b[p] >>> 4) * 8 + (b[p] & 7)], -32768, 32767) } return h[b.length - 1] }

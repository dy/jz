// The exponential kernels' table (module/math/trig-tables.js EXP2_TAB and its
// hex twin, EXP2_Q, EXP_Q, EXP_L1/EXP_L2): 2^(j/64) for j = 0..63 as the double
// nearest the exact power and the relative tail its rounding dropped, derived
// from the 64th root of 2 at 200 bits (Newton, then round-to-nearest-even on
// the 53-bit mantissa); the remainder series' exact coefficients ln2^n/n! and
// 1/n!; and ln2/64 split into a 36-bit head (k·L1 exact for |k| < 2^17) and
// its tail. test/math.js re-derives the table the same way.
//
//   node scripts/exp-table.mjs   → the literals, ready to paste
const P = 200n, ONE = 1n << P, N = 64
const LN2 = (() => { let s = 0n, t = ONE / 3n, k = 1n; while (t) { s += t / k; t = t / 9n; k += 2n } return 2n * s })()   // 2·atanh(1/3)
const rootN = (n, target) => { let x = ONE; for (let i = 0; i < 200; i++) { let p = ONE; for (let j = 0; j < n; j++) p = p * x / ONE; const nx = x - (p - target) * ONE / (BigInt(n) * (p * ONE / x)); if (nx === x) break; x = nx } return x }
const R = rootN(N, 2n * ONE)
const toD = (v) => { const q = v >> (P - 52n), r = v & ((1n << (P - 52n)) - 1n), half = 1n << (P - 53n); let m = q; if (r > half || (r === half && (q & 1n))) m += 1n; return Number(m) / 2 ** 52 }
const fix = (x) => BigInt(Math.round(x * 2 ** 60)) * (ONE >> 60n)
const T = [], TAIL = []
for (let j = 0, v = ONE; j < N; j++, v = v * R / ONE) { const t = toD(v); T.push(t); TAIL.push(Number(v - fix(t)) / Number(fix(t))) }
const L1 = (() => { const b = new Float64Array([Math.LN2 / N]); const u = new BigUint64Array(b.buffer); u[0] &= ~((1n << 17n) - 1n); return b[0] })()
const L2 = Number(LN2 / BigInt(N) - fix(L1)) / Number(ONE)
const Q2 = [], QE = []
for (let n = 1, f = 1; n <= 6; n++) { f *= n; Q2.push(Math.LN2 ** n / f); QE.push(1 / f) }
const dv = new DataView(new ArrayBuffer(16 * N))
T.forEach((t, j) => { dv.setFloat64(16 * j, t, true); dv.setFloat64(16 * j + 8, TAIL[j], true) })
let hex = ''
for (let i = 0; i < 16 * N; i++) hex += dv.getUint8(i).toString(16).padStart(2, '0')
console.log(`export const EXP2_TAB = [\n  ${T.map((t, j) => `${t}, ${TAIL[j]}`).join(',\n  ')},\n]`)
console.log(`export const EXP2_TAB_HEX = '${hex}'`)
console.log(`export const EXP2_Q = [${Q2.join(', ')}]`)
console.log(`export const EXP_Q = [${QE.join(', ')}]`)
console.log(`export const EXP_L1 = ${L1}, EXP_L2 = ${L2}`)

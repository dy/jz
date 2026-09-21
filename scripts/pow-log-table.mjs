// The pow kernel's log table (module/math/trig-tables.js POW_LOG_TAB and its hex
// twin): log(x) = k·ln2 + log(c) + log1p(z/c − 1) over z ∈ [0x1.69555p-1, 0x1.69555p0)
// split into 128 subintervals by the top mantissa bits of z − OFF, c near the
// center of each with 1/c = j/128 (or j/256 above 1) so that z/c − 1 is exact in
// a double, logc = log(c) rounded to 43 fractional bits (k·ln2hi + logc then
// adds exactly) and logctail the double nearest the remainder. log(c) is
// derived at 200 bits (ln2 = 2·atanh(1/3), log m = 2·atanh((m−1)/(m+1)) for
// m ∈ [1, 2)). The scheme is Arm's optimized-routines pow (Szabolcs Nagy, MIT):
// with its polynomial the kernel is within 0.54 ulp.
//
//   node scripts/pow-log-table.mjs   → the literals, ready to paste
const P = 200n, ONE = 1n << P, N = 128
const OFF = 0x3fe6955500000000n
const atanhSeries = (t) => { let s = 0n, term = t, k = 1n; const t2 = t * t / ONE; while (term) { s += term / k; term = term * t2 / ONE; k += 2n } return s }
const LN2 = 2n * atanhSeries(ONE / 3n)
// log of a positive rational p/q at P bits: log(p) − log(q), each as e·ln2 + log(m), m ∈ [1, 2)
const logInt = (n) => { let e = 0n, m = BigInt(n); while (m >= 2n) { if (m % 2n) break; m /= 2n; e++ } let k = 0n, v = m * ONE; while (v >= 2n * ONE) { v /= 2n; k++ }; return (e + k) * LN2 + 2n * atanhSeries((v - ONE) * ONE / (v + ONE)) }
const asDouble = (bits) => new Float64Array(new BigUint64Array([bits]).buffer)[0]
const bitsOf = (d) => new BigUint64Array(new Float64Array([d]).buffer)[0]
// The double nearest a P-bit fixed-point value: 62 significant bits into a
// Number (round to nearest even), then an exact power-of-two scale.
const toD = (v) => { if (v === 0n) return 0; const neg = v < 0n, a = neg ? -v : v, sh = a.toString(2).length - 62; const d = Number(sh > 0 ? a >> BigInt(sh) : a << BigInt(-sh)) * 2 ** (sh - Number(P)); return neg ? -d : d }
const rows = []
for (let i = 0; i < N; i++) {
  const center = asDouble(OFF + BigInt(i) * (1n << 45n) + (1n << 44n))
  const j = center < 1 ? Math.round(N / center) : Math.round(2 * N / center)
  const invc = center < 1 ? j / N : j / N / 2
  // log(c) = −log(invc) = −(log j − log(N or 2N))
  const logc200 = logInt(center < 1 ? N : 2 * N) - logInt(j)
  // logc: 43 fractional bits, round to nearest
  const scaled = logc200 * (1n << 43n), half = ONE / 2n
  const q = (scaled + (scaled >= 0n ? half : -half)) / ONE   // integer, rounded
  const logc = Number(q) / 2 ** 43
  const tail200 = logc200 - q * ONE / (1n << 43n)
  const logctail = toD(tail200)
  rows.push([invc, logc, logctail])
}
const dv = new DataView(new ArrayBuffer(24 * N))
rows.forEach(([a, b, c], i) => { dv.setFloat64(24 * i, a, true); dv.setFloat64(24 * i + 8, b, true); dv.setFloat64(24 * i + 16, c, true) })
let hex = ''
for (let i = 0; i < 24 * N; i++) hex += dv.getUint8(i).toString(16).padStart(2, '0')
const ln2hi = asDouble(bitsOf(toD(LN2)) & ~((1n << 11n) - 1n))   // ln2 with 11 trailing zero bits: k·ln2hi exact for |k| ≤ 2^11
const ln2lo = toD(LN2 - BigInt(Math.round(ln2hi * 2 ** 60)) * (ONE >> 60n))
if (process.argv[2] === '--check') {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(process.argv[3], 'utf8')
  const hexf = (s) => { const m = /^(-?)0x([0-9a-f]+)\.?([0-9a-f]*)p([+-]?\d+)$/i.exec(s.trim()); const mant = parseInt(m[2] + m[3], 16) / 16 ** m[3].length; return (m[1] ? -1 : 1) * mant * 2 ** +m[4] }
  const ref = [...src.matchAll(/A\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g)].filter(m => /0x/.test(m[1])).map(m => [hexf(m[1]), hexf(m[2]), hexf(m[3])])
  let bad = 0
  ref.forEach((r, i) => { for (let k = 0; k < 3; k++) if (bitsOf(r[k]) !== bitsOf(rows[i][k])) { bad++; if (bad < 6) console.log('differs at', i, k, r[k], rows[i][k]) } })
  const refhi = hexf('0x1.62e42fefa3800p-1'), reflo = hexf('0x1.ef35793c76730p-45')
  console.log('rows', ref.length, 'mismatching values', bad, '| ln2hi', ln2hi === refhi, '| ln2lo', ln2lo === reflo, ln2lo, reflo)
} else {
  console.log(`export const POW_LOG_TAB = [\n  ${rows.map(r => r.join(', ')).join(',\n  ')},\n]`)
  console.log(`export const POW_LOG_TAB_HEX = '${hex}'`)
  console.log(`export const POW_LN2HI = ${ln2hi}, POW_LN2LO = ${ln2lo}`)
}

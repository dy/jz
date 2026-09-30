// The kernels' polynomials (module/math/trig-tables.js SIN_C, COS_C, ATAN_C),
// plus the former asin fit for comparison with its current fdlibm kernel:
// minimax fits of the function's relative error on the reduced interval, by the Remez
// exchange in 256-bit fixed point, the coefficients rounded to the nearest double. Each is
// then measured as the kernels evaluate it (polyTree, binary64) against the same
// fixed-point reference over 50k arguments.
//
//   node scripts/minimax-trig.mjs          → the literals and their measured error
//
//   sin(r) = r·(1 + t·P(t))           t = r², |r| ≤ π/4   (the quadrant reduction's remainder)
//   cos(r) = 1 − t/2 + t²·Q(t)        |r| ≤ π/4
//   atan(r) = r·(1 + t·A(t))          |r| ≤ tan(π/8)       (after atan's three-interval reduction)
//   asin(r) = r·(1 + t·S(t))          |r| ≤ 1/2            (after asin's half-angle step)
//
// The degree of each is the lowest whose measured error stays well inside the 100-ulp
// budget used when these fits were selected: one degree less costs sin 46000 ulp, cos 1071, atan
// 248, asin 537 (the minimax bound, 2^53 × the relative error).
import { polyTree as tree } from '../module/math/trig-tables.js'

const P = 256n, ONE = 1n << P
const fx = (x) => {   // a double, exactly, in fixed point
  if (x === 0) return 0n
  const neg = x < 0; x = Math.abs(x)
  let e = Math.floor(Math.log2(x)); if (2 ** e > x) e--; if (2 ** (e + 1) <= x) e++
  const m = BigInt(x * 2 ** (52 - e))   // 53-bit integer, exact
  const sh = BigInt(e - 52) + P
  const v = sh >= 0n ? m << sh : m >> -sh
  return neg ? -v : v
}
const toNum = (v) => {   // nearest double, ties to even
  if (v === 0n) return 0
  const neg = v < 0n; if (neg) v = -v
  const L = BigInt(v.toString(2).length)
  if (L <= 53n) return (neg ? -1 : 1) * Number(v) * 2 ** -Number(P)
  const sh = L - 53n
  let m = v >> sh; const r = v - (m << sh), half = 1n << (sh - 1n)
  if (r > half || (r === half && (m & 1n))) m += 1n
  return (neg ? -1 : 1) * Number(m) * 2 ** Number(sh - P)
}
const mul = (a, b) => { const p = a * b; return p < 0n ? -(-p >> P) : p >> P }   // toward zero: a series of negatives ends at 0
const div = (a, b) => (a << P) / b
// the functions, as their Maclaurin series (arguments ≤ 0.8 in magnitude)
const pw = (x, n) => { let r = ONE; for (let i = 0; i < n; i++) r = mul(r, x); return r }
const SIN = (x) => { let t = x, s = 0n; const x2 = mul(x, x); for (let k = 1; t !== 0n; k += 2) { s += t; t = -mul(t, x2) / BigInt((k + 1) * (k + 2)) } return s }
const COS = (x) => { let t = ONE, s = 0n; const x2 = mul(x, x); for (let k = 0; t !== 0n; k += 2) { s += t; t = -mul(t, x2) / BigInt((k + 1) * (k + 2)) } return s }
const ATAN = (x) => { let t = x, s = 0n; const x2 = mul(x, x); for (let k = 1; t !== 0n; k += 2) { s += t / BigInt(k) * (((k - 1) / 2) % 2 ? -1n : 1n); t = mul(t, x2) } return s }
const ASIN = (x) => {   // Σ (2k)!/(4^k (k!)² (2k+1)) x^(2k+1)
  let c = ONE, t = x, s = 0n; const x2 = mul(x, x)
  for (let k = 0; t !== 0n; k++) { s += mul(c, t) / BigInt(2 * k + 1); c = c * BigInt((2 * k + 1) * (2 * k + 2)) / BigInt(4 * (k + 1) * (k + 1)); t = mul(t, x2) }
  return s
}
// linear solve, Gaussian elimination with partial pivoting, in fixed point
const solve = (A, b) => {
  const n = b.length
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if ((A[r][i] < 0n ? -A[r][i] : A[r][i]) > (A[p][i] < 0n ? -A[p][i] : A[p][i])) p = r
    ;[A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]]
    for (let r = i + 1; r < n; r++) {
      const f = div(A[r][i], A[i][i])
      for (let k = i; k < n; k++) A[r][k] -= mul(f, A[i][k])
      b[r] -= mul(f, b[i])
    }
  }
  const x = new Array(n).fill(0n)
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= mul(A[i][k], x[k]); x[i] = div(s, A[i][i]) }
  return x
}
// Remez: F ≈ lead(x) + Σ c_k x^(base + 2k), k = 0..deg, minimizing the relative error on (0, X]
function remez(F, lead, base, deg, X) {
  const n = deg + 2
  const basis = (x, k) => pw(x, base + 2 * k)
  // Chebyshev points in t = x², where the error's oscillation is spread (the relative
  // error vanishes toward 0 like a power of x)
  let xs = Array.from({ length: n }, (_, i) => fx(X * Math.sqrt((1 - Math.cos(Math.PI * (i + 0.5) / n)) / 2)))
  let c, E, max = 0n
  const err = (x) => { let p = lead(x); for (let k = 0; k <= deg; k++) p += mul(c[k], basis(x, k)); const f = F(x); return div(p - f, f) }
  for (let it = 0; it < 40; it++) {
    const A = xs.map((x, i) => [...Array.from({ length: deg + 1 }, (_, k) => basis(x, k)), (i % 2 ? 1n : -1n) * F(x)])
    const sol = solve(A, xs.map(x => F(x) - lead(x)))
    c = sol.slice(0, deg + 1); E = sol[deg + 1]
    // the error's extrema: a grid, then golden-section refinement of each local maximum of |e|
    const G = 1500, grid = Array.from({ length: G }, (_, j) => fx(X * Math.sqrt((j + 1) / G))), ev = grid.map(err)
    const abs = (v) => v < 0n ? -v : v, pts = []
    for (let j = 0; j < G; j++) {
      if ((j > 0 && abs(ev[j]) < abs(ev[j - 1])) || (j < G - 1 && abs(ev[j]) < abs(ev[j + 1]))) continue
      if (j === G - 1) { pts.push([grid[j], ev[j]]); continue }
      let lo = j > 0 ? grid[j - 1] : grid[j] / 2n, hi = grid[j + 1]
      for (let g = 0; g < 80; g++) {
        const m1 = lo + (hi - lo) * 382n / 1000n, m2 = lo + (hi - lo) * 618n / 1000n
        if (abs(err(m1)) > abs(err(m2))) hi = m2; else lo = m1
      }
      const x = (lo + hi) / 2n; pts.push([x, err(x)])
    }
    const alt = []
    for (const p of pts) {
      if (alt.length && (p[1] < 0n) === (alt.at(-1)[1] < 0n)) { if (abs(p[1]) > abs(alt.at(-1)[1])) alt[alt.length - 1] = p }
      else alt.push(p)
    }
    while (alt.length > n) abs(alt[0][1]) < abs(alt.at(-1)[1]) ? alt.shift() : alt.pop()
    max = alt.reduce((m, p) => abs(p[1]) > m ? abs(p[1]) : m, 0n)
    if (alt.length < n) break
    xs = alt.map(p => p[0])
    if (abs(max - abs(E)) * 1000000n < abs(E)) break
  }
  return { c: c.map(toNum), bound: Number(max) / Number(ONE) }
}

// the kernels' evaluation: module/math/trig-tables.js polyTree in binary64
const polyTree = (cs, x) => tree(cs, { konst: (c) => c, mul: (a, b) => a * b, add: (a, b) => a + b }, x)
const ulpOf = (v) => 2 ** (Math.floor(Math.log2(Math.abs(v))) - 52)
let seed = 0x2545f491
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const measure = (kernel, F, X) => {
  let worst = 0
  for (let i = 0; i < 50000; i++) {
    const r = i % 2 ? (rnd() * 2 - 1) * X : (rnd() < 0.5 ? -1 : 1) * (1 + rnd()) * 2 ** -Math.floor(2 + rnd() * 40)
    if (Math.abs(r) > X) continue
    const want = F(fx(r)), got = kernel(r)
    const u = Math.abs(Number(fx(got) - want) / Number(ONE)) / ulpOf(toNum(want))
    if (u > worst) worst = u
  }
  return worst
}

const PIO4 = Math.PI / 4 * (1 + 2 ** -20), TPIO8 = (Math.SQRT2 - 1) * (1 + 2 ** -30)   // a hair past the reduction's bound
const fits = [
  ['SIN_C', SIN, (x) => x, 3, 4, PIO4, (c) => [1, ...c], (cs, r) => r * polyTree(cs, r * r)],
  ['COS_C', COS, (x) => ONE - mul(x, x) / 2n, 4, 4, PIO4, (c) => [1, -0.5, ...c], (cs, r) => polyTree(cs, r * r)],
  ['ATAN_C', ATAN, (x) => x, 3, 8, TPIO8, (c) => [1, ...c], (cs, r) => r * polyTree(cs, r * r)],
  ['ASIN_C', ASIN, (x) => x, 3, 9, 0.5, (c) => [1, ...c], (cs, r) => r * polyTree(cs, r * r)],
]
for (const [name, F, lead, base, deg, X, coef, kernel] of fits) {
  const { c, bound } = remez(F, lead, base, deg, X)
  const cs = coef(c)
  console.log(`export const ${name} = [${cs.join(', ')}]`)
  console.log(`//   minimax ${(bound * 2 ** 53).toFixed(2)} ulp (2^53 × relative), measured in binary64 ${measure((r) => kernel(cs, r), F, X).toFixed(2)} ulp`)
}

// jz's Math against the host's (V8's) Math, in ulps: the bound each function keeps
// (README, "Where behaviour differs from JS"; scripts/math-ulp.mjs measures the full
// argument sets, the floatbeat corpus's included). The reference is the host's own
// Math: V8's fdlibm port (src/base/ieee754.cc) on x64, the same C with a·b + c fused
// on arm64, an ulp apart there on a fraction of a percent of arguments, which the
// bounds absorb. Every function runs compiled twice, scalar and with the lane
// vectorizer on, and the two must agree bit for bit, as must the constant folder
// (src/prepare/math-kernel.js) with the kernel it folds for.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, ulpDiff } from './util.js'
import { MATH_KERNEL, powRuntime } from '../src/prepare/math-kernel.js'

// the bound, in ulps, each function keeps against the host (measured maximum in the comment)
const BOUND = {
  sin: 48, cos: 48, tan: 56,            // 40, 39, 49: the degree-11 sine and degree-12 cosine
  asin: 1, acos: 1,                     // fdlibm rational kernels
  atan: 16, atan2: 16,                  // 10, 10
  sinh: 8, cosh: 8, tanh: 8,            // 5, 3, 5
  asinh: 8, acosh: 8, atanh: 8,         // 4, 5, 4
  exp: 2, expm1: 4, log: 6, log1p: 6, log2: 6, log10: 3,   // 1, 3, 4, 4, 4, 2
  cbrt: 1, hypot: 3, pow: 12,           // 0, 2, 11 (an integer exponent squares and multiplies)
}
const BINARY = ['atan2', 'hypot', 'pow']
const NAMES = Object.keys(BOUND)
const src = NAMES.map(n => BINARY.includes(n)
  ? `export let ${n} = (a, b, o, k) => { for (let i = 0; i < k; i++) o[i] = Math.${n}(a[i], b[i]) }`
  : `export let ${n} = (a, o, k) => { for (let i = 0; i < k; i++) o[i] = Math.${n}(a[i]) }`).join('\n')
const scalar = run(src, { optimize: { level: 2, noSimd: true } }), lanes = run(src, { optimize: 3 })
const apply = (m, n, xs, ys) => { const o = new Float64Array(xs.length); ys ? m[n](xs, ys, o, xs.length) : m[n](xs, o, xs.length); return o }

// seeded arguments: log-uniform magnitudes, both signs, the domain's edges
let seed = 0x2545f491
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const logU = (lo, hi) => (1 + rnd()) * 2 ** Math.floor(lo + rnd() * (hi - lo))
const sgn = (x) => rnd() < 0.5 ? -x : x
const pick = (...gs) => () => gs[Math.floor(rnd() * gs.length)]()
const trig = pick(() => sgn(logU(-30, 5)), () => sgn(logU(5, 24)), () => sgn(logU(24, 1024)), () => sgn(logU(-1074, -30)))
const unit = pick(() => sgn(rnd()), () => sgn(1 - logU(-53, -1)), () => sgn(logU(-60, -1)))
const real = pick(() => sgn(logU(-60, 60)), () => sgn(logU(-1074, 1024)), () => sgn(rnd() * 4))
const pos = pick(() => logU(-1074, 1024), () => logU(-60, 60), () => 1 + sgn(logU(-53, -1)))
const DOMAIN = {
  sin: trig, cos: trig, tan: trig, asin: unit, acos: unit, atan: real, cbrt: real, asinh: real,
  sinh: pick(() => sgn(logU(-60, 3)), () => sgn(rnd() * 711)), cosh: pick(() => sgn(logU(-60, 3)), () => sgn(rnd() * 711)),
  tanh: pick(() => sgn(logU(-60, 3)), () => sgn(rnd() * 30)),
  acosh: pick(() => 1 + logU(-52, 0), () => 1 + logU(0, 60), () => logU(60, 1024)),
  atanh: pick(() => sgn(rnd()), () => sgn(1 - logU(-53, -1)), () => sgn(logU(-60, -1))),
  exp: pick(() => sgn(rnd() * 745), () => sgn(logU(-60, 3))), expm1: pick(() => sgn(rnd() * 40), () => rnd() * 710, () => sgn(logU(-60, 1))),
  log: pos, log2: pos, log10: pos, log1p: pick(() => logU(-1074, 1024), () => sgn(logU(-60, -1)), () => -1 + logU(-53, -1)),
}
const N = 20000
const argsOf = (n) => {
  if (n === 'atan2' || n === 'hypot') return [Float64Array.from({ length: N }, real), Float64Array.from({ length: N }, real)]
  if (n === 'pow') {
    const xs = new Float64Array(N), ys = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) { xs[i] = logU(-20, 20); ys[i] = sgn(rnd() * 40) }
      else if (i % 3 === 1) { xs[i] = -logU(-10, 10); ys[i] = Math.round(sgn(rnd() * 16)) }
      else { xs[i] = 1 + sgn(logU(-40, -3)); ys[i] = sgn(logU(0, 40)) }
    }
    return [xs, ys]
  }
  return [Float64Array.from({ length: N }, DOMAIN[n])]
}
// the edges, each against every other for the two-argument functions
const EDGE = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 2, 5e-324, -5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, -1.7976931348623157e308, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, 1 - 2 ** -53,
  -(1 - 2 ** -53), 1 + 2 ** -52, 2 ** -28, 2 ** 28, 2 ** 24, 709.782712893384, 710.4758600739439, 1e300, 1e22]

// max ulps over the arguments; lanes and fold must equal the scalar kernel
const measure = (n, xs, ys) => {
  const got = apply(scalar, n, xs, ys), two = apply(lanes, n, xs, ys)
  const host = Math[n], fold = n === 'pow' ? powRuntime : MATH_KERNEL['math.' + n]
  let worst = 0, at = null, laneDiff = 0, foldDiff = null
  for (let i = 0; i < xs.length; i++) {
    const want = ys ? host(xs[i], ys[i]) : host(xs[i]), u = ulpDiff(got[i], want)
    if (u > worst) { worst = u; at = ys ? [xs[i], ys[i]] : [xs[i]] }
    if (!Object.is(got[i], two[i]) && !(got[i] !== got[i] && two[i] !== two[i])) laneDiff++
    const f = ys ? fold(xs[i], ys[i]) : fold(xs[i])
    if (f !== undefined && foldDiff == null && !Object.is(f, got[i]) && !(f !== f && got[i] !== got[i])) foldDiff = ys ? [xs[i], ys[i]] : [xs[i]]
  }
  return { worst, at, laneDiff, foldDiff }
}

for (const n of NAMES) test(`Math.${n}: within ${BOUND[n]} ulp of the host, lanes and fold bit-identical`, () => {
  const sets = [argsOf(n)]
  if (BINARY.includes(n)) sets.push([Float64Array.from(EDGE.flatMap(x => EDGE.map(() => x))), Float64Array.from(EDGE.flatMap(() => EDGE))])
  else sets.push([Float64Array.from(EDGE)])
  for (const [xs, ys] of sets) {
    const { worst, at, laneDiff, foldDiff } = measure(n, xs, ys)
    ok(worst <= BOUND[n], `${n}: ${worst} ulp at ${at}`)
    is(laneDiff, 0, `${n}: the two-lane build agrees with the scalar kernel`)
    is(foldDiff, null, `${n}: the constant folder agrees with the kernel`)
  }
})

// π/2 at 256 bits (Machin), the double nearest k·π/2, and the multiples whose nearest
// double is closest to them (an exhaustive search of k < 2^24: 29·2^j at 2^-60.5 below
// 2^5, 9206271 at 2^-59 as a fraction of k the worst), each with its ±4-ulp neighbours:
// the arguments whose reduction cancels the most bits
const P = 256n, ONE = 1n << P
const atanInv = (m) => { let s = 0n, t = ONE / m, k = 1n, sg = 1n; while (t) { s += sg * t / k; t /= m * m; k += 2n; sg = -sg } return s }
const PIO2 = (16n * atanInv(5n) - 4n * atanInv(239n)) / 2n
const nearestTo = (v) => { const L = BigInt(v.toString(2).length), sh = L - 53n; let m = v >> sh; const r = v - (m << sh), h = 1n << (sh - 1n); if (r > h || (r === h && (m & 1n))) m += 1n; return Number(m) * 2 ** Number(sh - P) }
const F = new Float64Array(1), U = new BigUint64Array(F.buffer)
const around = (x) => { F[0] = x; const b = U[0], out = []; for (let d = -4n; d <= 4n; d++) { U[0] = b + d; out.push(F[0], -F[0]) } return out }
const HARD = [29, 58, 116, 232, 464, 928, 14479, 29327, 58285, 87981, 204551, 409102, 818204, 1081409, 2162818, 4325636, 9206271]
const KPI2 = new Float64Array([...HARD, ...Array.from({ length: 4096 }, (_, i) => 1 + i * 257)].flatMap(k => around(nearestTo(BigInt(k) * PIO2))))

for (const n of ['sin', 'cos', 'tan']) test(`Math.${n}: within ${BOUND[n]} ulp of the host at the multiples of π/2 and their neighbours`, () => {
  const { worst, at, laneDiff, foldDiff } = measure(n, KPI2)
  ok(worst <= 2, `${n}: ${worst} ulp at ${at} (the reduction keeps r within an ulp)`)
  is(laneDiff, 0)
  is(foldDiff, null)
})

test('Math.sin/cos/tan: the values V8 gives at π and its multiples, signed zero, the non-finite', () => {
  const { s, c, t, sign } = run(`export let s = (x) => Math.sin(x)
export let c = (x) => Math.cos(x)
export let t = (x) => Math.tan(x)
export let sign = (x) => Math.sign(Math.sin(x))`)
  // V8 (fdlibm __kernel_sin of the reduced 1.2246467991473532e-16): the host's own answers
  is(s(Math.PI), Math.sin(Math.PI))
  is(s(Math.PI), 1.2246467991473532e-16)
  is(sign(3 * Math.PI), 1, 'sin of the double below 3π is positive')
  is(sign(-3 * Math.PI), -1)
  ok(Object.is(s(-0), -0), 'sin(-0) is -0')
  ok(Object.is(t(-0), -0), 'tan(-0) is -0')
  is(c(0), 1)
  is(s(Math.PI / 2), 1)
  is(c(Math.PI), -1)
  for (const x of [NaN, Infinity, -Infinity]) for (const f of [s, c, t]) ok(Number.isNaN(f(x)), `${f.name}(${x}) is NaN`)
  // Payne–Hanek: the double closest to a multiple of π/2 of all (Muller, Elementary
  // Functions, the worst case 6381956970095103·2^797 at 2^-61), and a sample past 2^24
  for (const x of [6381956970095103 * 2 ** 797, 1e22, -1e300, 2 ** 24, 1.7976931348623157e308]) {
    ok(ulpDiff(s(x), Math.sin(x)) <= BOUND.sin, `sin(${x}) = ${s(x)}, host ${Math.sin(x)}`)
    ok(ulpDiff(c(x), Math.cos(x)) <= BOUND.cos, `cos(${x}) = ${c(x)}, host ${Math.cos(x)}`)
  }
})

test('Math: a folded constant is the kernel\'s own answer', () => {
  // pre-eval folds the literal call; the kernel computes the parameter's
  const { folded, runtime } = run(`export let folded = () => [Math.sin(Math.PI), Math.cos(1e6), Math.atan(0.5), Math.asin(0.7), Math.acosh(1.5), 2.2 ** 2.4, 1e140 ** 2.2, Math.pow(-1, 1e300)]
export let runtime = (a, b, c, d, e, f, g, h, i, j) => [Math.sin(a), Math.cos(b), Math.atan(c), Math.asin(d), Math.acosh(e), f ** 2.4, g ** 2.2, Math.pow(h, i)]`)
  const want = runtime(Math.PI, 1e6, 0.5, 0.7, 1.5, 2.2, 1e140, -1, 1e300)
  const got = folded()
  for (let i = 0; i < want.length; i++) ok(Object.is(got[i], want[i]), `#${i}: folded ${got[i]}, kernel ${want[i]}`)
})

test('Math: the Payne–Hanek table is 2/π', async () => {
  const { TWO_OVER_PI_HEX } = await import('../module/math/trig-tables.js')
  // 2/π at 1300 bits: Machin's π (as above), then 2^2601 / π
  const Q = 1300n, one = 1n << Q
  const at = (m) => { let s = 0n, t = one / m, k = 1n, sg = 1n; while (t) { s += sg * t / k; t /= m * m; k += 2n; sg = -sg } return s }
  const twoOverPi = (1n << (2n * Q + 1n)) / (16n * at(5n) - 4n * at(239n))
  const word = (w) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(TWO_OVER_PI_HEX.slice(16 * w + 2 * i, 16 * w + 2 * i + 2), 16)); return v }
  is(TWO_OVER_PI_HEX.length, 20 * 16)
  is(word(0), 0n, 'a zero word first')
  for (let w = 1; w < 20; w++) is(word(w), (twoOverPi >> (Q - 64n * BigInt(w))) & ((1n << 64n) - 1n), `word ${w}`)
})

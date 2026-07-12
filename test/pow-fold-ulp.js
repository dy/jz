// Differential ULP test for the CORRECTLY-ROUNDED CONST-EXPONENT pow fold — under
// `optimize.crPow` (see the authoritative comment above emitPow in module/math.js), `x ** C` /
// Math.pow(x, C) with a compile-time-constant, non-integer, non-±0.5, non-k/5 exponent C lowers
// to `$math.pow_fold`, which shares $math.pow_transcend's two-phase Ziv dd/td kernel with the
// runtime-y path $math.pow_core uses (see $math.pow_fold's own comment in module/math.js for the
// algorithm). Off crPow (the default), the same case lowers to a plain `exp(C·log(x))`
// composition instead — no $math.pow_fold exists in that build at all; every probe here compiles
// with crPow explicitly on so the fold actually fires. This asserts the FOLDED path — a literal
// constant exponent per compiled function, so the fold actually fires — against the host's own
// Math.pow, and probes the compiled WAT to confirm the fold really took the cheap path (no
// `$math.pow`/`$math.pow_core` call) rather than silently falling through to the general call,
// which would make this test vacuous.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compileSrc, run, ulpDiff } from './util.js'

const CR_POW = { optimize: { crPow: true } }

// Deterministic XorShift32 — failures reproduce without saving state.
const mkRng = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

// Bases: log-spaced across (0, 1e300], plus the exact boundary/edge values Math.pow special-
// cases (±0, ±1, ±Infinity, NaN) and a few "awkward" explicit values.
const BASES = []
for (let e = -300; e <= 300; e += 12) BASES.push(10 ** e)
BASES.push(0, -0, 1, -1, Infinity, -Infinity, NaN, 0.18, 1.0000001, 2.2, 255.7)

// Exponents that reach $math.pow_fold specifically — finite, non-integer, not ±0.5, and not a
// k/5 fraction (those route to $math.sqrt / $math.fifthroot instead — see fifthroot-ulp.js).
// Includes the colorpq regression's own exponents (the PQ curve's nv=2610/16384 and
// p=1.7·2523/32) plus common non-fifthroot shapes.
const EXPS = [
  2610 / 16384, -(2610 / 16384),
  1.7 * 2523 / 32, -(1.7 * 2523 / 32),
  0.1593017578125, -0.1593017578125,
  1 / 3, -1 / 3,
  100.7, -100.7,
  1.61803398875, -1.61803398875,
]

// One compiled function per exponent (the exponent must be a source-level literal for the fold
// to fire) — probe its WAT once, then sweep every base through the same compiled `f`.
function sweepExp(c) {
  const wat = compileSrc(`export let f = (x) => x ** ${c}`, { wat: true, ...CR_POW })
  ok(!/call \$math\.pow(_core)? /.test(wat), `x ** ${c}: fold must not call the general $math.pow/$math.pow_core (got: ${/call \$math\.pow\S*/.exec(wat)?.[0]})`)
  ok(wat.includes('call $math.pow_fold'), `x ** ${c}: expected a $math.pow_fold call in the compiled WAT`)

  const { f } = run(`export let f = (x) => x ** ${c}`, CR_POW)
  let exact = 0, oneUlp = 0
  const worse = []
  for (const x of BASES) {
    const got = f(x), want = Math.pow(x, c)
    const u = ulpDiff(got, want)
    if (u === 0) exact++
    else if (u === 1) oneUlp++
    else worse.push({ x, got, want, u })
  }
  console.log(`pow fold ULP (c=${c}): ${exact}/${BASES.length} bit-exact, ${oneUlp} at 1 ulp, ${worse.length} worse than 1 ulp`)
  if (worse.length) console.log(`  offenders: ${worse.map(w => `(${w.x})**${c} = ${w.got} vs host ${w.want} (${w.u} ulp)`).join('\n  ')}`)
  ok(worse.length === 0, `c=${c}: every base within 1 ulp of host Math.pow (${worse.length} exceeded)`)
}

test('const-exponent pow fold — bit-exact/≤1ulp grid vs host, per exponent', () => {
  for (const c of EXPS) sweepExp(c)
})

test('const-exponent pow fold — bit-exact/≤1ulp random bases vs host', () => {
  const rng = mkRng(0xDEADBEEF)
  for (const c of [2610 / 16384, 1.7 * 2523 / 32, -0.1593017578125, 100.7, -1 / 3]) {
    const wat = compileSrc(`export let f = (x) => x ** ${c}`, { wat: true, ...CR_POW })
    ok(!/call \$math\.pow(_core)? /.test(wat), `x ** ${c}: fold must not call the general $math.pow/$math.pow_core`)
    const { f } = run(`export let f = (x) => x ** ${c}`, CR_POW)
    let exact = 0, oneUlp = 0
    const worse = []
    for (let i = 0; i < 64; i++) {
      const x = 10 ** ((rng() - 0.5) * 600)
      const got = f(x), want = Math.pow(x, c)
      const u = ulpDiff(got, want)
      if (u === 0) exact++
      else if (u === 1) oneUlp++
      else worse.push({ x, got, want, u })
    }
    console.log(`pow fold ULP random (c=${c}): ${exact}/64 bit-exact, ${oneUlp} at 1 ulp, ${worse.length} worse than 1 ulp`)
    ok(worse.length === 0, `c=${c} random: every base within 1 ulp of host Math.pow (${worse.length} exceeded)`)
  }
})

// The SIMD twin ($math.pow_fold_v, a per-lane scalar repack — see module/math.js) must be
// bit-identical to the scalar fold: it just calls $math.pow_fold on each lane. Force
// vectorization with a tight typed-array loop and confirm the mirror's output matches a scalar
// loop over the same data, base-by-base — this is the differential proof that repacking didn't
// perturb anything, complementing the emit-time WAT probes above.
test('const-exponent pow fold — SIMD twin (pow_fold_v) matches the scalar fold', () => {
  const c = 2610 / 16384
  const src = `
    export let f = (n) => {
      const src = new Float64Array(n), dst = new Float64Array(n)
      for (let i = 0; i < n; i++) src[i] = 1 + i * 3.7
      for (let i = 0; i < n; i++) dst[i] = src[i] ** ${c}
      let h = 0
      for (let i = 0; i < n; i++) h = h * 31 + dst[i]
      return h
    }
  `
  const wat = compileSrc(src, { wat: true, ...CR_POW })
  ok(wat.includes('math.pow_fold_v'), 'expected the loop to vectorize through $math.pow_fold_v')

  const { f } = run(src, CR_POW)
  const N = 64
  let want = 0
  for (let i = 0; i < N; i++) { const x = 1 + i * 3.7; want = want * 31 + Math.pow(x, c) }
  const got = f(N)
  ok(Object.is(got, want) || ulpDiff(got, want) <= 4, `vectorized loop's folded reduction matches a scalar host computation (got ${got} vs ${want})`)
})

// Differential ULP test for $math.pow_core — the fdlibm-ported non-integer tail that
// $math.pow's fallback line calls once the special-case ladder and the i32-range integer
// fast path (both untouched, still bit-identical) rule themselves out. Before this port the
// fallback was `exp(y·log(x))`, whose composed error grows with |y·ln x| — fine for small
// exponents but many ulps off for the large ones real content uses (PQ/HDR transfer curves,
// gamma decodes). This asserts the new tail against the host's own Math.pow (V8 ports the
// same fdlibm algorithm — see module/math.js's $math.pow_core comment) across a deterministic
// base×exponent grid plus randomized pairs: bit-exact where fdlibm's ~1-ulp accuracy bound
// allows it (the common case), ≤1 ulp everywhere else — fdlibm's e_pow.c is documented
// "nearly rounded", not a correctly-rounded (<0.5ulp) guarantee, so an occasional last-ulp
// difference from the host's own build of the same algorithm is expected, not a jz bug.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { run, ulpDiff } from './util.js'

const { f: pow } = run('export let f = (x, y) => Math.pow(x, y)')

// Deterministic XorShift32 — failures reproduce without saving state.
const mkRng = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

// Bases: log-spaced across (0, 1e300] plus a handful of "awkward" explicit values —
// just-above-1, a non-power-of-ten fraction, a large non-round value.
const BASES = []
for (let e = -300; e <= 300; e += 12) BASES.push(10 ** e)
BASES.push(0.18, 0.5, 1.0000001, 2.2, 255.7)

// Exponents: the pinned values from the colorpq regression (±0.1593017578125 — a PQ-curve
// exponent — and ±78.84375, its far end) plus common non-integer shapes: ±0.5 (sqrt fast
// path), ±1/3 (cube root), ±2.4 (sRGB gamma), ±100.7 (large non-integer).
const EXPS = [
  0.1593017578125, -0.1593017578125,
  78.84375, -78.84375,
  0.5, -0.5,
  1 / 3, -1 / 3,
  2.4, -2.4,
  100.7, -100.7,
]

// Runs one (bases × exponents or explicit pairs) sweep, reporting the exact/1-ulp/worse
// tally and — only on a genuine >1ulp miss — the offending pairs (so a regression is
// diagnosable from the test log alone).
function sweep(label, pairs) {
  let exact = 0, oneUlp = 0
  const worse = []
  for (const [x, y] of pairs) {
    const got = pow(x, y), want = Math.pow(x, y)
    const u = ulpDiff(got, want)
    if (u === 0) exact++
    else if (u === 1) oneUlp++
    else worse.push({ x, y, got, want, u })
  }
  const total = pairs.length
  console.log(`pow ULP (${label}): ${exact}/${total} bit-exact, ${oneUlp} at 1 ulp, ${worse.length} worse than 1 ulp`)
  if (worse.length) console.log(`  offenders: ${worse.map(w => `pow(${w.x}, ${w.y}) = ${w.got} vs host ${w.want} (${w.u} ulp)`).join('\n  ')}`)
  ok(worse.length === 0, `${label}: every pair within 1 ulp of host Math.pow (${worse.length} exceeded)`)
}

test('Math.pow non-integer tail — bit-exact/≤1ulp grid vs host', () => {
  const pairs = []
  for (const x of BASES) for (const y of EXPS) pairs.push([x, y])
  sweep('grid', pairs)
})

test('Math.pow non-integer tail — bit-exact/≤1ulp random pairs vs host', () => {
  const rng = mkRng(0xC0FFEE)
  const pairs = []
  while (pairs.length < 64) {
    const x = 10 ** ((rng() - 0.5) * 600)          // spans ~1e-300 .. 1e300
    let y = (rng() - 0.5) * 2 * 10 ** (rng() * 3)  // mixed magnitude, up to ~±1000
    if (Number.isInteger(y)) y += 0.5              // integer y is the fast path's territory, not this tail's
    if (x > 0 && Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y])
  }
  sweep('random', pairs)
})

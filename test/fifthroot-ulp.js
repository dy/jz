// Differential ULP regression guard for $math.fifthroot — the bit-hack-seed + 3-Newton-step
// kernel module/math.js's `emitPow` const-exponent fold uses for k/5 exponents (x**2.4, the
// sRGB/Rec.709 decode gamma, is the canonical caller) UNCONDITIONALLY by default — this predates
// and is independent of the CR-pow kernel (test/pow-cr.js). 3 steps leave a worst case in the
// low millions of ulp against host Math.pow(x, k/5) (measured ~2.6M here) — Newton's quadratic
// convergence hasn't fully saturated the f64 rounding floor at 3 steps (a 4th step, prototyped
// on an unmerged branch, brings this down to ~a few hundred ulp, but that improvement never
// shipped — this test pins the 3-step reality actually running). This is NOT a ≤1ulp guarantee
// (unlike pow-fold-ulp.js's $math.pow_fold): a genuine double-double Newton correction would be
// needed for that, and $math.cbrt — this fold's usual downstream neighbor in the sRGB/Oklab
// pipeline — is itself a documented non-bit-exact approximation, so ≤1ulp here buys no
// externally-observable win through that path (see $math.fifthroot's comment). This test is a
// REGRESSION GUARD: pin the current worst-case bound so a future change can't silently make it
// much worse (e.g. a broken correction term, or losing a Newton step outright).
//
// FLAG SEMANTICS (see the authoritative comment above emitPow in module/math.js):
//   crPow OFF (DEFAULT): $math.pow_fold is the old fdlibm-derived fold, and the k/5 fifthroot
//     fast path fires UNCONDITIONALLY — exactly the pre-CR-pow behavior, bit-for-bit. approxPow
//     is meaningless here (fifthroot is already the default; there's nothing faster to opt into).
//   crPow ON: $math.pow_fold instead shares $math.pow_transcend's correctly-rounded kernel, and
//     fifthroot now requires an explicit `{ optimize: { approxPow: true } }` opt-in — correctness
//     wins by default once crPow has opted into the correctly-rounded kernel family.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compileSrc, run, ulpDiff } from './util.js'

const CR_POW = { optimize: { crPow: true } }
const CR_POW_APPROX = { optimize: { crPow: true, approxPow: true } }

const mkRng = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

// k/5 exponents in (0,5), the fold's own domain (see module/math.js emitPow) — 2.4 is the sRGB
// EOTF gamma colorlch/colorconv actually use; the others cover the other reachable k/5 shapes.
const EXPS = [0.2, 0.4, 0.6, 0.8, 1.2, 1.4, 1.6, 1.8, 2.2, 2.4, 2.6, 2.8, 3.2, 3.4, 3.6, 3.8, 4.2, 4.4, 4.6, 4.8]

// Generous regression ceiling — roughly 2x the measured ~2.65M ulp worst case (3 Newton steps),
// tight enough to catch a genuinely broken correction (e.g. a dropped step) while tolerating the
// known 3-step accuracy floor and ordinary machine/input variance.
const ULP_CEILING = 5_000_000

test('fifthroot-backed pow fold reaches WAT via $math.fifthroot by default (not $math.pow/$math.pow_fold)', () => {
  const wat = compileSrc('export let f = (x) => x ** 2.4', { wat: true })
  ok(wat.includes('call $math.fifthroot'), 'x ** 2.4 must fold through $math.fifthroot by default')
  ok(!/call \$math\.pow(_core|_fold)? /.test(wat), 'x ** 2.4 must not fall through to the general pow paths')
})

test('x ** 2.4 under crPow (without approxPow) routes through the correctly-rounded $math.pow_fold', () => {
  const wat = compileSrc('export let f = (x) => x ** 2.4', { wat: true, ...CR_POW })
  ok(wat.includes('call $math.pow_fold'), 'crPow build must use $math.pow_fold, not the approximate fifthroot fast path')
  ok(!wat.includes('call $math.fifthroot'), 'crPow build must not reach $math.fifthroot from pow unless approxPow is also set')
})

test('x ** 2.4 under crPow + approxPow opts back into $math.fifthroot', () => {
  const wat = compileSrc('export let f = (x) => x ** 2.4', { wat: true, ...CR_POW_APPROX })
  ok(wat.includes('call $math.fifthroot'), 'crPow+approxPow must fold through $math.fifthroot')
  ok(!/call \$math\.pow(_core|_fold)? /.test(wat), 'crPow+approxPow must not fall through to the general pow paths')
})

test(`fifthroot pow fold (default path) — worst case stays under ${ULP_CEILING} ulp vs host (regression guard)`, () => {
  const rng = mkRng(0x51DEC0DE)
  let worstOverall = 0
  for (const c of EXPS) {
    const { f } = run(`export let f = (x) => x ** ${c}`)
    // Domain kept where the fold's OWN intermediate x**r (r up to 4, the algebraic
    // decomposition x**(k/5) = x**p · fifthroot(x**r)) can't itself over/underflow —
    // that's a separate, pre-existing property of the decomposition, not of $math.fifthroot's
    // own Newton accuracy, which is what this guard targets.
    const xs = []
    for (let e = -75; e <= 75; e += 3) xs.push(10 ** e)
    for (let i = 0; i < 200; i++) xs.push(10 ** ((rng() - 0.5) * 150))
    let worst = 0
    for (const x of xs) {
      const u = ulpDiff(f(x), Math.pow(x, c))
      if (u > worst) worst = u
    }
    if (worst > worstOverall) worstOverall = worst
    ok(worst <= ULP_CEILING, `c=${c}: worst case ${worst} ulp exceeds the ${ULP_CEILING} ulp regression ceiling`)
  }
  console.log(`fifthroot fold worst-case ulp across ${EXPS.length} exponents: ${worstOverall}`)
})

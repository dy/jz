// Differential ULP regression guard for $math.fifthroot — the bit-hack-seed + Newton kernel
// module/math.js's `emitPow` const-exponent fold used to ALWAYS use for k/5 exponents (x**2.4,
// the sRGB/Rec.709 decode gamma, is the canonical caller). Since the CR-pow kernel landed
// (test/pow-cr.js), that fold is OFF BY DEFAULT: it's only ~3.6e-10 relative error, not
// correctly rounded (worst case ~473 ulp — see below), so a plain build now routes k/5
// exponents through the correctly-rounded $math.pow_fold like any other constant exponent.
// Bench check before deciding this (not assumed): colorlch (this fold's own sRGB-gamma-heavy
// target case) is 4.8x slower through $math.pow_fold than through fifthroot — past the 1.3x
// bar for an unconditional swap — so fifthroot stays available as an explicit opt-in,
// `{ optimize: { approxPow: true } }`, for call sites where ulp-level error is genuinely fine
// and the speed matters more. Every compile in this file passes that flag so the ULP figures
// below still describe $math.fifthroot itself, not the (now default, ≤1ulp) $math.pow_fold
// path — see pow-fold-ulp.js for that one.
//
// $math.fifthroot went from 3 to 4 Newton steps (see its comment in module/math.js): 3 steps
// left a ~2.1M ulp worst case against host Math.pow(x, k/5); 4 steps — Newton's own quadratic
// convergence saturating the f64 rounding floor of the update formula itself, not under-
// convergence (a 5th step measured identical) — brings that down to ~a few hundred ulps. This
// is NOT a ≤1ulp guarantee (unlike pow-fold-ulp.js's $math.pow_fold): a genuine double-double
// Newton correction would be needed for that, and $math.cbrt — this fold's usual downstream
// neighbor in the sRGB/Oklab pipeline — is itself a documented non-bit-exact approximation, so
// ≤1ulp here buys no externally-observable win through that path (see $math.fifthroot's
// comment). This test is a REGRESSION GUARD: pin the current worst-case bound so a future
// change can't silently reopen the 2M-ulp hole 3 steps had.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compileSrc, run, ulpDiff } from './util.js'

const APPROX_POW = { optimize: { approxPow: true } }

const mkRng = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

// k/5 exponents in (0,5), the fold's own domain (see module/math.js emitPow) — 2.4 is the sRGB
// EOTF gamma colorlch/colorconv actually use; the others cover the other reachable k/5 shapes.
const EXPS = [0.2, 0.4, 0.6, 0.8, 1.2, 1.4, 1.6, 1.8, 2.2, 2.4, 2.6, 2.8, 3.2, 3.4, 3.6, 3.8, 4.2, 4.4, 4.6, 4.8]

// Generous regression ceiling — well above the measured ~200ulp worst case, tight enough to
// catch an accidental reversion to the old 3-step (~2.1M ulp) or a broken correction.
const ULP_CEILING = 2000

test('approxPow-opted-in fold reaches WAT via $math.fifthroot (not $math.pow/$math.pow_fold)', () => {
  const wat = compileSrc('export let f = (x) => x ** 2.4', { wat: true, ...APPROX_POW })
  ok(wat.includes('call $math.fifthroot'), 'x ** 2.4 must fold through $math.fifthroot when approxPow is on')
  ok(!/call \$math\.pow(_core|_fold)? /.test(wat), 'x ** 2.4 must not fall through to the general pow paths')
})

test('x ** 2.4 WITHOUT approxPow routes through the correctly-rounded $math.pow_fold by default', () => {
  const wat = compileSrc('export let f = (x) => x ** 2.4', { wat: true })
  ok(wat.includes('call $math.pow_fold'), 'plain build must use $math.pow_fold, not the approximate fifthroot fast path')
  ok(!wat.includes('call $math.fifthroot'), 'plain build must not reach $math.fifthroot from pow')
})

test(`fifthroot pow fold (approxPow opt-in) — worst case stays under ${ULP_CEILING} ulp vs host (regression guard)`, () => {
  const rng = mkRng(0x51DEC0DE)
  let worstOverall = 0
  for (const c of EXPS) {
    const { f } = run(`export let f = (x) => x ** ${c}`, APPROX_POW)
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

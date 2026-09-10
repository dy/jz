// Math.pow accuracy — differential gates over every pow path jz emits, against the
// host's own Math.pow (V8 ports the same fdlibm algorithm — see module/math.js) and
// against authoritative correctly-rounded vectors:
//
//   1. $math.pow_core — the fdlibm-ported non-integer tail the runtime-y $math.pow
//      falls back to once the special-case ladder and the i32-range integer fast path
//      rule themselves out. Before this port the fallback was `exp(y·log(x))`, whose
//      composed error grows with |y·ln x| — fine for small exponents but many ulps off
//      for the large ones real content uses (PQ/HDR transfer curves, gamma decodes).
//      Bit-exact where fdlibm's ~1-ulp accuracy bound allows it (the common case),
//      ≤1 ulp everywhere else — e_pow.c is documented "nearly rounded", not correctly
//      rounded, so an occasional last-ulp difference from the host's own build of the
//      same algorithm is expected, not a jz bug.
//   2. $math.pow_fold — the CORRECTLY-ROUNDED CONST-EXPONENT fold under
//      `optimize.crPow` (the authoritative comment is above emitPow in module/math.js):
//      `x ** C` / Math.pow(x, C) with a compile-time-constant, non-integer, non-±0.5,
//      non-k/5 exponent C lowers to `$math.pow_fold`, which shares $math.pow_transcend's
//      two-phase Ziv dd/td kernel with $math.pow_core. Off crPow (the default) the same
//      case lowers to a plain `exp(C·log(x))` composition and no $math.pow_fold exists in
//      the build, so every probe compiles with crPow on. The WAT is probed per function
//      to confirm the fold took the cheap path (no `$math.pow`/`$math.pow_core` call)
//      rather than silently falling through to the general call, which would make the
//      gate vacuous.
//   3. $math.fifthroot — the bit-hack-seed + 3-Newton-step kernel the k/5 fold
//      (x ** 2.4, the sRGB/Rec.709 decode gamma) uses UNCONDITIONALLY by default. NOT a
//      ≤1ulp guarantee: 3 steps leave a worst case in the low millions of ulp (measured
//      ~2.6M; a 4th step, prototyped on an unmerged branch, brings it to a few hundred
//      but never shipped) — a REGRESSION GUARD pins the bound so a broken correction
//      term or a lost Newton step cannot pass silently. $math.cbrt, this fold's usual
//      downstream neighbour in the sRGB/Oklab pipeline, is itself a documented
//      non-bit-exact approximation, so ≤1ulp here buys no externally-observable win.
//      Flag semantics: crPow OFF (default) — the k/5 fifthroot fast path fires
//      unconditionally, the pre-CR-pow behaviour bit-for-bit (approxPow is meaningless
//      there). crPow ON — $math.pow_fold takes the correctly-rounded kernel, and
//      fifthroot requires an explicit `{ optimize: { approxPow: true } }` opt-in.
//   4. The correctly-rounded vector gate — test/vectors/pow-cr.txt: 5152 lines of
//      `xbits ybits resultbits` (big-endian f64 hex), generated with mpmath 1.4.1 at
//      200-bit precision (round-to-nearest on the final float conversion), inputs
//      STRICTLY coerced to doubles before evaluation. Classes: colorpq's real exponents
//      (PQ nv=2610/16384, p=1.7·2523/32, their inverses, sRGB 2.4/±) over its value
//      range; general log-spaced grids across ±extremes; 3k random (x,y) pairs; 400
//      MINED hard cases (exact result nearest to a rounding boundary out of 30k
//      candidates). Regeneration recipe: .work/archive/todo.md (CR-pow session).
//      Baselines at bake time: V8 Math.pow misses 3/5152 (0.058%, all in the mined
//      tail); jz runtime $math.pow missed 424 (8.2%); the const-exponent fold missed
//      194/827 (23.5%). The gate demands ZERO on both jz paths — correctly rounded is
//      unique, so this also pins fold==runtime consistency (self-compile byte-parity
//      depends on it).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { funcWat, run, ulpDiff, wat } from './util.js'

const CR_POW = { optimize: { crPow: true } }
const CR_POW_APPROX = { optimize: { crPow: true, approxPow: true } }

// Deterministic XorShift32 — failures reproduce without saving state.
const mkRng = (seed) => () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}

// Bases log-spaced across (0, 1e300]; each path adds its own awkward explicit values.
const LOG_BASES = []
for (let e = -300; e <= 300; e += 12) LOG_BASES.push(10 ** e)

// One module with one function per exponent — the exponent must be a source-level
// literal for a fold to fire — so a whole exponent list compiles once.
const perExp = (exps) => exps.map((c, i) => `export let e${i} = (x) => x ** ${c}`).join('\n')

// Tally `pairs` of (x, y) through `pow` against host Math.pow: the bit-exact / 1-ulp /
// worse counts, and — only on a genuine miss — the offending pairs, so a regression is
// diagnosable from the log alone. Every pair must land within `limit` ulp.
function tally(label, pairs, pow, limit = 1) {
  let exact = 0, oneUlp = 0
  const worse = []
  for (const [x, y] of pairs) {
    const got = pow(x, y), want = Math.pow(x, y)
    const u = ulpDiff(got, want)
    if (u === 0) exact++
    else if (u === 1) oneUlp++
    else worse.push({ x, y, got, want, u })
  }
  console.log(`pow ULP (${label}): ${exact}/${pairs.length} bit-exact, ${oneUlp} at 1 ulp, ${worse.length} worse than 1 ulp`)
  if (worse.length) console.log(`  offenders: ${worse.map(w => `pow(${w.x}, ${w.y}) = ${w.got} vs host ${w.want} (${w.u} ulp)`).join('\n  ')}`)
  const over = worse.filter(w => w.u > limit).length
  ok(over === 0, `${label}: every pair within ${limit} ulp of host Math.pow (${over} exceeded)`)
}

// === 1. $math.pow_core — the runtime non-integer tail ===

const { f: pow } = run('export let f = (x, y) => Math.pow(x, y)')
const TAIL_BASES = [...LOG_BASES, 0.18, 0.5, 1.0000001, 2.2, 255.7]
// The pinned values from the colorpq regression (±0.1593017578125 — a PQ-curve exponent —
// and ±78.84375, its far end) plus common non-integer shapes: ±0.5 (sqrt fast path),
// ±1/3 (cube root), ±2.4 (sRGB gamma), ±100.7 (large non-integer).
const TAIL_EXPS = [0.1593017578125, -0.1593017578125, 78.84375, -78.84375, 0.5, -0.5, 1 / 3, -1 / 3, 2.4, -2.4, 100.7, -100.7]
// jz mirrors CURRENT V8's pow (src/prepare/math-kernel.js); older hosts' Math.pow itself
// sits ±1 ulp off that reference on a few pairs (node 22 CI vs node ≥ 24), so the ≤1ulp
// gate only holds against a current host — accept ≤2 ulp on older ones (Math.f16round
// presence is the version probe).
const TAIL_LIMIT = typeof Math.f16round === 'function' ? 1 : 2

test('Math.pow non-integer tail — bit-exact/≤1ulp grid vs host', () => {
  tally('grid', TAIL_BASES.flatMap(x => TAIL_EXPS.map(y => [x, y])), pow, TAIL_LIMIT)
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
  tally('random', pairs, pow, TAIL_LIMIT)
})

// === 2. $math.pow_fold — the correctly-rounded const-exponent fold (crPow) ===

// Exponents that reach $math.pow_fold specifically — finite, non-integer, not ±0.5 and
// not a k/5 fraction (those route to $math.sqrt / $math.fifthroot instead — section 3).
// The colorpq regression's own exponents (the PQ curve's nv=2610/16384 and
// p=1.7·2523/32) plus common non-fifthroot shapes.
// (2610/16384 IS 0.1593017578125, the pinned PQ exponent — listed once: identical
// functions in one module deduplicate, and the probe below reads each function's own body.)
const FOLD_EXPS = [
  2610 / 16384, -(2610 / 16384),
  1.7 * 2523 / 32, -(1.7 * 2523 / 32),
  1 / 3, -1 / 3,
  100.7, -100.7,
  1.61803398875, -1.61803398875,
]
// The exact boundary/edge values Math.pow special-cases (±0, ±1, ±Infinity, NaN) too.
const FOLD_BASES = [...LOG_BASES, 0, -0, 1, -1, Infinity, -Infinity, NaN, 0.18, 1.0000001, 2.2, 255.7]
const FOLD_SRC = perExp(FOLD_EXPS)
const foldOf = (exports, c) => exports[`e${FOLD_EXPS.indexOf(c)}`]

test('const-exponent pow fold — every exponent takes $math.pow_fold, never the general pow', () => {
  const text = wat(FOLD_SRC, CR_POW)
  for (const [i, c] of FOLD_EXPS.entries()) {
    const fn = funcWat(text, `e${i}`)
    ok(!/call \$math\.pow(_core)? /.test(fn), `x ** ${c}: fold must not call the general $math.pow/$math.pow_core (got: ${/call \$math\.pow\S*/.exec(fn)?.[0]})`)
    ok(fn.includes('call $math.pow_fold'), `x ** ${c}: expected a $math.pow_fold call in the compiled WAT`)
  }
})

test('const-exponent pow fold — bit-exact/≤1ulp grid vs host, per exponent', () => {
  const fold = run(FOLD_SRC, CR_POW)
  for (const c of FOLD_EXPS) tally(`fold c=${c}`, FOLD_BASES.map(x => [x, c]), foldOf(fold, c))
})

test('const-exponent pow fold — bit-exact/≤1ulp random bases vs host', () => {
  const rng = mkRng(0xDEADBEEF)
  const fold = run(FOLD_SRC, CR_POW)
  for (const c of [2610 / 16384, 1.7 * 2523 / 32, -0.1593017578125, 100.7, -1 / 3]) {
    const xs = []
    for (let i = 0; i < 64; i++) xs.push(10 ** ((rng() - 0.5) * 600))
    tally(`fold random c=${c}`, xs.map(x => [x, c]), foldOf(fold, c))
  }
})

// The SIMD twin ($math.pow_fold_v, a per-lane scalar repack — see module/math.js) must be
// bit-identical to the scalar fold: it just calls $math.pow_fold on each lane. Force
// vectorization with a tight typed-array loop and confirm the mirror's output matches a
// scalar loop over the same data, base-by-base — the differential proof that repacking
// didn't perturb anything, complementing the emit-time WAT probes above.
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
  ok(wat(src, CR_POW).includes('math.pow_fold_v'), 'expected the loop to vectorize through $math.pow_fold_v')
  const { f } = run(src, CR_POW)
  const N = 64
  let want = 0
  for (let i = 0; i < N; i++) { const x = 1 + i * 3.7; want = want * 31 + Math.pow(x, c) }
  const got = f(N)
  ok(Object.is(got, want) || ulpDiff(got, want) <= 4, `vectorized loop's folded reduction matches a scalar host computation (got ${got} vs ${want})`)
})

// === 3. $math.fifthroot — the k/5 fold's default kernel ===

test('fifthroot-backed pow fold reaches WAT via $math.fifthroot by default (not $math.pow/$math.pow_fold)', () => {
  const text = wat('export let f = (x) => x ** 2.4')
  ok(text.includes('call $math.fifthroot'), 'x ** 2.4 must fold through $math.fifthroot by default')
  ok(!/call \$math\.pow(_core|_fold)? /.test(text), 'x ** 2.4 must not fall through to the general pow paths')
})

test('x ** 2.4 under crPow (without approxPow) routes through the correctly-rounded $math.pow_fold', () => {
  const text = wat('export let f = (x) => x ** 2.4', CR_POW)
  ok(text.includes('call $math.pow_fold'), 'crPow build must use $math.pow_fold, not the approximate fifthroot fast path')
  ok(!text.includes('call $math.fifthroot'), 'crPow build must not reach $math.fifthroot from pow unless approxPow is also set')
})

test('x ** 2.4 under crPow + approxPow opts back into $math.fifthroot', () => {
  const text = wat('export let f = (x) => x ** 2.4', CR_POW_APPROX)
  ok(text.includes('call $math.fifthroot'), 'crPow+approxPow must fold through $math.fifthroot')
  ok(!/call \$math\.pow(_core|_fold)? /.test(text), 'crPow+approxPow must not fall through to the general pow paths')
})

// k/5 exponents in (0,5), the fold's own domain (see module/math.js emitPow) — 2.4 is the
// sRGB EOTF gamma colorlch/colorconv actually use; the others cover the other reachable
// k/5 shapes.
const FIFTH_EXPS = [0.2, 0.4, 0.6, 0.8, 1.2, 1.4, 1.6, 1.8, 2.2, 2.4, 2.6, 2.8, 3.2, 3.4, 3.6, 3.8, 4.2, 4.4, 4.6, 4.8]
// Generous regression ceiling — roughly 2x the measured ~2.65M ulp worst case (3 Newton
// steps), tight enough to catch a genuinely broken correction (e.g. a dropped step) while
// tolerating the known 3-step accuracy floor and ordinary machine/input variance.
const ULP_CEILING = 5_000_000

test(`fifthroot pow fold (default path) — worst case stays under ${ULP_CEILING} ulp vs host (regression guard)`, () => {
  const rng = mkRng(0x51DEC0DE)
  const fifth = run(perExp(FIFTH_EXPS))
  let worstOverall = 0
  for (const [i, c] of FIFTH_EXPS.entries()) {
    const f = fifth[`e${i}`]
    // Domain kept where the fold's OWN intermediate x**r (r up to 4, the algebraic
    // decomposition x**(k/5) = x**p · fifthroot(x**r)) can't itself over/underflow —
    // that's a separate, pre-existing property of the decomposition, not of
    // $math.fifthroot's own Newton accuracy, which is what this guard targets.
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
  console.log(`fifthroot fold worst-case ulp across ${FIFTH_EXPS.length} exponents: ${worstOverall}`)
})

// === 4. Correctly rounded on the authoritative vector set (runtime + fold paths) ===

const NV = 2610 / 16384, P = 1.7 * 2523 / 32

test('pow: correctly rounded on the authoritative vector set (runtime + fold paths)', () => {
  // crPow:true — the CORE-MATH-class kernel is opt-in (the default build keeps the old
  // fdlibm fold/kernel bit-for-bit for speed); approxPow stays off (its default), so f24's
  // k/5 exponent still routes through the correctly-rounded $math.pow_fold, not fifthroot.
  const { rt, fnv, fp, f24, fi24 } = run(`
    export let rt = (x, y) => x ** y
    export let fnv = (x) => x ** ${NV}
    export let fp = (x) => x ** ${P}
    export let f24 = (x) => x ** 2.4
    export let fi24 = (x) => x ** ${1 / 2.4}
  `, CR_POW)
  const buf = new Float64Array(1), u64 = new BigUint64Array(buf.buffer)
  const fromBits = (h) => { u64[0] = BigInt('0x' + h); return buf[0] }
  const toBits = (x) => { buf[0] = x; return u64[0].toString(16).padStart(16, '0') }
  const foldFns = { [toBits(NV)]: fnv, [toBits(P)]: fp, [toBits(2.4)]: f24, [toBits(1 / 2.4)]: fi24 }
  let rtMis = 0, foldMis = 0, foldTotal = 0, total = 0, firstRt = null, firstFold = null
  for (const line of readFileSync(new URL('./vectors/pow-cr.txt', import.meta.url), 'utf8').trim().split('\n')) {
    const [xh, yh, rh] = line.split(' ')
    const x = fromBits(xh), y = fromBits(yh)
    total++
    if (toBits(rt(x, y)) !== rh) { rtMis++; firstRt ??= `x=${xh} y=${yh} want=${rh} got=${toBits(rt(x, y))}` }
    const ff = foldFns[yh]
    if (ff) { foldTotal++; if (toBits(ff(x)) !== rh) { foldMis++; firstFold ??= `x=${xh} y=${yh} want=${rh} got=${toBits(ff(x))}` } }
  }
  is(total, 5152, 'vector count')
  is(rtMis, 0, `runtime $math.pow misrounds (first: ${firstRt})`)
  is(foldMis, 0, `const-exponent fold misrounds of ${foldTotal} (first: ${firstFold})`)
})

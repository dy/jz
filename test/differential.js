// Differential fuzz: for each program, jz-compiled wasm must produce the exact
// same result as the same source run as plain JavaScript ("valid jz = valid JS"),
// across many random inputs. This is the correctness floor under the
// size/speed gate — "smallest/fastest" must never be bought with a wrong answer.
//
// Scope: numeric programs over operations that are bit-exact between wasm f64
// and JS f64 (arithmetic, bitwise, comparisons, Math.floor/ceil/round/trunc/
// abs/sqrt/min/max, integer `**`). Transcendental Math.* is intentionally
// excluded — last-ULP differences there are not jz bugs.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'

// Deterministic PRNG so failures reproduce.
const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)(0xC0FFEE)
const pick = arr => arr[(rng() * arr.length) | 0]
// A spread of "interesting" f64s plus random ones.
const SPECIALS = [0, -0, 1, -1, 2, -2, 0.5, -0.5, 3, 7, 255, 256, -255, 1e9, -1e9, 0.1, NaN, Infinity, -Infinity, 2 ** 31, -(2 ** 31), 2 ** 32, 12345.678, -98765.4321]
const num = () => rng() < 0.35 ? pick(SPECIALS) : (rng() - 0.5) * 10 ** ((rng() * 20 | 0) - 6)

// Each program exports a function named `f`. `args` returns one random arg list.
const PROGRAMS = [
  { name: 'poly arith', src: `export let f = (a, b, c) => (a*b + c) / (a - b + 1) - c*c`, args: () => [num(), num(), num()] },
  { name: 'bitwise mix', src: `export let f = (a, b) => { let x = (a|0) ^ ((b|0) << 5); x ^= x >>> 13; x = Math.imul(x, 16777619) + (b|0); return (x ^ (x >>> 16)) | 0 }`, args: () => [num(), num()] },
  // imul with a literal ≥ 2³¹ (Knuth's multiplicative hash constant) — exercises ToInt32-wrapping of the operand.
  { name: 'imul big literal', src: `export let f = (a) => { let h = Math.imul(a|0, 2654435761); h = Math.imul(h ^ (h >>> 15), 2246822519); return (h ^ (h >>> 13)) | 0 }`, args: () => [num()] },
  { name: 'rounding', src: `export let f = (a) => Math.floor(a) + Math.ceil(a) + Math.trunc(a) + Math.round(a) + (Math.abs(a) - a)`, args: () => [num()] },
  // half-integers stress Math.round's ties-toward-+∞ (vs wasm f64.nearest's ties-to-even).
  { name: 'round half-integers', src: `export let f = (a) => { let n = (a|0) % 64; return Math.round(n * 0.5) + Math.round(-n * 0.5) + Math.round(n * 0.5 + 0.5) }`, args: () => [num()] },
  { name: 'min/max/sqrt', src: `export let f = (a, b, c) => Math.max(a, b, c) - Math.min(a, b, c) + Math.sqrt(Math.abs(a*b))`, args: () => [num(), num(), num()] },
  { name: 'loop accumulate', src: `export let f = (a, b) => { let s = 0; let i = 0; while (i < 64) { s = s + a*i - b; i = i + 1 } return s }`, args: () => [num(), num()] },
  { name: 'newton sqrt', src: `export let f = (a) => { let x = a < 0 ? -a : a; let y = x > 0 ? x : 1; let i = 0; while (i < 30) { y = (y + x/y) * 0.5; i = i + 1 } return y }`, args: () => [Math.abs(num()) + rng()] },
  { name: 'fib-ish', src: `export let f = (n) => { let k = (n|0) & 31; let a = 0; let b = 1; let i = 0; while (i < k) { let t = (a + b) | 0; a = b; b = t; i = i + 1 } return a }`, args: () => [num()] },
  { name: 'branchy', src: `export let f = (a, b) => { let r = 0; if (a > b) r = a - b; else if (a < b) r = b - a; else r = 0; return a > 0 ? (r % 7) : -(r % 13) }`, args: () => [num(), num()] },
  // small base/exp so the exact f64 range isn't exceeded (iterated-multiply vs
  // libm pow only agree bit-for-bit while results stay ≤ 2**53).
  { name: 'integer pow', src: `export let f = (a, b) => { let e = ((b|0) & 5); let n = (a|0) % 12; return n ** e + 2 ** e }`, args: () => [num(), num()] },
  { name: 'fnv hash', src: `export let f = (a, b, c) => { let h = 2166136261 | 0; h = Math.imul(h ^ (a|0), 16777619); h = Math.imul(h ^ (b|0), 16777619); h = Math.imul(h ^ (c|0), 16777619); return h >>> 8 }`, args: () => [num(), num(), num()] },
  // Conditional negation feeding arithmetic — the Perlin-gradient sign-select shape
  // (`(h&1)?x:-x`). stripCanon recurses through the ?: to drop the per-neg NaN-canon,
  // trusting the consuming f64.add/sub/mul to re-canon at escape. A NaN/Inf/-0 operand
  // that round-trips wrong (sign-flipped NaN read as a tagged value, or -0 vs +0) shows
  // up here as a divergence, and the result is fed back through `===` to surface a
  // mis-canon'd NaN (NaN === NaN is false; a tagged sign-flip would read true).
  { name: 'cond-neg canon', src: `export let f = (c, x, y) => { let n = (c|0) & 3; let u = (n === 0 ? x : -x) + (n === 1 ? -y : y); let v = (n === 2 ? -x : x) * (n === 3 ? y : -y); let w = u - v; return (w === w ? w : 1.5) + (u !== u ? 2.25 : 0.0) }`, args: () => [num(), num(), num()] },
]

// Divergences this fuzzer caught and that are now fixed (kept here as a log):
//   • `Math.round(a)`  — was `f64.nearest` (ties-to-even); now corrected to JS
//     ties-toward-+∞ (module/math.js).  • `Math.imul(_, ≥2³¹)` — operand now
//     ToInt32-wrapped, not saturated (module/math.js).  Both are back in PROGRAMS.

const jsRef = src => new Function(`${src.replace(/export\s+let\s+f\s*=/, 'let f =')}\n;return f`)()
const RUNS = 400

for (const { name, src, args } of PROGRAMS) {
  test(`differential: ${name}`, () => {
    const { exports: { f } } = jz(src)
    const ref = jsRef(src)
    for (let i = 0; i < RUNS; i++) {
      const a = args()
      const got = f(...a)
      const want = ref(...a)
      const same = Object.is(got, want) || (got === want) || (Number.isNaN(got) && Number.isNaN(want))
      ok(same, `${name}(${a.map(String).join(', ')}) → jz ${got} ≠ js ${want}`)
    }
  })
}

// ── Memory-access geometries: the typed-array store/load sublanguage where the SLP
// store-pair packer and the lane vectorizer live — the oracle this suite previously
// lacked (a forward-shift `o[k+1]=o[k]; o[k+2]=o[k+1]` SLP read-after-write miscompile
// shipped past every green gate). MODULE-LEVEL arrays (the base-addressing shape that
// actually engages SLP — a local array stays scalar) with FLOAT arithmetic over
// INTEGER-VALUED data (×100.0): the value stays f64 so the packer fires, yet every
// partial sum stays < 2^53, so a POSITION-WEIGHTED sum is exact regardless of addition
// order — the lane vectorizer's accepted f64-reduction reassociation (1–2 ULP, see
// vectorize.js) can't move it, but a wrong/duplicated/stale ELEMENT does (verified: with
// the RAW guard removed, "forward shift" diverges 7/7 by ~1.5e5, not a ULP). `(seed*i)|0`
// is avoided — the i32 store path skips SLP. Run at the default level (SLP + vectorizer
// on) and 'speed' (adds the 4-accumulator reduce). `weight (i+1)` is order-sensitive, so
// a permutation that preserves the multiset still trips it.
const sval = () => (rng() * 200 | 0) - 100
const MEM_PROGRAMS = [
  { name: 'forward shift (SLP RAW)',
    src: `let o = new Float64Array(99); export let f = (seed) => { for (let i=0;i<99;i++) o[i]=(seed+i)*100.0; for (let k=0;k<96;k+=3){ o[k+1]=o[k]; o[k+2]=o[k+1] } let s=0.0; for (let i=0;i<99;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'backward shift',
    src: `let o = new Float64Array(99); export let f = (seed) => { for (let i=0;i<99;i++) o[i]=(seed+i)*100.0; for (let k=93;k>=0;k-=3){ o[k+1]=o[k+2]; o[k]=o[k+1] } let s=0.0; for (let i=0;i<99;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'own-index map',
    src: `let o = new Float64Array(64), a = new Float64Array(64); export let f = (seed) => { for (let i=0;i<64;i++) a[i]=(seed+i)*100.0; for (let i=0;i<64;i+=2){ o[i]=a[i]*2.0+1.0; o[i+1]=a[i+1]*2.0+1.0 } let s=0.0; for (let i=0;i<64;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'multi-array sum',
    src: `let o = new Float64Array(64), a = new Float64Array(64), b = new Float64Array(64); export let f = (seed) => { for (let i=0;i<64;i++){ a[i]=(seed+i)*100.0; b[i]=(seed-i)*100.0 } for (let i=0;i<64;i+=2){ o[i]=a[i]+b[i]; o[i+1]=a[i+1]+b[i+1] } let s=0.0; for (let i=0;i<64;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'pairwise swap',
    src: `let o = new Float64Array(64); export let f = (seed) => { for (let i=0;i<64;i++) o[i]=(seed+i)*100.0; for (let i=0;i<64;i+=2){ let t=o[i]; o[i]=o[i+1]; o[i+1]=t } let s=0.0; for (let i=0;i<64;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'strided de-interleave',
    src: `let o = new Float64Array(64), a = new Float64Array(64); export let f = (seed) => { for (let i=0;i<64;i++) a[i]=(seed+i)*100.0; for (let i=0;i<32;i++){ o[i]=a[2*i]; o[i+32]=a[2*i+1] } let s=0.0; for (let i=0;i<64;i++) s=s+o[i]*(i+1); return s }` },
  { name: 'prefix sum (recurrence)',
    src: `let o = new Float64Array(64); export let f = (seed) => { o[0]=seed*1.0; for (let i=1;i<64;i++) o[i]=o[i-1]+i*1.0; let s=0.0; for (let i=0;i<64;i++) s=s+o[i]*(i+1); return s }` },
]
for (const { name, src } of MEM_PROGRAMS) {
  test(`differential mem: ${name}`, () => {
    const ref = jsRef(src)
    for (const level of [2, 'speed']) {
      const { exports: { f } } = jz(src, { optimize: { level } })
      for (let i = 0; i < 120; i++) {
        const seed = sval()
        const got = f(seed), want = ref(seed)
        ok(Object.is(got, want), `${name}@${level}(${seed}) → jz ${got} ≠ js ${want}`)
      }
    }
  })
}

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

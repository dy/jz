// i32 conditional maps over typed arrays must NARROW to i32 and VECTORIZE (i32x4),
// not round-trip through f64. Two paths:
//   • `?:` lowered to (if result f64): toI32 distributes ToInt32 through it,
//     recursively for nested chains (src/optimize/index.js).
//   • `?:` lowered to a branchless `select` with two distinct arms: liftExprV lifts
//     the general select → v128.bitselect for EVERY lane type, not just float
//     (src/optimize/vectorize.js). (Clamp/abs shapes fold to specialized i32x4 ops.)
// The pin is bit-exactness across opt0 / noSimd / speed AND that the speed build
// vectorizes as i32x4 (the narrowing held — an f64x2 body would be a lost narrowing).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const runF = (src, o) => jz(src, { optimize: o }).exports.run()
const watRun = (src) => {
  const w = jz.compile(src, { wat: true, optimize: { level: 'speed' } })
  const i = w.indexOf('(func $run')
  return w.slice(i, w.indexOf('\n  (func ', i + 8))
}

function pin(name, src, { bitselect = false } = {}) {
  const f = watRun(src)
  ok(/i32x4/.test(f), `${name}: vectorizes as i32x4 (narrowing held)`)
  if (bitselect) ok(/v128\.bitselect/.test(f), `${name}: general select lifted to bitselect`)
  const a = runF(src, 0), b = runF(src, { level: 'speed', noSimd: true }), c = runF(src, { level: 'speed' })
  ok(a === b && a === c, `${name}: bit-exact opt0/noSimd/speed (${a})`)
}

test('cond-vectorize: clamp → i32x4', () => {
  pin('clamp', `export let run = () => {
    let a = new Int32Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 5) & 127
    for (let i = 0; i < 64; i++) a[i] = (a[i] > 50) ? 50 : a[i]
    let s = 0; for (let i = 0; i < 64; i++) s = (s + a[i]) | 0; return s }`)
})

test('cond-vectorize: two-arm select → i32x4 bitselect', () => {
  // P0-2 ledger (2026-08-02): the `then` arm was bare `a[i] * 2` — an Int32Array
  // element is a genuinely FULL-RANGE i32 (no narrowing load width like a
  // Uint8/16Array, and jz has no whole-program proof that every WRITE into `a`
  // stays masked), so `a[i]*2` is not actually provably i32-safe — the OLD
  // `mulFitsI32` admitted it anyway (bounding only the literal `2` side), which
  // was live-unsound (confirmed: `a[0]=2000000000; a[0]*2` wrapped to
  // -294967296 instead of 4000000000 at HEAD). The corrected rule can't prove
  // it either, so the optimizer's own lane-vectorizer follows suit and bails
  // the WHOLE loop to scalar — a real, but honest, lost optimization for a
  // pattern that was never actually sound. Re-mask `a[i]` before the multiply
  // (`(a[i]&127)*2 ≤ 254`, genuinely i32-safe) so this test again exercises
  // its OWN subject — the two-arm-select-to-bitselect lift — decoupled from
  // the (separate, now-fixed) product-safety question.
  //
  // P0-2 SIBLING (2026-08-02): same story for the `else` arm, which was bare
  // `a[i] + 1` — also not provably i32-safe (a[i] could be within 1 of
  // INT32_MAX), so the now-corrected `addFitsI32` can't admit it as a bare
  // i32.add either, and the vectorizer follows suit. Re-mask it too
  // (`(a[i]&127)+1 ≤ 128`, genuinely i32-safe) for the same reason.
  pin('two-arm', `export let run = () => {
    let a = new Int32Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 5) & 127
    for (let i = 0; i < 64; i++) a[i] = (a[i] > 50) ? ((a[i] & 127) * 2) : ((a[i] & 127) + 1)
    let s = 0; for (let i = 0; i < 64; i++) s = (s + a[i]) | 0; return s }`, { bitselect: true })
})

test('cond-vectorize: nested ternary chain → i32x4 bitselect', () => {
  pin('nested', `export let run = () => {
    let a = new Int32Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 7) & 63
    for (let i = 0; i < 64; i++) a[i] = ((3 < a[i]) ? (2 & a[i]) : ((7 < a[i]) ? a[i] : 1)) | 0
    let s = 0; for (let i = 0; i < 64; i++) s = (s + a[i]) | 0; return s }`, { bitselect: true })
})

// An integer comparison choosing between float64 values (a bitmap seeding a
// distance field: `d[i] = bmp[i] === 1 ? 0 : INF`): the two lanes' integers
// compare in i32x4 lanes and each answer widens to its 64-bit lane, the mask
// of an f64x2 bitselect. Signed and unsigned elements, an invariant operand,
// and lengths that leave a scalar tail agree with the host at every level.
test('cond-vectorize: an integer comparison selects float64 lanes', () => {
  const src = (T, cond) => `const seed = (a, d, n, k) => { for (let i = 0; i < n; i++) d[i] = ${cond} ? 0.25 : 1e20 }
  export let run = (n, k) => {
    const a = new ${T}(n), d = new Float64Array(n)
    let s = 7
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) | 0; a[i] = (s >> 8) % 300 }
    seed(a, d, n, k | 0)
    let h = 0
    for (let i = 0; i < n; i++) h = (h * 31 + (d[i] === 1e20 ? 7 : 3)) % 1000000007
    return h }`
  // (`mask`: the scalar test compares integers; a u16 against `k` compares as float64 there)
  for (const [T, cond, mask] of [['Uint8Array', 'a[i] === 1', true], ['Int8Array', 'a[i] < -3', true], ['Uint16Array', 'a[i] >= k', false], ['Int32Array', 'a[i] !== k', true]]) {
    const s = src(T, cond)
    const w = jz.compile(s, { wat: true, optimize: { level: 'speed' } })
    const f = w.slice(w.indexOf('(func $run'), w.indexOf('\n  (func ', w.indexOf('(func $run') + 8))
    ok(/v128\.bitselect/.test(f), `${T} ${cond}: the map runs in f64x2 lanes`)
    if (mask) ok(/i64x2\.extend_low_i32x4_s/.test(f), `${T} ${cond}: its mask is the integer comparison widened`)
    const host = new Function(s.replace('export let run =', 'return'))()
    for (const o of [0, { level: 'speed', noSimd: true }, { level: 'speed' }]) {
      const run = jz(s, { optimize: o }).exports.run
      for (const n of [0, 1, 2, 5, 64, 67]) for (const k of [1, 120, -2])
        is(run(n, k), host(n, k), `${T} ${cond}, ${JSON.stringify(o)}: n=${n} k=${k}`)
    }
  }
})

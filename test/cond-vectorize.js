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

// The speed build's WAT of function `name` (the kernels inline into `go`: WASI reserves `run` for its void command entry), and the module run
// at every level beside the host.
const funcWatOf = (src, name, extra = {}) => {
  const w = jz.compile(src, { wat: true, optimize: { level: 'speed', ...extra } })
  const i = w.indexOf(`(func $${name}`)
  return i < 0 ? '' : w.slice(i, w.indexOf('\n  (func ', i + 8))
}
const LEVELS = [0, { level: 'speed', noSimd: true }, { level: 'speed' }]
const agree = (label, src, argSets, extra = {}) => {
  const host = new Function(src.replace('export let go =', 'return'))()
  for (const o of LEVELS) {
    const run = jz(src, { optimize: o && { ...o, ...extra } }).exports.go
    for (const args of argSets) is(run(...args), host(...args), `${label}, ${JSON.stringify(o)}: ${JSON.stringify(args)}`)
  }
}

// A local one path of a conditional writes and another leaves alone keeps the
// previous iteration's value there: it is carried, not lane data, and the loop
// stays scalar. Written on both paths it is lane data again.
test('cond-vectorize: a conditional write some path skips is loop-carried', () => {
  // (a constant count: the loop a run-time count bounds is not vectorized to begin with)
  const carried = (T, mix, n) => `export let go = () => {
    const a = new ${T}(${n}), o = new ${T}(${n})
    for (let i = 0; i < ${n}; i++) a[i] = ((i * 37) % 11) - 5
    let t = 1
    for (let i = 0; i < ${n}; i++) { const x = a[i]; if (x > 0) t = x; o[i] = ${mix} }
    let s = 0; for (let i = 0; i < ${n}; i++) s = (s * 3 + o[i]) % 1000003; return s }`
  for (const [T, mix] of [['Float64Array', 't'], ['Int32Array', 't + x'], ['Float32Array', 't * 2']])
    for (const n of [7, 64, 67]) agree(`${T} carried, ${n} elements`, carried(T, mix, n), [[]])
  const both = `const f = (a, o, n) => { for (let i = 0; i < n; i++) { const x = a[i]; let t = 0; if (x > 0) t = x; else t = -x; o[i] = t } }
  export let go = (n) => {
    const a = new Float64Array(n), o = new Float64Array(n)
    for (let i = 0; i < n; i++) a[i] = ((i * 37) % 11) - 5.5
    f(a, o, n)
    let s = 0; for (let i = 0; i < n; i++) s = s * 3 + o[i]; return s }`
  ok(/v128\.bitselect/.test(funcWatOf(both, 'go')), 'written on both paths: f64x2 lanes')
  agree('both paths', both, [[0], [3], [64], [65]])
})

// Several assignments under a mask (a rounding step behind a run-time flag, which
// lowers to three statements, and else arms that assign more than one local): each
// arm runs on every lane and every assignment keeps the old value where the mask is off.
test('cond-vectorize: several assignments per arm run under the arm\'s mask', () => {
  // (unswitching off: it copies the loop per answer of a flag it can name, and the
  // lift is what remains where it does not, a flag of record fields in pcmconvert)
  const flagged = `const conv = (src, dst, n, scale, lo, hi) => {
    const round = hi - lo > 2
    for (let i = 0; i < n; i++) {
      let v = src[i] * scale
      if (round) v = Math.round(v)
      dst[i] = v < lo ? lo : v > hi ? hi : v
    }
  }
  export let go = (n, lo, hi) => {
    const src = new Float32Array(n), dst = new Float64Array(n)
    for (let i = 0; i < n; i++) src[i] = Math.fround(((i * 37) % 23) / 9 - 1.2 + (i % 4) * 0.125)
    conv(src, dst, n, 100.5, lo, hi)
    let s = 0; for (let i = 0; i < n; i++) s = s * 1.0001 + dst[i]; return s }`
  const noUnswitch = { unswitchLoops: false }
  const f = funcWatOf(flagged, 'go', noUnswitch)
  ok(/f64x2\.nearest/.test(f) && /v128\.bitselect/.test(f), 'the flagged rounding runs in f64x2 lanes')
  agree('flagged rounding', flagged, [[0, -100, 100], [5, -100, 100], [64, -50, 70], [67, -1, 1], [33, -1e9, 1e9]], noUnswitch)

  const ladder = `const f = (a, o, n) => {
    for (let i = 0; i < n; i++) {
      let v = a[i], w = v * 2
      if (v > 0.5) { w = v - 1; v = w * w }
      else if (v < -0.5) { w = v + 1; v = -w }
      else { v = v * 3; w = w + v }
      o[i] = v + w
    }
  }
  export let go = (n) => {
    const a = new Float64Array(n), o = new Float64Array(n)
    for (let i = 0; i < n; i++) a[i] = ((i * 29) % 17) / 5.5 - 1.5
    f(a, o, n)
    let s = 0; for (let i = 0; i < n; i++) s = s * 1.0001 + o[i]; return s }`
  ok(/v128\.bitselect/.test(funcWatOf(ladder, 'go')), 'the multi-assignment else-if ladder runs in f64x2 lanes')
  agree('assignment ladder', ladder, [[0], [1], [2], [9], [64], [67]])
})

// An integer element stored from float arithmetic whose range the program decides at
// run time (clamp bounds passed in): the vector truncation where every lane lies inside
// ±2³¹, the exact conversion lane by lane otherwise (NaN, the infinities, wrapping
// magnitudes), each agreeing with the host.
test('cond-vectorize: an exact integer store truncates in lanes inside a word', () => {
  const VALUES = [0, -0, 0.5, -0.5, 1.75, -1.75, 32767.9, -32768.9, 65535.5, 2147483647.5, -2147483648.5,
    2147483648, -2147483649, 4294967296.25, -1e12, 1e15, 2 ** 53, NaN, Infinity, -Infinity, 123.456, -98765.4321]
  const src = (T) => `const enc = (x, out, n, lo, hi) => {
    for (let i = 0; i < n; i++) { const v = x[i] * 1.5; out[i] = v < lo ? lo : v > hi ? hi : v }
  }
  export let go = (n, lo, hi, seed) => {
    const x = new Float64Array(n), out = new ${T}(n)
    const vals = [${VALUES.map(v => Object.is(v, -0) ? '-0' : String(v)).join(', ')}]
    for (let i = 0; i < n; i++) x[i] = vals[(i * 7 + seed) % vals.length]
    enc(x, out, n, lo, hi)
    let h = 0; for (let i = 0; i < n; i++) h = (h * 31 + out[i]) % 1000000007; return h }`
  for (const T of ['Int16Array', 'Int32Array', 'Uint8Array']) {
    const s = src(T)
    const f = funcWatOf(s, 'go')
    ok(/i32x4\.all_true/.test(f) && /i32x4\.trunc_sat_f64x2_s_zero/.test(f), `${T}: the store truncates in lanes behind the word test`)
    const args = []
    for (const [lo, hi] of [[-40000, 40000], [-1e300, 1e300], [-Infinity, Infinity], [-3, 3]])
      for (const [n, seed] of [[0, 0], [1, 3], [2, 17], [44, 0], [45, 5]]) args.push([n, lo, hi, seed])
    agree(T, s, args)
  }
})

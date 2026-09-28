// SLP (superword-level parallelism): packs two adjacent isomorphic f64 element
// stores within one iteration into a single v128 store — the lane class the loop
// vectorizer (which packs ACROSS iterations) can't reach. Sound ONLY when the module
// creates no aliasing typed-array view; the bail cases below are the soundness pins
// (a missed view = packing aliased memory = miscompile, the watr self-compile class).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { onWasi } from './_matrix.js'

const speed = { level: 'speed' }
const speedNoSimd = { level: 'speed', noSimd: true }
const fires = (src) => (jz.compile(src, { wat: true, optimize: speed }).match(/v128\.store/g) || []).length

// Run the same source SIMD vs scalar; assert byte-identical numeric result.
function bitExact(name, src) {
  if (onWasi()) return  // compares JS-side `.exports.run()` returns, which the WASI boundary doesn't surface
  const a = jz(src, { optimize: speed }).exports.run()
  const b = jz(src, { optimize: speedNoSimd }).exports.run()
  ok(Object.is(a, b), `${name}: SIMD == scalar (${a})`)
}

test('slp: 2-wide map packs to v128 + bit-exact', () => {
  const src = `
    let o = new Float64Array(64), a = new Float64Array(64)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i * 0.5
      for (let i = 0; i < 64; i += 2) { o[i] = a[i] * 2.0 + 1.0; o[i+1] = a[i+1] * 2.0 + 1.0 }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + o[i] * (i + 1); return s
    }`
  ok(fires(src) >= 1, 'packs adjacent stores into a v128 store')
  bitExact('2-wide map', src)
})

test('slp: multi-array map (a+b) packs + bit-exact', () => {
  const src = `
    let o = new Float64Array(64), a = new Float64Array(64), b = new Float64Array(64)
    export let run = () => {
      for (let i = 0; i < 64; i++) { a[i] = i; b[i] = i * 2.0 }
      for (let i = 0; i < 64; i += 2) { o[i] = a[i] + b[i]; o[i+1] = a[i+1] + b[i+1] }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + o[i]; return s
    }`
  ok(fires(src) >= 1, 'two distinct non-view bases pack soundly')
  bitExact('multi-array', src)
})

// === Soundness pins: SLP MUST bail when a typed-array view exists ===
// The two statements of each pair differ: an unrolled body of two equal
// statements is rolled back to one (plan/counted-loops.js) and taken by the
// lane vectorizer, which versions on aliasing itself; SLP is what these pin.
// The values stay small integers and halves, so the sums are exact in any order.

test('slp: bails on a subarray view (aliasing)', () => {
  // `v = a.subarray(1)` overlaps `a`; packing the shifted write would miscompile.
  const src = `
    let a = new Float64Array(65), v = a.subarray(1)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i + 1.0
      for (let i = 0; i < 64; i += 2) { v[i] = a[i] + 1.0; v[i+1] = a[i+1] + 2.0 }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + a[i]; return s
    }`
  is(fires(src), 0, 'view present → SLP bails (no v128 store)')
  bitExact('subarray view', src)
})

test('slp: bails on an INLINE subarray view (no binding)', () => {
  // `a.subarray(1)[i] = …` aliases `a` with no `let v = …` decl — the `.subarray`
  // EMIT handler must flag the view, not just the bound-decl path in analyze.js.
  const src = `
    let a = new Float64Array(65)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i + 1.0
      for (let i = 0; i < 64; i += 2) { a.subarray(1)[i] = a[i] * 2.0; a.subarray(1)[i+1] = a[i+1] * 2.0 }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + a[i]; return s
    }`
  is(fires(src), 0, 'inline subarray view → SLP bails')
  bitExact('inline subarray', src)
})

test('slp: does NOT splat distinct allocations (array-literal scatter)', () => {
  // `[new Float32Array(3), new Float32Array(3)]` builds an outer f64 array of two
  // adjacent pointer stores. They look identical but are DISTINCT allocations — SLP
  // must not splat them (which would alias ch[0] and ch[1]). Regression: this aliased
  // and returned 2220 instead of 1220.
  const { exports } = jz(`export let f = () => {
    let ch = [new Float32Array(3), new Float32Array(3)]
    for (let i = 0; i < 3; i++) for (let c = 0; c < 2; c++) ch[c][i] = (c + 1) * 10 + i
    return ch[0][2] * 100 + ch[1][0] }`, { optimize: { level: 'speed' } })
  is(exports.f(), 1220, 'ch[0] and ch[1] are distinct arrays (no splat-aliasing)')
})

test('slp: does NOT splat distinct NON-FINITE / signed-zero constants', () => {
  // exprEq compared nodes via JSON.stringify, which maps Infinity/-Infinity/NaN→null
  // and -0→0 — so a `[Infinity, -Infinity]` (or `[-0, 0]`) adjacent-constant store pair
  // LOOKED equal and packed as ONE f64x2.splat lane, dropping the second value.
  // Regression (test262 Math/sumPrecise): sumPrecise([Inf,-Inf]) returned Infinity
  // (splat→[Inf,Inf]) instead of NaN; sumPrecise([-0,0]) returned -0 instead of +0.
  const e = jz(`
    export let sumInf = () => Math.sumPrecise([Infinity, -Infinity])
    export let sumInf2 = () => Math.sumPrecise([-Infinity, Infinity])
    export let sumZero = () => Math.sumPrecise([-0.0, 0.0])
    export let sumSame = () => Math.sumPrecise([Infinity, Infinity])
  `, { optimize: speed }).exports
  ok(Number.isNaN(e.sumInf()), 'sumPrecise([Inf,-Inf]) = NaN — pair not splatted to [Inf,Inf]')
  ok(Number.isNaN(e.sumInf2()), 'sumPrecise([-Inf,Inf]) = NaN — pair not splatted to [-Inf,-Inf]')
  ok(Object.is(e.sumZero(), 0), 'sumPrecise([-0,0]) = +0 — -0 not splatted over +0')
  is(e.sumSame(), Infinity, 'sumPrecise([Inf,Inf]) = Inf — genuinely-equal constants still pack')
})

test('slp: bails on a within-iteration read-after-write (forward shift)', () => {
  // `o[k+1]=o[k]; o[k+2]=o[k+1]` — the second store's value reads o[k+1], which the
  // FIRST store just wrote. SLP materializes both lane values before either store, so a
  // pack would read o[k+1]'s PRE-store value → o[k+2] gets the wrong element. The RAW
  // guard (slpReadsSlot) must bail. This is NOT a view (single owned array), so the
  // typedView gate can't see it — it's the same-base read-after-write hazard class.
  // Store forwarding resolves the second value to the first store's local before the
  // packer runs, so the guard is pinned with it off.
  const src = `
    let o = new Float64Array(99)
    export let run = () => {
      for (let i = 0; i < 99; i++) o[i] = i + 1.0
      for (let k = 0; k < 96; k += 3) { o[k+1] = o[k]; o[k+2] = o[k+1] }
      let s = 0.0; for (let i = 0; i < 99; i++) s = s + o[i]; return s
    }`
  const unforwarded = jz.compile(src, { wat: true, optimize: { ...speed, forwardStores: false } })
  is((unforwarded.match(/v128\.store/g) || []).length, 0, 'forward-shift RAW → SLP bails (no v128 store)')
  bitExact('forward shift', src)
  // ground-truth: a regressed guard would re-pack and diverge from plain JS
  const js = (() => { let o = new Float64Array(99); for (let i=0;i<99;i++) o[i]=i+1; for (let k=0;k<96;k+=3){o[k+1]=o[k];o[k+2]=o[k+1]} let s=0; for (let i=0;i<99;i++) s+=o[i]; return s })()
  if (!onWasi()) is(jz(src, { optimize: speed }).exports.run(), js, 'jz speed == JS ground truth')  // WASI doesn't surface the return value
})

test('slp: bails on a buffer-backed view (the watr self-compile class)', () => {
  // Two Float64Arrays over one ArrayBuffer alias; SLP must not pack across them.
  const src = `
    let buf = new ArrayBuffer(512)
    let a = new Float64Array(buf), o = new Float64Array(buf)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i * 0.5
      for (let i = 0; i < 64; i += 2) { o[i] = a[i] * 2.0 + 1.0; o[i+1] = a[i+1] * 3.0 + 1.0 }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + o[i]; return s
    }`
  is(fires(src), 0, 'buffer-backed view → SLP bails (no v128 store)')
  bitExact('buffer-backed view', src)
})

// === Field pairs: the field-first idiom (`a00 = a[0], a01 = a[1]`) packs through one v128 per adjacent pair ===

// mat4 multiply the way vector libraries write it: every lane leaf is a local loaded
// once from consecutive slots, no load in the values themselves (alias-safe by construction).
const mat4 = (call) => `
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const a = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.25, 0.125, 1]
  const b = [0.9, 0.1, 0, 0, -0.1, 0.9, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
  function mul(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3]
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7]
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11]
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15]
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    return out
  }
  ${call}
  export let run = () => { let s = 0; for (let i = 0; i < 64; i++) { s += step(i); a[12] = out[12] * 0.001 } return s }`
const groundTruth = (src) => new Function(src.replace(/export let run/, 'return () => { const run') + '; return run() }')()()

test('slp: field pairs pack a kernel that loads its fields into locals first', () => {
  const src = mat4('const step = (i) => { mul(out, a, b); return out[0] + out[15] }')
  ok(fires(src) >= 8, 'every row packs: (a0k,a1k) and (a2k,a3k) are one v128 each')
  bitExact('field pairs', src)
  if (!onWasi()) is(jz(src, { optimize: speed }).exports.run(), groundTruth(src), 'jz speed == JS ground truth')
})

test('slp: field pairs through a staged receiver (a parameter that may be absent)', () => {
  // `as[i & 3]` may be absent to the summary: each field read stages its receiver and the
  // first one throws when absent; the loads still pair through the staging.
  const src = mat4(`const as = []
    for (let i = 0; i < 4; i++) as.push([1 + i, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.25, 0.125, 4 - i])
    const step = (i) => { mul(out, as[i & 3], b); return out[0] + out[15] }`)
  ok(fires(src) >= 8, 'the staged reads pair')
  bitExact('staged field pairs', src)
  if (!onWasi()) is(jz(src, { optimize: speed }).exports.run(), groundTruth(src), 'jz speed == JS ground truth')
})

test('slp: bails when the high value loads the low store\'s slot through another name', () => {
  // `shift(x, x)`: `o` and `a` are one array, so `a[1]` is the slot `o[1]` just wrote. A pack
  // would read it before the write (the aliased-parameter forward shift); the RAW guard
  // rejects a load at the low slot's offset whatever its base.
  const src = `
    const x = [3, 5, 0, 0], y = [1, 1, 0, 0]
    function shift(o, a) { o[1] = a[0] * 2.0; o[2] = a[1] * 2.0; return o }
    export let run = () => { let s = 0; for (let i = 0; i < 4; i++) { x[0] = 3; x[1] = 5; shift(x, x); s += x[2]; shift(y, x); s += y[2] } return s }`
  is(fires(src), 0, 'aliased forward shift → SLP bails')
  if (!onWasi()) is(jz(src, { optimize: speed }).exports.run(), 96, 'jz speed == JS ground truth (x[2] = 2 * (2 * x[0]))')
})

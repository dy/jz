// SLP (superword-level parallelism): packs two adjacent isomorphic f64 element
// stores within one iteration into a single v128 store — the lane class the loop
// vectorizer (which packs ACROSS iterations) can't reach. Sound ONLY when the module
// creates no aliasing typed-array view; the bail cases below are the soundness pins
// (a missed view = packing aliased memory = miscompile, the watr self-host class).
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

test('slp: bails on a subarray view (aliasing)', () => {
  // `v = a.subarray(1)` overlaps `a`; packing the shifted write would miscompile.
  const src = `
    let a = new Float64Array(65), v = a.subarray(1)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i + 1.0
      for (let i = 0; i < 64; i += 2) { v[i] = a[i] * 2.0; v[i+1] = a[i+1] * 2.0 }
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
  // guard (slpReadsOffset) must bail. This is NOT a view (single owned array), so the
  // typedView gate can't see it — it's the same-base read-after-write hazard class.
  const src = `
    let o = new Float64Array(99)
    export let run = () => {
      for (let i = 0; i < 99; i++) o[i] = i + 1.0
      for (let k = 0; k < 96; k += 3) { o[k+1] = o[k]; o[k+2] = o[k+1] }
      let s = 0.0; for (let i = 0; i < 99; i++) s = s + o[i]; return s
    }`
  is(fires(src), 0, 'forward-shift RAW → SLP bails (no v128 store)')
  bitExact('forward shift', src)
  // ground-truth: a regressed guard would re-pack and diverge from plain JS
  const js = (() => { let o = new Float64Array(99); for (let i=0;i<99;i++) o[i]=i+1; for (let k=0;k<96;k+=3){o[k+1]=o[k];o[k+2]=o[k+1]} let s=0; for (let i=0;i<99;i++) s+=o[i]; return s })()
  if (!onWasi()) is(jz(src, { optimize: speed }).exports.run(), js, 'jz speed == JS ground truth')  // WASI doesn't surface the return value
})

test('slp: bails on a buffer-backed view (the watr self-host class)', () => {
  // Two Float64Arrays over one ArrayBuffer alias; SLP must not pack across them.
  const src = `
    let buf = new ArrayBuffer(512)
    let a = new Float64Array(buf), o = new Float64Array(buf)
    export let run = () => {
      for (let i = 0; i < 64; i++) a[i] = i * 0.5
      for (let i = 0; i < 64; i += 2) { o[i] = a[i] * 2.0 + 1.0; o[i+1] = a[i+1] * 2.0 + 1.0 }
      let s = 0.0; for (let i = 0; i < 64; i++) s = s + o[i]; return s
    }`
  is(fires(src), 0, 'buffer-backed view → SLP bails (no v128 store)')
  bitExact('buffer-backed view', src)
})

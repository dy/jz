// SLP (superword-level parallelism): packs two adjacent isomorphic f64 element
// stores within one iteration into a single v128 store — the lane class the loop
// vectorizer (which packs ACROSS iterations) can't reach. Sound ONLY when the module
// creates no aliasing typed-array view; the bail cases below are the soundness pins
// (a missed view = packing aliased memory = miscompile, the watr self-host class).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const speed = { level: 'speed' }
const speedNoSimd = { level: 'speed', noSimd: true }
const fires = (src) => (jz.compile(src, { wat: true, optimize: speed }).match(/v128\.store/g) || []).length

// Run the same source SIMD vs scalar; assert byte-identical numeric result.
function bitExact(name, src) {
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

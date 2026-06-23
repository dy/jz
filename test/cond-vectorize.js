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
  pin('two-arm', `export let run = () => {
    let a = new Int32Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 5) & 127
    for (let i = 0; i < 64; i++) a[i] = (a[i] > 50) ? (a[i] * 2) : (a[i] + 1)
    let s = 0; for (let i = 0; i < 64; i++) s = (s + a[i]) | 0; return s }`, { bitselect: true })
})

test('cond-vectorize: nested ternary chain → i32x4 bitselect', () => {
  pin('nested', `export let run = () => {
    let a = new Int32Array(64); for (let i = 0; i < 64; i++) a[i] = (i * 7) & 63
    for (let i = 0; i < 64; i++) a[i] = ((3 < a[i]) ? (2 & a[i]) : ((7 < a[i]) ? a[i] : 1)) | 0
    let s = 0; for (let i = 0; i < 64; i++) s = (s + a[i]) | 0; return s }`, { bitselect: true })
})

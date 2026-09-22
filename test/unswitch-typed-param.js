// unswitchTypedParamLoop: a typed-array passed as a PARAM (`(buf,n)=>{for(i<n) buf[i]=…}`,
// JZ's flagship DSP shape) emits a POLYMORPHIC per-iteration store — a tag-dispatch `if`
// that re-decodes the NaN-box base and, on the array branch, reassigns `buf` (realloc),
// which marks the param unsafe so the base never hoists and the loop never vectorizes.
// The pass tests ONCE before the loop "is buf a (non-BigInt) Float64Array?": yes → a base-
// hoisted f64.load/store fast loop the lane vectorizer lifts to f64x2; no → the original
// block verbatim. Speed-only (it duplicates the loop body — a size↔speed trade, like the
// rest of vectorizeLaneLocal). These pins are the soundness contract: the fast path fires
// for Float64Array (owned + view), and EVERY other type / shape falls back bit-exact.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { onWasi } from './_matrix.js'
import { oracle } from './util.js'

const speed = { level: 'speed' }
const fProcess = (src, opt = speed) => {
  const wat = jz.compile(src, { wat: true, optimize: opt })
  const fi = wat.indexOf('(func $process')
  return wat.slice(fi, wat.indexOf('\n  (func ', fi + 10))
}

// Self-map Float64Array param: the flagship shape. The standalone (exported) $process is
// polymorphic; with the pass it grows a base-hoisted fast loop that vectorizes to f64x2.
const SELF_MAP = 'export function process(buf, n) { for (let i = 0; i < n; i++) buf[i] = buf[i] * 2.0 + 1.0 }'

// An export whose parameter is used only as a numeric array-like takes the
// typed boundary contract (`Float64Array` at entry): its loop is typed storage
// outright and vectorizes with no unswitch. The unswitch is for the
// polymorphic shape: a function also called inside the module with other kinds.
const POLY_MAP = `${SELF_MAP}
  export let runX = (x) => process(x, 4)`

test('unswitch: Float64Array param self-map gets a vectorized fast path', () => {
  ok(!/\$__utb/.test(fProcess(SELF_MAP)), 'boundary-typed export: no unswitch needed')
  ok(/v128|f64x2/.test(fProcess(SELF_MAP)), 'typed loop lifts to SIMD lanes')
  ok(/\$__utb/.test(fProcess(POLY_MAP)), 'polymorphic shape: base hoisted to a $__utb local (unswitch fired)')
  ok(/v128|f64x2/.test(fProcess(POLY_MAP)), 'fast loop lifts to SIMD lanes')
})

test('ablation: pass off → the polymorphic param loop does NOT vectorize', () => {
  const off = fProcess(POLY_MAP, { level: 'speed', unswitchTypedParamLoop: false })
  ok(!/\$__utb/.test(off), 'control: no base-hoist with pass OFF')
  ok(!/v128|f64x2/.test(off), 'control: scalar polymorphic loop with pass OFF (the deopt this pass removes)')
})

test('unswitch: the object-capable store keeps dictionary receivers in the fallback', () => {
  consistent('dictionary fallback', `${POLY_MAP}
    export function run() {
      const a = { 0: 1, 1: 2, 2: 3, 3: 4 }
      process(a, 4)
      return a[0] * 1000 + a[1] * 100 + a[2] * 10 + a[3]
    }`, 3579)
})

// Runtime bit-exactness. Export-boundary mutations don't reflect back into a JS typed
// array (interop copies), so an INTERNAL driver creates the array, calls the polymorphic
// `process`, and returns a wasm-computed checksum. The fast path (Float64Array) and every
// fallback (Int32/Uint8/Float32) must agree across speed / scalar-SIMD / opt0.
function consistent(name, src, want) {
  if (onWasi()) return  // verifies via the JS-side `.exports.run()` return value, which the WASI boundary doesn't surface
  const r = [speed, { level: 'speed', noSimd: true }, { level: 0 }].map((opt) => jz(src, { optimize: opt }).exports.run())
  ok(r.every((v) => Object.is(v, r[0])), `${name}: speed == scalar-SIMD == opt0 (${r.join(' ')})`)
  if (want !== undefined) is(r[0], want, `${name}: == ${want}`)
}
// driver: fill a[i]=i+1, run process, return digits a[0..3] as a base-10 checksum
const drive = (proc, ctor, n = 4) => `${proc}
  export let run = () => { let a = new ${ctor}(${n}); for (let i = 0; i < 4; i++) a[i] = i + 1; process(a, ${n}); return a[0]*1000 + a[1]*100 + a[2]*10 + a[3] }`

test('unswitch: Float64Array fast path is bit-exact (== scalar == opt0)', () => {
  consistent('f64 self-map', drive(SELF_MAP, 'Float64Array'), 3579) // [1,2,3,4] → 2x+1 → [3,5,7,9]
})

test('unswitch: non-f64 element types fall back bit-exact', () => {
  consistent('Int32 fallback', drive('export function process(buf,n){for(let i=0;i<n;i++) buf[i]=(buf[i]*2)|0}', 'Int32Array'), 2468)
  consistent('Uint8 fallback', drive(SELF_MAP, 'Uint8Array'), 3579)
  consistent('Float32 fallback', drive(SELF_MAP, 'Float32Array'), 3579)
})

test('unswitch: Float64Array subarray VIEW (aux=15) takes the fast path, bit-exact', () => {
  // A view's aux carries the VIEW flag (15, not the owned 7); the gate accepts both.
  const src = `${SELF_MAP}
    export let run = () => { let base = new Float64Array(8), v = base.subarray(2)
      for (let i = 0; i < 4; i++) v[i] = i + 1; process(v, 4); return v[0]*1000 + v[1]*100 + v[2]*10 + v[3] }`
  consistent('subarray view', src, 3579)
})

test('unswitch: bit-exact on zero-trip / buffer-alias / stencil / const-fill / global-read', () => {
  consistent('zero-trip (n=0)', `${SELF_MAP}
    export let run = () => { let a = new Float64Array(4); for (let i = 0; i < 4; i++) a[i] = i + 1; process(a, 0); return a[0]*1000 + a[1]*100 + a[2]*10 + a[3] }`, 1234)
  consistent('buffer-alias', `${SELF_MAP}
    export let run = () => { let b = new ArrayBuffer(32), a = new Float64Array(b), o = new Float64Array(b)
      for (let i = 0; i < 4; i++) a[i] = i + 1; process(a, 4); return o[0]*1000 + o[1]*100 + o[2]*10 + o[3] }`, 3579)
  // loop-carried dependence: the vectorizer must keep it scalar — bit-exact either way
  consistent('stencil buf[i]=buf[i-1]+1', `export function process(buf,n){for(let i=1;i<n;i++) buf[i]=buf[i-1]+1.0}
    export let run = () => { let a = new Float64Array(5); a[0] = 10; process(a, 5); return a[1]*1000 + a[2]*100 + a[3]*10 + a[4] }`, 12344)
  // const-fill (no buf read) and global-read map (value reads a different array): the
  // store-keyed match covers both, not just self-maps.
  consistent('const-fill buf[i]=7', `export function process(buf,n){for(let i=0;i<n;i++) buf[i]=7.0}
    export let run = () => { let a = new Float64Array(4); process(a, 4); return a[0]*1000 + a[1]*100 + a[2]*10 + a[3] }`, 7777)
  consistent('global-read buf[i]=g[i]*2', `let g = new Float64Array(4); export function process(buf,n){for(let i=0;i<n;i++) buf[i]=g[i]*2.0}
    export let run = () => { for (let i = 0; i < 4; i++) g[i] = i + 1; let a = new Float64Array(4); process(a, 4); return a[0]*1000 + a[1]*100 + a[2]*10 + a[3] }`, 2468)
})

test('unswitch: param reassigned in the loop → guard bails, stays bit-exact', () => {
  // `buf = o` inside the loop makes the hoisted base stale; the reassign guard must bail.
  consistent('reassign buf', `export function process(buf,n){ let o = new Float64Array(4); for (let i = 0; i < n; i++) { buf[i] = buf[i]*2.0; buf = o } return buf[0] }
    export let run = () => { let a = new Float64Array(4); for (let i = 0; i < 4; i++) a[i] = i + 1; process(a, 1); return a[0]*1000 + a[1]*100 }`, 2200)
})

test('unswitch: local typed widths preserve bounds, rounding and assignment values', () => {
  const src = `export function f(which, n, view) {
    const storage = which === 0 ? new Float32Array(8) : which === 1 ? new Float64Array(8) : new Uint8Array(8)
    storage[0] = 17; storage[7] = 19
    const a = view ? storage.subarray(2, 6) : storage
    let sum = 0
    for (let i = -1; i < n; i++) sum += (a[i] = i * 0.1)
    return [sum, a[0], a[3], a[7], a[8], storage[0], storage[7]]
  }`
  const wat = jz.compile(src, { wat: true, optimize: speed })
  ok(wat.includes('$__utw'), 'stable local receiver gets width versions')
  ok(wat.includes('f32.store') && wat.includes('f64.store'), 'both floating widths have direct stores')
  const js = oracle(src).f
  for (const optimize of [speed, { level: 'speed', unswitchTypedParamLoop: false }, 0]) {
    const { f } = jz(src, { optimize }).exports
    for (const which of [0, 1, 2]) for (const view of [false, true]) for (const n of [-1, 0, 4, 8, 9]) {
      const expected = js(which, n, view)
      is(f(which, n, view), expected, `${which}/${view}/${n}: bounds and f32 rounding`)
      is(f(which, n, view), expected, 'same instance, repeated call')
    }
  }
})

test('unswitch: typed store value effects run once before the bounds check', () => {
  const src = `export function f(which, n) {
    const a = which ? new Float32Array(2) : new Float64Array(2)
    let calls = 0, j = 0, sum = 0
    for (let i = 0; i < n; i++) sum += (a[j] = (++calls, j++, 0.1))
    return [sum, calls, j, a[0], a[1]]
  }`
  const js = oracle(src).f
  const { f } = jz(src, { optimize: speed }).exports
  for (const which of [true, false]) for (const n of [0, 1, 2, 5])
    is(f(which, n), js(which, n), 'index is captured before the RHS changes it, including OOB writes')
})

test('unswitch: coercing values and changing receivers retain their fallback', () => {
  const src = `export function f(which) {
    let a = which ? new Float32Array(2) : new Float64Array(2)
    const b = new Float64Array(2)
    for (let i = 0; i < 2; i++) { a[i] = 0.1; a = b }
    return [a[0], a[1]]
  }`
  ok(!jz.compile(src, { wat: true, optimize: speed }).includes('$__utw'), 'reassigned local has no width version')
  const { f } = jz(src, { optimize: speed }).exports
  for (const which of [true, false]) is(f(which), oracle(src).f(which))
  consistent('coercion hooks', `export function run() {
    let calls = 0
    const a = new Float32Array(2), b = new Float64Array(2)
    const rows = [a, b]
    for (let c = 0; c < 2; c++) { const row = rows[c]
      for (let i = 0; i < 3; i++) row[i] = { valueOf() { calls++; return 7 } }
    }
    return calls * 100 + a[0] + b[0]
  }`, 614)
})

test('unswitch: empty storage, special numbers and BigInt fallbacks', () => {
  const src = `export function f(which, n, empty) {
    const a = which === 0 ? new Float32Array(empty ? 0 : 4)
      : which === 1 ? new Float64Array(empty ? 0 : 4) : new BigInt64Array(4)
    try {
      for (let i = 0; i < n; i++) a[i] = i === 0 ? -0 : i === 1 ? NaN : i === 2 ? Infinity : -Infinity
    } catch (e) { return e.name }
    return [a[0], a[1], a[2], a[3]]
  }`
  const js = oracle(src).f, { f } = jz(src, { optimize: speed }).exports
  for (const which of [0, 1, 2]) for (const n of [0, 1, 4, 5]) for (const empty of [false, true])
    is(f(which, n, empty), js(which, n, empty), 'zero work, signed zero, NaN, infinities and mismatched BigInt store')
})

test('unswitch: absent numeric reads store NaN but retain the assignment result', () => {
  const src = `export function f(which, n) {
    const a = which ? new Float32Array(4) : new Float64Array(4)
    const b = [1]
    let result = 0
    for (let i = 0; i < n; i++) result = (a[i] = b[i])
    return [result, a[0], a[1], Number.isNaN(a[1]), a[1] === undefined]
  }`
  const js = oracle(src).f
  for (const optimize of [speed, { level: 'speed', unswitchTypedParamLoop: false }, 0]) {
    const { f } = jz(src, { optimize }).exports
    for (const which of [false, true]) for (const n of [0, 1, 4, 5])
      is(f(which, n), js(which, n), 'missing source stays undefined as a value, becomes NaN in floating storage')
  }
})

test('unswitch: polymorphic parameter stores require a numeric value proof', () => {
  for (const value of ['"3"', 'null', 'true', 'undefined']) {
    const src = `export function process(buf,n) { for(let i=0;i<n;i++) buf[i]=${value}; return buf }
      export const runX = x => process(x,4)`
    const js = oracle(src).runX
    for (const unswitchTypedParamLoop of [true, false]) {
      const { runX } = jz(src, { optimize: { level: 'speed', unswitchTypedParamLoop } }).exports
      is(Array.from(runX(new Float64Array(4))), Array.from(js(new Float64Array(4))), value + ': storage uses ToNumber')
    }
  }
})

test('unswitch: polymorphic view loops resolve data and require the whole trip range in bounds', () => {
  const src = `export function process(buf,start,n) {
    for (let i=start;i<n;i++) buf[i]=buf[i]*2+1
  }
  export const runX = x => process(x,0,4)
  export function f(start,n,view) {
    const b = new Float64Array(8)
    for(let i=0;i<8;i++) b[i]=i+1
    process(view ? b.subarray(2,4) : b,start,n)
    return b
  }`
  const js = oracle(src).f
  for (const unswitchTypedParamLoop of [true, false]) {
    const optimize = { level: 'speed', unswitchTypedParamLoop }
    const { f } = jz(src, { optimize }).exports
    for (const view of [false,true]) for (const start of [-1,0,1]) for (const n of [0,2,4,8,10]) {
      const expected = Array.from(js(start,n,view))
      is(Array.from(f(start,n,view)), expected, `${view}/${start}/${n}: writes stay within the receiver`)
      is(Array.from(f(start,n,view)), expected, 'repeated call preserves adjacent parent elements')
    }
  }
})

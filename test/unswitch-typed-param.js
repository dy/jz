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

const speed = { level: 'speed' }
const fProcess = (src, opt = speed) => {
  const wat = jz.compile(src, { wat: true, optimize: opt })
  const fi = wat.indexOf('(func $process')
  return wat.slice(fi, wat.indexOf('\n  (func ', fi + 10))
}

// Self-map Float64Array param: the flagship shape. The standalone (exported) $process is
// polymorphic; with the pass it grows a base-hoisted fast loop that vectorizes to f64x2.
const SELF_MAP = 'export function process(buf, n) { for (let i = 0; i < n; i++) buf[i] = buf[i] * 2.0 + 1.0 }'

test('unswitch: Float64Array param self-map gets a vectorized fast path', () => {
  ok(/\$__utb/.test(fProcess(SELF_MAP)), 'base hoisted to a $__utb local (unswitch fired)')
  ok(/v128|f64x2/.test(fProcess(SELF_MAP)), 'fast loop lifts to SIMD lanes')
})

test('ablation: pass off → the polymorphic param loop does NOT vectorize', () => {
  const off = fProcess(SELF_MAP, { level: 'speed', unswitchTypedParamLoop: false })
  ok(!/\$__utb/.test(off), 'control: no base-hoist with pass OFF')
  ok(!/v128|f64x2/.test(off), 'control: scalar polymorphic loop with pass OFF (the deopt this pass removes)')
})

// Runtime bit-exactness. Export-boundary mutations don't reflect back into a JS typed
// array (interop copies), so an INTERNAL driver creates the array, calls the polymorphic
// `process`, and returns a wasm-computed checksum. The fast path (Float64Array) and every
// fallback (Int32/Uint8/Float32) must agree across speed / scalar-SIMD / opt0.
function consistent(name, src, want) {
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

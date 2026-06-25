import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { belowOpt, onKernel } from './_matrix.js'
import jz, { compile } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function run(code) {
  return jz(code).exports
}

const SIMD_OPT = { optimize: { vectorizeLaneLocal: true, watr: true } }
// Same pipeline with vectorization OFF — the scalar oracle for SIMD correctness checks.
const NOVEC = { optimize: { vectorizeLaneLocal: false, watr: true } }
const runVec = (code, opts) => jz(code, opts).exports
const wat = (code, opts) => compile(code, { ...opts, wat: true })
const hasV128 = (w) =>
  /v128\.load|v128\.store|i32x4\.|i64x2\.|f32x4\.|f64x2\.|v128\.(and|or|xor)/.test(w)

// === Array.from ===

test('Array.from - shallow copy', () => {
  is(run('export let main = () => { let a = [1,2,3]; let b = Array.from(a); return b[0]+b[1]+b[2] }').main(), 6)
})

test('Array.from - independent copy', () => {
  is(run('export let main = () => { let a = [1,2,3]; let b = Array.from(a); b[0] = 99; return a[0] }').main(), 1)
})

test('Array.from - length preserved', () => {
  is(run('export let main = () => { let a = [10,20,30,40]; return Array.from(a).length }').main(), 4)
})

// === SIMD Float64Array (f64x2 — 2 elements per vector) ===

test('SIMD f64x2 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0] + r[3] + r[7]
  }`).main(), 26) // 2+8+16
})

test('SIMD f64x2 - map add', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x + 10)
    return r[0] + r[3]
  }`).main(), 25) // 11+14
})

test('SIMD f64x2 - map divide', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=2; buf[1]=4; buf[2]=6; buf[3]=8
    let r = buf.map(x => x / 2)
    return r[0] + r[1] + r[2] + r[3]
  }`).main(), 10)
})

test('SIMD f64x2 - odd length (remainder)', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(5)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5
    let r = buf.map(x => x * 3)
    return r[4]
  }`).main(), 15)
})

// Self-host parity: jz.wasm miscompiled deep property reads of an ARG-passed object (the lift
// chain's `ctx` — NaN-box schema corrupted across arg boundaries at call-depth 2-3), so
// getOrAllocLanedLocal read back a wrong slot and EVERY map lift silently scalarized in the
// self-hosted compiler. Fixed by threading ctx via a module-global (_liftCtx in vectorize.js).
// NO onKernel guard — this (and the un-guarded shape checks throughout) runs on the kernel leg,
// pinning that the self-host kernel vectorizes IDENTICALLY to in-process.
test('self-host parity: the lane vectorizer runs in the jz.wasm kernel', () => {
  const SRC = `export let run = () => {
    let a = new Float64Array(64), o = new Float64Array(64)
    for (let i = 0; i < 64; i = i + 1) a[i] = i * 0.5
    for (let i = 0; i < 64; i = i + 1) o[i] = a[i] * 2.0 + 1.0
    let s = 0.0; for (let i = 0; i < 64; i = i + 1) s = s + o[i]; return s }`
  ok((wat(SRC, SIMD_OPT).match(/f64x2/g) || []).length >= 4, 'map loop lifts to f64x2 (in-process AND kernel)')
  is(runVec(SRC, SIMD_OPT).run(), 2080, 'bit-exact result')
})

// === SIMD breadth matrix — pins generic DSP patterns against regression ===
// These are GENERIC shapes (not the specific kernels the recognizers were written
// for); each must keep vectorizing. A regression here means a vectorizer change
// narrowed coverage. SPEED enables relaxedSimd (f32 arithmetic precision).
test('SIMD breadth - generic f32/int DSP patterns stay vectorized', () => {
  if (onKernel()) return
  const cases = {
    'f32 gain':            `export let f=(n,k)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*k;return o}`,
    'f32 mix a*x+b*y':     `export let f=(n,x,y)=>{let a=new Float32Array(n);let b=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*x+b[i]*y;return o}`,
    'f32 clamp (nested ?)':`export let f=(n)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++){let v=a[i];o[i]=v>1?1:(v<-1?-1:v)}return o}`,
    'f32 clamp (Math.min/max)':`export let f=(n)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=Math.min(1,Math.max(-1,a[i]));return o}`,
    'f32 abs via cond':    `export let f=(n)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++){let v=a[i];o[i]=v<0?0-v:v}return o}`,
    'f32 sqrt':            `export let f=(n)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=Math.sqrt(a[i]);return o}`,
    'f32 Math.abs':        `export let f=(n)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=Math.abs(a[i]);return o}`,
    'f32 FMA a*b+c':       `export let f=(n)=>{let a=new Float32Array(n);let b=new Float32Array(n);let c=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*b[i]+c[i];return o}`,
    'f32 Horner poly':     `export let f=(n,c0,c1,c2)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++){let x=a[i];o[i]=c0+x*(c1+x*c2)}return o}`,
    'f32 dot reduction':   `export let f=(n)=>{let a=new Float32Array(n);let b=new Float32Array(n);let s=0;for(let i=0;i<n;i++)s+=a[i]*b[i];return s}`,
    'f32 RMS reduction':   `export let f=(n)=>{let a=new Float32Array(n);let s=0;for(let i=0;i<n;i++)s+=a[i]*a[i];return s}`,
    'i32 bitwise & const': `export let f=(n)=>{let a=new Int32Array(n);let o=new Int32Array(n);for(let i=0;i<n;i++)o[i]=(a[i]&255)>>1;return o}`,
    'i32 add arrays':      `export let f=(n)=>{let a=new Int32Array(n);let b=new Int32Array(n);let o=new Int32Array(n);for(let i=0;i<n;i++)o[i]=a[i]+b[i];return o}`,
    'i32 mask by param':   `export let f=(n,m)=>{let a=new Int32Array(n);let o=new Int32Array(n);for(let i=0;i<n;i++)o[i]=a[i]&m;return o}`,
    'f32 scale by 1/param':`export let f=(n,k)=>{let a=new Float32Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*(1/k);return o}`,
    'f32 FIR stencil':     `export let f=(n,b0,b1)=>{let x=new Float32Array(n);let o=new Float32Array(n);for(let i=1;i<n;i++)o[i]=b0*x[i]+b1*x[i-1];return o}`,
    'f32 sum (widening)':  `export let f=(n)=>{let a=new Float32Array(n);let s=0;for(let i=0;i<n;i++)s+=a[i];return s}`,
    'u8 normalize':        `export let f=(n)=>{let a=new Uint8Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*0.5;return o}`,
    'i16 normalize':       `export let f=(n)=>{let a=new Int16Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*0.5;return o}`,
    'f64→f32 narrow':      `export let f=(n,k)=>{let a=new Float64Array(n);let o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*k;return o}`,
    'f32→i16 encode':      `export let f=(n)=>{let a=new Float32Array(n);let o=new Int16Array(n);for(let i=0;i<n;i++)o[i]=a[i]*32767;return o}`,
    'f32→i8 narrow':       `export let f=(n)=>{let a=new Float32Array(n);let o=new Int8Array(n);for(let i=0;i<n;i++)o[i]=a[i]*127;return o}`,
    'f64 still vectorizes':`export let f=(n,k)=>{let a=new Float64Array(n);let o=new Float64Array(n);for(let i=0;i<n;i++)o[i]=a[i]*k;return o}`,
  }
  for (const [name, src] of Object.entries(cases)) ok(hasV128(wat(src, SPEED)), `${name} vectorizes`)
})

test('SIMD narrowing - encode/downsample bit-identical to scalar (incl. clipping)', () => {
  // f32→i16 encode must WRAP exactly like scalar Int16Array store, even past ±1
  // (the SIMD packs low bytes via shuffle, never saturates). Compare O3 SIMD to O2 scalar.
  const enc = `export let f = (n) => { let a = new Float32Array(n); for (let i=0;i<n;i++) a[i] = Math.sin(i)*1.5; let o = new Int16Array(n); for (let i=0;i<n;i++) o[i] = a[i]*32767; let s=0; for (let i=0;i<n;i++) s += o[i]; return s }`
  is(jz(enc, { optimize: 'speed' }).exports.f(64), jz(enc, { optimize: 2 }).exports.f(64))
  // f64→f32 downsample is a plain demote — bit-exact at any level.
  const ds = `export let f = (n) => { let a = new Float64Array(n); for (let i=0;i<n;i++) a[i] = i*0.1; let o = new Float32Array(n); for (let i=0;i<n;i++) o[i] = a[i]*0.5; let s=0; for (let i=0;i<n;i++) s += o[i]; return s }`
  is(jz(ds, { optimize: 'speed' }).exports.f(40), jz(ds, { optimize: 2 }).exports.f(40))
})

// === SIMD Float32Array (f32x4 — 4 elements per vector) ===

test('SIMD f32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Float32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 72) // 2+4+6+8+10+12+14+16
})

test('SIMD f32x4 - map with remainder', () => {
  is(run(`export let main = () => {
    let buf = new Float32Array(6)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6
    let r = buf.map(x => x + 10)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]
  }`).main(), 81) // 11+12+13+14+15+16
})

// f32 arithmetic loops: jz computes Float32Array math in f64 (promote→f64 op→
// demote). Lifting to f32x4 drops the f64 intermediate to f32 (sub-ulp, inaudible
// for audio/DSP) — NOT bit-exact, so gated on relaxedSimd (speed). A pure copy has
// no arithmetic; promote(load)+demote round-trips losslessly → vectorizes always.

test('SIMD f32x4 - contiguous scale vectorizes at speed, scalar below it', () => {
  const src = `export let s = (n, k) => { let a = new Float32Array(n); let o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * k; return o }`
  ok(/f32x4\.mul/.test(wat(src, SPEED)), 'f32 scale → f32x4.mul under relaxedSimd (speed)')
  ok(!/f32x4\.mul/.test(wat(src, SIMD_OPT)), 'f32 scale stays scalar without relaxedSimd (bit-exact default)')
})

test('SIMD f32x4 - pure copy vectorizes bit-exactly without relaxedSimd', () => {
  const src = `export let c = (n) => { let a = new Float32Array(n); let o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i]; return o }`
  ok(hasV128(wat(src, SIMD_OPT)), 'f32 copy lifts to v128 (promote/demote round-trip is lossless)')
})

test('SIMD f32x4 - conditional (ternary/select) vectorizes + correct', () => {
  // `v < 0 ? a : b` lowers to a `select` (cheap arms) or `if`; both lift to
  // v128.bitselect. The f64 comparison maps to f32x4 (operands are exact promotions).
  const src = `export let f = (n) => { let a = new Float32Array(n); let o = new Float32Array(n); for (let i = 0; i < n; i++) { let v = a[i]; o[i] = v < 0 ? v * 0.5 : v * 0.25 } return o }`
  ok(/v128\.bitselect/.test(wat(src, SPEED)), 'f32 conditional → bitselect at speed')
  is(jz(`export let m = () => {
    let a = new Float32Array(4); a[0]=-2; a[1]=4; a[2]=-8; a[3]=16
    let o = new Float32Array(4); for (let i=0;i<4;i++){ let v=a[i]; o[i]= v<0 ? v*0.5 : v*0.25 }
    return o[0]*1000 + o[1]*100 + o[2]*10 + o[3]
  }`, { optimize: 'speed' }).exports.m(), (-1)*1000 + 1*100 + (-4)*10 + 4) // -1,1,-4,4
})

test('SIMD f64x2 - general conditional select vectorizes (bit-exact)', () => {
  // relu `v>0?v:0` — a general value-select, lifts to bitselect with no precision
  // change (f64 lane needs no relaxedSimd).
  const src = `export let f = (n) => { let a = new Float64Array(n); let o = new Float64Array(n); for (let i = 0; i < n; i++) { let v = a[i]; o[i] = v > 0 ? v : 0 } return o }`
  ok(hasV128(wat(src, SIMD_OPT)), 'f64 relu conditional vectorizes (no relaxedSimd needed)')
})

test('SIMD f32x4 - scaled result correct at speed', () => {
  is(jz(`export let m = () => {
    let a = new Float32Array(8)
    for (let i = 0; i < 8; i++) a[i] = i + 1
    let o = new Float32Array(8)
    for (let i = 0; i < 8; i++) o[i] = a[i] * 2
    let s = 0; for (let i = 0; i < 8; i++) s += o[i]
    return s
  }`, { optimize: 'speed' }).exports.m(), 72) // 2*(1+2+…+8)
})

test('SIMD - int→f32 widening map (Int16Array → Float32Array normalize)', () => {
  // `o[i] = i16[i] * k` — decode/normalize. Widen: load 4 i16, extend to i32x4,
  // f32x4.convert, f32x4.mul. i8/i16/u8 are exact in f32 → bit-identical to scalar.
  const src = `export let f = (n) => { let s = new Int16Array(n); let o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = s[i] * 0.5; return o }`
  const w = wat(src, SPEED)
  ok(/f32x4\.convert_i32x4_s/.test(w) && /extend_low_i16x8_s/.test(w), 'i16→f32 widening chain')
  // correctness: i16 values exact in f32, *0.5 exact → identical to scalar
  is(jz(`export let m = () => {
    let s = new Int16Array(8); for (let i=0;i<8;i++) s[i] = (i-4) * 1000
    let o = new Float32Array(8); for (let i=0;i<8;i++) o[i] = s[i] * 0.5
    let t = 0; for (let i=0;i<8;i++) t += o[i]
    return t
  }`, { optimize: 'speed' }).exports.m(), -2000) // sum((i-4)*1000*0.5), i=0..7 = -2000
})

test('SIMD - f32 reduction widens to f64x2 accumulate, bit-identical', () => {
  // `s += f32arr[i]` accumulates in f64; vectorize as f64x2 over promote_low_f32x4
  // (2 f32 per chunk). Single-accumulator (half-width loads don't fit multi-acc).
  const src = `export let f = (n) => { let a = new Float32Array(n); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }`
  ok(/f64x2\.add/.test(wat(src, SPEED)) && /promote_low_f32x4/.test(wat(src, SPEED)), 'f32 sum → f64x2 widening reduction')
  // sum 1..16 over a Float32Array == 136, exact in f64 accumulation
  is(jz(`export let m = () => { let a = new Float32Array(16); for (let i=0;i<16;i++) a[i]=i+1; let s=0; for (let i=0;i<16;i++) s+=a[i]; return s }`, { optimize: 'speed' }).exports.m(), 136)
})

// === SIMD Int32Array (i32x4 — 4 elements per vector) ===

test('SIMD i32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 3)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 108)
})

test('SIMD i32x4 - map add', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=10; buf[1]=20; buf[2]=30; buf[3]=40
    let r = buf.map(x => x + 5)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 120)
})

// === SIMD ramp-map (out[i] = f(i), induction var as DATA) — tryRampMap ===
// No input load: the IV becomes an i32x4 ramp [i, i+1, i+2, i+3]. SIMD result is
// checked bit-for-bit against the scalar (NOVEC) oracle.

test('SIMD ramp-map - u8 bytebeat-shaped store (16-wide pack)', () => {
  const src = `export let main = () => {
    const out = new Uint8Array(1024)
    for (let i = 0; i < 1024; i++) out[i] = (i * 5 & i >> 3 | i * 3) & 255
    let h = 0
    for (let i = 0; i < 1024; i++) h = (h + out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  // i8 ramp stores take the 16-wide path: 4 offset ramps packed into ONE
  // i8x16 v128.store (three shuffles), not the 4-wide narrowing i32.store.
  const w = wat(src, SIMD_OPT)
  ok(/v128\.store/.test(w), 'expected 16-wide packed v128.store')
  ok((w.match(/i8x16\.shuffle/g) || []).length >= 3, 'expected 3-shuffle 16-lane pack')
})

test('SIMD ramp-map - u8 narrowing is truncation-exact (values > 255)', () => {
  // i32.store8 keeps each lane's low byte; the i8x16.shuffle pack must truncate
  // identically (never saturate). Values reach 6993 here, well past a byte.
  const src = `export let main = () => {
    const out = new Uint8Array(1000)
    for (let i = 0; i < 1000; i++) out[i] = (i * 7) | 0
    let h = 0
    for (let i = 0; i < 1000; i++) h = (h + out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops')
})

test('SIMD ramp-map - i32 full-width store', () => {
  const src = `export let main = () => {
    const out = new Int32Array(512)
    for (let i = 0; i < 512; i++) out[i] = (i * i + (i << 1)) | 0
    let h = 0
    for (let i = 0; i < 512; i++) h = (h ^ out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops')
})

test('SIMD ramp-map - tail (length not a multiple of 4) stays correct', () => {
  const src = `export let main = () => {
    const out = new Uint8Array(1003)
    for (let i = 0; i < 1003; i++) out[i] = (i * 9) & 255
    let h = 0
    for (let i = 0; i < 1003; i++) h = (h + out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops')
})

// === SIMD widening byte-map (out[i] = narrow(f_i32(widen(u8 loads)))) ===
// u8 loads feeding i32 arithmetic that overflows a byte — tryVectorize can't
// (no i8x16.mul; shifts excluded on narrow lanes). The widening path loads the
// 4 elements as a partial vector and zero-extends to i32x4. Checked against the
// scalar (NOVEC) oracle.

test('SIMD widening byte-map - alpha blend (mul exceeds byte)', () => {
  const src = `export let main = () => {
    const a = new Uint8Array(2048), b = new Uint8Array(2048), out = new Uint8Array(2048)
    for (let i = 0; i < 2048; i++) { a[i] = (i * 7) & 255; b[i] = (i * 13) & 255 }
    for (let i = 0; i < 2048; i++) out[i] = (Math.imul(a[i], 160) + Math.imul(b[i], 95) + 127) >> 8
    let h = 0
    for (let i = 0; i < 2048; i++) h = (h + out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  const w = wat(src, SIMD_OPT)
  // Goes 16-wide in i16x8 (the alpha-blend shape: every intermediate fits u16 —
  // 255*160+255*95+127 = 65152 < 65536 — and the result fits a byte): v128.load 16,
  // extend_low/high, i16x8 arithmetic, narrow_u, v128.store. (clang's NEON, bit-exact.)
  ok(/i16x8\.mul/.test(w) && /i8x16\.narrow_i16x8_u/.test(w) && /v128\.load\b/.test(w), 'expected 16-wide i16x8 widening map')

  // When an intermediate would exceed u16, the 16-wide path is unsound — it must fall
  // back to the bit-exact 4-wide (i32x4) widening map. `*200 + *200` peaks at
  // 255*200+255*200 = 102000 > 65535, so i16x8 would wrap.
  const wide = `export let main = () => {
    const a = new Uint8Array(2048), b = new Uint8Array(2048), out = new Uint8Array(2048)
    for (let i = 0; i < 2048; i++) { a[i] = (i * 7) & 255; b[i] = (i * 13) & 255 }
    for (let i = 0; i < 2048; i++) out[i] = (Math.imul(a[i], 200) + Math.imul(b[i], 200)) >> 8 & 255
    let h = 0; for (let i = 0; i < 2048; i++) h = (h + out[i]) | 0; return h
  }`
  is(runVec(wide, SIMD_OPT).main(), runVec(wide, NOVEC).main(), 'u16-overflow map stays bit-exact')
  ok(!/i16x8\.mul/.test(wat(wide, SIMD_OPT)), 'u16-overflow map must NOT take the i16x8 path')
})

test('SIMD channel-reduce - RGBA box-filter accumulation', () => {
  // 4 adjacent-byte accumulators summed over a window → i32x4 (integer-exact),
  // extracted back; the edge clamp + divide stay scalar. Checked vs NOVEC.
  const src = `export let main = () => {
    const src = new Uint8Array(256), dst = new Uint8Array(256)
    for (let i = 0; i < 256; i++) src[i] = (i * 7) & 255
    for (let x = 0; x < 64; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let k = -2; k <= 2; k++) {
        let xi = x + k
        if (xi < 0) xi = 0; else if (xi >= 64) xi = 63
        const p = xi << 2
        sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3]
      }
      const o = x << 2
      dst[o] = (sr / 5) | 0; dst[o + 1] = (sg / 5) | 0; dst[o + 2] = (sb / 5) | 0; dst[o + 3] = (sa / 5) | 0
    }
    let h = 0
    for (let i = 0; i < 256; i++) h = (h + dst[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  const w = wat(src, SIMD_OPT)
  ok(/v128\.load32_zero/.test(w) && /i32x4\.add/.test(w), 'expected widening channel accumulation')
})

test('SIMD channel-reduce - real 2D box blur (row loop nesting)', () => {
  // The actual separable-blur shape: an outer row loop wraps the pixel loop, so
  // LICM hoists the invariant edge bound (w-1) into the pixel-loop block ahead of
  // the loop. The channel recognizer must tolerate that preamble (it previously
  // bailed, so the vectorizer never fired on a real 2D blur — only the 1D test).
  const src = `export let main = () => {
    const src = new Uint8Array(64 * 48 * 4), dst = new Uint8Array(64 * 48 * 4)
    for (let i = 0; i < 64 * 48 * 4; i++) src[i] = (i * 7) & 255
    const w = 64, h = 48, r = 2, win = 2 * r + 1
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0
        for (let k = -r; k <= r; k++) {
          let xi = x + k
          if (xi < 0) xi = 0; else if (xi >= w) xi = w - 1
          const p = (row + xi) << 2
          sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3]
        }
        const o = (row + x) << 2
        dst[o] = (sr / win) | 0; dst[o + 1] = (sg / win) | 0; dst[o + 2] = (sb / win) | 0; dst[o + 3] = (sa / win) | 0
      }
    }
    let acc = 0
    for (let i = 0; i < 64 * 48 * 4; i++) acc = (acc + dst[i]) | 0
    return acc
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/v128\.load32_zero/.test(wat(src, SIMD_OPT)), 'channel-reduce must fire through the hoisted preamble')
})

test('SIMD widening byte-map - store8 truncation matches (value > 255)', () => {
  // i32 product reaches 76500; the store8 keeps the low byte. The narrow pack
  // must truncate identically, not saturate.
  const src = `export let main = () => {
    const a = new Uint8Array(1000), out = new Uint8Array(1000)
    for (let i = 0; i < 1000; i++) a[i] = (i * 11) & 255
    for (let i = 0; i < 1000; i++) out[i] = Math.imul(a[i], 300)
    let h = 0
    for (let i = 0; i < 1000; i++) h = (h ^ out[i]) | 0
    return h
  }`
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 widening ops')
})

test('SIMD i32x4 - bitwise AND', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=255; buf[1]=170; buf[2]=85; buf[3]=65280
    let r = buf.map(x => x & 240)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 480)
})

test('SIMD i32x4 - shift left', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x << 2)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 40)
})

test('SIMD i32x4 - with remainder', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(6)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6
    let r = buf.map(x => x * 10)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]
  }`).main(), 210)
})

// === SIMD Uint32Array ===

test('SIMD u32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Uint32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 72)
})

// === Mixed-lane log-tonemap (tryToneMap) ===
//
// The fern/bifurcation/attractors tail: i32 dens[i] → f64 log → i32 pack → px[i], an i32 loop with an
// f64 island. Lifts 2-wide (load64_zero → i32x4 low, convert_low → f64x2, log_v, clamp, trunc_sat_zero,
// pack, masked i64.store). Must be BIT-EXACT vs the scalar oracle — incl. the odd-width scalar tail,
// the clamp saturation (log·S > 255), and the v==0 lanes (both the conditional-value and if-store forms).

// (a) conditional VALUE form (attractors-shaped): `g=0; if(v>0) g=trunc(min(log(v+1)·S,255)); px=pack(g)`
const TONE_VALUE = (n) => `
  let dens = new Uint32Array(${n}), px = new Uint32Array(${n})
  export let main = () => {
    let i = 0
    while (i < ${n}) { dens[i] = (i * 53) % 600; i++ }   // 0..599 — some saturate the 255 clamp, some 0
    i = 0
    while (i < ${n}) {
      let v = dens[i], g = 0
      if (v > 0) { let L = Math.log(v + 1.0) * 44.0; g = (L > 255.0 ? 255.0 : L) | 0 }
      px[i] = (255 << 24) | (g << 16) | (g << 8) | g
      i++
    }
    let s = 0; i = 0; while (i < ${n}) { s = (s + px[i]) | 0; i++ }
    return s
  }`

// (b) conditional STORE form (bifurcation/fern-shaped): if(v>0) px=pack(...) else px=bg
const TONE_STORE = (n) => `
  let dens = new Uint32Array(${n}), px = new Uint32Array(${n})
  export let main = () => {
    let i = 0
    while (i < ${n}) { dens[i] = (i * 53) % 600; i++ }
    i = 0
    while (i < ${n}) {
      let v = dens[i]
      if (v > 0) { let L = Math.log(v + 1.0) * 44.0; if (L > 255.0) L = 255.0; let g = L | 0; px[i] = (255 << 24) | (g << 16) | (g << 8) | g }
      else { px[i] = (255 << 24) }
      i++
    }
    let s = 0; i = 0; while (i < ${n}) { s = (s + px[i]) | 0; i++ }
    return s
  }`

// optimize:'speed' (not SIMD_OPT) so SIMD_PROTECTED keeps Math.log un-inlined → the f64x2 mirror fires
// (as in the real examples); plain SIMD_OPT inlines the log poly and the tonemap shape never forms.
const SPEED = { optimize: 'speed' }, SPEED_SCALAR = { optimize: 'speed', noSimd: true }
for (const [label, mk] of [['value-form', TONE_VALUE], ['store-form', TONE_STORE]]) {
  test(`SIMD tonemap ${label} - vectorizes mixed-lane and is bit-exact (even + odd width)`, () => {
    const w64 = wat(mk(64), SPEED)
    ok(/f64x2\.convert_low_i32x4/.test(w64), `tonemap ${label} lifts the i32→f64 island (convert_low_i32x4)`)
    ok(/call \$math\.log_v/.test(w64), `tonemap ${label} lifts Math.log → $math.log_v`)
    for (const n of [64, 63, 1, 2, 3]) {   // even, odd tail, and the smallest widths
      const simd = runVec(mk(n), SPEED).main()
      const scal = runVec(mk(n), SPEED_SCALAR).main()
      is(simd, scal, `tonemap ${label} n=${n}: SIMD checksum === scalar`)
    }
  })
}

// Per-pixel-color HAZARD (domain-color): a guarded conditional assignment `let fx=0; if(cond){fx=…}`
// whose target later feeds a transcendental mirror (hypot/atan2). `fx=0` lifts to an f64x2 lane
// local, but the statement-form `if` lands in the SCALAR epilogue — so the lifted `hypot(fx,…)`,
// emitted BEFORE the epilogue, read the stale splat(0) and the SIMD frame went ALL-ZERO while the
// scalar one was correct (domain-color rendered solid black). tryPerPixelColor now bails to scalar
// when a lane local is re-written in the epilogue AND consumed by another lane. Mirrors the exact
// four-Math field (hypot+atan2+|sin|) over domain-color's nested pixel-loop shape.
const COMPLEX_FIELD = (d, guarded) => `
  let W = ${d}, H = ${d}, px = new Uint32Array(${d * d})
  export let main = () => {
    let invW = 1.0/W, invH = 1.0/H, aspect = W*invH, j = 0, py = 0
    while (py < H) {
      let zy = (0.5 - py*invH) * 2.0
      let qx = 0
      while (qx < W) {
        let zx = (qx*invW - 0.5) * 2.0 * aspect
        let dr = zx*zx - zy*zy + 1.0, di = 2.0*zx*zy
        let denom = dr*dr + di*di${guarded ? '' : ' + 1e-300'}
        ${guarded
          ? 'let fx = 0.0, fy = 0.0\n        if (denom > 1e-18) { fx = (zx*dr)/denom; fy = (zy*di)/denom }'
          : 'let fx = (zx*dr)/denom, fy = (zy*di)/denom'}
        let mag = Math.hypot(fx, fy), arg = Math.atan2(fy, fx)
        let v = mag/(mag+1.0)
        let g = (v * (0.55 + 0.45*Math.abs(Math.sin(2.0*arg))) * 255.0) | 0
        px[j] = (255 << 24) | (g << 16) | (g << 8) | g
        j++; qx++
      }
      py++
    }
    let s = 0, i = 0; while (i < ${d * d}) { s = (s + (px[i] & 255)) | 0; i++ }
    return s
  }`
test('SIMD per-pixel-color - guarded assign into a transcendental stays bit-exact (domain-color)', () => {
  // Positive control: the UNCONDITIONAL field really is a per-pixel-color candidate — it lifts to
  // f64x2 through the hypot/atan2 mirrors. So the guarded variant below genuinely hits the hazard
  // path (not a loop the vectorizer ignores), and the bail — not luck — is what keeps it correct.
  const wu = wat(COMPLEX_FIELD(8, false), SPEED)
  ok(/\$__ppc/.test(wu), 'unconditional field takes the per-pixel-color path')
  ok(/\$math\.hypot_2/.test(wu) && /\$math\.atan2_2/.test(wu), 'unconditional field lifts hypot/atan2 mirrors')
  for (const d of [8, 7, 3]) {     // even, odd-width tail, tiny
    is(runVec(COMPLEX_FIELD(d, false), SPEED).main(), runVec(COMPLEX_FIELD(d, false), SPEED_SCALAR).main(), `unconditional d=${d}: SIMD === scalar`)
    // Regression: pre-fix the SIMD frame was all-zero here (stale fx/fy shadow) ≠ scalar.
    is(runVec(COMPLEX_FIELD(d, true), SPEED).main(), runVec(COMPLEX_FIELD(d, true), SPEED_SCALAR).main(), `guarded-assign + hypot d=${d}: SIMD === scalar`)
  }
})

// === TypedArray type-aware indexing ===

test('Int32Array - type-aware read/write', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(3)
    buf[0] = 100; buf[1] = 200; buf[2] = 300
    return buf[0] + buf[1] + buf[2]
  }`).main(), 600)
})

test('Float32Array - type-aware read/write', () => {
  const r = run(`export let main = () => {
    let buf = new Float32Array(2)
    buf[0] = 1.5; buf[1] = 2.5
    return buf[0] + buf[1]
  }`).main()
  ok(Math.abs(r - 4) < 0.01, `Expected ~4, got ${r}`)
})

test('TypedArray - polymorphic indexed write dispatches by runtime element type', () => {
  is(run(`export let main = (wide) => {
    let arr = wide ? new Uint32Array(1) : new Uint8Array(4)
    arr[0] = wide ? 0xffffffff : -128
    let bytes = new Uint8Array(arr.buffer)
    return bytes[0] + bytes[1] + bytes[2] + bytes[3]
  }`).main(1), 1020)
  is(run(`export let main = (wide) => {
    let arr = wide ? new Uint32Array(1) : new Uint8Array(4)
    arr[0] = wide ? 0xffffffff : -128
    let bytes = new Uint8Array(arr.buffer)
    return bytes[0]
  }`).main(0), 128)
})

// === TypedArray.from ===

test('Uint8Array.from: basic', () => {
  is(run(`export let main = () => {
    let a = Uint8Array.from([65, 66, 67])
    return a[0] + a[1] + a[2]
  }`).main(), 198)
})

test('Uint8Array constructor: array source', () => {
  const { main } = run(`export let main = () => {
    let a = new Uint8Array([65, 66, 67])
    return [a.length, a[0], a[2]]
  }`)
  is(main()[0], 3)
  is(main()[1], 65)
  is(main()[2], 67)
})

test('spread: .push(...typedArray)', () => {
  const { main } = run(`export let main = () => {
    let out = []
    let bytes = new Uint8Array([1, 2, 3])
    out.push(...bytes)
    return [out.length, out[0], out[2]]
  }`)
  is(main()[0], 3)
  is(main()[1], 1)
  is(main()[2], 3)
})

test('Uint8Array.set: omitted offset defaults to 0', () => {
  is(run(`export let main = () => {
    let src = new Uint8Array([5, 6, 7])
    let dst = new Uint8Array(5)
    dst.set(src)
    return dst[0] * 100 + dst[1] * 10 + dst[2]
  }`).main(), 567)
})

test('Uint8Array.set: explicit offset', () => {
  is(run(`export let main = () => {
    let src = new Uint8Array([8, 9])
    let dst = new Uint8Array(5)
    dst.set(src, 2)
    return dst[1] * 100 + dst[2] * 10 + dst[3]
  }`).main(), 89)
})

test('Int32Array.from: basic', () => {
  is(run(`export let main = () => {
    let a = Int32Array.from([10, 20, 30])
    return a.length
  }`).main(), 3)
})

test('Float64Array.from: preserves values', () => {
  const r = run(`export let main = () => {
    let a = Float64Array.from([1.5, 2.5, 3.5])
    return a[0] + a[2]
  }`).main()
  ok(Math.abs(r - 5) < 0.01)
})

// === Uint32Array full range ===

test('Uint32Array - large values (> 2^31)', () => {
  is(run(`export let main = () => {
    let buf = new Uint32Array(2)
    buf[0] = 3000000000
    buf[1] = 4000000000
    return buf[0]
  }`).main(), 3000000000)
})

// === TypedArray.map scalar fallback (non-SIMD types) ===

test('Int16Array.map scalar fallback', () => {
  is(run(`export let main = () => {
    let buf = new Int16Array(3)
    buf[0] = 1; buf[1] = 2; buf[2] = 3
    let r = buf.map(x => x + 5)
    return r[0] + r[1] + r[2]
  }`).main(), 21)  // 6+7+8
})

test('Uint8Array.map scalar fallback', () => {
  is(run(`export let main = () => {
    let buf = new Uint8Array(4)
    buf[0] = 10; buf[1] = 20; buf[2] = 30; buf[3] = 40
    let r = buf.map(x => x * 2)
    return r[0] + r[3]
  }`).main(), 100)  // 20+80
})

// === Chained typed-array indexing (expression, not named var) ===

test('Int16Array.map chained index', () => {
  is(run(`export let main = () => {
    let buf = new Int16Array(3)
    buf[0] = 8; buf[1] = 9; buf[2] = 10
    return buf.map(x => x + 1)[1]
  }`).main(), 10)
})

// Verify SIMD generates v128 instructions
test('SIMD - generates v128 instructions', () => {
  const w = compile(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x * 2)
    return r[0]
  }`, { wat: true })
  ok(w.includes('v128.load'), 'should contain v128.load')
  ok(w.includes('f64x2.mul'), 'should contain f64x2.mul')
  ok(w.includes('v128.store'), 'should contain v128.store')
})

// ============================================================================
// SIMD-128 lane-local vectorizer (vectorizeLaneLocal pass).
//
// Recognizer is a STRUCTURAL property, not a benchmark match. Tests pin:
//   • Positive: pure-lane bodies lift to v128 ops, checksum stays identical.
//   • Negative: cross-iter dataflow (reductions, loop-carried scalars,
//     stencils, varying bound) must NOT lift.
//   • Tail correctness: lengths that aren't a multiple of LANES still work.
// ============================================================================

// ---- positive cases ------------------------------------------------------

test('vectorize: bitwise lane-local matches and produces identical checksum', () => {
  const src = `
    export const main = () => {
      const N = 4096
      const a = new Int32Array(N)
      let s = 0x1234abcd | 0
      for (let i = 0; i < N; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s }
      for (let r = 0; r < 4; r++) {
        for (let i = 0; i < N; i++) {
          let x = a[i] | 0
          x ^= x << 7
          x ^= x >>> 9
          x = (x ^ (x * 1103515245 + 12345)) | 0
          a[i] = x ^ (x >>> 16)
        }
      }
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops in SIMD output')
})

test('vectorize: i32 shift lane-local lifts (a[i] = a[i] << 1)', () => {
  // Pure-i32 path: bitwise shift narrows cleanly.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = (a[i] << 1) | 0
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops')
})

test('vectorize: f64 map loop across two arrays lifts (b[i] = f(a[i]))', () => {
  // Map between DISTINCT base pointers: the `i << 3` offset is CSE'd into one
  // local shared by the load and store address. Recognizer must see through
  // that offset-tee, not just the same-array in-place form.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      const b = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i * 1.5 - 3.0
      for (let i = 0; i < N; i++) b[i] = a[i] * 2.0 + 1.0
      let s = 0.0
      for (let i = 0; i < N; i++) s = s + b[i]
      return s
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/v128\.load|f64x2\./.test(wat(src, SIMD_OPT)), 'expected f64x2 ops for the cross-array map')
})

test('vectorize: f64 cross-array map tail correctness (N not a multiple of LANES)', () => {
  // N=1023 — odd, exercises the f64x2 (2-lane) remainder via the scalar tail.
  const src = `
    export const main = () => {
      const N = 1023
      const a = new Float64Array(N)
      const b = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i * 0.5 + 1.0
      for (let i = 0; i < N; i++) b[i] = a[i] * a[i] - 2.0
      let s = 0.0
      for (let i = 0; i < N; i++) s = s + b[i]
      return s
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

test('vectorize: tail correctness when N is not a multiple of LANES', () => {
  // N=1023 (i32x4 → 4 lanes; 1023 % 4 = 3 → tail of 3 elems)
  const src = `
    export const main = () => {
      const N = 1023
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 17) | 0
      for (let i = 0; i < N; i++) a[i] = (a[i] ^ 0x5a5a5a5a) | 0
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

test('vectorize: i32x4 small-N boundary sweep (0,1,LANES,LANES±1) vs JS oracle', () => {
  // i32x4 → 4 lanes. Sweep N around the lane boundary to flush prologue/epilogue
  // off-by-ones. The map (`a[i] ^= mask`) vectorizes; the reduction stays scalar,
  // so a sequential JS oracle is an exact comparator. Empty N=0 must be a clean no-op.
  for (const N of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16]) {
    const src = `
      export const main = () => {
        const a = new Int32Array(${N})
        for (let i = 0; i < ${N}; i++) a[i] = (i * 17) | 0
        for (let i = 0; i < ${N}; i++) a[i] = (a[i] ^ 0x5a5a5a5a) | 0
        let h = 0
        for (let i = 0; i < ${N}; i++) h = (h ^ a[i]) | 0
        return h | 0
      }`
    let h = 0
    for (let i = 0; i < N; i++) h = (h ^ (((i * 17) | 0) ^ 0x5a5a5a5a)) | 0
    is(runVec(src, SIMD_OPT).main(), h | 0, `N=${N}`)
  }
})

test('vectorize: f64x2 small-N boundary sweep (0,1,2,3) vs JS oracle', () => {
  // f64x2 → 2 lanes. Values are exact in f64 at this scale, so `is` holds.
  for (const N of [0, 1, 2, 3, 5]) {
    const src = `
      export const main = () => {
        const a = new Float64Array(${N})
        const b = new Float64Array(${N})
        for (let i = 0; i < ${N}; i++) a[i] = i * 0.5 + 1.0
        for (let i = 0; i < ${N}; i++) b[i] = a[i] * 2.0 + 1.0
        let s = 0.0
        for (let i = 0; i < ${N}; i++) s = s + b[i]
        return s
      }`
    let s = 0
    for (let i = 0; i < N; i++) s = s + ((i * 0.5 + 1.0) * 2.0 + 1.0)
    is(runVec(src, SIMD_OPT).main(), s, `N=${N}`)
  }
})

// ---- hand-written SoA shape (3+ arrays, same induction var) --------------
// Documents the supported migration path: code that already separates fields
// into distinct typed arrays (xs / ys / zs … rather than one interleaved
// AoS buffer) vectorizes today without any compiler-side struct splitting.

test('vectorize: SoA-3 fused map zs[i] = xs[i]*a + ys[i]*b', () => {
  // Three distinct bases, one CSE'd `i << 3` offset shared across all
  // load/store addresses — the offset-tee path lifts cleanly.
  const src = `
    export const main = () => {
      const N = 1024
      const xs = new Float64Array(N)
      const ys = new Float64Array(N)
      const zs = new Float64Array(N)
      for (let i = 0; i < N; i++) { xs[i] = i * 0.25; ys[i] = i * 0.5 + 1.0 }
      for (let i = 0; i < N; i++) zs[i] = xs[i] * 3.0 + ys[i] * 2.0
      let s = 0.0
      for (let i = 0; i < N; i++) s = s + zs[i]
      return s
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/f64x2\./.test(wat(src, SIMD_OPT)), 'expected f64x2 ops for the SoA-3 fused map')
})

test('vectorize: SoA-4 channel blend (rgba luminance)', () => {
  // Compares the vectorized build against the env-level baseline. The map is lane-local
  // (bit-exact), but the trailing float sum REORDERS: at level 3 the baseline lifts it to
  // 4 independent accumulators (reduceUnroll), a wider reassociation than SIMD_OPT's single
  // accumulator — so the results differ in the last ULP. `almost`, not `is`. (Below opt 2
  // the baseline doesn't vectorize at all, so there's nothing to compare.)
  if (belowOpt(2)) return
  // Four base pointers in the inner loop — common image-processing shape.
  const src = `
    export const main = () => {
      const N = 1024
      const r = new Float64Array(N)
      const g = new Float64Array(N)
      const b = new Float64Array(N)
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) { r[i] = i * 0.01; g[i] = i * 0.02; b[i] = i * 0.03 }
      for (let i = 0; i < N; i++) a[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114
      let s = 0.0
      for (let i = 0; i < N; i++) s = s + a[i]
      return s
    }
  `
  almost(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/f64x2\./.test(wat(src, SIMD_OPT)), 'expected f64x2 ops for the SoA-4 blend')
})

// ---- AoS counterpart documents the boundary ------------------------------
// Interleaved {x,y,…} in one buffer reads as `a[i*stride + offset]` —
// strided, not contiguous, so the recognizer can't lift to v128.load. This
// negative test pins the boundary so future changes don't accidentally
// promise AoS support without a real struct-splitting carrier.

test('vectorize: AoS-interleaved stride>1 does NOT lift (parity intact)', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N * 2)
      for (let i = 0; i < N; i++) { a[i*2] = i; a[i*2+1] = i + 1 }
      for (let i = 0; i < N; i++) a[i*2] = a[i*2] * 2.0
      let s = 0.0
      for (let i = 0; i < N; i++) s = s + a[i*2]
      return s
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(!/\$__simd_loop\d+/.test(wat(src, SIMD_OPT)), 'AoS strided access should not lift to SIMD')
})

// Regression: sibling loops that each lift the SAME source local to a v128
// scratch named `$<name>__v` used to emit that `local` decl twice → invalid wasm
// ("Duplicate local"). Crashed the FFT bench kernel at the speed preset
// (`$inl_dt__v` from the inlined twiddle builder). Post-order vectorizes
// innermost-first and an outer loop bails once its inner became a wrapper, so no
// two NESTED loops co-lift — sharing one scratch across SEQUENTIAL loops is
// correct, and the decls dedupe by name at the splice. Compile the real kernel.
test('vectorize: sibling lifts dedupe lane locals (fft kernel @ speed)', () => {
  if (onKernel()) return  // compiles a real bench file via the host `modules` map; the kernel owns compilation and has no module resolver
  const ROOT = join(HERE, '..')
  const src = readFileSync(join(ROOT, 'bench/fft/fft.js'), 'utf8')
  const benchlib = readFileSync(join(ROOT, 'bench/_lib/benchlib.js'), 'utf8')
  let err = null
  try { compile(src, { modules: { '../_lib/benchlib.js': benchlib }, optimize: { level: 'speed' } }) }
  catch (e) { err = e.message }
  ok(err === null, `fft must compile at the speed preset (no duplicate lane locals); got: ${err}`)
})

// ---- negative cases ------------------------------------------------------

test('vectorize: loop-carried scalar (s ^= s << 13) must NOT lift', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      let s = 0x1234abcd | 0
      for (let i = 0; i < N; i++) { s ^= s << 13; s ^= s >>> 17; a[i] = s }
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  // Hash loop below is a legitimate xor reduction and IS expected to lift —
  // assert specifically that lift did NOT happen on $s.
  const w = wat(src, SIMD_OPT)
  ok(!/\$s__v/.test(w), 'expected no lane-local lift of loop-carried $s')
})

test('vectorize: i32 sum reduction lifts to i32x4.add', () => {
  // `(sum + a[i]) | 0` over an Int32Array compiles the `+` in f64 then ToInt32s; the
  // optimizer folds that back to a clean i32.add (NOVEC oracle, vectorize off), which
  // the reduction recognizer then lifts to i32x4.add. Integer sum is exact ⇒ no drift.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 7 + 3) | 0
      let sum = 0 | 0
      for (let i = 0; i < N; i++) sum = (sum + a[i]) | 0
      return sum | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/i32x4\.add/.test(wat(src, SIMD_OPT)), 'i32 sum reduction → i32x4.add')
})

test('vectorize: f64 reduction unrolls to N accumulators under reduceUnroll', () => {
  // A reduction's accumulator is a latency chain (each add waits on the prior).
  // reduceUnroll lifts it to 4 INDEPENDENT f64x2 accumulators (ILP / latency hiding),
  // combined before the horizontal fold — a size↔speed trade enabled at level 3 /
  // 'speed'. It is deterministic (just wider reassociation), and with integer-valued
  // data the sum is exact regardless of order ⇒ still matches the scalar oracle.
  const src = `
    export const main = () => {
      const N = 1000
      const a = new Float64Array(N), b = new Float64Array(N)
      for (let i = 0; i < N; i++) { a[i] = i % 7; b[i] = i % 5 }
      let s = 0
      for (let i = 0; i < N; i++) s += a[i] * b[i]
      return s
    }
  `
  const UNROLL = { optimize: { vectorizeLaneLocal: true, watr: true, reduceUnroll: true } }
  is(runVec(src, UNROLL).main(), runVec(src, NOVEC).main())   // correct despite reassociation
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main()) // single-acc oracle also matches
  ok(/\$__simd_acc\d+_\d+/.test(wat(src, UNROLL)), 'reduceUnroll → independent accumulators')
  ok(!/\$__simd_acc\d+_\d+/.test(wat(src, SIMD_OPT)), 'default reduce stays single-accumulator')
})

test('vectorize: stencil (a[i] depends on a[i-1]) must NOT lift', () => {
  const src = `
    export const main = () => {
      const N = 256
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 3 + 1) | 0
      for (let i = 1; i < N; i++) a[i] = (a[i] + a[i - 1]) | 0
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

// ---- narrow-lane (i8x16 / i16x8) cases -----------------------------------

test('vectorize: Uint8Array bitwise XOR lifts to i8x16 / v128.xor', () => {
  const src = `
    export const main = () => {
      const N = 256
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = (i + 1) & 0xff
      for (let i = 0; i < N; i++) a[i] = (a[i] ^ 0x5a) | 0
      let h = 0; for (let i = 0; i < N; i++) h = (h * 31 + a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  { const w = wat(src, SIMD_OPT); ok(/v128\.load/.test(w) && /v128\.xor/.test(w), 'expected v128.load + v128.xor') }
})

test('vectorize: Uint8Array shl lifts to i8x16.shl', () => {
  const src = `
    export const main = () => {
      const N = 256
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = (a[i] << 2) | 0
      let h = 0; for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/i8x16\.shl/.test(wat(src, SIMD_OPT)), 'expected i8x16.shl')
})

test('vectorize: Uint16Array mul lifts to i16x8.mul', () => {
  const src = `
    export const main = () => {
      const N = 512
      const a = new Uint16Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = Math.imul(a[i], 17) & 0xffff
      let h = 0; for (let i = 0; i < N; i++) h = (h + a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/i16x8\.mul/.test(wat(src, SIMD_OPT)), 'expected i16x8.mul')
})

test('vectorize: Uint8Array right shift must NOT lift (signedness mismatch)', () => {
  // i32.shr_u on load8_u differs from i8x16.shr_u (lane treats byte as unsigned
  // regardless; i32 path zero-extends first then shifts in i32 width).
  // Conservative recognizer drops shr_* for i8/i16.
  const src = `
    export const main = () => {
      const N = 256
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = (a[i] >>> 1) | 0
      let h = 0; for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(!/v128\.load/.test(wat(src, SIMD_OPT)), 'expected no v128.load on u8 shr')
})

// ---- reduction (horizontal fold) cases -----------------------------------

test('vectorize: i32 xor reduction lifts to v128.xor + lane extracts', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 31) | 0
      let s = 0
      for (let i = 0; i < N; i++) s = (s ^ a[i]) | 0
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  const w = wat(src, SIMD_OPT)
  ok(/v128\.xor/.test(w) && /i32x4\.extract_lane/.test(w),
    'expected v128.xor and lane extracts')
})

test('vectorize: i32 or / and reductions both lift', () => {
  const orSrc = `
    export const main = () => {
      const a = new Int32Array(1024)
      for (let i = 0; i < 1024; i++) a[i] = i & 0xff
      let s = 0
      for (let i = 0; i < 1024; i++) s = (s | a[i]) | 0
      return s | 0
    }
  `
  const andSrc = `
    export const main = () => {
      const a = new Int32Array(1024)
      for (let i = 0; i < 1024; i++) a[i] = ~i
      let s = -1 | 0
      for (let i = 0; i < 1024; i++) s = (s & a[i]) | 0
      return s | 0
    }
  `
  is(runVec(orSrc, SIMD_OPT).main(), runVec(orSrc).main())
  is(runVec(andSrc, SIMD_OPT).main(), runVec(andSrc).main())
  ok(/v128\.or/.test(wat(orSrc, SIMD_OPT)), 'or reduction → v128.or')
  ok(/v128\.and/.test(wat(andSrc, SIMD_OPT)), 'and reduction → v128.and')
})

test('vectorize: f64 sum reduction lifts (associativity tolerated)', () => {
  // Inputs where reorder of f64 add is exact (small integers stored as doubles
  // add associatively up to N * max < 2^53).
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/f64x2\.add/.test(wat(src, SIMD_OPT)), 'expected f64x2.add')
})

test('vectorize: i32 product (Math.imul) reduction lifts to i32x4.mul (exact mod 2^32)', () => {
  // Integer mul is associative+commutative mod 2^32, so the vectorized product
  // equals the scalar product bit-for-bit even as it wraps.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i % 6) + 1
      let p = 1
      for (let i = 0; i < N; i++) p = Math.imul(p, a[i])
      return p | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/i32x4\.mul/.test(wat(src, SIMD_OPT)), 'expected i32x4.mul')
})

test('vectorize: f64 product reduction lifts to f64x2.mul', () => {
  // Powers of two multiply exactly in any order ⇒ no ulp drift between the
  // vectorized and scalar fold; product is exactly 1.0.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i & 1) ? 2 : 0.5
      let p = 1
      for (let i = 0; i < N; i++) p *= a[i]
      return (p * 1024) | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  is(runVec(src, SIMD_OPT).main(), 1024)
  ok(/f64x2\.mul/.test(wat(src, SIMD_OPT)), 'expected f64x2.mul')
})

test('vectorize: reduction tail correctness when N is not a multiple of LANES', () => {
  const src = `
    export const main = () => {
      const N = 1023
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 7) | 0
      let s = 0
      for (let i = 0; i < N; i++) s = (s ^ a[i]) | 0
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

// ---- widening (extadd_pairwise) byte/short sums ----------------------------
// `s += u8[i]` has an i32 accumulator over i8/i16 lanes — lifted via the
// extadd_pairwise chain into i32x4 partials. Value-exact mod 2^32 (wrap-add
// is associative+commutative; pairwise intermediates can't overflow).

const widenSum = (ctor, fill, N = 1003, seed = 0) => `
    export const main = () => {
      const N = ${N}
      const a = new ${ctor}(N)
      for (let i = 0; i < N; i++) a[i] = ${fill}
      let s = ${seed} | 0
      for (let i = 0; i < N; i++) s = (s + a[i]) | 0
      return s | 0
    }
  `

test('vectorize: u8 sum reduction widens via extadd_pairwise chain', () => {
  const src = widenSum('Uint8Array', '(i * 37) & 0xff')
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  const w = wat(src, SIMD_OPT)
  ok(/i16x8\.extadd_pairwise_i8x16_u/.test(w) && /i32x4\.extadd_pairwise_i16x8_u/.test(w),
    'expected unsigned extadd chain i8x16 → i16x8 → i32x4')
})

test('vectorize: s8 sum reduction widens sign-extended', () => {
  const src = widenSum('Int8Array', '(i * 37) - 128')
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  const w = wat(src, SIMD_OPT)
  ok(/i16x8\.extadd_pairwise_i8x16_s/.test(w) && /i32x4\.extadd_pairwise_i16x8_s/.test(w),
    'expected signed extadd chain')
})

test('vectorize: u16 sum reduction widens with one extadd step (wraps exactly)', () => {
  // Seed near INT32_MAX so the running sum wraps — vectorized partials must
  // match the scalar wrap bit-for-bit (mod 2^32 exactness).
  const src = widenSum('Uint16Array', '(i * 2654) & 0xffff', 1003, 2147480000)
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/i32x4\.extadd_pairwise_i16x8_u/.test(wat(src, SIMD_OPT)), 'expected one unsigned i16x8→i32x4 extadd')
})

test('vectorize: s16 sum reduction widens sign-extended', () => {
  const src = widenSum('Int16Array', '(i * 997) - 32768')
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/i32x4\.extadd_pairwise_i16x8_s/.test(wat(src, SIMD_OPT)), 'expected signed i16x8→i32x4 extadd')
})

test('vectorize: narrow sum with lane arithmetic must NOT widen (i8 wrap ≠ i32 widen-then-add)', () => {
  // `(a[i] ^ 3)` on i8 lanes would wrap at lane width before widening, while
  // the scalar code zero-extends FIRST — only the bare load is liftable.
  const src = `
    export const main = () => {
      const N = 256
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 37) & 0xff
      let s = 0
      for (let i = 0; i < N; i++) s = (s + (a[i] ^ 3)) | 0
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(!/extadd_pairwise/.test(wat(src, SIMD_OPT)), 'expected no extadd lift on lane arithmetic')
})

test('vectorize: multi-stmt reduction body must NOT lift', () => {
  const src = `
    export const main = () => {
      const a = new Int32Array(1024)
      for (let i = 0; i < 1024; i++) a[i] = i
      let s = 0, t = 0
      for (let i = 0; i < 1024; i++) { s = (s ^ a[i]) | 0; t = (t + 1) | 0 }
      return (s ^ t) | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

// ---- integer min/max reductions → i32x4.max_s / min_s ----------------------
// WASM has no scalar i32.min/max, so the peak-find idiom arrives as a select/if
// (after the ToInt32-through-`?:` fold) — matchIntMinMaxReduce lifts it. Selection
// is value-exact (no arithmetic), so vectorized == scalar bit-for-bit. All four
// comparison directions × two branch orderings reduce to the same max/min.
// (Generative coverage: `node test/fuzz.js --typed-int-minmax`.)

const minmaxReduce = (form, seed, start = 0) => `
  export const main = () => {
    const N = 1024
    const a = new Int32Array(N)
    for (let i = 0; i < N; i++) a[i] = ((i * 73 + 13) % 4001 - 2000) | 0
    let m = ${seed}
    for (let i = ${start}; i < N; i++) m = ${form} | 0
    return m | 0
  }
`

test('vectorize: i32 max reduction lifts to i32x4.max_s (all orderings, exact)', () => {
  for (const form of ['(a[i] > m ? a[i] : m)', '(m > a[i] ? m : a[i])', '(a[i] >= m ? a[i] : m)']) {
    const src = minmaxReduce(form, '-2147483648')
    is(runVec(src, SIMD_OPT).main(), runVec(src).main())
    ok(/i32x4\.max_s/.test(wat(src, SIMD_OPT)), `expected i32x4.max_s for ${form}`)
  }
})

test('vectorize: i32 min reduction lifts to i32x4.min_s (all orderings, exact)', () => {
  for (const form of ['(a[i] < m ? a[i] : m)', '(m < a[i] ? m : a[i])', '(a[i] <= m ? a[i] : m)']) {
    const src = minmaxReduce(form, '2147483647')
    is(runVec(src, SIMD_OPT).main(), runVec(src).main())
    ok(/i32x4\.min_s/.test(wat(src, SIMD_OPT)), `expected i32x4.min_s for ${form}`)
  }
})

test('vectorize: min/max reduction with m=a[0] start-at-1 idiom + non-LANES-multiple N', () => {
  // Seeds the accumulator from the first element and starts at i=1 — the overshoot-safe
  // SIMD bound must not run a lane past the end; the scalar tail cleans up N % 4 != 0.
  const src = `
    export const main = () => {
      const N = 1021
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = ((i * 31 + 5) % 2003 - 1000) | 0
      let m = a[0]
      for (let i = 1; i < N; i++) m = (a[i] > m ? a[i] : m) | 0
      return m | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/i32x4\.max_s/.test(wat(src, SIMD_OPT)), 'expected i32x4.max_s')
})

test('vectorize: Math.max(m, a[i]) int reduction stays scalar (computes in f64)', () => {
  // Documents the boundary: Math.min/max lower through f64 (NaN-canonicalized), so the
  // int form is f64.max-then-truncate, not the i32 select idiom — correct, just not lifted.
  const src = minmaxReduce('Math.max(m, a[i])', '-2147483648')
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(!/i32x4\.max_s/.test(wat(src, SIMD_OPT)), 'Math.max int reduction not lifted to i32x4 (f64 path)')
})

// ---- byte-scan (memchr) → i8x16.eq + bitmask -------------------------------
// A pure "find first index where buf[i] ==/!= byte" loop scans 16 bytes per step; the
// first match is located via i8x16.bitmask + i32.ctz, with the original loop as the
// <16-byte tail. ~8× over the scalar scan on V8. (Generative: node test/fuzz.js below.)
const byteScan = (cmp, delimDecl, delim, fill) => `
  export const main = () => {
    const b = new Uint8Array(100)
    for (let i = 0; i < 100; i++) b[i] = (${fill}) & 255
    ${delimDecl}
    let i = 0
    while (i < 100) { if (b[i] ${cmp} ${delim}) break; i = (i + 1) | 0 }
    return i | 0
  }
`

test('vectorize: byte scan === const lifts to i8x16.eq + finds exact first match', () => {
  for (const pos of [0, 7, 16, 17, 63, 64, 99]) {
    // place the only `44` byte at `pos`; every other byte is 1 (never 44)
    const src = byteScan('===', '', '44', `i === ${pos} ? 44 : 1`)
    is(runVec(src, SIMD_OPT).main(), pos)
    is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  }
  ok(/i8x16\.eq/.test(wat(byteScan('===', '', '44', 'i*9+1'), SIMD_OPT)), 'expected i8x16.eq')
})

test('vectorize: byte scan !== const (skip-while-equal) matches scalar', () => {
  const src = byteScan('!==', '', '7', 'i < 40 ? 7 : i')   // first non-7 at index 40
  is(runVec(src, SIMD_OPT).main(), 40)
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  ok(/i8x16\.eq/.test(wat(src, SIMD_OPT)), 'expected i8x16.eq (inverted mask for !=)')
})

test('vectorize: byte scan with runtime delimiter is guarded (out-of-range → scalar tail)', () => {
  // delimiter comes from data (runtime); the SIMD path runs only when it is a byte in
  // [0,255]. An out-of-range runtime delimiter must still give the scalar result (no match).
  const inRange = byteScan('===', 'let t = (b[0] + 3) | 0;', 't', 'i*5+10')
  is(runVec(inRange, SIMD_OPT).main(), runVec(inRange).main())
  ok(/i8x16\.eq/.test(wat(inRange, SIMD_OPT)), 'runtime delimiter still vectorizes (guarded)')
  const outOfRange = byteScan('===', 'let t = (b[0] + 1000) | 0;', 't', 'i*5+10')
  is(runVec(outOfRange, SIMD_OPT).main(), runVec(outOfRange).main())  // both return 100 (no match)
})

test('vectorize: byte scan no-match returns the bound', () => {
  const src = byteScan('===', '', '200', 'i')   // bytes 0..99, never 200
  is(runVec(src, SIMD_OPT).main(), 100)
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
})

// ---- conditional (ternary) maps → v128.bitselect ---------------------------
// jz lowers `cond ? X : Y` to `(if (result f64) COND (then X)(else Y))`; the
// vectorizer lifts it to `v128.bitselect(X, Y, mask)`, mask = COND as a lane
// comparison. NOVEC (defined up top) re-runs the same source with vectorization OFF
// as the scalar oracle. (Generative coverage: `node test/fuzz.js --typed-map`.)

test('vectorize: conditional map (distinct arms) lifts to v128.bitselect, matches scalar', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i % 9) - 4
      for (let i = 0; i < N; i++) a[i] = a[i] < 1.0 ? (a[i] * 2.0) : (a[i] - 3.0)
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/v128\.bitselect/.test(wat(src, SIMD_OPT)), 'conditional map → v128.bitselect')
})

test('vectorize: conditional map matches scalar across all comparison ops', () => {
  for (const cmp of ['<', '>', '<=', '>=', '===', '!==']) {
    const src = `
      export const main = () => {
        const N = 256
        const a = new Float64Array(N)
        for (let i = 0; i < N; i++) a[i] = (i % 7) - 3
        for (let i = 0; i < N; i++) a[i] = (a[i] ${cmp} 0.0) ? (a[i] * 2.0) : (a[i] - 1.0)
        let s = 0
        for (let i = 0; i < N; i++) s += a[i]
        return s | 0
      }
    `
    is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  }
})

test('opt: identical-arm conditional store keeps the element address (select-fold regression)', () => {
  // `cond ? K : K` folds the value to K, but COND holds the element's address
  // `local.tee`; the old `(select x x cond)→x` dropped it, leaving the store stale
  // (the element kept its init). Both arms = 2.0 ⇒ every element must become 2.0.
  const src = `
    export const main = () => {
      const N = 65
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i - 30) * 0.5
      for (let i = 0; i < N; i++) a[i] = (a[i] > 0.5) ? 2.0 : (1.0 + 1.0)
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), 130)        // 65 elements × 2.0
  is(runVec(src, NOVEC).main(), 130)
})

test('vectorize: conditional map with a pooled constant (global.get) still lifts', () => {
  // `0.0` recurs (the compare, a branch, and the `!= 0` booleanization), so
  // hoistConstantPool lifts it to a global. The vectorizer splats the invariant
  // global.get instead of bailing — so the loop still reaches v128.bitselect.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i % 9) - 4
      for (let i = 0; i < N; i++) a[i] = a[i] < 0.0 ? (0.0 - a[i]) : (a[i] + 10.0)
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/v128\.bitselect/.test(wat(src, SIMD_OPT)), 'pooled-const conditional vectorizes via global.get splat')
})

// ---- NaN-canonicalized float maps (Math.sqrt / min / max / clamp) --------
// jz wraps every NaN-producing float builtin in a per-element canonicalizing
// `select(C, x, x≠x)`. Each lifts faithfully to `v128.bitselect(splat(C), v, v≠v)`
// for any C, so these maps vectorize even though a raw lane op would diverge on
// NaN bit-patterns. Oracle is the exact JS result (integer-valued ⇒ no ulp drift).

test('vectorize: Math.sqrt map lifts to f64x2.sqrt under a NaN-canon bitselect', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i * i
      for (let i = 0; i < N; i++) a[i] = Math.sqrt(a[i])
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  // sqrt of perfect squares is exact ⇒ Σ_{0}^{1023} i
  is(runVec(src, SIMD_OPT).main(), (1023 * 1024 / 2) | 0)
  { const w = wat(src, SIMD_OPT); ok(/f64x2\.sqrt/.test(w) && /v128\.bitselect/.test(w), 'sqrt map → f64x2.sqrt beneath a v128.bitselect NaN-canon') }
})

test('vectorize: vectorized Math.sqrt canonicalizes NaN lanes (sqrt of negatives)', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i - 3
      for (let i = 0; i < N; i++) a[i] = Math.sqrt(a[i])
      let nans = 0
      for (let i = 0; i < N; i++) nans += (a[i] !== a[i])
      return nans | 0
    }
  `
  // a[0..2] = -3,-2,-1 ⇒ sqrt → NaN on exactly 3 lanes (rest finite)
  is(runVec(src, SIMD_OPT).main(), 3)
  ok(/f64x2\.sqrt/.test(wat(src, SIMD_OPT)), 'sqrt lane op present')
})

test('vectorize: Math.min / Math.max map with a scalar bound lift', () => {
  const minSrc = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = Math.min(a[i], 500)
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  const maxSrc = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = Math.max(a[i], 500)
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  // Σ min(i,500): Σ_{0}^{500} i + 523·500 ; Σ max(i,500): 500·500 + Σ_{500}^{1023} i
  is(runVec(minSrc, SIMD_OPT).main(), (500 * 501 / 2 + 523 * 500) | 0)
  is(runVec(maxSrc, SIMD_OPT).main(), (500 * 500 + (1023 * 1024 / 2 - 499 * 500 / 2)) | 0)
  ok(/f64x2\.min/.test(wat(minSrc, SIMD_OPT)), 'min map → f64x2.min')
  ok(/f64x2\.max/.test(wat(maxSrc, SIMD_OPT)), 'max map → f64x2.max')
})

test('vectorize: clamp map Math.max(0, Math.min(255, a[i])) lifts both lane ops', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i
      for (let i = 0; i < N; i++) a[i] = Math.max(0, Math.min(255, a[i]))
      let s = 0
      for (let i = 0; i < N; i++) s += a[i]
      return s | 0
    }
  `
  // clamp i∈[0,1023] to [0,255]: Σ_{0}^{255} i + 768·255
  is(runVec(src, SIMD_OPT).main(), (255 * 256 / 2 + 768 * 255) | 0)
  { const w = wat(src, SIMD_OPT); ok(/f64x2\.min/.test(w) && /f64x2\.max/.test(w) && /v128\.bitselect/.test(w), 'clamp → nested f64x2.min/max beneath a NaN-canon bitselect') }
})

// ---- min / max horizontal reductions (overshoot-safe SIMD bound) ----------
// The idiom `m=a[0]; for(i=1;…) m=Math.max(m,a[i])` starts induction at 1, so the
// SIMD bound is `bound-(lanes-1)` (overshoot-safe for any start), not the i=0-only
// mask. min/max are exactly associative incl. NaN propagation ⇒ bit-exact oracle.

test('vectorize: Math.max reduction lifts to f64x2.max + horizontal extract', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 31) & 1023
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.max(m, a[i])
      return m | 0
    }
  `
  const N = 1024, a = new Float64Array(N)
  for (let i = 0; i < N; i++) a[i] = (i * 31) & 1023
  let m = a[0]; for (let i = 1; i < N; i++) m = Math.max(m, a[i])
  is(runVec(src, SIMD_OPT).main(), m | 0)
  const w = wat(src, SIMD_OPT)
  ok(/f64x2\.max/.test(w) && /f64x2\.extract_lane/.test(w),
    'max reduction → f64x2.max + horizontal extract')
})

test('vectorize: Math.min reduction lifts to f64x2.min + horizontal extract', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = ((i * 31) & 1023) + 1
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.min(m, a[i])
      return m | 0
    }
  `
  const N = 1024, a = new Float64Array(N)
  for (let i = 0; i < N; i++) a[i] = ((i * 31) & 1023) + 1
  let m = a[0]; for (let i = 1; i < N; i++) m = Math.min(m, a[i])
  is(runVec(src, SIMD_OPT).main(), m | 0)
  ok(/f64x2\.min/.test(wat(src, SIMD_OPT)), 'min reduction → f64x2.min')
})

test('vectorize: min/max reduction tail correct for non-multiple N (no overshoot read)', () => {
  const mk = (n) => `
    export const main = () => {
      const N = ${n}
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = (i * 7) & 511
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.max(m, a[i])
      return m | 0
    }
  `
  for (const n of [2, 3, 4, 5, 101, 1023, 1025]) {
    const a = new Float64Array(n)
    for (let i = 0; i < n; i++) a[i] = (i * 7) & 511
    let m = a[0]; for (let i = 1; i < n; i++) m = Math.max(m, a[i])
    is(runVec(mk(n), SIMD_OPT).main(), m | 0)
  }
})

test('vectorize: Math.max reduction propagates a NaN element through the canon merge', () => {
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i + 1
      a[613] = Math.sqrt(-1)
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.max(m, a[i])
      return (m !== m) | 0
    }
  `
  // a single NaN forces the running max to NaN in both scalar and SIMD folds
  is(runVec(src, SIMD_OPT).main(), 1)
  ok(/f64x2\.max/.test(wat(src, SIMD_OPT)), 'max reduction vectorized')
})

test('vectorize: default level 2 emits SIMD for obvious lane-local loops', () => {
  if (belowOpt(2)) return  // asserts SIMD emission — requires the vectorizer (optimize >= 2)
  // At default optimize:true (level 2), the stable SIMD pass is enabled.
  const src = `
    export const main = () => {
      const N = 1024
      const a = new Int32Array(N)
      for (let i = 0; i < N; i++) a[i] = i | 0
      for (let i = 0; i < N; i++) a[i] = (a[i] ^ 0x5a5a5a5a) | 0
      let h = 0 | 0
      for (let i = 0; i < N; i++) h = (h ^ a[i]) | 0
      return h | 0
    }
  `
  ok(hasV128(wat(src)), 'expected v128 ops at default optimization')
})

// ---- memory.copy / memory.fill loop idioms ---------------------------------
// Whole copy/fill loops become bulk-memory ops (memmove/memset in the engine):
// for(i<N) a[i]=b[i] → overlap-guarded memory.copy; a[i]=0 / u8[i]=C →
// memory.fill. Runs before the lane vectorizer; the overlap guard keeps the
// original loop for dst-strictly-inside-src layouts where a forward loop and
// memmove genuinely differ.

test('memop: f64 copy loop lifts to memory.copy with overlap guard', () => {
  const src = `
    export const main = () => {
      const a = new Float64Array(64)
      const b = new Float64Array(64)
      for (let i = 0; i < 64; i++) a[i] = i * 1.25
      for (let i = 0; i < 64; i++) b[i] = a[i]
      let s = 0
      for (let i = 0; i < 64; i++) s += b[i]
      return s
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
  ok(/memory\.copy/.test(wat(src, SIMD_OPT)), 'expected memory.copy')
})

test('memop: zero-fill and byte-fill loops lift to memory.fill', () => {
  const srcZ = `
    export const main = () => {
      const a = new Float64Array(64)
      for (let i = 0; i < 64; i++) a[i] = i
      for (let i = 0; i < 64; i++) a[i] = 0
      let s = 1
      for (let i = 0; i < 64; i++) s += a[i]
      return s
    }
  `
  const srcB = `
    export const main = () => {
      const a = new Uint8Array(64)
      for (let i = 0; i < 64; i++) a[i] = 42
      let s = 0
      for (let i = 0; i < 64; i++) s = (s + a[i]) | 0
      return s
    }
  `
  is(runVec(srcZ, SIMD_OPT).main(), 1)
  is(runVec(srcB, SIMD_OPT).main(), 42 * 64)
  ok(/memory\.fill/.test(wat(srcZ, SIMD_OPT)), 'zero fill → memory.fill')
  ok(/memory\.fill/.test(wat(srcB, SIMD_OPT)), 'byte fill → memory.fill')
})

test('memop: overlapping same-buffer copy keeps exact forward-loop semantics', () => {
  // dst strictly inside (src, src+len): forward loop re-reads bytes it already
  // wrote — memmove would differ, so the guard must take the loop fallback.
  const src = `
    export const main = () => {
      const a = new Float64Array(16)
      for (let i = 0; i < 16; i++) a[i] = i
      for (let i = 0; i < 8; i++) a[4 + i] = a[2 + i]
      let h = 0
      for (let i = 0; i < 16; i++) h = (h * 31 + a[i]) | 0
      return h
    }
  `
  is(runVec(src, SIMD_OPT).main(), runVec(src, NOVEC).main())
})

test('memop: induction variable and bound state exact after the lift', () => {
  // i is read after the loop — the lift must leave it == bound.
  const src = `
    export const main = () => {
      const a = new Float64Array(32)
      const b = new Float64Array(32)
      for (let i = 0; i < 32; i++) a[i] = i
      let i = 0
      for (; i < 32; i++) b[i] = a[i]
      return i + b[31]
    }
  `
  is(runVec(src, SIMD_OPT).main(), 32 + 31)
})

// ---- widening min/max reductions -------------------------------------------
// `m = Math.max(m, u8[i])` (acc f64, narrow lanes) folds at the LOAD's own
// width/sign — i8x16.max_u etc., 16/8 lanes per op — exact because min/max
// never rounds and narrow values are exact in f64. Only the one horizontal
// result converts to f64. The SIMD prefix (incl. merge) is guarded: lane-domain
// identities (0 for u8-max) aren't neutral for an arbitrary live accumulator.

test('widen minmax: u8/s16 fold at lane width, all seeds exact', () => {
  const src = `
    export let mx = (seed, n) => {
      let a = new Uint8Array(64)
      for (let i = 0; i < 64; i++) a[i] = (i * 37 + 11) % 256
      let m = +seed
      for (let i = 0; i < n; i++) m = Math.max(m, a[i])
      return m
    }
    export let mn = (seed, n) => {
      let a = new Int16Array(64)
      for (let i = 0; i < 64; i++) a[i] = (i * 379 - 9000) % 32768
      let m = +seed
      for (let i = 0; i < n; i++) m = Math.min(m, a[i])
      return m
    }
  `
  // `+seed` unboxes the param once so the accumulator is a plain f64 local —
  // an unconverted param stays NaN-boxed (per-iteration __to_num) and the
  // canon shape never forms. Vector side at optimize:3; scalar oracle NOVEC.
  const v = runVec(src, { optimize: 3 }), s = runVec(src, NOVEC)
  for (const seed of [NaN, -0.5, 1e9, -1e9, -0, Infinity, -Infinity])
    for (const n of [0, 1, 15, 16, 17, 64])
      for (const f of ['mx', 'mn'])
        ok(Object.is(v[f](seed, n), s[f](seed, n)), `${f}(${seed}, ${n})`)
  const w = wat(src, { optimize: 3 })
  ok(/i8x16\.max_u/.test(w), 'u8 max folds as i8x16.max_u')
  ok(/i16x8\.min_s/.test(w), 's16 min folds as i16x8.min_s')
})

test('widen minmax: zero-iteration SIMD range cannot clamp the accumulator', () => {
  // n=3 < lanes: the SIMD prefix must not run its merge — identity 0 would
  // otherwise lift a negative seed to 0.
  const src = `
    export let go = (n) => {
      let a = new Uint8Array(32)
      for (let i = 0; i < 32; i++) a[i] = i + 1
      let m = -7.5
      for (let i = 0; i < n; i++) m = Math.max(m, a[i])
      return m
    }
  `
  is(runVec(src, SIMD_OPT).go(0), -7.5)
  is(runVec(src, SIMD_OPT).go(3), 3)
  is(runVec(src, SIMD_OPT).go(32), 32)
})

// === Divergent escape-time vectorizer (f64x2 masked lockstep, bit-exact) ===
// Two adjacent pixels run in f64x2 lockstep; a lane is frozen via v128.bitselect
// the instant it escapes or hits MAXIT, so it/zx/zy stay bit-identical to scalar.
// The differential fuzzer never generates escape-time loops, so these hand-written
// oracle checks (SIMD == NOVEC scalar, every regime) are the correctness gate.

// Build an escape-time kernel over a parametric grid + iteration map.
const escKern = (W, H, MAXIT, x0, dx, y0, dy, map) => `
  const W=${W}, H=${H}, MAXIT=${MAXIT}, X0=${x0}, DX=${dx}, Y0=${y0}, DY=${dy}
  let out = new Uint32Array(W*H)
  export let render = () => {
    for (let py=0; py<H; py++) {
      let cy = Y0 + py*DY
      for (let px=0; px<W; px++) {
        let cx = X0 + px*DX
        let zx=0.0, zy=0.0, i=0
        while (i < MAXIT) {
          let x2=zx*zx, y2=zy*zy
          if (x2+y2 > 4.0) break
          ${map}
          i++
        }
        out[py*W+px] = i
      }
    }
  }
  export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }
`
const MANDEL = `zy = 2.0*zx*zy + cy; zx = x2 - y2 + cx`
const JULIA  = `zy = 2.0*zx*zy + 0.27015; zx = x2 - y2 + (-0.8)`
// The divergent-escape recognizer needs the full speed pipeline (LICM preamble +
// i32-narrowed pixel IV), so compare at 'speed' with vectorization the only delta.
const ESC_VEC = { optimize: 'speed' }
const ESC_SCALAR = { optimize: { level: 'speed', vectorizeLaneLocal: false } }
// Run both pipelines, return [scalarChecksum, simdChecksum, vectorized?].
const escRun = (src) => {
  const s = runVec(src, ESC_SCALAR), d = runVec(src, ESC_VEC)
  s.render(); d.render()
  return [s.cs() >>> 0, d.cs() >>> 0, /v128\.bitselect/.test(wat(src, ESC_VEC))]
}

test('escape-time f64x2 - mandelbrot bit-exact + vectorized', () => {
  const [sc, dc, vec] = escRun(escKern(64,64,256,-2.0,2.5/64,-1.25,2.5/64, MANDEL))
  is(dc, sc); ok(vec, 'SIMD lockstep fired')
})

test('escape-time f64x2 - odd width falls to scalar tail (bit-exact)', () => {
  const [sc, dc, vec] = escRun(escKern(63,64,256,-2.0,2.5/63,-1.25,2.5/64, MANDEL))
  is(dc, sc); ok(vec, 'even pixels still vectorized')
})

test('escape-time f64x2 - all-escape@0 (far field)', () => {
  const [sc, dc] = escRun(escKern(32,32,64,10.0,1.0,10.0,1.0, MANDEL))
  is(dc, sc)
})

test('escape-time f64x2 - never-escape interior (it=MAXIT)', () => {
  const [sc, dc] = escRun(escKern(32,32,128,-0.5,0.001,0.0,0.001, MANDEL))
  is(dc, sc)
})

test('escape-time f64x2 - MAXIT edges (1, 2, 3)', () => {
  for (const m of [1, 2, 3]) {
    const [sc, dc] = escRun(escKern(32,16,m,-2.0,2.5/32,-1.25,2.5/16, MANDEL))
    is(dc, sc, `MAXIT=${m}`)
  }
})

test('escape-time f64x2 - high MAXIT=1000', () => {
  const [sc, dc] = escRun(escKern(48,48,1000,-2.0,2.5/48,-1.25,2.5/48, MANDEL))
  is(dc, sc)
})

test('escape-time f64x2 - julia (fixed c, invariant lanes) + odd width', () => {
  const [sc1, dc1, vec1] = escRun(escKern(64,64,256,-1.5,3.0/64,-1.5,3.0/64, JULIA))
  is(dc1, sc1); ok(vec1, 'julia vectorized')
  const [sc2, dc2] = escRun(escKern(65,40,256,-1.5,3.0/65,-1.5,3.0/40, JULIA))
  is(dc2, sc2)
})

// Burning-ship structure: escape break is AFTER the z-update (not before), the
// squares are inlined (no x2/y2 temps), the update uses Math.abs, the output is a
// smooth colour read from the post-loop z, and the store uses a parallel `j`
// counter (j++ alongside qx++). Exercises the general masking (escape mid-break at
// any position), carried-vs-temp classification, the colour epilogue (extract
// per-lane x/y/it → run scalar colour ×2), and parallel pixel IVs.
const SHIP = (W, H, MAXIT, colour) => `
  let W=${W}, H=${H}, MAXIT=${MAXIT}
  let out = new Uint32Array(W*H)
  export let render = (cx, cy, scale) => {
    let j = 0, py = 0
    while (py < H) {
      let ry = py*scale + cy
      let qx = 0
      while (qx < W) {
        let rx = qx*scale + cx
        let x=0.0, y=0.0, it=0
        while (it < MAXIT) {
          let xt = x*x - y*y + rx
          y = 2.0*Math.abs(x*y) + ry
          x = xt
          if (x*x + y*y > 256.0) break
          it++
        }
        ${colour}
        j++; qx++
      }
      py++
    }
  }
  export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }
`
const SHIP_SMOOTH = `
  let gv = 0
  if (it < MAXIT) {
    let sqd = x*x + y*y
    let v = (it + 1.0 - Math.log2(0.5*Math.log(sqd))) / MAXIT
    if (v < 0.0) v = 0.0
    if (v > 1.0) v = 1.0
    gv = (Math.sqrt(v)*255.0)|0
  }
  out[j] = (255<<24)|(gv<<16)|(gv<<8)|gv`
const SHIP_INT = `out[j] = it`   // integer output through the parallel-counter store
const shipRun = (src, ...a) => {
  const sx = runVec(src, ESC_SCALAR), dx = runVec(src, ESC_VEC)
  sx.render(...a); dx.render(...a)
  // Achievement pin: the escape-after-update (ship) shape must take the break-on-first-escape
  // FAST path — vectorized (f64x2) AND free of the per-iteration v128.bitselect freeze that left
  // the old masked SIMD ~parity-or-slower than V8. Both together are what beat V8 (burning-ship
  // 1.46×). Regressing to the masked path re-adds bitselect; to scalar drops f64x2 — either trips it.
  const w = wat(src, ESC_VEC)
  return [sx.cs() >>> 0, dx.cs() >>> 0, /f64x2\./.test(w) && !/v128\.bitselect/.test(w)]
}

test('escape-time f64x2 - burning-ship (escape-after-update, abs, colour epilogue)', () => {
  const [sc, dc, vec] = shipRun(SHIP(96, 96, 200, SHIP_SMOOTH), -0.5, -0.5, 0.02)
  is(dc, sc); ok(vec, 'ship vectorized')
})

test('escape-time f64x2 - burning-ship odd width + zoom regimes', () => {
  for (const [w, h, cx, cy, sc] of [[97,64,-0.5,-0.5,0.03],[80,80,-1.75,-0.03,0.001],[128,72,0.0,0.0,0.05]]) {
    const [a, b] = shipRun(SHIP(w, h, 200, SHIP_SMOOTH), cx, cy, sc)
    is(b, a, `ship ${w}x${h}`)
  }
})

test('escape-time f64x2 - parallel-counter store (j++) integer output', () => {
  const [sc, dc, vec] = shipRun(SHIP(64, 48, 256, SHIP_INT), -1.8, -0.08, 0.04)
  is(dc, sc); ok(vec, 'parallel-counter store vectorized')
})

test('escape-time f64x2 - burning-ship tiny widths (1,2,3 → tail)', () => {
  for (const w of [1, 2, 3]) {
    const [a, b] = shipRun(SHIP(w, 32, 200, SHIP_SMOOTH), -1.0, -0.5, 0.05)
    is(b, a, `ship width=${w}`)
  }
})

// Dual-exit structure (example-mandelbrot): the ESCAPE is the while-condition (with
// squares tee'd in the guard and reused in the body), the it-LIMIT is a mid-break, the
// pixel IV is f64 (param-bound `while (x < width)`), and the colour reads post-loop z.
// Exercises: symmetric top/mid keep matching (escape-at-top), tee extraction, the
// f64-converted limit compare (iter kept as f64x2), and f64 pixel-IV stepping.
const DUAL = (limit, colour) => `
  let mem = new Uint32Array(1<<18)
  const BAILOUT = 4.0, MAXIT = ${limit}
  export let render = (width, height, scale, cx, cy) => {
    let y = 0
    while (y < height) {
      let imag = y*scale + cy
      let x = 0
      while (x < width) {
        let real = x*scale + cx
        let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0, it = 0
        while ((ixSq = ix*ix) + (iySq = iy*iy) <= BAILOUT) {
          iy = 2.0*ix*iy + imag
          ix = ixSq - iySq + real
          if (it >= MAXIT) break
          it++
        }
        ${colour}
        x++
      }
      y++
    }
  }
  export let cs = (n) => { let h=0x811c9dc5|0; for(let i=0;i<n;i++) h=((h^mem[i])*0x01000193)|0; return h>>>0 }
`
const DUAL_SMOOTH = `
  let col = 0
  let sqd = ix*ix + iy*iy
  if (sqd > BAILOUT) {
    let v = (it + 1.0 - Math.log2(0.5*Math.log(sqd))) / MAXIT
    if (v < 0.0) v = 0.0
    if (v > 1.0) v = 1.0
    col = (v*255.0)|0
  }
  mem[(y*width + x)|0] = col`
const DUAL_INT = `mem[(y*width + x)|0] = it`
const dualRun = (src, ...a) => {
  const s = runVec(src, ESC_SCALAR), d = runVec(src, ESC_VEC)
  s.render(...a); d.render(...a)
  // escape-at-top (escape = while-cond) must also take the break-on-first FAST path: vectorized
  // (f64x2) AND no per-iteration freeze (v128.bitselect). That's the speedup cause (Julia 1.19×).
  const w = wat(src, ESC_VEC)
  return [s.cs(4096) >>> 0, d.cs(4096) >>> 0, /f64x2\./.test(w) && !/v128\.bitselect/.test(w)]
}

test('escape-time f64x2 - dual-exit smooth colour (escape=while-cond, f64 IV)', () => {
  const [sc, dc, vec] = dualRun(DUAL(256, DUAL_SMOOTH), 64, 48, 0.05, -2.0, -1.2)
  is(dc, sc); ok(vec, 'dual-exit vectorized')
})

test('escape-time f64x2 - dual-exit integer + odd width + low limit', () => {
  let r = dualRun(DUAL(256, DUAL_INT), 64, 48, 0.05, -2.0, -1.2); is(r[1], r[0]); ok(r[2])
  r = dualRun(DUAL(256, DUAL_SMOOTH), 63, 40, 0.06, -2.0, -1.2); is(r[1], r[0])
  r = dualRun(DUAL(3, DUAL_SMOOTH), 48, 32, 0.08, -2.0, -1.2); is(r[1], r[0])
})

// --- Regression: two miscompiles found by adversarial verification ---

// CLASS A — NaN masking. A single-component escape (`zx > 2`) lets the orbit overflow to
// Inf→NaN WITHOUT escaping; scalar `NOT(NaN > 2)` is true (keeps iterating to MAXIT), so the
// SIMD keep must also be true on NaN. Lowering ¬(a>b) as `a<=b` is false on NaN and would
// wrongly deactivate the lane — the keep must be v128.not(direct compare).
test('escape-time f64x2 - NaN keep: single-component escape (zx>2 / zy>2)', () => {
  const mk = (comp) => `
    const W=64, H=64, MAXIT=64, X0=-2.0, DX=4.0/64, Y0=-2.0, DY=4.0/64
    let out = new Uint32Array(W*H)
    export let render = () => {
      for (let py=0; py<H; py++) { let cy=Y0+py*DY
        for (let px=0; px<W; px++) { let cx=X0+px*DX
          let zx=0.0, zy=0.0, i=0
          while (i<MAXIT) { let x2=zx*zx, y2=zy*zy; zy=2.0*zx*zy+cy; if (${comp})break; zx=x2-y2+cx; i++ }
          out[py*W+px]=i } } }
    export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }`
  for (const comp of ['zx>2.0', 'zy>2.0']) {
    const src = mk(comp)
    const s = runVec(src, ESC_SCALAR), d = runVec(src, ESC_VEC)
    s.render(); d.render()
    is(d.cs() >>> 0, s.cs() >>> 0, `escape ${comp}`)
    ok(/v128\.bitselect/.test(wat(src, ESC_VEC)), `${comp} vectorized`)
  }
})

// CLASS B — per-pixel c-var derived from another per-pixel c-var. `bail = 4 + cx*cx` (cx
// itself derived from the pixel IV) must give lane 1 the cx(px+1)-based threshold; a px-only
// substitution can't follow the cx chain, so lanes are built by lifting the init through each
// dependency's already-built lane.
test('escape-time f64x2 - per-pixel threshold derived from a c-var', () => {
  const mk = (bail) => `
    const W=64, H=64, MAXIT=64, X0=-2.0, DX=4.0/64, Y0=-2.0, DY=4.0/64
    let out = new Uint32Array(W*H)
    export let render = () => {
      for (let py=0; py<H; py++) { let cy=Y0+py*DY
        for (let px=0; px<W; px++) { let cx=X0+px*DX
          let zx=0.0, zy=0.0, i=0
          let bail = ${bail}
          while (i<MAXIT) { let x2=zx*zx, y2=zy*zy; if (x2+y2>bail)break; zy=2.0*zx*zy+cy; zx=x2-y2+cx; i++ }
          out[py*W+px]=i } } }
    export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }`
  for (const bail of ['4.0+cx*cx', '4.0+cx*cy', '4.0+cx*cx+cy*cy']) {
    const src = mk(bail)
    const s = runVec(src, ESC_SCALAR), d = runVec(src, ESC_VEC)
    s.render(); d.render()
    is(d.cs() >>> 0, s.cs() >>> 0, `bail=${bail}`)
    ok(/v128\.bitselect/.test(wat(src, ESC_VEC)), `bail=${bail} vectorized`)
  }
})

test('SIMD multi-pixel - 4-pixel RGBA box blur (the Zig-matcher)', () => {
  // tryBlurMultiPixel: 4 output pixels per iteration, 16-byte v128.load → two i16x8
  // accumulators (AoS aligns, no shuffle), divide+store per pixel, scalar ≤3 remainder.
  // Fires only on the clamp-free interior the peel produced; must be bit-exact vs the
  // 1-pixel channel-reduce fallback across dims, radii, odd widths, and the remainder seam.
  const blur = (w, h, r) => `export let main = () => {
    const src = new Uint8Array(${w * h * 4}), dst = new Uint8Array(${w * h * 4})
    let s = 0x1234abcd|0
    for (let i = 0; i < ${w * h * 4}; i++) { s ^= s<<13; s ^= s>>>17; s ^= s<<5; src[i] = (s>>>0)&255 }
    const ww = ${w}|0, hh = ${h}|0, rr = ${r}|0, win = 2*rr+1
    for (let y = 0; y < hh; y++) { const row = y*ww
      for (let x = 0; x < ww; x++) {
        let sr=0,sg=0,sb=0,sa=0
        for (let k=-rr; k<=rr; k++) { let xi=x+k; if(xi<0)xi=0; else if(xi>=ww)xi=ww-1; const p=(row+xi)<<2; sr+=src[p];sg+=src[p+1];sb+=src[p+2];sa+=src[p+3] }
        const o=(row+x)<<2; dst[o]=(sr/win)|0; dst[o+1]=(sg/win)|0; dst[o+2]=(sb/win)|0; dst[o+3]=(sa/win)|0
      } }
    let acc = 0; for (let i = 0; i < ${w * h * 4}; i++) acc = (acc + dst[i])|0
    return acc
  }`
  const ON = { optimize: 'speed' }, OFF = { optimize: { level: 'speed', blurMultiPixel: false } }
  for (const [w, h, r] of [[64, 8, 4], [63, 5, 4], [17, 3, 2], [15, 4, 1], [14, 4, 2], [8, 8, 3], [7, 7, 2], [6, 3, 1], [5, 5, 1], [4, 4, 0], [3, 3, 1], [9, 9, 3]])
    is(runVec(blur(w, h, r), ON).main(), runVec(blur(w, h, r), OFF).main(), `blur ${w}x${h} r=${r}`)
  ok(/i16x8\.extend_high/.test(wat(blur(64, 8, 4), ON)), '4-pixel SIMD must fire')
  ok(!/i16x8\.extend_high/.test(wat(blur(64, 8, 4), OFF)), 'disabled by blurMultiPixel:false')
})

test('SIMD multi-pixel - vertical box blur (outer-loop peel + 4-pixel SIMD)', () => {
  // The vertical pass taps the OUTER y-loop (yi=y+k, index (yi*w+x)<<2). clamp-peel
  // must peel that outer loop (its body is a single inner loop, not a `;` sequence),
  // after which the 4-pixel SIMD fires on the inner x-loop. Bit-exact vs the fallback.
  const vblur = (w, h, r) => `export let main = () => {
    const src = new Uint8Array(${w * h * 4}), dst = new Uint8Array(${w * h * 4})
    let s = 0x1234abcd|0
    for (let i = 0; i < ${w * h * 4}; i++) { s ^= s<<13; s ^= s>>>17; s ^= s<<5; src[i] = (s>>>0)&255 }
    const ww = ${w}|0, hh = ${h}|0, rr = ${r}|0, win = 2*rr+1
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < ww; x++) {
        let sr=0,sg=0,sb=0,sa=0
        for (let k=-rr; k<=rr; k++) { let yi=y+k; if(yi<0)yi=0; else if(yi>=hh)yi=hh-1; const p=(yi*ww+x)<<2; sr+=src[p];sg+=src[p+1];sb+=src[p+2];sa+=src[p+3] }
        const o=(y*ww+x)<<2; dst[o]=(sr/win)|0; dst[o+1]=(sg/win)|0; dst[o+2]=(sb/win)|0; dst[o+3]=(sa/win)|0
      }
    let acc = 0; for (let i = 0; i < ${w * h * 4}; i++) acc = (acc + dst[i])|0
    return acc
  }`
  const ON = { optimize: 'speed' }, OFF = { optimize: { level: 'speed', blurMultiPixel: false } }
  for (const [w, h, r] of [[64, 8, 4], [63, 7, 3], [17, 9, 2], [15, 5, 1], [8, 8, 3], [7, 7, 2], [5, 5, 1], [9, 9, 4], [4, 4, 1]])
    is(runVec(vblur(w, h, r), ON).main(), runVec(vblur(w, h, r), OFF).main(), `vblur ${w}x${h} r=${r}`)
  ok(/i16x8\.extend_high/.test(wat(vblur(64, 8, 4), ON)), '4-pixel SIMD must fire on the vertical pass')
})

test('SIMD channel order - permuted RGBA channels stay positionally correct', () => {
  // Both channel-SIMD lifts (1-pixel tryChannelReduce and 4-pixel tryBlurMultiPixel)
  // map v128 lane c to the accumulator that summed SOURCE byte-offset c. The recognizer
  // ties that to read-offset order, but the lane→accumulator extract must use that same
  // order — not the zero-init order. They coincide for an identity-order blur, so a
  // permutation-insensitive SUM checksum can't see a mis-map. This program permutes which
  // channel each accumulator reads/stores and checks a POSITION-SENSITIVE rolling hash, so
  // a lane mis-map diverges. Oracle = the unoptimized (no-SIMD) compile.
  // rp[off] = accumulator (0..3) fed by source offset `off`; sp[m] = accumulator stored at
  // output offset m. acc names a0..a3.
  const rd = (acc, off) => `${acc}+=src[${off === 0 ? 'p' : 'p+' + off}]`
  const wr = (off, acc) => `dst[${off === 0 ? 'o' : 'o+' + off}]=(${acc}/win)|0`
  const blur = (w, r, rp, sp) => `export let main = () => {
    const W=${w}|0, R=${r}|0, N=W*4, src=new Uint8Array(N), dst=new Uint8Array(N)
    let s = 0x1234abcd|0
    for (let i=0;i<N;i++){ s^=s<<13; s^=s>>>17; s^=s<<5; src[i]=(s>>>0)&255 }
    const win=2*R+1
    for (let x=0;x<W;x++){ let a0=0,a1=0,a2=0,a3=0
      for (let k=-R;k<=R;k++){ let xi=x+k; if(xi<0)xi=0; else if(xi>=W)xi=W-1; const p=xi<<2
        ${[0, 1, 2, 3].map(off => rd('a' + rp[off], off)).join('; ')} }
      const o=x<<2; ${[0, 1, 2, 3].map(m => wr(m, 'a' + sp[m])).join('; ')} }
    let h=0; for (let i=0;i<N;i++) h=(h*31+dst[i])|0; return h
  }`
  const ON = { optimize: 'speed' }, NO = { optimize: { vectorizeLaneLocal: false } }   // SIMD vs scalar oracle
  const id = [0, 1, 2, 3]
  // identity store (sp=id) lets the 4-pixel lift fire; varied read perms exercise the map.
  const perms = [[0, 1, 2, 3], [3, 0, 2, 1], [1, 0, 3, 2], [2, 3, 0, 1], [3, 2, 1, 0]]
  let firedB = false
  for (const w of [20, 67]) for (const r of [2, 4]) for (const rp of perms) {
    const src = blur(w, r, rp, id)
    is(runVec(src, ON).main(), runVec(src, NO).main(), `chan-perm w=${w} r=${r} rp=${rp}`)
    if (/i16x8\.extend_high/.test(wat(src, ON))) firedB = true
  }
  ok(firedB, '4-pixel SIMD must fire on a permuted-channel blur (else the test is hollow)')
  // a non-identity read perm with the channel-reduce path (narrow width → no 4-pixel lift)
  is(runVec(blur(6, 1, [3, 0, 2, 1], id), ON).main(), runVec(blur(6, 1, [3, 0, 2, 1], id), NO).main(), 'chan-reduce permuted')
})

test('SIMD multi-pixel - soundness guards bail on non-canonical blurs', () => {
  // The 4-pixel lift reads 16 source bytes (4 pixels) with ONE v128.load and reuses the
  // scalar store template per pixel. That is sound ONLY when (a) consecutive output
  // pixels read CONSECUTIVE source pixels — the source address advances exactly 4 bytes
  // per pivot step — and (b) the store value does not depend on the pivot. These shapes
  // violate one or the other; B must bail (→ 1-pixel chan-reduce) and stay bit-exact.
  // Position-sensitive rolling hash so any lane mis-map shows. Oracle = no-SIMD compile.
  const ON = { optimize: 'speed' }, NO = { optimize: { vectorizeLaneLocal: false } }
  const wrap = (w, body) => `export let main = () => {
    const W=${w}|0, H=8|0, R=4|0, N=W*H*4, src=new Uint8Array(N*4), dst=new Uint8Array(N)
    let s = 0x1234abcd|0
    for (let i=0;i<N*4;i++){ s^=s<<13; s^=s>>>17; s^=s<<5; src[i]=(s>>>0)&255 }
    const win=2*R+1
    for (let y=0;y<H;y++){ const row=y*W
      for (let x=0;x<W;x++){ let sr=0,sg=0,sb=0,sa=0
        ${body}
        const o=(row+x)<<2; dst[o]=(sr/win)|0; dst[o+1]=(sg/win)|0; dst[o+2]=(sb/win)|0; dst[o+3]=(sa/win)|0 } }
    let h=0; for (let i=0;i<N;i++) h=(h*31+dst[i])|0; return h
  }`
  // (a) stride-2 source: 4 outputs read source columns x*2 — not consecutive.
  const stride2 = wrap(64, `for (let k=-R;k<=R;k++){ const xi=x+k, p=(xi*2+row)<<2; sr+=src[p];sg+=src[p+1];sb+=src[p+2];sa+=src[p+3] }`)
  // (a) non-constant stride: column x*(1+k) varies per tap.
  const varstride = wrap(64, `for (let k=-R;k<=R;k++){ const p=(row + x + k*x)<<2; sr+=src[p];sg+=src[p+1];sb+=src[p+2];sa+=src[p+3] }`)
  // (b) pivot in the store value: (sr+x) reused for all 4 pixels would use the wrong x.
  const pivotStore = `export let main = () => {
    const W=64|0,H=8|0,R=4|0,N=W*H*4,src=new Uint8Array(N),dst=new Uint8Array(N)
    let s=0x1234abcd|0; for (let i=0;i<N;i++){ s^=s<<13; s^=s>>>17; s^=s<<5; src[i]=(s>>>0)&255 }
    for (let y=0;y<H;y++){ const row=y*W
      for (let x=0;x<W;x++){ let sr=0,sg=0,sb=0,sa=0
        for (let k=-R;k<=R;k++){ let xi=x+k; if(xi<0)xi=0; else if(xi>=W)xi=W-1; const p=(row+xi)<<2; sr+=src[p];sg+=src[p+1];sb+=src[p+2];sa+=src[p+3] }
        const o=(row+x)<<2; dst[o]=(sr+x)&255; dst[o+1]=(sg+x)&255; dst[o+2]=(sb+x)&255; dst[o+3]=(sa+x)&255 } }
    let h=0; for (let i=0;i<N;i++) h=(h*31+dst[i])|0; return h }`
  for (const [name, src] of [['stride-2 source', stride2], ['non-constant stride', varstride], ['pivot in store value', pivotStore]]) {
    is(runVec(src, ON).main(), runVec(src, NO).main(), `${name}: bit-exact`)
    ok(!/i16x8\.extend_high/.test(wat(src, ON)), `${name}: 4-pixel lift must bail`)
  }
})

test('SIMD vectorize - LICM preamble before the loop: pure lifts, impure bails', () => {
  // tryVectorize accepts a PURE LICM-hoisted invariant `(local.set $__liN …)` ahead of
  // the inner loop (the particle integrator's G*DT) — cloning it before the SIMD block —
  // and f64x2-lifts the SoA update, bit-exact. It must NOT be lured into vectorizing a
  // loop whose block preamble carries a SIDE EFFECT (a for-in's `$__inl_ptr = (call
  // $__alloc …)`): cloning that would allocate twice and miscompile.
  const ON = { optimize: 'speed' }, NO = { optimize: { level: 'speed', vectorizeLaneLocal: false } }
  const integ = `export let main = () => {
    const N=1024, vx=new Float64Array(N), x=new Float64Array(N)
    let s=0x1234abcd|0
    for (let i=0;i<N;i++){ s^=s<<13; s^=s>>>17; s^=s<<5; vx[i]=(s>>>0)/4294967296-0.5; x[i]=i*0.25 }
    const step = (vx, x, n, dvy) => { for (let i=0;i<n;i++){ vx[i]=vx[i]+dvy; x[i]=x[i]+vx[i]*0.5 } }
    for (let f=0;f<128;f++) step(vx, x, N, -0.153125)
    let acc=0; for (let i=0;i<N;i++) acc+=x[i]; return (acc*1000)|0
  }`
  is(runVec(integ, ON).main(), runVec(integ, NO).main(), 'SoA f64 integrator bit-exact')
  ok(/f64x2/.test(wat(integ, ON)), 'SoA f64 integrator must f64x2-vectorize')
  // a for-in over an object literal compiles the object to an alloc'd buffer, so its
  // block preamble is the impure `$__inl_ptr = (call $__alloc …)`. The cover-paren LHS
  // assigns the key into a scalar `x` each step — must stay scalar (no v128) and correct.
  const forin = `export let main = () => { let x=0; let n=0; for ((x) in {a:1,b:2,c:3}) n=n+1; return n }`
  is(runVec(forin, ON).main(), runVec(forin, NO).main(), 'impure-setup for-in bit-exact')
  ok(!/v128|f64x2|i32x4\./.test(wat(forin, ON)), 'impure-setup for-in must NOT vectorize')
})

test('SIMD map-reduce - bit-exact f64 reduction (the n-body force loop)', () => {
  // A loop with MULTIPLE f64 accumulators whose per-iteration contributions are
  // independent of the accumulators (direct-summation gravity). It vectorizes 2
  // interactions per step in f64x2 then accumulates each lane IN SCALAR ORDER, so the
  // reduction is BIT-EXACT vs the unoptimized scalar truth (every f64x2 op is IEEE-754-
  // identical per lane; the per-accumulator addition order is preserved). Odd N exercises
  // the ≤1-element scalar remainder.
  const nb = (N) => `export let main = () => {
    const N=${N}, px=new Float64Array(N), py=new Float64Array(N), pz=new Float64Array(N), mm=new Float64Array(N)
    let s=0x1234abcd|0
    for(let i=0;i<N;i++){ s^=s<<13;s^=s>>>17;s^=s<<5; px[i]=(s>>>0)/4294967296*2-1; py[i]=i*0.013-3; pz[i]=i*0.007; mm[i]=1+(i&7)*0.1 }
    let acc=0
    for(let it=0;it<4;it++) for(let i=0;i<N;i++){
      const xi=px[i],yi=py[i],zi=pz[i]; let ax=0,ay=0,az=0
      for(let j=0;j<N;j++){ const dx=px[j]-xi,dy=py[j]-yi,dz=pz[j]-zi
        const r2=dx*dx+dy*dy+dz*dz+0.05; const inv=1/(r2*Math.sqrt(r2)); const f=mm[j]*inv
        ax+=dx*f; ay+=dy*f; az+=dz*f }
      acc += ax*0.013 + ay*0.017 + az*0.019 }
    return (acc*1e6)|0 }`
  const ON = { optimize: 'speed' }, O0 = { optimize: false }   // O0 = scalar ground truth
  for (const N of [9, 16, 17, 64, 65, 128, 256, 257])
    is(runVec(nb(N), ON).main(), runVec(nb(N), O0).main(), `n-body N=${N} bit-exact`)
  ok(/f64x2\.sqrt/.test(wat(nb(64), ON)), 'f64x2 map-reduce must fire on the n-body force loop')
})

test('SIMD reduce - offset-indexed dot (matmul A[off+i]*B[off+i]) folds the invariant into the base', () => {
  // The index `off+i` lowers to (i32.shl (i32.add off i) 3), which matchLaneAddr rejects
  // (the IV isn't the bare shift operand). tryReduceVectorize folds the loop-invariant
  // `off` into the base — (base + (off+i)<<3) → ((base + off<<3) + i<<3) — so the offset
  // is the bare IV the matcher/lifter accept; the byte address is unchanged ⇒ bit-exact.
  // Small-int data keeps the product-sum exact in f64. This is the inner dot of a
  // transposed matmul C = A·Bᵀ, the canonical offset-indexed reduction.
  const mm = (N) => `export let main = () => {
    const N=${N}, A=new Float64Array(N*N), B=new Float64Array(N*N), C=new Float64Array(N*N)
    for(let i=0;i<N*N;i++){ A[i]=(i%13)-6; B[i]=((i*7)%11)-5 }
    for(let i=0;i<N;i++){ const ai=i*N
      for(let j=0;j<N;j++){ const bj=j*N
        let s=0; for(let k=0;k<N;k++) s+=A[ai+k]*B[bj+k]; C[i*N+j]=s } }
    let h=0; for(let i=0;i<N*N;i++) h=(h+(C[i]|0))|0; return h }`
  const ON = { optimize: 'speed' }, O0 = { optimize: false }   // O0 = scalar ground truth
  // N≥8 so the inner k-loop actually reaches the SIMD width; N≤4 is left to a
  // separate, pre-existing watOptimize miscompile of tiny matmuls (unrelated to the
  // fold — it reproduces with vectorizeLaneLocal:false).
  for (const N of [8, 9, 16, 17, 32, 64])
    is(runVec(mm(N), ON).main(), runVec(mm(N), O0).main(), `matmul N=${N} offset-dot bit-exact`)
  ok(hasV128(wat(mm(16), ON)), 'offset-indexed dot must vectorize (INV folded into base)')
})

// ── Stencil vectorizer (tryStencil, experimental) ─────────────────────────────
// Neighbour loads `a[i±1]` / 2-D `a[c±1]`, a[rn+x] (c = rc+x derived IV). The lift is
// address-preserving (each f64.load → v128.load at the SAME address ⇒ the δ-shifted
// pair), so it's BIT-EXACT vs the scalar oracle (a lane-parallel map reorders nothing
// within a lane — unlike a horizontal reduction). Opt-in behind experimentalStencil.
const STENCIL = { optimize: 'speed', experimentalStencil: true }
// Oracle: SAME pipeline with the stencil pass OFF (its loop stays scalar) — so the
// shared checksum-reduction vectorizes identically in both and cancels; only the
// stencil loop differs. (vs optimize:false the checksum would reassociate ⇒ ulp noise.)
const SCALAR = { optimize: 'speed' }

test('SIMD stencil - 3-point bit-exact + vectorized (incl. odd-width tail)', () => {
  if (belowOpt(2)) return
  const src = (k) => `
    let a = new Float64Array(320), b = new Float64Array(320)
    export let main = () => {
      let i = 0; while (i < 320) { a[i] = Math.sin(i*0.1)*1.3 + i*0.001; i++ }
      for (let j = 1; j < ${k}; j++) b[j] = a[j-1] + a[j] + a[j+1]
      let s = 0.0, t = 0; while (t < ${k}) { s += b[t]; t++ }
      return s
    }`
  for (const k of [301, 300, 200, 17, 16, 3])
    is(runVec(src(k), STENCIL).main(), runVec(src(k), SCALAR).main(), `3-point k=${k} bit-exact`)
  const w = wat(src(301), STENCIL)
  ok(hasV128(w), 'stencil vectorized')
  ok(/v128\.load offset/.test(w), 'a[j+1] folds onto a[j] tee via memarg offset')
})

test('SIMD stencil - 5-point with derived IV (c = rc + x) bit-exact', () => {
  if (belowOpt(2)) return
  // 2-D laplacian-ish sweep over distinct read/write buffers — the waves shape.
  const src = (n) => `
    let a = new Float64Array(${n*n}), b = new Float64Array(${n*n})
    export let main = () => {
      let i = 0; while (i < ${n*n}) { a[i] = Math.sin(i*0.07)*2.0 + (i&15)*0.01; i++ }
      let w = ${n}, y = 1
      while (y < ${n-1}) {
        let rc = y * w, rn = rc - w, rs = rc + w, x = 1
        while (x < w - 1) {
          let c = rc + x
          b[c] = a[rn+x] + a[rs+x] + a[c-1] + a[c+1] - 4.0 * a[c]
          x++
        }
        y++
      }
      let s = 0.0, t = 0; while (t < ${n*n}) { s += b[t]; t++ }
      return s
    }`
  for (const n of [24, 25, 16])
    is(runVec(src(n), STENCIL).main(), runVec(src(n), SCALAR).main(), `5-point n=${n} bit-exact`)
  ok(hasV128(wat(src(24), STENCIL)), '5-point stencil with derived IV vectorized')
})

test('SIMD stencil - inline row base (idx = y*w + x) bit-exact', () => {
  if (belowOpt(2)) return
  // No precomputed row-base local: the index is `y*w + x` inline. ivCoeff treats the
  // invariant×invariant `y*w` as coeff 0, so `idx` is still a stride-1 derived IV.
  const src = (n) => `
    let a = new Float64Array(${n*n}), b = new Float64Array(${n*n})
    export let main = () => {
      let i = 0; while (i < ${n*n}) { a[i] = Math.sin(i*0.07)*2.0; i++ }
      let w = ${n}, h = ${n}, y = 1
      while (y < h-1) { let x = 1; while (x < w-1) { let idx = y*w + x; b[idx] = a[idx-1] + a[idx+1] - 2.0*a[idx]; x++ } y++ }
      let s = 0.0, t = 0; while (t < ${n*n}) { s += b[t]; t++ }
      return s
    }`
  for (const n of [24, 25])
    is(runVec(src(n), STENCIL).main(), runVec(src(n), SCALAR).main(), `inline-row n=${n} bit-exact`)
  ok(hasV128(wat(src(24), STENCIL)), 'inline y*w+x stencil vectorized')
})

test('SIMD stencil - in-place (a[i]=a[i-1]+a[i]) is loop-carried: bails, stays correct', () => {
  if (belowOpt(2)) return
  // Reading the WRITTEN array at a shifted index is loop-carried — SIMD would read
  // stale data. tryStencil must bail; the result must equal the scalar oracle.
  const src = `
    let a = new Float64Array(128)
    export let main = () => {
      let i = 0; while (i < 128) { a[i] = (i % 7) * 0.5 + 1.0; i++ }
      for (let j = 1; j < 120; j++) a[j] = a[j-1] + a[j]
      let s = 0.0, t = 0; while (t < 128) { s += a[t]; t++ }
      return s
    }`
  is(runVec(src, STENCIL).main(), runVec(src, SCALAR).main(), 'in-place stays bit-exact (bailed)')
  // The store-back is the signature: an in-place stencil that vectorized would v128.store
  // the computed lane back to `a`. The legit loops don't store-vectorize (the `i%7` init
  // isn't lane-pure; the reduction accumulates in a local), so NO v128.store ⇒ the stencil
  // bailed. (Was `!/v128.load offset/` — stale since the reduction's v128 loads now fold to
  // `offset=` form via the v128 memarg fold, so a load-offset is no longer stencil-specific.)
  ok(!/v128\.store/.test(wat(src, STENCIL)), 'in-place stencil not vectorized (no v128 store-back)')
})

// ── Per-pixel-color vectorizer (tryPerPixelColor) ─────────────────────────────
// Achievement pin: a pixel loop that computes an f64 value from the index (cos/sin/sqrt…), packs
// it to a u32 colour and stores it — no inner loop — lifts two adjacent pixels into f64x2 lanes
// (transcendentals → the bit-exact $math.*2 mirrors, the pack runs scalar per lane). This made
// chladni 2.28× and interference 1.14× vs V8. Wall-clock is machine-dependent, so pin the cause:
// the kernel takes the per-pixel-color path AND is BIT-EXACT to the scalar build (SIMD vs the
// vectorizer disabled — the strongest correctness gate; odd widths exercise the scalar tail).
const PPC_ON = { optimize: 'speed' }, PPC_NO = { optimize: { level: 'speed', vectorizeLaneLocal: false } }
const PPC_TRIG = (W, H) => `
  let W=${W}, H=${H}
  let out = new Uint32Array(W*H)
  export let render = (t) => {
    let j=0, py=0
    while (py < H) {
      let cyn = Math.cos(py*0.05 + t)            // hoisted per row
      let qx = 0
      while (qx < W) {
        let x = qx*0.05
        let f = Math.cos(x*3.0)*cyn - Math.cos(x*2.0)
        let g = (Math.abs(f)*127.0)|0
        if (g > 255) g = 255
        out[j] = (255<<24)|(g<<16)|(g<<8)|g
        j++; qx++
      }
      py++
    }
  }
  export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }`

test('per-pixel-color f64x2 - trig kernel (chladni shape: cos→u32, bit-exact + vectorized)', () => {
  const src = PPC_TRIG(64, 48)
  const on = runVec(src, PPC_ON), no = runVec(src, PPC_NO)
  on.render(0.7); no.render(0.7)
  is(on.cs() >>> 0, no.cs() >>> 0, 'trig per-pixel-color bit-exact vs scalar')
  const w = wat(src, PPC_ON)
  ok(/__ppc/.test(w), 'trig kernel takes the per-pixel-color path')
  ok(/call \$math\.cos2/.test(w), 'per-pixel Math.cos vectorized to the f64x2 $math.cos2 mirror')
})

test('per-pixel-color f64x2 - odd widths exercise the scalar tail (bit-exact)', () => {
  for (const W of [1, 2, 3, 7, 31, 65]) {
    const src = PPC_TRIG(W, 5)
    const on = runVec(src, PPC_ON), no = runVec(src, PPC_NO)
    on.render(0.3); no.render(0.3)
    is(on.cs() >>> 0, no.cs() >>> 0, `trig per-pixel-color width=${W} bit-exact`)
  }
})

// Phase 2: a sin+sqrt heavy pixel with an `a ** γ` sRGB pack. sin/sqrt go 2-wide; pow rides along
// via the $math.pow2 mirror (bit-exact per-lane scalar) so the surrounding f64x2 arithmetic stays
// vectorized. Both the conditional (→ v128.bitselect) and the |0 pack must stay bit-exact.
const PPC_POW = `
  let W=64, H=48
  let mem = new Uint32Array(W*H)
  export let render = (t) => {
    let py=0
    while (py < H) {
      let qx=0
      while (qx < W) {
        let off = py*W + qx
        let x = qx*0.04, y = py*0.04
        let a = Math.abs(Math.sin(Math.sqrt(x*x + y*y)*4.0 - t)) * 0.5
        let s = a <= 0.0031308 ? a*12.92 : 1.055*(a**(1.0/2.4)) - 0.055
        let vi = (s*255.0)|0
        if (vi > 255) vi = 255
        mem[off] = (255<<24)|(vi<<16)|(vi<<8)|vi
        qx++
      }
      py++
    }
  }
  export let cs = () => { let h=0x811c9dc5|0; for(let i=0;i<W*H;i++) h=((h^mem[i])*0x01000193)|0; return h>>>0 }`

test('per-pixel-color f64x2 - sin+sqrt+pow kernel (interference shape: bit-exact + pow2)', () => {
  const on = runVec(PPC_POW, PPC_ON), no = runVec(PPC_POW, PPC_NO)
  on.render(0.5); no.render(0.5)
  is(on.cs() >>> 0, no.cs() >>> 0, 'sin+sqrt+pow per-pixel-color bit-exact vs scalar')
  const w = wat(PPC_POW, PPC_ON)
  ok(/__ppc/.test(w), 'pow kernel takes the per-pixel-color path')
  ok(/call \$math\.sin2/.test(w) && /f64x2\.sqrt/.test(w), 'sin + sqrt vectorized 2-wide')
  ok(/call \$math\.pow2/.test(w), 'a**γ pow vectorized via the f64x2 $math.pow2 mirror (Phase 2)')
})

// ── Multi-caller SIMD-helper inlining (the size-for-speed `inline` pass) ──────────────────
// A hand-vectorized hot loop's per-step helper (e.g. a raymarcher's SDF) is called every
// iteration but never inlined by V8's wasm JIT, so the call overhead is pure tax. The speed
// level's `inline` pass duplicates such SMALL pure-v128 helpers into every caller and drops
// the function — removing the calls — while leaving level 2 (and SCALAR helpers, where jz's
// codegen-shape tuning + the auto-vectorizer's own call-lifting live) untouched.
const INLINE_SRC = `
let len = (x, y, z) => f32x4.sqrt(f32x4.add(f32x4.add(f32x4.mul(x, x), f32x4.mul(y, y)), f32x4.mul(z, z)))
let sdf = (x, y, z) => f32x4.sub(len(x, y, z), f32x4.splat(0.55))
export let main = (a, b, c) => {
  let p = f32x4.splat(a), q = f32x4.splat(b), r = f32x4.splat(c)
  let s = f32x4.add(f32x4.add(sdf(p, q, r), sdf(q, r, p)), sdf(r, p, q))
  return f32x4.lane(s, 0)
}`
test('SIMD inline - small v128 helpers fold into every caller at speed, bit-exact', () => {
  // Bit-exact: inlining is pure substitution, so the speed result must equal the level-2 (called) one.
  const base = runVec(INLINE_SRC, { optimize: 2 }), fast = runVec(INLINE_SRC, { optimize: 'speed' })
  for (const [a, b, c] of [[1.1, 2.2, 3.3], [0.5, -7.0, 4.25], [100.0, 1e-3, 1.5]])
    is(fast.main(a, b, c), base.main(a, b, c), `inlined SIMD helper bit-exact @ (${a},${b},${c})`)
  if (onKernel()) return  // call-shape is a host-codegen assertion; bit-exactness above is the portable gate
  // Level 2 keeps the 3 multi-caller sdf calls ($len, single-caller, inlineOnce folds even at L2);
  // speed removes every $len/$sdf call (the multi-caller chain fully collapses).
  is((wat(INLINE_SRC, { optimize: 2 }).match(/call \$(len|sdf)/g) || []).length, 3, 'level 2 keeps the 3 multi-caller sdf calls')
  is((wat(INLINE_SRC, { optimize: 'speed' }).match(/call \$(len|sdf)/g) || []).length, 0, 'speed inlines the whole SIMD helper chain → 0 calls')
})

// Integer convolution column-strip-mine (tryConvColumn): the int8 conv2d / dense-MAC kernel. After
// the K×K receptive-field loops unroll at speed, the output-column loop is a straight-line f64
// reduction `acc = bias + Σ inp[…+ox]·wt[…]` over int8 taps → requantize (>>SHIFT), ReLU-clamp,
// store uint8. Every product is int8×int8 so the f64 acc is an EXACT integer; the column loop
// strip-mines 8-wide as pure integer SIMD — `v128.load64_zero`+`i16x8.extend` gather, `i16x8.splat`
// weight, `i16x8.mul`, widened into two i32x4 accumulators; requant+store scalar per lane; the kept
// scalar loop is the <8 tail. BIT-EXACT (integer reorders nothing). OW=13 exercises the 8-lane body
// AND the 5-wide scalar tail. (~2.8× on bench/conv2d — jz overtakes clang→wasm, second only to native.)
const CONV_SRC = `
  const CIN=3, COUT=2, H=9, W=13, K=3, OH=7, OW=11, SHIFT=6
  let inp=new Int8Array(CIN*H*W), wt=new Int8Array(COUT*CIN*K*K), bias=new Int32Array(COUT), out=new Uint8Array(COUT*OH*OW)
  export let fill=()=>{ let x=0x1234abcd|0,i=0
    while(i<inp.length){x=(Math.imul(x,1103515245)+12345)|0; inp[i]=x>>24; i++}
    i=0; while(i<wt.length){x=(Math.imul(x,1103515245)+12345)|0; wt[i]=x>>24; i++}
    i=0; while(i<bias.length){x=(Math.imul(x,1103515245)+12345)|0; bias[i]=(x>>20)&255; i++} }
  export let conv=()=>{
    for(let oc=0;oc<COUT;oc++){ const b=bias[oc]; const ocBase=oc*OH*OW
      for(let oy=0;oy<OH;oy++){ for(let ox=0;ox<OW;ox++){ let acc=b
        for(let ic=0;ic<CIN;ic++){ const inCh=ic*H*W; const wCh=((oc*CIN)+ic)*K*K
          for(let ky=0;ky<K;ky++){ const irow=inCh+(oy+ky)*W+ox; const wrow=wCh+ky*K
            for(let kx=0;kx<K;kx++){ acc += inp[irow+kx]*wt[wrow+kx] } } }
        let q=acc>>SHIFT; if(q<0)q=0; if(q>127)q=127; out[ocBase+oy*OW+ox]=q } } } }
  export let cs=()=>{ let h=0x811c9dc5|0; for(let i=0;i<out.length;i++) h=((h^out[i])*0x01000193)|0; return h>>>0 }`
const CV_ON = { optimize: 'speed' }, CV_NO = { optimize: { level: 'speed', experimentalOuterStrip: false } }

test('conv-column i16x8 - int8 conv2d strip-mines the output column, bit-exact + vectorized', () => {
  const on = runVec(CONV_SRC, CV_ON), no = runVec(CONV_SRC, CV_NO)
  on.fill(); no.fill(); on.conv(); no.conv()
  is(on.cs() >>> 0, no.cs() >>> 0, 'int8 conv2d column strip-mine bit-exact vs scalar (8-wide body + scalar tail)')
  if (onKernel()) return  // op-shape is a host-codegen assertion; bit-exactness above is the portable gate
  const w = wat(CONV_SRC, CV_ON)
  ok(/i16x8\.mul/.test(w) && /v128\.load64_zero/.test(w), `conv2d column loop vectorizes (${(w.match(/i16x8\.mul/g) || []).length} i16x8.mul, ${(w.match(/v128\.load64_zero/g) || []).length} gathers)`)
  ok(!/i16x8\.mul/.test(wat(CONV_SRC, CV_NO)), 'experimentalOuterStrip:false leaves it scalar (isolates the pass)')
})

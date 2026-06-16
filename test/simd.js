import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { belowOpt, onKernel } from './_matrix.js'
import jz, { compile } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function run(code) {
  const wasm = compile(code)
  return new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
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
  ok(/load32_zero/.test(w) && /extend_low/.test(w), 'expected widening u8 loads')
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
  const w = wat(src, SIMD_OPT)
  ok(/v128\.load/.test(w) && /v128\.xor/.test(w), 'expected v128.load + v128.xor')
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
  const w = wat(src, SIMD_OPT)
  ok(/f64x2\.sqrt/.test(w) && /v128\.bitselect/.test(w),
    'sqrt map → f64x2.sqrt beneath a v128.bitselect NaN-canon')
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
  const w = wat(src, SIMD_OPT)
  ok(/f64x2\.min/.test(w) && /f64x2\.max/.test(w) && /v128\.bitselect/.test(w),
    'clamp → nested f64x2.min/max beneath a NaN-canon bitselect')
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

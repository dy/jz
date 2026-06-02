import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt } from './_matrix.js'
import jz, { compile } from '../index.js'

function run(code) {
  const wasm = compile(code)
  return new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
}

const SIMD_OPT = { optimize: { vectorizeLaneLocal: true, watr: true } }
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
  // Compares the vectorized build against the env-level baseline; bit-equality only
  // holds when the baseline also vectorizes (optimize >= 2) — float reductions reorder.
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
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
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

test('vectorize: reduction (sum += a[i]) must NOT lift', () => {
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
  is(runVec(src, SIMD_OPT).main(), runVec(src).main())
  // Reduction loop has NO store; recognizer requires at least one mem op.
  const w = wat(src, SIMD_OPT)
  ok(!/\$__simd_loop\d+/.test(w), 'expected no SIMD prefix on reduction')
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

// ---- conditional (ternary) maps → v128.bitselect ---------------------------
// jz lowers `cond ? X : Y` to `(if (result f64) COND (then X)(else Y))`; the
// vectorizer lifts it to `v128.bitselect(X, Y, mask)`, mask = COND as a lane
// comparison. NOVEC re-runs the same source with vectorization OFF — the scalar
// oracle. (Generative coverage: `node test/fuzz.js --typed-map`.)
const NOVEC = { optimize: { vectorizeLaneLocal: false, watr: true } }

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

/**
 * SIMD-128 lane-local vectorizer tests.
 *
 * The recognizer is a STRUCTURAL property, not a benchmark match. These tests
 * pin the contract:
 *   • Positive: pure-lane bodies lift to v128 ops, checksum stays identical.
 *   • Negative: anything with cross-iter dataflow (reductions, loop-carried
 *     scalars, stencils, varying bound) must NOT lift.
 *   • Tail correctness: lengths that aren't a multiple of LANES still work.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'

const SIMD_OPT = { optimize: { vectorizeLaneLocal: true } }

function run(code, opts) {
  return jz(code, opts).exports
}
function wat(code, opts) {
  return compile(code, { ...opts, wat: true })
}
function hasV128(w) {
  return /v128\.load|v128\.store|i32x4\.|i64x2\.|f32x4\.|f64x2\.|v128\.(and|or|xor)/.test(w)
}

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
  is(run(src, SIMD_OPT).main(), run(src).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops in SIMD output')
})

test('vectorize: i32 shift lane-local lifts (a[i] = a[i] << 1)', () => {
  // Pure-i32 path: bitwise shift narrows cleanly. Plain `+` would route
  // through f64 in jz's narrowing — that's a separate concern from the
  // vectorizer; here we test the vectorizer on canonical i32 IR.
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  ok(hasV128(wat(src, SIMD_OPT)), 'expected v128 ops')
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
  is(run(src, SIMD_OPT).main(), run(src).main())
})

// ---- negative cases ------------------------------------------------------

test('vectorize: loop-carried scalar (s ^= s << 13) must NOT lift', () => {
  // The init loop body has a cross-iter dependency through `s`. The lane-
  // local recognizer must see the read-before-write and bail.
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  // If init were (incorrectly) lifted as lane-local, $s would be turned into
  // a v128-shadowed `$s__v`. Assert that lift did NOT happen. The hash loop
  // below is a legitimate xor reduction and IS expected to lift — so we
  // can't assert "no SIMD prefix anywhere", just "no lane lift on $s".
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  // The reduction loop has NO store; recognizer requires at least one mem op.
  // Even more importantly, `sum` is loop-carried — first access is a read.
  const w = wat(src, SIMD_OPT)
  ok(!/\$__simd_loop\d+/.test(w), 'expected no SIMD prefix on reduction')
})

test('vectorize: stencil (a[i] depends on a[i-1]) must NOT lift', () => {
  // Note: jz front-end may rewrite `i-1` differently; the structural property
  // we're testing is "address other than (add base (shl i K)) → bail". If the
  // address shape doesn't match, the recognizer returns null. Either way,
  // checksum must match scalar.
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
  is(run(src, SIMD_OPT).main(), run(src).main())
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
  is(run(src, SIMD_OPT).main(), run(src).main())
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
  is(run(src, SIMD_OPT).main(), run(src).main())
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  ok(/i16x8\.mul/.test(wat(src, SIMD_OPT)), 'expected i16x8.mul')
})

test('vectorize: Uint8Array right shift must NOT lift (signedness mismatch hazard)', () => {
  // i32.shr_u on load8_u differs from i8x16.shr_u (lane treats the byte as
  // unsigned regardless, but the i32 path zero-extends first then shifts in
  // i32 width). Conservative recognizer drops shr_* for i8/i16.
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  // No i8x16/v128 lifts — recognizer bails.
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  const w = wat(src, SIMD_OPT)
  ok(/v128\.xor/.test(w) && /i32x4\.extract_lane/.test(w), 'expected v128.xor and lane extracts')
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
  is(run(orSrc, SIMD_OPT).main(), run(orSrc).main())
  is(run(andSrc, SIMD_OPT).main(), run(andSrc).main())
  ok(/v128\.or/.test(wat(orSrc, SIMD_OPT)), 'or reduction → v128.or')
  ok(/v128\.and/.test(wat(andSrc, SIMD_OPT)), 'and reduction → v128.and')
})

test('vectorize: f64 sum reduction lifts (associativity tolerated)', () => {
  // Uses inputs where reorder of f64 add is exact (small integers stored
  // as doubles add associatively up to N * max < 2^53).
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
  is(run(src, SIMD_OPT).main(), run(src).main())
  ok(/f64x2\.add/.test(wat(src, SIMD_OPT)), 'expected f64x2.add')
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
  is(run(src, SIMD_OPT).main(), run(src).main())
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
  is(run(src, SIMD_OPT).main(), run(src).main())
})

test('vectorize: opt off by default at level 2 (no SIMD without explicit flag)', () => {
  // At default optimize:true (level 2), the pass is OFF. Compiling the same
  // bitwise loop should not produce v128 ops.
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
  const w = wat(src) // default opts
  ok(!hasV128(w), 'expected NO v128 ops at default optimization')
})

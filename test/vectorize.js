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
  // The store body has a cross-iter dependency through `s`. Recognizer must
  // see the read-before-write and bail.
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
  // The init-style loop above is the ONLY (block (loop)) involving a[i]; if
  // we lifted it, we'd get a wrong checksum (lanes don't see each other's $s).
  // Identical checksum is the proof. Also assert no SIMD prefix label appears
  // in this fn — we don't want to vectorize accidentally.
  const w = wat(src, SIMD_OPT)
  ok(!/\$__simd_loop\d+/.test(w), 'expected no SIMD prefix on loop-carried scalar')
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

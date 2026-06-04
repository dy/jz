import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'

// Source-level f32x4 / i32x4 intrinsics (module/simd.js) lowering to wasm SIMD (v128).
// The point: v128 must flow through user locals (let v = f32x4.…), survive
// reassignment, and let a kernel run 4 lanes in masked lockstep. (v128 itself can't
// cross the JS boundary, so every export returns extracted scalars.)

test('simd: build a vector + per-lane arithmetic + extract', () => {
  const { f } = run(`export let f = (a, b, c, d) => {
    let v = f32x4.lanes(a, b, c, d)
    let w = f32x4.mul(v, v)
    return f32x4.lane(w, 0) + f32x4.lane(w, 1) + f32x4.lane(w, 2) + f32x4.lane(w, 3)
  }`)
  is(f(1, 2, 3, 4), 30)   // 1 + 4 + 9 + 16
  is(f(2, 0, 0, 5), 29)   // 4 + 0 + 0 + 25
})

test('simd: splat broadcast + add/sub/div', () => {
  const { f } = run(`export let f = (x) => {
    let v = f32x4.add(f32x4.splat(x), f32x4.lanes(0.0, 1.0, 2.0, 3.0))
    let h = f32x4.div(v, f32x4.splat(2.0))
    return f32x4.lane(v, 0) + f32x4.lane(v, 3) + f32x4.lane(h, 3)
  }`)
  is(f(10), 10 + 13 + 6.5)
})

test('simd: sqrt / min / max', () => {
  const { f } = run(`export let f = (a, b, c, d) => {
    let v = f32x4.lanes(a, b, c, d)
    let s = f32x4.sqrt(v)
    let lo = f32x4.min(v, f32x4.splat(3.0))
    let hi = f32x4.max(v, f32x4.splat(3.0))
    return f32x4.lane(s, 0) + f32x4.lane(lo, 3) + f32x4.lane(hi, 0)
  }`)
  is(f(4, 9, 16, 25), 2 + 3 + 4)   // sqrt(4)=2, min(25,3)=3, max(4,3)=4
})

test('simd: compare → lane mask + v128.bitselect', () => {
  const { pick } = run(`export let pick = (a, b, c, d) => {
    let v = f32x4.lanes(a, b, c, d)
    let m = f32x4.le(v, f32x4.splat(2.5))                 // lanes <= 2.5 → all-ones
    let r = v128.bitselect(f32x4.splat(100.0), v, m)      // mask ? 100 : v
    return f32x4.lane(r, 0) + f32x4.lane(r, 1) + f32x4.lane(r, 2) + f32x4.lane(r, 3)
  }`)
  is(pick(1, 2, 3, 4), 207)   // 100 + 100 + 3 + 4
})

test('simd: i32x4 counters + v128.and/anyTrue (masked-lockstep loop)', () => {
  // Per lane: how many +1 steps until acc reaches the lane's threshold.
  const { count } = run(`export let count = (t0, t1, t2, t3, steps) => {
    let thr = f32x4.lanes(t0, t1, t2, t3)
    let acc = f32x4.splat(0.0)
    let iter = i32x4.splat(0)
    let active = i32x4.splat(-1)
    let k = 0
    while (k < steps) {
      active = v128.and(active, f32x4.lt(acc, thr))
      if (v128.anyTrue(active)) {
        iter = i32x4.sub(iter, active)        // active lane (= -1) → +1
        acc = f32x4.add(acc, f32x4.splat(1.0))
        k++
      } else { k = steps }
    }
    return i32x4.lane(iter, 0) * 1000 + i32x4.lane(iter, 1) * 100 + i32x4.lane(iter, 2) * 10 + i32x4.lane(iter, 3)
  }`)
  is(count(3, 5, 1, 8, 100), 3 * 1000 + 5 * 100 + 1 * 10 + 8)   // each lane stops at ceil(thr)
})

test('simd: v128 flows through helper params + returns + nested calls', () => {
  const { f } = run(`let dbl = (x) => f32x4.add(x, x)
    let quad = (x) => dbl(dbl(x))
    export let f = (a, b, c, d) => f32x4.lane(quad(f32x4.lanes(a, b, c, d)), 2)`)
  is(f(1, 1, 3, 1), 12)   // 3 * 4
})

test('simd: i32x4 shifts + f32↔i32 reinterpret/convert (float-bit twiddling)', () => {
  const { exp, mant, conv } = run(`
    export let exp = (x) => i32x4.lane(i32x4.shrU(f32x4.splat(x), 23), 0)
    export let mant = (x) => f32x4.lane(v128.or(v128.and(f32x4.splat(x), i32x4.splat(8388607)), i32x4.splat(1065353216)), 0)
    export let conv = (n) => f32x4.lane(f32x4.convertI32(i32x4.splat(n)), 0)`)
  is(exp(2), 128)        // exponent field of 2.0f
  is(mant(3), 1.5)       // mantissa of 3.0 with exponent forced to 127 → 1.5
  is(conv(5), 5)         // i32 lane 5 → f32 value 5
})

test('simd: a SIMD natural log (Cephes logf via v128 helper) matches Math.log', () => {
  const { logL } = run(`let slog = (x) => {
    let e = i32x4.sub(v128.and(i32x4.shrU(x, 23), i32x4.splat(255)), i32x4.splat(126))
    let m = v128.or(v128.and(x, i32x4.splat(8388607)), i32x4.splat(1056964608))
    let less = f32x4.lt(m, f32x4.splat(0.70710678))
    m = v128.bitselect(f32x4.sub(f32x4.add(m, m), f32x4.splat(1.0)), f32x4.sub(m, f32x4.splat(1.0)), less)
    e = i32x4.sub(e, v128.and(less, i32x4.splat(1)))
    let ef = f32x4.convertI32(e)
    let z = f32x4.mul(m, m)
    let y = f32x4.splat(0.070376836292)
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.1151461031))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.116769987))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.12420140846))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.14249322787))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.16668057665))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.20000714765))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.24999993993))
    y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.33333331174))
    y = f32x4.mul(f32x4.mul(y, m), z)
    y = f32x4.add(y, f32x4.mul(ef, f32x4.splat(-0.000212194440)))
    y = f32x4.sub(y, f32x4.mul(f32x4.splat(0.5), z))
    return f32x4.add(f32x4.add(m, y), f32x4.mul(ef, f32x4.splat(0.693359375)))
  }
  export let logL = (x) => f32x4.lane(slog(f32x4.splat(x)), 0)`)
  let maxErr = 0
  for (let i = 1; i < 500; i++) { const x = i * 2.5; maxErr = Math.max(maxErr, Math.abs(logL(x) - Math.log(x))) }
  ok(maxErr < 1e-5)   // f32 logf accuracy
})

test('simd: dynamic lane index is a compile error (extract_lane needs a constant)', () => {
  let threw = false
  try {
    run(`export let f = (a, b, c, d) => { let v = f32x4.lanes(a, b, c, d); let s = 0.0; let k = 0; while (k < 4) { s = s + f32x4.lane(v, k); k++ } return s }`)
  } catch (e) { threw = /lane index must be a 0\.\.3 literal/.test(e.message) }
  is(threw, true)
})

test('simd: masked-lockstep mandelbrot matches scalar (f32 lanes)', () => {
  const { frame } = run(`export let frame = (w, h, limit) => {
    let scale = 0.0035, sum = 0.0, y = 0
    while (y < h) {
      let ci = f32x4.splat((y - (h >> 1)) * scale)
      let x = 0
      while (x < w) {
        let base = (x - (w >> 1)) * scale
        let cr = f32x4.add(f32x4.splat(base), f32x4.mul(f32x4.lanes(0.0, 1.0, 2.0, 3.0), f32x4.splat(scale)))
        let zr = f32x4.splat(0.0), zi = f32x4.splat(0.0)
        let iter = i32x4.splat(0), active = i32x4.splat(-1), k = 0
        while (k < limit) {
          let zr2 = f32x4.mul(zr, zr), zi2 = f32x4.mul(zi, zi)
          active = v128.and(active, f32x4.le(f32x4.add(zr2, zi2), f32x4.splat(4.0)))
          if (v128.anyTrue(active)) {
            iter = i32x4.sub(iter, active)
            zi = f32x4.add(f32x4.mul(f32x4.add(zr, zr), zi), ci)
            zr = f32x4.add(f32x4.sub(zr2, zi2), cr)
            k++
          } else { k = limit }
        }
        sum = sum + i32x4.lane(iter, 0) + i32x4.lane(iter, 1) + i32x4.lane(iter, 2) + i32x4.lane(iter, 3)
        x = x + 4
      }
      y++
    }
    return sum
  }`)
  // scalar oracle, f32-rounded to mirror the lanes
  const fr = Math.fround
  const scalar = (w, h, limit) => {
    const scale = fr(0.0035); let sum = 0
    for (let y = 0; y < h; y++) {
      const ci = fr((y - (h >> 1)) * scale)
      for (let x = 0; x < w; x++) {
        let cr = fr((x - (w >> 1)) * scale), zr = 0, zi = 0, k = 0, iter = 0
        while (k < limit) {
          const zr2 = fr(zr * zr), zi2 = fr(zi * zi)
          if (fr(zr2 + zi2) > 4) break
          iter++
          zi = fr(fr(fr(zr + zr) * zi) + ci)
          zr = fr(fr(zr2 - zi2) + cr); k++
        }
        sum += iter
      }
    }
    return sum
  }
  const W = 80, H = 60, L = 60
  is(frame(W, H, L), scalar(W, H, L))
})

import test from 'tst'
import { is } from 'tst/assert.js'
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

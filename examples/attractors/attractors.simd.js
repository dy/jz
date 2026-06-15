// Strange attractor — Peter de Jong's map (SIMD f64x2 sibling of attractors.js).
//   xₙ₊₁ = sin(a·yₙ) − cos(b·xₙ)
//   yₙ₊₁ = sin(c·xₙ) − cos(d·yₙ)
// The map is a serial recurrence (no cross-iteration parallelism), but WITHIN an
// iteration its four transcendentals are independent: the two sines and the two
// cosines each pack into one f64x2 lane-pair. So `f64x2.sin([a·y, c·x])` and
// `f64x2.cos([b·x, d·y])` replace four scalar calls with two, and a single
// `f64x2.sub` yields [nx, ny] — ≈halving the trig cost that dominates the loop
// (~1.35× the scalar wasm here). V8 runs the scalar attractors.js (no auto-SIMD for
// a divergent transcendental recurrence); jz compiles this hand-vectorized kernel.
let W = 0, H = 0, dens, px
let bounds                              // [minX,maxX,minY,maxY] of the attractor (Float64Array)

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)   // integer hit-counts; half the memory traffic of f64
  px = new Uint32Array(w * h)
  // fractional bounds live in a Float64Array (a scalar f64 global assigned these
  // would be i32-narrowed → truncated). Seed with the de Jong theoretical range.
  bounds = new Float64Array(4)
  bounds[0] = -2.0; bounds[1] = 2.0; bounds[2] = -2.0; bounds[3] = 2.0
  return px
}

export let frame = (a, b, c, d, iters) => {
  let n = W * H, i = 0
  while (i < n) { dens[i] = 0; i++ }

  // Auto-fit: stretch the attractor's actual bounding box to fill the whole viewport
  // (independent x/y scale, 4% margin), so it never sits as a small centred/top blob.
  // The params morph slowly via LFOs, so using the PREVIOUS frame's box (1-frame lag)
  // is imperceptible and keeps this a single pass. Per-frame divides only — not per-point.
  let spanX = bounds[1] - bounds[0]
  let spanY = bounds[3] - bounds[2]
  if (spanX < 0.001) spanX = 0.001
  if (spanY < 0.001) spanY = 0.001
  let scaleX = W * 0.92 / spanX
  let scaleY = H * 0.92 / spanY
  let offX = W * 0.04 - bounds[0] * scaleX
  let offY = H * 0.04 - bounds[2] * scaleY

  let x = 0.1, y = 0.1
  let nMinX = 1.0e9, nMaxX = -1.0e9, nMinY = 1.0e9, nMaxY = -1.0e9
  let k = 0
  while (k < iters) {
    // [sin(a·y), sin(c·x)] − [cos(b·x), cos(d·y)] = [nx, ny], two trig ops not four
    let s = f64x2.sin(f64x2.lanes(a * y, c * x))
    let c2 = f64x2.cos(f64x2.lanes(b * x, d * y))
    let n2 = f64x2.sub(s, c2)
    x = f64x2.lane(n2, 0); y = f64x2.lane(n2, 1)
    if (x < nMinX) nMinX = x
    if (x > nMaxX) nMaxX = x
    if (y < nMinY) nMinY = y
    if (y > nMaxY) nMaxY = y
    let ix = (offX + x * scaleX) | 0
    let iy = (offY + y * scaleY) | 0
    if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
      let idx = iy * W + ix
      dens[idx] = dens[idx] + 1
    }
    k++
  }
  // hand this frame's measured box to the next frame's fit
  bounds[0] = nMinX; bounds[1] = nMaxX; bounds[2] = nMinY; bounds[3] = nMaxY

  // log density → brightness, dark → teal → warm white. The tone-map runs over
  // every pixel, so the channel ramps use shifts (>>8 ≈ ÷256), never per-pixel
  // divides — a `/255` here stalls the pipeline and erases jz's iteration win at
  // full-screen sizes. log() is skipped for the empty (dens==0) majority.
  i = 0
  while (i < n) {
    let v = dens[i]
    let g = 0
    if (v > 0) {
      let L = Math.log(v + 1.0) * 44.0
      g = (L > 255.0 ? 255.0 : L) | 0
    }
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

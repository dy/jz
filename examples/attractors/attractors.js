// Strange attractor — Peter de Jong's map, iterated a few million times into a
// density histogram, then log-tone-mapped to a luminous curve:
//   xₙ₊₁ = sin(a·yₙ) − cos(b·xₙ)
//   yₙ₊₁ = sin(c·xₙ) − cos(d·yₙ)
// The hot loop is four transcendentals per iteration over millions of iterations —
// jz's exact sweet spot. The same source is the V8 baseline (imported) and compiles
// to wasm. (The map is chaotic, so jz's sub-ulp sin/cos make individual points drift
// from V8's, but the attractor's shape — its invariant density — is identical.)
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
    let nx = Math.sin(a * y) - Math.cos(b * x)
    let ny = Math.sin(c * x) - Math.cos(d * y)
    x = nx; y = ny
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

  // log density → brightness, dark → teal → warm white
  i = 0
  while (i < n) {
    let v = dens[i]
    let L = v > 0.0 ? Math.log(v + 1.0) * 44.0 : 0.0
    if (L > 255.0) L = 255.0
    let g = L | 0
    let r = (g * g / 255) | 0
    let bl = (g * 210 / 255) | 0
    px[i] = (255 << 24) | (bl << 16) | (g << 8) | r
    i++
  }
}

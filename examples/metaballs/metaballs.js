// Metaballs — a 2D implicit surface. Each pixel sums an inverse-square field from
// every blob (Σ r²/d²); where the sum crosses ~1 an organic membrane appears, and
// blobs merge and split smoothly as they move. The per-pixel inner loop over all
// blobs is the hot path: pure multiply-add-reciprocal, no transcendentals.
//
// Blobs drift and bounce off the walls. Press and hold to grow a fresh blob under
// the cursor (release to let it drift off); the field is shaded through a black→red→
// orange→yellow→white "heat" ramp for a molten look.
// resize(w,h) → Uint32Array; frame(t) mutates px in place.

let W = 0, H = 0, px

let MAXN = 24
let bx = new Float64Array(MAXN)
let by = new Float64Array(MAXN)
let bvx = new Float64Array(MAXN)
let bvy = new Float64Array(MAXN)
let br = new Float64Array(MAXN)
let count = 0
let active = -1

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(W * H)
  return px
}

export let init = () => {
  count = 8
  let i = 0
  while (i < count) {
    let ang = i * 6.283185307179586 / 8.0
    bx[i] = 0.5 + Math.cos(ang) * 0.3
    by[i] = 0.5 + Math.sin(ang) * 0.3
    bvx[i] = Math.cos(ang * 2.3 + 1.0) * 0.0022
    bvy[i] = Math.sin(ang * 1.7 + 0.5) * 0.0022
    br[i] = 0.06 + (i % 3) * 0.026             // three blob sizes
    i++
  }
  active = -1
}

// re-roll: a genuinely different blob soup — random count, positions, velocities and sizes
export let randomize = () => {
  count = 5 + (Math.random() * 8.0 | 0)        // 5..12 blobs
  let i = 0
  while (i < count) {
    bx[i] = 0.12 + Math.random() * 0.76
    by[i] = 0.12 + Math.random() * 0.76
    bvx[i] = (Math.random() - 0.5) * 0.0044
    bvy[i] = (Math.random() - 0.5) * 0.0044
    br[i] = 0.04 + Math.random() * 0.095
    i++
  }
  active = -1
}

// Press: spawn a tiny blob at the cursor (or, at capacity, re-grow the oldest).
export let spawn = (x, y) => {
  if (count < MAXN) { active = count; count++ } else { active = 0 }
  bx[active] = x; by[active] = y
  bvx[active] = 0.0; bvy[active] = 0.0
  br[active] = 0.02
}

// Hold: keep the active blob under the cursor and inflate it.
export let grow = (x, y) => {
  if (active < 0) return 0.0
  bx[active] = x; by[active] = y
  let r = br[active] + 0.0016
  if (r > 0.17) r = 0.17
  br[active] = r
  return 0.0
}

// Release: let the active blob drift away with a little push.
export let release = () => {
  if (active >= 0) {
    bvx[active] = (Math.random() - 0.5) * 0.003
    bvy[active] = (Math.random() - 0.5) * 0.003
    active = -1
  }
}

export let frame = (t) => {
  // ---- move blobs: free drift + wall bounce (the held blob stays put) ----
  let i = 0
  while (i < count) {
    if (i !== active) {
      bx[i] += bvx[i]; by[i] += bvy[i]
      let r = br[i]
      if (bx[i] < r) { bx[i] = r; bvx[i] = -bvx[i] }
      if (bx[i] > 1.0 - r) { bx[i] = 1.0 - r; bvx[i] = -bvx[i] }
      if (by[i] < r) { by[i] = r; bvy[i] = -bvy[i] }
      if (by[i] > 1.0 - r) { by[i] = 1.0 - r; bvy[i] = -bvy[i] }
    }
    i++
  }

  // ---- field evaluation + heat shading ----
  let row = 0, yi = 0
  while (yi < H) {
    let cy = yi / H
    let xi = 0
    while (xi < W) {
      let cx = xi / W
      let sum = 0.0
      let b = 0
      while (b < count) {
        let dx = cx - bx[b], dy = cy - by[b]
        let r = br[b]
        sum += (r * r) / (dx * dx + dy * dy + 0.0008)
        b++
      }
      // grayscale: field crosses the ~1 membrane into white, dark outside
      let q = sum * 0.85
      if (q < 0.0) q = 0.0
      if (q > 1.0) q = 1.0
      let g = (q * 255.0) | 0
      px[row + xi] = (255 << 24) | (g << 16) | (g << 8) | g
      xi++
    }
    row += W
    yi++
  }
}

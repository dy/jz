// Metaballs — a 2D implicit surface. Each pixel sums an inverse-square field from
// every blob (Σ r²/d²); where the sum crosses ~1 an organic membrane appears, and
// blobs merge and split smoothly as they move. The per-pixel inner loop over all
// blobs is the hot path: pure multiply-add-reciprocal, no transcendentals.
//
// Blobs drift and bounce off the walls. Press and hold to grow a fresh blob under
// the cursor (release to let it drift off).
//
// The same inner loop also sums the field's analytic gradient (∇ r²/(d²+ε) = −2 r² d/(d²+ε)²).
// Inside the membrane the blobs are liquid metal — the height 1 − 1/Σ gives a surface normal, which
// reflects a black studio (an overhead softbox, two strip lights, a key glint); the membrane edge is
// anti-aliased by its distance in pixels (Σ − 1 over the gradient's length). Outside, the field
// glows softly, fading with distance.
// resize(w,h) → Uint32Array; frame(t) mutates px in place.

let W = 0, H = 0, px
let fs, fgx, fgy  // Float64Array W*H — the field Σ and its gradient terms, then shaded (deferred)
let AW = 1.0      // world width: the field is AW × 1, so blobs stay round on screen

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
  AW = H > 0 ? W / H : 1.0
  px = new Uint32Array(W * H)
  fs = new Float64Array(W * H); fgx = new Float64Array(W * H); fgy = new Float64Array(W * H)
  return px
}

export let init = () => {
  count = 8
  let i = 0
  while (i < count) {
    let ang = i * 6.283185307179586 / 8.0
    bx[i] = (0.5 + Math.cos(ang) * 0.3) * AW
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
    bx[i] = (0.12 + Math.random() * 0.76) * AW
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
  bx[active] = x * AW; by[active] = y
  bvx[active] = 0.0; bvy[active] = 0.0
  br[active] = 0.02
}

// Hold: keep the active blob under the cursor and inflate it.
export let grow = (x, y) => {
  if (active < 0) return 0.0
  bx[active] = x * AW; by[active] = y
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
      if (bx[i] > AW - r) { bx[i] = AW - r; bvx[i] = -bvx[i] }
      if (by[i] < r) { by[i] = r; bvy[i] = -bvy[i] }
      if (by[i] > 1.0 - r) { by[i] = 1.0 - r; bvy[i] = -bvy[i] }
    }
    i++
  }

  // ---- pass 1: the field and its gradient at every pixel ----
  let pw = 1.0 / H                       // one pixel, in world units
  let row = 0, yi = 0
  while (yi < H) {
    let cy = (yi + 0.5) * pw
    let xi = 0
    while (xi < W) {
      let cx = (xi + 0.5) * pw
      let sum = 0.0, gx = 0.0, gy = 0.0
      let b = 0
      while (b < count) {
        let dx = cx - bx[b], dy = cy - by[b]
        let r = br[b]
        let q = 1.0 / (dx * dx + dy * dy + 0.0008)
        let f = r * r * q
        sum += f
        gx += f * q * dx; gy += f * q * dy     // ∇Σ = −2 (gx, gy)
        b++
      }
      fs[row + xi] = sum; fgx[row + xi] = gx; fgy[row + xi] = gy
      xi++
    }
    row += W
    yi++
  }

  // ---- pass 2: a soft glow outside, liquid metal inside ----
  let n = W * H, p = 0
  while (p < n) {
    let sum = fs[p], gx = fgx[p], gy = fgy[p]
    let gl = 2.0 * Math.sqrt(gx * gx + gy * gy) + 1e-12   // |∇Σ|
    // membrane coverage: signed distance to Σ = 1 in pixels, ±½ px ramp
    let a = (sum - 1.0) / (gl * pw) + 0.5
    a = a < 0.0 ? 0.0 : a > 1.0 ? 1.0 : a
    let out = Math.min(1.0, sum) * 0.3                   // the field's glow around the membrane
    // liquid metal: height 1 − 1/Σ → normal (−∂h, 1); ∂h = ∇Σ/Σ², scaled into relief
    let k = 0.09 / (sum * sum)
    let nx = 2.0 * gx * k, ny = 2.0 * gy * k
    let nz = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0)
    nx *= nz; ny *= nz
    // reflect the view ray (0,0,−1): r = (2nz·nx, 2nz·ny, 2nz² − 1); up is −y on screen
    let rx = 2.0 * nz * nx, ru = -2.0 * nz * ny, rz = 2.0 * nz * nz - 1.0
    let ax = Math.abs(rx)
    let box = Math.min(1.0, Math.max(0.0, (ru - 0.2) * 5.0)) * Math.min(1.0, Math.max(0.0, (0.62 - ax) * 6.0))
    let strip = Math.min(1.0, Math.max(0.0, (ax - 0.6) * 8.0))
    let c = Math.max(0.0, rx * -0.42 + ru * 0.62 + rz * 0.66)
    let sp = c * c
    sp = sp * sp; sp = sp * sp; sp = sp * sp; sp = sp * sp
    let inside = 0.05 + box * 0.8 + strip * 0.55 + sp * sp * 1.4 + (1.0 - nz) * 0.25
    let v = Math.min(1.0, out + (inside - out) * a)
    let g = (v * 255.0) | 0
    px[p] = (255 << 24) | (g << 16) | (g << 8) | g
    p++
  }
}

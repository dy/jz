// Phyllotaxis / sunflower packing — Vogel's model: seed n sits at angle n·α (the golden angle)
// and radius ∝ √n. The golden angle α≈137.508° is irrational in the deepest sense — its
// continued fraction [2;1,1,1,…] makes it the "most irrational" number, packing seeds with
// zero gaps. The beauty: vary α even a fraction of a degree and the seeds fan into spoke-wheels
// or spiral arms and back. frame(t, ang) feeds the divergence angle; drag scrubs it live.
//
// Each seed is drawn as a lit floret — a small sphere, key light upper left, a specular glint, an
// anti-aliased rim — packed edge to edge like the seeds of a sunflower head.

let W = 0, H = 0, px

let PI2 = 6.283185307179586
let GOLDEN_ANGLE = 2.3999632297286535   // 2π(1 − 1/φ), the golden angle in radians

// Store mutable floats in Float64Array to avoid jz i32 narrowing
let st = new Float64Array(4) // [userAng, unused, unused, unused]

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// one floret: a lit sphere of radius rad, anti-aliased by coverage at its rim
let floret = (cx, cy, rad) => {
  let xi = Math.floor(cx - rad - 1.0), xe = Math.ceil(cx + rad + 1.0)
  let yi = Math.floor(cy - rad - 1.0), ye = Math.ceil(cy + rad + 1.0)
  if (xi < 0) xi = 0
  if (yi < 0) yi = 0
  if (xe > W - 1) xe = W - 1
  if (ye > H - 1) ye = H - 1
  let inv = 1.0 / rad
  let y = yi
  while (y <= ye) {
    let x = xi
    while (x <= xe) {
      let nx = (x + 0.5 - cx) * inv, ny = (y + 0.5 - cy) * inv
      let d2 = nx * nx + ny * ny
      let a = (1.0 - Math.sqrt(d2)) * rad + 0.5          // coverage across the rim
      if (a > 0.0) {
        if (a > 1.0) a = 1.0
        let nz = Math.sqrt(d2 < 1.0 ? 1.0 - d2 : 0.0)
        let lam = -0.45 * nx - 0.55 * ny + 0.7 * nz        // key light, upper left
        if (lam < 0.0) lam = 0.0
        let hl = -0.24 * nx - 0.3 * ny + 0.92 * nz          // Blinn half-vector toward the viewer
        let sp = hl > 0.0 ? hl * hl : 0.0
        sp = sp * sp; sp = sp * sp; sp = sp * sp
        let v = 0.12 + 0.8 * lam + sp * 0.5
        if (v > 1.0) v = 1.0
        let idx = y * W + x
        let o = px[idx] & 255
        let g = (o + (v * 255.0 - o) * a) | 0
        px[idx] = (255 << 24) | (g << 16) | (g << 8) | g
      }
      x++
    }
    y++
  }
}

export let frame = (t, ang, nf, dotMul) => {
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let N = nf | 0                       // seed count — drives the density (re-roll varies it)
  if (N < 200) N = 200
  let cx = W * 0.5, cy = H * 0.5
  let minDim = W < H ? W : H
  let scale = minDim * 0.47 / Math.sqrt(N)
  let dotR = scale * 0.8 * dotMul      // floret radius: ~touching at dotMul 1 — re-roll varies how tightly they pack
  if (dotR < 0.8) dotR = 0.8

  // outermost first, so the inner florets overlap the outer ones like a real flower head
  i = N - 1
  while (i >= 0) {
    let fi = i + 0.0
    let theta = fi * ang
    let rr = scale * Math.sqrt(fi)
    floret(cx + rr * Math.cos(theta), cy + rr * Math.sin(theta), dotR * (0.8 + 0.2 * rr / (minDim * 0.47)))
    i--
  }
}

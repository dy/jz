// Phyllotaxis / sunflower packing — Vogel's model: seed n sits at angle n·α (the golden angle)
// and radius ∝ √n. The golden angle α≈137.508° is irrational in the deepest sense — its
// continued fraction [2;1,1,1,…] makes it the "most irrational" number, packing seeds with
// zero gaps. The beauty: vary α even a fraction of a degree and the seeds fan into spoke-wheels
// or spiral arms and back. frame(t, ang) feeds the divergence angle; drag scrubs it live.

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

let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let r = (p & 0xff) + rr; if (r > 255) r = 255
  let g = ((p >> 8) & 0xff) + gg; if (g > 255) g = 255
  let b = ((p >> 16) & 0xff) + bb; if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

let disc = (cx, cy, radius, rr, gg, bb) => {
  let xi = (cx - radius) | 0, xe = (cx + radius + 1.0) | 0
  let yi = (cy - radius) | 0, ye = (cy + radius + 1.0) | 0
  let r2 = radius * radius
  let dy = yi
  while (dy <= ye) {
    let dx = xi
    while (dx <= xe) {
      let ddx = dx - cx, ddy = dy - cy
      if (ddx * ddx + ddy * ddy <= r2) addpix(dx, dy, rr, gg, bb)
      dx++
    }
    dy++
  }
}

export let frame = (t, ang) => {
  // Clear to near-black
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let N = 3600
  let cx = W * 0.5, cy = H * 0.5
  let minDim = W < H ? W : H
  let scale = minDim * 0.47 / Math.sqrt(N)
  let dotR = scale * 0.32              // well under half the seed spacing → smaller, crisper, more separated dots
  if (dotR < 0.75) dotR = 0.75

  i = 0
  while (i < N) {
    let fi = i + 0.0
    let theta = fi * ang
    let rr = scale * Math.sqrt(fi)
    let px2 = cx + rr * Math.cos(theta)
    let py2 = cy + rr * Math.sin(theta)

    // Gray ramp by index — spiral arms read as gradient; palette button recolors
    let cg = (40 + (fi / N) * 215) | 0

    disc(px2, py2, dotR, cg, cg, cg)
    i++
  }
}

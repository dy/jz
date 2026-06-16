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

  let N = 3200
  let cx = W * 0.5, cy = H * 0.5
  let minDim = W < H ? W : H
  let scale = minDim * 0.46 / Math.sqrt(N)
  let dotR = scale * 0.75
  if (dotR < 1.0) dotR = 1.0

  i = 0
  while (i < N) {
    let fi = i + 0.0
    let theta = fi * ang
    let rr = scale * Math.sqrt(fi)
    let px2 = cx + rr * Math.cos(theta)
    let py2 = cy + rr * Math.sin(theta)

    // Rainbow by index
    let h6 = (fi / N) * 6.0
    let cr = Math.abs(h6 - 3.0) - 1.0
    let cg = 2.0 - Math.abs(h6 - 2.0)
    let cb = 2.0 - Math.abs(h6 - 4.0)
    if (cr < 0.0) cr = 0.0; if (cr > 1.0) cr = 1.0
    if (cg < 0.0) cg = 0.0; if (cg > 1.0) cg = 1.0
    if (cb < 0.0) cb = 0.0; if (cb > 1.0) cb = 1.0

    disc(px2, py2, dotR, (cr * 200.0) | 0, (cg * 200.0) | 0, (cb * 200.0) | 0)
    i++
  }
}

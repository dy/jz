// Newton's cradle — a row of pendulum balls that pass kinetic energy through the line by
// elastic collisions. Each ball is a pendulum (angle θ, angular velocity ω) integrated as
// a small oscillator; when two adjacent balls overlap and are closing, equal masses just
// exchange velocities, so a ball swinging in stops dead and launches the ball at the far
// end. Click to lift and release the end balls. resize(w,h) → Uint32Array; frame() runs.

let W = 0, H = 0, px
let N = 6
let th = new Float64Array(N)      // angle (rad)
let om = new Float64Array(N)      // angular velocity
let pvx = new Float64Array(N)     // pivot x (px)
let pvy = 0, L = 0, R = 0, sp = 0
let W0 = 0.05                      // pendulum angular frequency

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  pvy = H * 0.16
  L = H * 0.62
  sp = W * 0.7 / N                 // ball spacing
  R = sp * 0.5                     // touching at rest
  let ox = (W - (N - 1) * sp) * 0.5
  let i = 0
  while (i < N) { pvx[i] = ox + i * sp; th[i] = 0.0; om[i] = 0.0; i++ }
  th[0] = -0.7                     // lift the left ball to start
  W0 = Math.sqrt(9.8 / (L / H)) * 0.0016
  return px
}

export let init = () => {
  let i = 0
  while (i < N) { th[i] = 0.0; om[i] = 0.0; i++ }
  th[0] = -0.7
}

// lift the nearest end ball to release angle a (px is a screen x)
export let lift = (sx) => {
  let i = sx < W * 0.5 ? 0 : N - 1
  th[i] = i === 0 ? -0.7 : 0.7
  om[i] = 0.0
}

let ballX = (i) => pvx[i] + Math.sin(th[i]) * L

let disc = (fx, fy, rad, g) => {
  let cxi = fx | 0, cyi = fy | 0, ri = rad | 0
  let r2 = rad * rad, oy = -ri
  while (oy <= ri) {
    let iy = cyi + oy
    if (iy >= 0 && iy < H) {
      let ox = -ri
      while (ox <= ri) {
        let ix = cxi + ox
        if (ix >= 0 && ix < W) { if (ox * ox + oy * oy <= r2) px[iy * W + ix] = (255 << 24) | (g << 16) | (g << 8) | g }
        ox++
      }
    }
    oy++
  }
}

let line = (x0, y0, x1, y1, g) => {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy, x = x0, y = y0, gd = 0
  let col = (255 << 24) | (g << 16) | (g << 8) | g
  while (gd < 3000) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = col
    if (x === x1 && y === y1) break
    let e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
    gd++
  }
}

export let frame = (t) => {
  // integrate each pendulum (a few substeps for stable collisions)
  let s = 0
  while (s < 4) {
    let i = 0
    while (i < N) { om[i] += -W0 * W0 * Math.sin(th[i]); th[i] += om[i]; i++ }
    // resolve collisions between neighbours: overlap + closing → swap angular velocities
    i = 0
    while (i < N - 1) {
      let xa = ballX(i), xb = ballX(i + 1)
      if (xb - xa < 2.0 * R) {
        let va = om[i] * L, vb = om[i + 1] * L          // linear speeds (∝ ω)
        if (va > vb) {                                   // closing
          let to = om[i]; om[i] = om[i + 1]; om[i + 1] = to
          // separate so they rest just touching
          let overlap = (2.0 * R - (xb - xa)) * 0.5
          th[i] -= overlap / L; th[i + 1] += overlap / L
        }
      }
      i++
    }
    s++
  }

  // render: light background, support bar, strings, dark balls
  let n = W * H, k = 0
  while (k < n) { px[k] = 0xfff2f0ea; k++ }
  let barY = (pvy - L * 0.0) | 0
  line((pvx[0] - R) | 0, pvy | 0, (pvx[N - 1] + R) | 0, pvy | 0, 60)   // support bar
  let i = 0
  while (i < N) {
    let bx = ballX(i), by = pvy + Math.cos(th[i]) * L
    line(pvx[i] | 0, pvy | 0, bx | 0, by | 0, 110)                     // string
    disc(bx, by, R * 0.82, 36)                                         // ball
    i++
  }
}

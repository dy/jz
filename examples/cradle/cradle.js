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

let grabbed = -1

// grab the ball nearest the cursor; drag sets its angle; release lets it swing
export let grab = (sx, sy) => {
  let best = 1e18, bi = -1, i = 0
  while (i < N) {
    let bx = pvx[i] + Math.sin(th[i]) * L, by = pvy + Math.cos(th[i]) * L
    let dx = bx - sx, dy = by - sy, d = dx * dx + dy * dy
    if (d < best) { best = d; bi = i }
    i++
  }
  if (best < (2.0 * R) * (2.0 * R)) grabbed = bi
}
export let dragTo = (sx) => {
  if (grabbed < 0) return 0.0
  let s = (sx - pvx[grabbed]) / L
  if (s > 0.95) s = 0.95
  if (s < -0.95) s = -0.95
  th[grabbed] = Math.asin(s); om[grabbed] = 0.0
  return 0.0
}
export let release = () => { grabbed = -1 }

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
    while (i < N) { if (i !== grabbed) { om[i] += -W0 * W0 * Math.sin(th[i]); th[i] += om[i] } i++ }
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

  // render: black background, light support bar + strings, bright balls (inverted look)
  let n = W * H, k = 0
  while (k < n) { px[k] = (255 << 24); k++ }                           // black bg
  line((pvx[0] - R) | 0, pvy | 0, (pvx[N - 1] + R) | 0, pvy | 0, 130)  // support bar
  let i = 0
  while (i < N) {
    let bx = ballX(i), by = pvy + Math.cos(th[i]) * L
    line(pvx[i] | 0, pvy | 0, bx | 0, by | 0, 80)                      // string — dim
    disc(bx, by, R, 225)                                               // ball — bright
    i++
  }
}

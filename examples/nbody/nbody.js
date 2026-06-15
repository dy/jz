// N-body gravity — a few planets pulling on each other. Starts as 3 randomly-placed
// bodies (the classic chaotic dance); click-hold to drop more. Space is periodic (toroidal):
// forces use the nearest wrapped image and bodies that leave one edge re-enter the opposite
// one, so the system stays bounded and on-screen forever instead of flinging apart. Smooth
// fading trails trace the orbits, so the gravity is visible. Pairwise O(N²) f64 multiply-add.
// resize(w,h) → Uint32Array; frame() steps + draws.

let W = 0, H = 0, px

let MAXN = 400
let x = new Float64Array(MAXN)    // world coords in [0,1], toroidal
let y = new Float64Array(MAXN)
let vx = new Float64Array(MAXN)
let vy = new Float64Array(MAXN)
let m = new Float64Array(MAXN)
let lx = new Float64Array(MAXN)   // previous screen pos (for continuous trails)
let ly = new Float64Array(MAXN)
let count = 0
let held = -1

let G = 0.0000011, EPS = 0.0016, SUB = 1, DT = 0.25   // small timestep → slow, stable dance

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(W * H)
  return px
}

export let init = () => {
  count = 0; held = -1
  let i = 0
  while (i < 3) {
    x[i] = 0.2 + Math.random() * 0.6
    y[i] = 0.2 + Math.random() * 0.6
    vx[i] = (Math.random() - 0.5) * 0.0022
    vy[i] = (Math.random() - 0.5) * 0.0022
    m[i] = 2.5 + Math.random() * 2.0
    lx[i] = x[i] * W; ly[i] = y[i] * H
    count = i + 1
    i++
  }
}

export let spawn = (sx, sy) => {
  if (count >= MAXN) { held = count - 1 } else { held = count; count++ }
  x[held] = sx; y[held] = sy; vx[held] = 0.0; vy[held] = 0.0; m[held] = 1.5
  lx[held] = sx * W; ly[held] = sy * H
}
export let grow = (sx, sy) => {
  if (held < 0) return 0.0
  x[held] = sx; y[held] = sy; vx[held] = 0.0; vy[held] = 0.0
  let mm = m[held] + 0.6
  if (mm > 40.0) mm = 40.0
  m[held] = mm
  return 0.0
}
export let release = () => { held = -1 }

let step = () => {
  let i = 0
  while (i < count) {
    if (i !== held) {
      let xi = x[i], yi = y[i], ax = 0.0, ay = 0.0
      let j = 0
      while (j < count) {
        if (j !== i) {
          let dx = x[j] - xi, dy = y[j] - yi
          if (dx > 0.5) dx -= 1.0; else if (dx < -0.5) dx += 1.0   // nearest wrapped image
          if (dy > 0.5) dy -= 1.0; else if (dy < -0.5) dy += 1.0
          let d2 = dx * dx + dy * dy + EPS
          let f = G * m[j] / (d2 * Math.sqrt(d2))
          ax += f * dx; ay += f * dy
        }
        j++
      }
      vx[i] += ax * DT; vy[i] += ay * DT
    }
    i++
  }
  i = 0
  while (i < count) {
    if (i !== held) {
      x[i] += vx[i] * DT; y[i] += vy[i] * DT
      if (x[i] < 0.0) x[i] += 1.0; else if (x[i] >= 1.0) x[i] -= 1.0   // wrap
      if (y[i] < 0.0) y[i] += 1.0; else if (y[i] >= 1.0) y[i] -= 1.0
    }
    i++
  }
}

let disc = (fx, fy, rad, g) => {
  let cxi = fx | 0, cyi = fy | 0, ri = rad | 0
  if (ri < 1) ri = 1
  let r2 = rad * rad
  let col = (255 << 24) | (g << 16) | (g << 8) | g
  let oy = -ri
  while (oy <= ri) {
    let iy = cyi + oy
    if (iy >= 0 && iy < H) {
      let ox = -ri
      while (ox <= ri) {
        let ix = cxi + ox
        if (ix >= 0 && ix < W) { if (ox * ox + oy * oy <= r2) px[iy * W + ix] = col }
        ox++
      }
    }
    oy++
  }
}

export let frame = (t) => {
  let s = 0
  while (s < SUB) { step(); s++ }

  // fade for smooth trails
  let n = W * H, i = 0
  while (i < n) { let g = (px[i] & 255) * 234 >> 8; px[i] = (255 << 24) | (g << 16) | (g << 8) | g; i++ }

  let rscale = (W < H ? W : H) * 0.006
  i = 0
  while (i < count) {
    let fx = x[i] * W, fy = y[i] * H
    let rad = Math.sqrt(m[i]) * rscale
    if (rad < 1.5) rad = 1.5
    // continuous trail: draw a line of discs from last pos to current (unless it wrapped)
    let dx = fx - lx[i], dy = fy - ly[i]
    if (dx < W * 0.5 && dx > -W * 0.5 && dy < H * 0.5 && dy > -H * 0.5) {
      let steps = (Math.sqrt(dx * dx + dy * dy) | 0) + 1
      let k = 1
      while (k <= steps) { disc(lx[i] + dx * k / steps, ly[i] + dy * k / steps, rad, 255); k++ }
    } else {
      disc(fx, fy, rad, 255)
    }
    lx[i] = fx; ly[i] = fy
    i++
  }
}

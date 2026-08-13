// Lenia's canonical O2(a) Orbium unicaudatus (Chan, 2018).
//
//   U = K * A
//   A' = clip(A + dt * (2 exp(-(U-mu)^2 / (2 sigma^2)) - 1), 0, 1)
//
// The field is continuous, the domain is toroidal, and the normalized radial kernel is the
// original compact Gaussian bump. The official 20x20 Orbium seed and parameters are reproduced
// from Chakazul's Lenia catalogue. resize(w,h) returns an ARGB pixel buffer.

let W = 0, H = 0, N = 0
let a, b, px
let kx, ky, kw

const R = 13
const MU = 0.15
const SIGMA = 0.017
const DT = 0.1

// Official `(zip)` O2(a) seed decoded to hundredths. Keeping it numeric makes this source valid
// plain JS and avoids carrying a text decoder into the emitted module.
const OW = 20, OH = 20
const ORBIUM = new Int32Array([
  0, 0, 0, 0, 0, 0, 10, 14, 10, 0, 0, 3, 3, 0, 0, 30, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 8, 24, 30, 30, 18, 14, 15, 16, 15, 9, 20, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 15, 34, 44, 46, 38, 18, 14, 11, 13, 19, 18, 45, 0, 0, 0,
  0, 0, 0, 0, 6, 13, 39, 50, 50, 37, 6, 0, 0, 0, 2, 16, 68, 0, 0, 0,
  0, 0, 0, 11, 17, 17, 33, 40, 38, 28, 14, 0, 0, 0, 0, 0, 18, 42, 0, 0,
  0, 0, 9, 18, 13, 6, 8, 26, 32, 32, 27, 0, 0, 0, 0, 0, 0, 82, 0, 0,
  27, 0, 16, 12, 0, 0, 0, 25, 38, 44, 45, 34, 0, 0, 0, 0, 0, 22, 17, 0,
  0, 7, 20, 2, 0, 0, 0, 31, 48, 57, 60, 57, 0, 0, 0, 0, 0, 0, 49, 0,
  0, 59, 19, 0, 0, 0, 0, 20, 57, 69, 76, 76, 49, 0, 0, 0, 0, 0, 36, 0,
  0, 58, 19, 0, 0, 0, 0, 0, 67, 83, 90, 92, 87, 12, 0, 0, 0, 0, 22, 7,
  0, 0, 46, 0, 0, 0, 0, 0, 70, 93, 100, 100, 100, 61, 0, 0, 0, 0, 18, 11,
  0, 0, 82, 0, 0, 0, 0, 0, 47, 100, 100, 98, 100, 96, 27, 0, 0, 0, 19, 10,
  0, 0, 46, 0, 0, 0, 0, 0, 25, 100, 100, 84, 92, 97, 54, 14, 4, 10, 21, 5,
  0, 0, 0, 40, 0, 0, 0, 0, 9, 80, 100, 82, 80, 85, 63, 31, 18, 19, 20, 1,
  0, 0, 0, 36, 10, 0, 0, 0, 5, 54, 86, 79, 74, 72, 60, 39, 28, 24, 13, 0,
  0, 0, 0, 1, 30, 7, 0, 0, 8, 36, 64, 70, 64, 60, 51, 39, 29, 19, 4, 0,
  0, 0, 0, 0, 10, 24, 14, 10, 15, 29, 45, 53, 52, 46, 40, 31, 21, 8, 0, 0,
  0, 0, 0, 0, 0, 8, 21, 21, 22, 29, 36, 39, 37, 33, 26, 18, 9, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 3, 13, 19, 22, 24, 24, 23, 18, 13, 5, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 8, 9, 7, 5, 1, 0, 0, 0, 0, 0,
])

let tapCount = () => {
  let count = 0
  let y = -R
  while (y <= R) {
    let x = -R
    while (x <= R) {
      let r = Math.sqrt(x * x + y * y) / R
      if (r > 0.0 && r < 1.0) count++
      x++
    }
    y++
  }
  return count
}

let buildKernel = () => {
  let count = tapCount()
  kx = new Int32Array(count)
  ky = new Int32Array(count)
  kw = new Float64Array(count)

  let i = 0, sum = 0.0
  let y = -R
  while (y <= R) {
    let x = -R
    while (x <= R) {
      let r = Math.sqrt(x * x + y * y) / R
      if (r > 0.0 && r < 1.0) {
        let q = 4.0 * r * (1.0 - r)
        let weight = Math.exp(4.0 - 4.0 / q)
        kx[i] = x; ky[i] = y; kw[i] = weight
        sum = sum + weight
        i++
      }
      x++
    }
    y++
  }
  let inv = 1.0 / sum
  i = 0
  while (i < count) { kw[i] = kw[i] * inv; i++ }
}

export let resize = (w, h) => {
  W = w; H = h; N = w * h
  a = new Float64Array(N)
  b = new Float64Array(N)
  px = new Uint32Array(N)
  buildKernel()
  return px
}

export let clear = () => {
  let i = 0
  while (i < N) { a[i] = 0.0; b[i] = 0.0; px[i] = 0xff000000; i++ }
}

// Rotations are quarter-turns: enough to send otherwise identical Orbiums in different directions.
export let plant = (cx, cy, turn) => {
  let ox = (cx - OW * 0.5) | 0
  let oy = (cy - OH * 0.5) | 0
  let y = 0
  while (y < OH) {
    let x = 0
    while (x < OW) {
      let v = ORBIUM[y * OW + x] * 0.01
      if (v > 0.0) {
        let rx = x, ry = y
        if (turn === 1) { rx = OH - 1 - y; ry = x }
        else if (turn === 2) { rx = OW - 1 - x; ry = OH - 1 - y }
        else if (turn === 3) { rx = y; ry = OW - 1 - x }
        let xx = ox + rx, yy = oy + ry
        while (xx < 0) xx = xx + W
        while (xx >= W) xx = xx - W
        while (yy < 0) yy = yy + H
        while (yy >= H) yy = yy - H
        let at = yy * W + xx
        if (v > a[at]) a[at] = v
      }
      x++
    }
    y++
  }
}

// Paint a smooth density field directly into the world. Positive mode erases; zero paints.
// The brush wraps with the simulation, so a stroke remains continuous across either edge.
export let paint = (cx, cy, radius, erase) => {
  let r2 = radius * radius
  let y = (cy - radius) | 0, y1 = (cy + radius) | 0
  while (y <= y1) {
    let dy = y - cy
    let yy = y
    while (yy < 0) yy = yy + H
    while (yy >= H) yy = yy - H
    let x = (cx - radius) | 0, x1 = (cx + radius) | 0
    while (x <= x1) {
      let dx = x - cx
      let d2 = dx * dx + dy * dy
      if (d2 < r2) {
        let xx = x
        while (xx < 0) xx = xx + W
        while (xx >= W) xx = xx - W
        let at = yy * W + xx
        let f = 1.0 - d2 / r2
        f = f * f * (3.0 - 2.0 * f)
        let v = a[at]
        if (erase !== 0) v = v * (1.0 - f)
        else if (f > v) v = f
        a[at] = v
        let gray = (Math.sqrt(v) * 255.0) | 0
        px[at] = 0xff000000 | (gray << 16) | (gray << 8) | gray
      }
      x++
    }
    y++
  }
}

// Fill the field with separated canonical organisms; the seed only changes their orientation and
// small positional offsets, so every reset starts from valid Lenia rather than random soup.
export let seed = (seedValue) => {
  clear()
  let code = seedValue | 0
  let gap = 46
  let cols = (W / gap) | 0, rows = (H / gap) | 0
  if (cols < 1) cols = 1
  if (rows < 1) rows = 1
  let count = cols * rows
  if (count > 8) count = 8
  let i = 0
  while (i < count) {
    code = (code * 1664525 + 1013904223) | 0
    let col = i % cols, row = (i / cols) | 0
    let jx = ((code >> 4) & 7) - 3
    let jy = ((code >> 8) & 7) - 3
    let cx = (col + 0.5) * W / cols + jx
    let cy = (row + 0.5) * H / rows + jy
    plant(cx, cy, code & 3)
    i++
  }
}

let render = () => {
  let i = 0
  while (i < N) {
    let gray = (Math.sqrt(a[i]) * 255.0) | 0
    px[i] = 0xff000000 | (gray << 16) | (gray << 8) | gray
    i++
  }
}

export let frame = () => {
  let y = 0
  while (y < H) {
    let x = 0
    while (x < W) {
      let u = 0.0, k = 0
      while (k < kw.length) {
        let xx = x + kx[k], yy = y + ky[k]
        if (xx < 0) xx = xx + W; else if (xx >= W) xx = xx - W
        if (yy < 0) yy = yy + H; else if (yy >= H) yy = yy - H
        u = u + kw[k] * a[yy * W + xx]
        k++
      }
      let d = u - MU
      let growth = 2.0 * Math.exp(-(d * d) / (2.0 * SIGMA * SIGMA)) - 1.0
      let v = a[y * W + x] + DT * growth
      if (v < 0.0) v = 0.0; else if (v > 1.0) v = 1.0
      b[y * W + x] = v
      x++
    }
    y++
  }
  let next = a; a = b; b = next
  render()
}

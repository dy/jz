// Hero grid current — sparse electron-like pulses travelling along the blueprint grid.
// resize(w,h) -> Uint32Array; configure(gridX, scale); frame(t) renders transparent RGBA.

let W = 0, H = 0, px
let gridX = 0.0, mid = 40.0, major = 80.0
let PULSES = 18

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

export let configure = (x, scale) => {
  gridX = x
  mid = 40.0 * scale
  major = 80.0 * scale
  if (mid < 1.0) mid = 1.0
  if (major < 1.0) major = 1.0
}

let rnd = (n) => {
  let x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

let wrap = (x, m) => {
  x = x % m
  if (x < 0.0) x += m
  return x
}

let put = (x, y, a) => {
  let ix = x | 0, iy = y | 0
  if (ix < 0 || ix >= W || iy < 0 || iy >= H || a < 1.0) return
  let p = iy * W + ix
  let old = (px[p] >>> 24) & 255
  let ia = a | 0
  let na = old + ia
  if (na > 220) na = 220
  let r = 168 + ((na * 42) >> 8)
  let g = 190 + ((na * 48) >> 8)
  let b = 238 + ((na * 17) >> 8)
  if (b > 255) b = 255
  px[p] = (na << 24) | (b << 16) | (g << 8) | r
}

let mark = (x, y, a, wide) => {
  put(x, y, a)
  put(x - 1.0, y, a * 0.34)
  put(x + 1.0, y, a * 0.34)
  put(x, y - 1.0, a * 0.34)
  put(x, y + 1.0, a * 0.34)
  if (wide) {
    put(x - 2.0, y, a * 0.14)
    put(x + 2.0, y, a * 0.14)
    put(x, y - 2.0, a * 0.14)
    put(x, y + 2.0, a * 0.14)
  }
}

let spark = (x, y, a) => {
  mark(x, y, a, 1)
  put(x - 1.0, y - 1.0, a * 0.16)
  put(x + 1.0, y - 1.0, a * 0.16)
  put(x - 1.0, y + 1.0, a * 0.16)
  put(x + 1.0, y + 1.0, a * 0.16)
}

let nearJunction = (axis, x, y) => {
  let phase = axis === 0 ? x - gridX : y
  let step = mid
  let k = Math.floor(phase / step + 0.5)
  let j = axis === 0 ? gridX + k * step : k * step
  let d = axis === 0 ? Math.abs(x - j) : Math.abs(y - j)
  return d < 1.7
}

let linePos = (axis, step, seed) => {
  if (axis === 0) {
    let lines = ((H / step) | 0) + 2
    return ((seed * lines) | 0) * step
  }
  let lo = Math.floor((-gridX) / step) - 1
  let lines = ((W / step) | 0) + 5
  return gridX + (lo + ((seed * lines) | 0)) * step
}

let drawPulse = (axis, line, pos, dir, len, power, wide) => {
  let steps = len | 0
  if (steps < 8) steps = 8
  let k = 0
  while (k < steps) {
    let fall = 1.0 - k / steps
    let a = power * fall * fall
    let x = axis === 0 ? pos - dir * k : line
    let y = axis === 0 ? line : pos - dir * k
    mark(x, y, a, wide)
    k++
  }

  let hx = axis === 0 ? pos : line
  let hy = axis === 0 ? line : pos
  spark(hx, hy, power * 0.78)
  if (nearJunction(axis, hx, hy)) spark(hx, hy, power * 0.48)
}

export let frame = (t) => {
  let n = W * H, i = 0
  while (i < n) { px[i] = 0; i++ }

  i = 0
  while (i < PULSES) {
    let axis = rnd(i * 5.0 + 1.0) < 0.5 ? 0 : 1
    let isMajor = rnd(i * 7.0 + 3.0) > 0.66
    let step = isMajor ? major : mid
    let line = linePos(axis, step, rnd(i * 17.0 + 4.0))
    let dim = axis === 0 ? W : H
    let len = (isMajor ? 104.0 : 62.0) + rnd(i * 11.0 + 6.0) * (isMajor ? 86.0 : 58.0)
    let speed = (isMajor ? 54.0 : 74.0) + rnd(i * 13.0 + 8.0) * 52.0
    let power = (isMajor ? 54.0 : 34.0) + rnd(i * 19.0 + 10.0) * (isMajor ? 58.0 : 42.0)
    let dir = rnd(i * 23.0 + 12.0) < 0.5 ? 1.0 : -1.0
    let span = dim + len * 2.0
    let pos = wrap(t * speed + rnd(i * 29.0 + 14.0) * span, span) - len
    if (dir < 0.0) pos = dim - pos
    drawPulse(axis, line, pos, dir, len, power, isMajor)
    i++
  }
}

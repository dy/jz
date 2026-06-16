// Times-table circle — the number-theory cardioid machine. Place N points evenly around a
// circle, numbered 0…N−1. From each point i draw a chord to point (i·k) — its k-times-table
// entry, wrapping mod N. The chords are tangent to an envelope that is a pure curve: k=2
// draws a cardioid, k=3 a nephroid, k=4 a three-cusped epicycloid… and sweeping k continuously
// (it's a real here, not just an integer) morphs one into the next. A whole field of modular
// arithmetic, drawn with nothing but sines and additive lines.
//
// k is an f64 arg so it stays fractional (a module global would be i32-narrowed in jz, locking
// the animation). Lines blend additively — where many chords bunch, the envelope glows white.
// resize(w,h) → Uint32Array; frame(t, k, n) renders.

let W = 0, H = 0, px

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// additive, saturating pixel write — overlaps build toward white
let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = y * W + x
  let p = px[idx]
  let r = (p & 0xff) + rr
  let g = ((p >> 8) & 0xff) + gg
  let b = ((p >> 16) & 0xff) + bb
  if (r > 255) r = 255
  if (g > 255) g = 255
  if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

let line = (x0, y0, x1, y1, rr, gg, bb) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let x = x0, y = y0, s = 0
  while (s <= steps) {
    addpix(x | 0, y | 0, rr, gg, bb)
    x += xi; y += yi; s++
  }
}

export let frame = (t, k, n) => {
  let N = n | 0
  let i = 0, total = W * H
  while (i < total) { px[i] = (255 << 24); i++ }   // opaque black

  let cx = W * 0.5, cy = H * 0.5
  let R = (W < H ? W : H) * 0.46
  let inv = 6.283185307179586 / N
  let INT = 70.0

  i = 0
  while (i < N) {
    let a = i * inv
    let ax = cx + Math.cos(a) * R, ay = cy + Math.sin(a) * R
    let b = i * k * inv
    let bx = cx + Math.cos(b) * R, by = cy + Math.sin(b) * R
    // rainbow by position around the circle
    let h6 = (i / N) * 6.0
    let rr = Math.abs(h6 - 3.0) - 1.0
    let gg = 2.0 - Math.abs(h6 - 2.0)
    let bb = 2.0 - Math.abs(h6 - 4.0)
    if (rr < 0.0) rr = 0.0; if (rr > 1.0) rr = 1.0
    if (gg < 0.0) gg = 0.0; if (gg > 1.0) gg = 1.0
    if (bb < 0.0) bb = 0.0; if (bb > 1.0) bb = 1.0
    line(ax, ay, bx, by, (rr * INT) | 0, (gg * INT) | 0, (bb * INT) | 0)
    i++
  }
}

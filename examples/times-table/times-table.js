// Times-table circle — the number-theory cardioid machine. Place N points evenly around a
// circle, numbered 0…N−1. From each point i draw a chord to point (i·k) — its k-times-table
// entry, wrapping mod N. The chords are tangent to an envelope that is a pure curve: k=2
// draws a cardioid, k=3 a nephroid, k=4 a three-cusped epicycloid… and sweeping k continuously
// (it's a real here, not just an integer) morphs one into the next. A whole field of modular
// arithmetic, drawn with nothing but sines and additive lines.
//
// k is an f64 arg so it stays fractional (a module global would be i32-narrowed in jz, locking
// the animation). Lines blend additively — where many chords bunch, the envelope glows white.
//
// Current runs the map itself: a pulse rides chord i to its far end, point i·k, and carries on along
// that point's chord — so it traces the orbit i → ik → ik² … mod N, the multiplication's own
// dynamics. Heads splat into a fading heat field; spark(fx, fy) starts pulses at the nearest point.
// resize(w,h) → Uint32Array; frame(t, k, n) renders.

let W = 0, H = 0, px, heat
let NA = 14, MAXP = 60
let pi_ = new Int32Array(MAXP), ps = new Float64Array(MAXP), np = 0
let tch = new Float64Array(3)   // a pending touch: x, y px, armed

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  heat = new Float32Array(w * h)
  np = 0
  return px
}

export let spark = (fx, fy) => { tch[0] = fx * W; tch[1] = fy * H; tch[2] = 1.0 }

let dot = (hx, hy, r) => {
  let x0 = (hx - r) | 0, x1 = (hx + r + 1.0) | 0, y0 = (hy - r) | 0, y1 = (hy + r + 1.0) | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let ir2 = 1.0 / (r * r)
  let y = y0
  while (y <= y1) {
    let x = x0
    while (x <= x1) {
      let dx = x + 0.5 - hx, dy = y + 0.5 - hy
      let q = 1.0 - (dx * dx + dy * dy) * ir2
      if (q > 0.0) { let p = y * W + x; if (heat[p] < q) heat[p] = q }
      x++
    }
    y++
  }
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
    line(ax, ay, bx, by, INT | 0, INT | 0, INT | 0)
    i++
  }

  // the current: pulses ride chords at ~4 px a frame and carry on from the point they land on
  if (tch[2] > 0.5) {
    tch[2] = 0.0
    let a = Math.atan2(tch[1] - cy, tch[0] - cx)
    let j = Math.round(a / inv)
    j = ((j % N) + N) % N
    let q = 0
    while (q < 6 && np < MAXP) { pi_[np] = (j + q) % N; ps[np] = 0.0; np++; q++ }
  }
  while (np < NA) { pi_[np] = (Math.random() * N) | 0; ps[np] = Math.random(); np++ }
  let p = 0
  while (p < np) {
    let sub = 0
    while (sub < 4) {
      let a = pi_[p] * inv, b = pi_[p] * k * inv
      let ax = cx + Math.cos(a) * R, ay = cy + Math.sin(a) * R
      let bx = cx + Math.cos(b) * R, by = cy + Math.sin(b) * R
      let len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) + 1.0
      dot(ax + (bx - ax) * ps[p], ay + (by - ay) * ps[p], 2.4)
      ps[p] = ps[p] + 0.5 / len
      if (ps[p] >= 1.0) {
        let nx = Math.round(pi_[p] * k) % N
        if (nx === pi_[p] || p >= NA && Math.random() < 0.08) {   // a fixed point, or a spark spent
          if (p >= NA) { np--; pi_[p] = pi_[np]; ps[p] = ps[np]; p--; sub = 4 }
          else { pi_[p] = (Math.random() * N) | 0; ps[p] = 0.0 }
        } else { pi_[p] = nx; ps[p] = 0.0 }
      }
      sub++
    }
    p++
  }
  i = 0
  while (i < total) {
    let hh = heat[i]
    if (hh > 0.004) {
      let c = px[i] & 255
      let g = c + ((255 - c) * hh) | 0
      px[i] = (255 << 24) | (g << 16) | (g << 8) | g
      heat[i] = hh * 0.96
    }
    i++
  }
}

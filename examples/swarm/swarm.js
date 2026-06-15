// Swarm — "mouches", faithful to the old mouches.swf. Every fly obeys the same rules:
// accelerate toward the cursor at a fixed magnitude (MOOCHACCLERATION), feel GRAVITY, clamp
// to MOOCHSPEED, and bounce off the walls with ELASTICITY. Uniform rules (no per-fly noise)
// are what give the toy its coherent streaming swarm that chases and sags under the cursor.
// Each fly is a small triangle pointing where it's headed. Click adds one; hold streams them.
// resize(w,h) → Uint32Array.

let W = 0, H = 0, px

let MAXN = 3000
let x = new Float64Array(MAXN)
let y = new Float64Array(MAXN)
let vx = new Float64Array(MAXN)
let vy = new Float64Array(MAXN)
let count = 0
let tx = 0.5, ty = 0.5

// faithful to mouches.swf: a SPRING pull toward the cursor (accel ∝ distance, not a unit
// vector), gravity, a speed clamp, and bouncy walls. Ratios from the swf
// (GRAVITY 0.1 : MOOCHSPEED 0.04 : ELASTICITY 0.9), scaled to normalized space + slowed.
let ACC = 0.0013      // MOOCHACCLERATION (spring toward cursor)
let MAXSP = 0.0068    // MOOCHSPEED
let GRAV = 0.00019    // GRAVITY
let EL = 0.9          // ELASTICITY (bouncy walls)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(W * H)
  return px
}

let spawn1 = (cx, cy, spread) => {
  if (count >= MAXN) return
  let ang = Math.random() * 6.283185307179586, r = Math.random() * spread
  let i = count
  x[i] = cx + Math.cos(ang) * r
  y[i] = cy + Math.sin(ang) * r
  vx[i] = (Math.random() - 0.5) * 0.004
  vy[i] = (Math.random() - 0.5) * 0.004
  count++
}

export let init = () => { count = 0; let i = 0; while (i < 20) { spawn1(0.5, 0.4, 0.28); i++ } }   // MOOCHNUMBER = 20
export let setTarget = (a, b) => { tx = a; ty = b }
export let addFlies = (a, b, n) => { let i = 0; while (i < n) { spawn1(a, b, 0.03); i++ } }

// filled triangle (tip in heading dir) via bounding-box point-in-triangle
let tri = (cxf, cyf, ux, uy, s, col) => {
  let pxv = -uy, pyv = ux
  let ax = cxf + ux * s, ay = cyf + uy * s
  let bx = cxf - ux * s * 0.7 + pxv * s * 0.6, by = cyf - uy * s * 0.7 + pyv * s * 0.6
  let cx = cxf - ux * s * 0.7 - pxv * s * 0.6, cy = cyf - uy * s * 0.7 - pyv * s * 0.6
  let x0 = Math.floor(Math.min(ax, Math.min(bx, cx))), x1 = Math.ceil(Math.max(ax, Math.max(bx, cx)))
  let y0 = Math.floor(Math.min(ay, Math.min(by, cy))), y1 = Math.ceil(Math.max(ay, Math.max(by, cy)))
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let py = y0
  while (py <= y1) {
    let pxx = x0
    while (pxx <= x1) {
      let w0 = (bx - ax) * (py - ay) - (by - ay) * (pxx - ax)
      let w1 = (cx - bx) * (py - by) - (cy - by) * (pxx - bx)
      let w2 = (ax - cx) * (py - cy) - (ay - cy) * (pxx - cx)
      if ((w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) || (w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0))
        px[py * W + pxx] = col
      pxx++
    }
    py++
  }
}

export let frame = (t) => {
  let bg = 0xffffffff
  let i = 0, n = W * H
  while (i < n) { px[i] = bg; i++ }

  let col = (255 << 24) | (24 << 16) | (20 << 8) | 22
  i = 0
  while (i < count) {
    // velocity: spring pull toward cursor + gravity, clamped to top speed (mouches)
    let dx = tx - x[i], dy = ty - y[i]
    vx[i] += dx * ACC
    vy[i] += dy * ACC + GRAV
    let s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i])
    if (s > MAXSP) { let k = MAXSP / s; vx[i] *= k; vy[i] *= k }
    x[i] += vx[i]; y[i] += vy[i]
    // elastic walls
    if (x[i] < 0.0) { x[i] = 0.0; vx[i] = -vx[i] * EL } else if (x[i] > 1.0) { x[i] = 1.0; vx[i] = -vx[i] * EL }
    if (y[i] < 0.0) { y[i] = 0.0; vy[i] = -vy[i] * EL } else if (y[i] > 1.0) { y[i] = 1.0; vy[i] = -vy[i] * EL }

    let sv = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) + 0.000001
    tri(x[i] * W, y[i] * H, vx[i] / sv, vy[i] / sv, 7.0, col)   // bigger fly, faces travel dir
    i++
  }
}

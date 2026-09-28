// Swarm — "mouches", after mouches.swf (decompiled). There is NO velocity/momentum/
// gravity/bounce — that's the whole point. The swf ran two interval loops: every
// ~200ms each fly picks a fresh RANDOM target near the cursor (tx = cursorx +
// random(AREA) − AREA/2), and every frame shift-eases toward it plus a cos/sin
// flow-field nudge. This port keeps the same skeleton — periodic random re-target +
// ease — but replaces the shift-ease and fixed flow field with a smooth lerp and a
// decorrelated per-fly wander (no closed streamlines, so flies can't fall into orbits).
//
// The per-fly random re-targeting is what makes the motion look randomized (not an orbit);
// the lerp+wander gives the lazy buzz. Each fly is a triangle facing its motion, and its path is
// traced into a slowly fading ink buffer — a long exposure of the buzz, like flies photographed
// round a lamp. Coordinates are kept in pixels (as in the swf). resize(w,h) → Uint32Array.

let W = 0, H = 0, px
let ink                               // Float32Array — the long-exposure trace of every path
let MAXN = 3000
let x = new Float64Array(MAXN)        // position (px)
let y = new Float64Array(MAXN)
let tx = new Float64Array(MAXN)       // current random target (px)
let ty = new Float64Array(MAXN)
let tmr = new Float64Array(MAXN)      // frames until the next re-target
let wvx = new Float64Array(MAXN)      // per-fly wander velocity (Ornstein–Uhlenbeck)
let wvy = new Float64Array(MAXN)
let count = 0
let cx = 0.5, cy = 0.5                // cursor (normalized)
// theme palette: [paperR,G,B, inkR,G,B] — the harness feeds it; default = dark theme (black field,
// light flies). In light theme it flips to dark flies on the page paper.
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

let LERP = 0.008        // ease toward target (lazy approach — the swf drifts, never darts)
let AREAF = 0.4         // AREA as a fraction of the smaller side
let WKICK = 0.0011      // random kick added to wander velocity each frame (fraction of side)
let WDECAY = 0.9        // wander-velocity persistence (smoothness; lower = twitchier)
let REROLL = 22         // re-target interval in frames (~0.35s)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  ink = new Float32Array(w * h)
  return px
}

let reroll = (i) => {
  let area = (W < H ? W : H) * AREAF
  tx[i] = cx * W + (Math.random() - 0.5) * area
  ty[i] = cy * H + (Math.random() - 0.5) * area
  tmr[i] = REROLL * (0.6 + Math.random() * 0.8)     // staggered (the swf's per-fly `time`)
}

let spawn1 = (nx, ny) => {
  if (count >= MAXN) return
  let i = count
  x[i] = nx * W; y[i] = ny * H
  wvx[i] = 0.0; wvy[i] = 0.0
  reroll(i); count++
}

export let init = () => {
  count = 0
  let i = 0, n = W * H
  while (i < n) { ink[i] = 0; i++ }
  i = 0
  while (i < 20) { spawn1(0.5, 0.4); i++ }   // MOOCHNUMBER = 20
}
export let setTarget = (a, b) => { cx = a; cy = b }
export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }
export let addFlies = (a, b, n) => { let i = 0; while (i < n) { spawn1(a, b); i++ } }

// filled triangle (tip in dir) via bounding-box point-in-triangle
let tri = (cxf, cyf, ux, uy, s, col) => {
  let pvx = -uy, pvy = ux
  let ax = cxf + ux * s, ay = cyf + uy * s
  let bx = cxf - ux * s * 0.7 + pvx * s * 0.6, by = cyf - uy * s * 0.7 + pvy * s * 0.6
  let dx2 = cxf - ux * s * 0.7 - pvx * s * 0.6, dy2 = cyf - uy * s * 0.7 - pvy * s * 0.6
  let x0 = Math.floor(Math.min(ax, Math.min(bx, dx2))), x1 = Math.ceil(Math.max(ax, Math.max(bx, dx2)))
  let y0 = Math.floor(Math.min(ay, Math.min(by, dy2))), y1 = Math.ceil(Math.max(ay, Math.max(by, dy2)))
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let py = y0
  while (py <= y1) {
    let pxx = x0
    while (pxx <= x1) {
      let w0 = (bx - ax) * (py - ay) - (by - ay) * (pxx - ax)
      let w1 = (dx2 - bx) * (py - by) - (dy2 - by) * (pxx - bx)
      let w2 = (ax - dx2) * (py - dy2) - (ay - dy2) * (pxx - dx2)
      if ((w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) || (w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0))
        px[py * W + pxx] = col
      pxx++
    }
    py++
  }
}

// additive deposit of weight a at pixel (ix, iy)
let dep = (ix, iy, a) => {
  if (ix >= 0 && ix < W && iy >= 0 && iy < H) ink[iy * W + ix] += a
}

// anti-aliased hairline from (ax,ay) to (bx,by): bilinear splats every half pixel
let trace = (ax, ay, bx, by) => {
  let dx = bx - ax, dy = by - ay
  let n = (Math.sqrt(dx * dx + dy * dy) * 2.0 | 0) + 1
  let k = 0
  while (k < n) {
    let fx = ax + dx * k / n - 0.5, fy = ay + dy * k / n - 0.5
    let ix = Math.floor(fx), iy = Math.floor(fy)
    let ux = fx - ix, uy = fy - iy
    dep(ix, iy, (1.0 - ux) * (1.0 - uy) * 0.5)
    dep(ix + 1, iy, ux * (1.0 - uy) * 0.5)
    dep(ix, iy + 1, (1.0 - ux) * uy * 0.5)
    dep(ix + 1, iy + 1, ux * uy * 0.5)
    k++
  }
}

export let frame = (t) => {
  // the exposure: paths fade slowly (half-life ≈ 3 s), so each fly leaves a wandering hairline;
  // composite it at up to half the ink's strength over the paper, saturating softly where paths pile up
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  let i = 0, n = W * H
  while (i < n) {
    let e = ink[i] * 0.996
    ink[i] = e
    let v = e < 1.0 ? e * 0.55 : 0.55
    let r = (pr + (ir - pr) * v) | 0
    let g = (pg + (ig - pg) * v) | 0
    let b = (pb + (ib - pb) * v) | 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }

  let kick = (W < H ? W : H) * WKICK
  let size = (W < H ? W : H) * 0.0085
  if (size < 5.0) size = 5.0
  let col = (255 << 24) | ((ib | 0) << 16) | ((ig | 0) << 8) | (ir | 0)  // page ink (flies)
  i = 0
  while (i < count) {
    tmr[i] -= 1.0
    if (tmr[i] <= 0.0) reroll(i)
    let dx = tx[i] - x[i], dy = ty[i] - y[i]
    // decorrelated per-fly wander: smooth random drift, no closed streamlines (no orbits)
    wvx[i] = wvx[i] * WDECAY + (Math.random() - 0.5) * kick
    wvy[i] = wvy[i] * WDECAY + (Math.random() - 0.5) * kick
    // direct lerp toward the (random, near-cursor) target — no inertia, so it can't orbit it
    let mvx = dx * LERP + wvx[i], mvy = dy * LERP + wvy[i]
    trace(x[i], y[i], x[i] + mvx, y[i] + mvy)
    x[i] += mvx; y[i] += mvy
    let d = Math.sqrt(mvx * mvx + mvy * mvy) + 0.0001
    tri(x[i], y[i], mvx / d, mvy / d, size, col)      // face actual motion
    i++
  }
}

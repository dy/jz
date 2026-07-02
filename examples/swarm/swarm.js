// Swarm — "mouches", after mouches.swf (decompiled). There is NO velocity/momentum/
// gravity/bounce — that's the whole point. The swf ran two interval loops: every
// ~200ms each fly picks a fresh RANDOM target near the cursor (tx = cursorx +
// random(AREA) − AREA/2), and every frame shift-eases toward it plus a cos/sin
// flow-field nudge. This port keeps the same skeleton — periodic random re-target +
// ease — but replaces the shift-ease and fixed flow field with a smooth lerp and a
// decorrelated per-fly wander (no closed streamlines, so flies can't fall into orbits).
//
// The per-fly random re-targeting is what makes the motion look randomized (not an orbit);
// the lerp+wander gives the lazy buzz. Each fly is a triangle facing its motion.
// Coordinates are kept in pixels (as in the swf). resize(w,h) → Uint32Array.

let W = 0, H = 0, px
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

export let init = () => { count = 0; let i = 0; while (i < 20) { spawn1(0.5, 0.4); i++ } }   // MOOCHNUMBER = 20
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

export let frame = (t) => {
  let bg = (255 << 24) | ((th[2] | 0) << 16) | ((th[1] | 0) << 8) | (th[0] | 0)   // page paper
  let i = 0, n = W * H
  while (i < n) { px[i] = bg; i++ }

  let kick = (W < H ? W : H) * WKICK
  let col = (255 << 24) | ((th[5] | 0) << 16) | ((th[4] | 0) << 8) | (th[3] | 0)  // page ink (flies)
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
    x[i] += mvx; y[i] += mvy
    let d = Math.sqrt(mvx * mvx + mvy * mvy) + 0.0001
    tri(x[i], y[i], mvx / d, mvy / d, 7.0, col)       // face actual motion
    i++
  }
}

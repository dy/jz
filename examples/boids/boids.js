// Boids — Craig Reynolds' flocking (1986), the three-rule model that gives starling
// murmurations, fish schools and CG crowds. Every boid steers by only what it can see
// (its visual range), summing three urges:
//   · cohesion  — steer toward the average position of nearby boids
//   · alignment — steer toward their average heading
//   · separation — steer away from any that crowd too close
// No leader, no global plan — flocking is emergent. Plus an edge turn-back and a
// speed clamp (after Ben Eater's https://eater.net/boids), and the cursor is a hawk:
// press and the flock scatters, then re-forms. It's O(N²) neighbor checks per frame —
// a few hundred boids is a million distance tests a frame, exactly what jz makes cheap.
//
// All boid state lives in Float64Arrays (scalar f64 globals would be i32-narrowed in jz,
// freezing the motion). resize(w,h) → Uint32Array; frame(t, mx, my, mdown) renders.

let W = 0, H = 0, px
let MAXN = 1200
let bx = new Float64Array(MAXN)        // position
let by = new Float64Array(MAXN)
let bvx = new Float64Array(MAXN)       // velocity
let bvy = new Float64Array(MAXN)
let count = 0

// dimensionless steering gains (these transfer across canvas sizes unchanged)
let CENTERING = 0.0009                 // cohesion pull
let MATCHING = 0.05                    // alignment
let AVOID = 0.06                       // separation push
let SEED = 0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// cheap deterministic PRNG so init() doesn't depend on Math.random's seeding
let rnd = () => {
  SEED = (SEED * 1103515245 + 12345) | 0
  return ((SEED >>> 8) & 0xffff) / 65536.0
}

let spawn1 = (fx, fy) => {
  if (count >= MAXN) return
  let i = count
  bx[i] = fx * W; by[i] = fy * H
  let a = rnd() * 6.2831853
  let s = (W < H ? W : H) * 0.006
  bvx[i] = Math.cos(a) * s; bvy[i] = Math.sin(a) * s
  count++
}

export let init = () => {
  SEED = 1234567; count = 0
  let i = 0
  while (i < 240) { spawn1(rnd(), rnd()); i++ }
}
export let addBoids = (fx, fy, n) => { let i = 0; while (i < n) { spawn1(fx + (rnd() - 0.5) * 0.04, fy + (rnd() - 0.5) * 0.04); i++ } }

// filled triangle facing (ux,uy), tip forward — bounding-box point-in-triangle (after swarm.js)
let tri = (cxf, cyf, ux, uy, s, col) => {
  let pvx = -uy, pvy = ux
  let ax = cxf + ux * s, ay = cyf + uy * s
  let bxp = cxf - ux * s * 0.7 + pvx * s * 0.55, byp = cyf - uy * s * 0.7 + pvy * s * 0.55
  let dx2 = cxf - ux * s * 0.7 - pvx * s * 0.55, dy2 = cyf - uy * s * 0.7 - pvy * s * 0.55
  let x0 = Math.floor(Math.min(ax, Math.min(bxp, dx2))), x1 = Math.ceil(Math.max(ax, Math.max(bxp, dx2)))
  let y0 = Math.floor(Math.min(ay, Math.min(byp, dy2))), y1 = Math.ceil(Math.max(ay, Math.max(byp, dy2)))
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let py = y0
  while (py <= y1) {
    let pxx = x0
    while (pxx <= x1) {
      let w0 = (bxp - ax) * (py - ay) - (byp - ay) * (pxx - ax)
      let w1 = (dx2 - bxp) * (py - byp) - (dy2 - byp) * (pxx - bxp)
      let w2 = (ax - dx2) * (py - dy2) - (ay - dy2) * (pxx - dx2)
      if ((w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) || (w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0))
        px[py * W + pxx] = col
      pxx++
    }
    py++
  }
}

export let frame = (t, mx, my, mdown) => {
  // fade the buffer toward black → motion trails (a starling murmuration smears the air)
  let i = 0, n = W * H
  while (i < n) {
    let p = px[i]
    let r = ((p & 0xff) * 205) >> 8
    let g = ((p >> 8 & 0xff) * 205) >> 8
    let b = ((p >> 16 & 0xff) * 205) >> 8
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }

  let S = (W < H ? W : H)
  let VR = S * 0.09, VR2 = VR * VR        // visual range
  let PR = S * 0.022, PR2 = PR * PR       // protected (separation) range
  let MAXS = S * 0.011, MINS = S * 0.005  // speed clamp
  let MARGIN = S * 0.10, TURN = S * 0.0009
  let FLEE = S * 0.20, FLEE2 = FLEE * FLEE
  let size = S * 0.011

  i = 0
  while (i < count) {
    let xp = bx[i], yp = by[i]
    let cx = 0.0, cy = 0.0, avx = 0.0, avy = 0.0, sx = 0.0, sy = 0.0
    let neigh = 0
    let j = 0
    while (j < count) {
      if (j != i) {
        let dx = bx[j] - xp, dy = by[j] - yp
        let d2 = dx * dx + dy * dy
        if (d2 < VR2) {
          cx += bx[j]; cy += by[j]; avx += bvx[j]; avy += bvy[j]; neigh++
          if (d2 < PR2) { sx -= dx; sy -= dy }   // steer away from a crowding neighbor
        }
      }
      j++
    }
    let vx = bvx[i], vy = bvy[i]
    if (neigh > 0) {
      let inv = 1.0 / neigh
      vx += (cx * inv - xp) * CENTERING + (avx * inv - vx) * MATCHING
      vy += (cy * inv - yp) * CENTERING + (avy * inv - vy) * MATCHING
    }
    vx += sx * AVOID; vy += sy * AVOID

    // the hawk: flee the cursor while it's pressed
    if (mdown > 0.5) {
      let dx = xp - mx, dy = yp - my
      let d2 = dx * dx + dy * dy
      if (d2 < FLEE2) {
        let d = Math.sqrt(d2) + 0.001
        let f = (1.0 - d / FLEE) * MAXS * 0.9
        vx += dx / d * f; vy += dy / d * f
      }
    }

    // turn back at the edges (a soft wall, not a wrap — keeps the flock on stage)
    if (xp < MARGIN) vx += TURN
    if (xp > W - MARGIN) vx -= TURN
    if (yp < MARGIN) vy += TURN
    if (yp > H - MARGIN) vy -= TURN

    // clamp speed into [MINS, MAXS] so they always cruise, never freeze or rocket off
    let sp = Math.sqrt(vx * vx + vy * vy)
    if (sp > MAXS) { vx = vx / sp * MAXS; vy = vy / sp * MAXS; sp = MAXS }
    if (sp < MINS && sp > 0.0001) { vx = vx / sp * MINS; vy = vy / sp * MINS; sp = MINS }

    bvx[i] = vx; bvy[i] = vy
    bx[i] = xp + vx; by[i] = yp + vy

    // color by heading — the flock reads as a rainbow that swirls as one
    let ux = vx / (sp + 0.0001), uy = vy / (sp + 0.0001)
    let h6 = (Math.atan2(uy, ux) * 0.1591549 + 0.5) * 6.0     // atan2/2π + .5, in [0,6)
    let rr = Math.abs(h6 - 3.0) - 1.0
    let gg = 2.0 - Math.abs(h6 - 2.0)
    let bb = 2.0 - Math.abs(h6 - 4.0)
    if (rr < 0.0) rr = 0.0; if (rr > 1.0) rr = 1.0
    if (gg < 0.0) gg = 0.0; if (gg > 1.0) gg = 1.0
    if (bb < 0.0) bb = 0.0; if (bb > 1.0) bb = 1.0
    let col = (255 << 24) | (((40.0 + bb * 215.0) | 0) << 16) | (((40.0 + gg * 215.0) | 0) << 8) | ((40.0 + rr * 215.0) | 0)
    tri(bx[i], by[i], ux, uy, size, col)
    i++
  }
}

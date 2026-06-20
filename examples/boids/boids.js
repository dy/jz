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
let ink                                // Uint8Array — per-pixel ink amount (the murmuration trail)
let MAXN = 1200
let bx = new Float64Array(MAXN)        // position
let by = new Float64Array(MAXN)
let bvx = new Float64Array(MAXN)       // velocity
let bvy = new Float64Array(MAXN)
let count = 0
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; default = dark theme (black sky, light birds)
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

// dimensionless steering gains (these transfer across canvas sizes unchanged)
let CENTERING = 0.0009                 // cohesion pull
let MATCHING = 0.05                    // alignment
let AVOID = 0.06                       // separation push
let SEED = 0

export let resize = (w, h) => {
  W = w; H = h
  ink = new Uint8Array(w * h)
  px = new Uint32Array(w * h)
  return px
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

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

// filled triangle facing (ux,uy), tip forward — stamps full ink into the trail buffer
let tri = (cxf, cyf, ux, uy, s) => {
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
        ink[py * W + pxx] = 255
      pxx++
    }
    py++
  }
}

export let frame = (t, mx, my, mdown) => {
  // fade the ink toward zero → motion trails (a starling murmuration smears the air)
  let i = 0, n = W * H
  while (i < n) { ink[i] = (ink[i] * 205) >> 8; i++ }

  let S = (W < H ? W : H)
  let VR = S * 0.09, VR2 = VR * VR        // visual range
  let PR = S * 0.022, PR2 = PR * PR       // protected (separation) range
  let MAXS = S * 0.0035, MINS = S * 0.0016  // speed clamp — a slow, lazy drift
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

    let ux = vx / (sp + 0.0001), uy = vy / (sp + 0.0001)
    tri(bx[i], by[i], ux, uy, size)
    i++
  }

  // composite: every pixel = lerp(paper, ink, trail) → birds in the page ink over the page paper,
  // flipping with the light/dark theme.
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  i = 0
  while (i < n) {
    let v = ink[i] / 255.0
    let r = (pr + (ir - pr) * v) | 0
    let g = (pg + (ig - pg) * v) | 0
    let b = (pb + (ib - pb) * v) | 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}

// Dynamic Window Approach — Fox, Burgard & Thrun (1997), reproduced after Andrew Davison's
// Imperial demo (https://www.doc.ic.ac.uk/~ajd/Planning/). A faithful port of HIS planner. The robot
// is differential drive (two wheels, separation L). Each tick it samples the (vLeft, vRight) pairs
// reachable within one acceleration step — the "dynamic window" — and for each predicts the EXACT
// circular arc the wheels trace over a fixed horizon. Arcs that would hit a sphere are inadmissible;
// among the rest it maximises the Fox/Burgard/Thrun objective — three terms, each normalised to [0,1]:
//
//   benefit = AH·heading(face the goal) + AC·clearance(distance to spheres) + AV·velocity(drive forward)
//
// (Davison's page quotes raw weights 12 / 6666 tuned to metres; at pixel scale the clearance term
// swamps the rest and the robot stalls, so we use the original normalised, scale-invariant form.) It
// commits the winning wheel speeds for one tick and replans — pure reactive control, no map.
//
// Look follows his demo: black floor, white spheres, a faint white fan of 169 candidate arcs, the
// chosen arc and the robot in red, a hollow target ring, a fading trail.
//
// All continuous state lives in Float64Arrays — a scalar f64 module global is i32-narrowed in jz.
// resize(w,h) → Uint32Array; frame(t) drives; setGoal(fx,fy) steers.

let W = 0, H = 0, px
let trail              // Uint8Array — fading trail intensity (0..255)
let SEED = 0

// robot pose + wheel velocities
let RX = 0, RY = 1, RH = 2, VL = 3, VR = 4
let rob = new Float64Array(5)
let goal = new Float64Array(2)

// the flying spheres
let MAXO = 26
let ox = new Float64Array(MAXO), oy = new Float64Array(MAXO)
let ovx = new Float64Array(MAXO), ovy = new Float64Array(MAXO), orr = new Float64Array(MAXO)
let nobs = 0

// theme palette [paperR,G,B, inkR,G,B] — default = his look (black floor, white spheres)
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

// the one accent — red for the robot, the chosen arc, and the collision alarm
let ACR = 232.0, ACG = 58.0, ACB = 42.0

// deterministic PRNG
let rnd = () => {
  SEED = (SEED * 1103515245 + 12345) | 0
  return ((SEED >>> 8) & 0xffff) / 65536.0
}

// ── drawing primitives (ARGB = 0xAABBGGRR) ──
let bl = (idx, r, g, b, a) => {
  let p = px[idx]
  let pr = p & 255, pg = (p >> 8) & 255, pb = (p >> 16) & 255
  let nr = (pr + (r - pr) * a) | 0, ng = (pg + (g - pg) * a) | 0, nb = (pb + (b - pb) * a) | 0
  px[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr
}

let lineA = (x0, y0, x1, y1, r, g, b, a) => {
  let x = x0 | 0, y = y0 | 0, xe = x1 | 0, ye = y1 | 0
  let dx = Math.abs(xe - x), dy = Math.abs(ye - y)
  let sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1, err = dx - dy, gd = 0
  while (gd < 4000) {
    if (x >= 0 && x < W && y >= 0 && y < H) bl(y * W + x, r, g, b, a)
    if (x === xe && y === ye) break
    let e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
    gd++
  }
}

let discA = (cx, cy, rad, r, g, b, a) => {
  let ci = cx | 0, cj = cy | 0, ri = rad | 0, r2 = rad * rad, oyl = -ri
  while (oyl <= ri) {
    let jy = cj + oyl
    if (jy >= 0 && jy < H) {
      let oxl = -ri
      while (oxl <= ri) {
        let ix = ci + oxl
        if (ix >= 0 && ix < W) { if (oxl * oxl + oyl * oyl <= r2) bl(jy * W + ix, r, g, b, a) }
        oxl++
      }
    }
    oyl++
  }
}

let ringA = (cx, cy, rad, thick, r, g, b, a) => {
  let ci = cx | 0, cj = cy | 0, ro = (rad + thick) | 0, oyl = -ro
  let lo = rad - thick, hi = rad + thick
  while (oyl <= ro) {
    let jy = cj + oyl
    if (jy >= 0 && jy < H) {
      let oxl = -ro
      while (oxl <= ro) {
        let ix = ci + oxl
        if (ix >= 0 && ix < W) {
          let d = Math.sqrt(oxl * oxl + oyl * oyl)
          if (d >= lo && d <= hi) bl(jy * W + ix, r, g, b, a)
        }
        oxl++
      }
    }
    oyl++
  }
}

// filled triangle facing (ux,uy), tip forward — the robot, opaque
let triA = (cxf, cyf, ux, uy, s, r, g, b) => {
  let pvx = -uy, pvy = ux
  let ax = cxf + ux * s * 1.5, ay = cyf + uy * s * 1.5
  let bxp = cxf - ux * s + pvx * s * 0.85, byp = cyf - uy * s + pvy * s * 0.85
  let dx2 = cxf - ux * s - pvx * s * 0.85, dy2 = cyf - uy * s - pvy * s * 0.85
  let x0 = Math.floor(Math.min(ax, Math.min(bxp, dx2))), x1 = Math.ceil(Math.max(ax, Math.max(bxp, dx2)))
  let y0 = Math.floor(Math.min(ay, Math.min(byp, dy2))), y1 = Math.ceil(Math.max(ay, Math.max(byp, dy2)))
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let col = (255 << 24) | (b << 16) | (g << 8) | r
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

// stamp the trail buffer at the robot's spot
let stamp = (cx, cy, rr) => {
  let ci = cx | 0, cj = cy | 0, ri = rr | 0, r2 = rr * rr, oyl = -ri
  while (oyl <= ri) {
    let jy = cj + oyl
    if (jy >= 0 && jy < H) {
      let oxl = -ri
      while (oxl <= ri) {
        let ix = ci + oxl
        if (ix >= 0 && ix < W) { if (oxl * oxl + oyl * oyl <= r2) trail[jy * W + ix] = 255 }
        oxl++
      }
    }
    oyl++
  }
}

// fling a fresh sphere across the arena (a "flying" obstacle that drifts and bounces)
let spawnObstacle = (i) => {
  let S = (W < H ? W : H)
  ox[i] = W * (0.16 + rnd() * 0.74); oy[i] = H * (0.1 + rnd() * 0.8)
  let a = rnd() * 6.2831853, sp = S * 0.0004 * (0.5 + rnd() * 0.9)
  ovx[i] = Math.cos(a) * sp; ovy[i] = Math.sin(a) * sp
  orr[i] = S * (0.016 + rnd() * 0.010)
}

// pick a fresh goal clear of every sphere and a good throw from the robot
let newGoal = () => {
  let S = (W < H ? W : H), tries = 0
  while (tries < 200) {
    let gx = W * (0.1 + rnd() * 0.8), gy = H * (0.1 + rnd() * 0.8)
    let ok = 1, i = 0
    while (i < nobs) {
      let dx = gx - ox[i], dy = gy - oy[i], m = orr[i] + S * 0.05
      if (dx * dx + dy * dy < m * m) ok = 0
      i++
    }
    let dxr = gx - rob[RX], dyr = gy - rob[RY]
    if (ok > 0 && dxr * dxr + dyr * dyr > (S * 0.3) * (S * 0.3)) { goal[0] = gx; goal[1] = gy; return }
    tries++
  }
  goal[0] = W * 0.5; goal[1] = H * 0.5
}

export let resize = (w, h) => {
  W = w; H = h
  trail = new Uint8Array(w * h)
  px = new Uint32Array(w * h)
  return px
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

export let init = () => {
  SEED = 20240626
  rob[RX] = W * 0.12; rob[RY] = H * 0.5; rob[RH] = 0.0; rob[VL] = 0.0; rob[VR] = 0.0
  nobs = 13
  let i = 0
  while (i < nobs) { spawnObstacle(i); i++ }
  newGoal()
}

// host steers the goal: click or drag (normalized coords)
export let setGoal = (fx, fy) => { goal[0] = fx * W; goal[1] = fy * H }

export let frame = (t) => {
  let S = (W < H ? W : H)
  let VMAX = S * 0.0032                  // max wheel velocity (px/step) — gentle, near his pace
  let L = S * 0.026                      // wheel separation ≈ robot width — Davison 0.20 m
  let A = VMAX * 0.05                     // acceleration·dt: Davison 0.50 m/s² · 0.05 s = 5% of v_max
  let SIG = VMAX * 0.10                   // barrier velocity σ — below this |vR−vL| an arc is a straight line
  let RR = S * 0.012                      // robot radius
  let STEPS = 15                          // steps ahead to plan — his horizon (kept fluid; weight is in NS)
  let SAFE = S * 0.030                    // barrier band: clearance benefit saturates beyond this
  // objective weights — each term is normalised to [0,1], so these are directly comparable
  let AH = 0.6                            // heading: turn to FACE the goal (works even at zero speed)
  let AC = 0.3                            // clearance: keep distance from the spheres
  let AV = 0.2                            // velocity: keep driving FORWARD (never stall, never reverse to travel)
  let NS = 13                             // wheel-velocity samples per wheel → 169 candidate arcs (dense fan)

  // the spheres fly, bouncing off walls
  let i = 0
  while (i < nobs) {
    ox[i] += ovx[i]; oy[i] += ovy[i]
    if (ox[i] < orr[i] || ox[i] > W - orr[i]) ovx[i] = -ovx[i]
    if (oy[i] < orr[i] || oy[i] > H - orr[i]) ovy[i] = -ovy[i]
    if (ox[i] < orr[i]) ox[i] = orr[i]
    if (ox[i] > W - orr[i]) ox[i] = W - orr[i]
    if (oy[i] < orr[i]) oy[i] = orr[i]
    if (oy[i] > H - orr[i]) oy[i] = H - orr[i]
    i++
  }

  let rx = rob[RX], ry = rob[RY], rh = rob[RH]

  // fade the trail, then stamp the current spot
  let n = W * H, k = 0
  while (k < n) { trail[k] = (trail[k] * 253) >> 8; k++ }   // ~0.988/frame — persists a couple of seconds even at 120fps
  stamp(rx, ry, RR * 0.7)

  // composite floor (black paper) + trail (white, faint)
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  k = 0
  while (k < n) {
    let v = trail[k] / 255.0 * 0.5
    let r = (pr + (ir - pr) * v) | 0, g = (pg + (ig - pg) * v) | 0, b = (pb + (ib - pb) * v) | 0
    px[k] = (255 << 24) | (b << 16) | (g << 8) | r
    k++
  }

  // the spheres (white, solid)
  i = 0
  while (i < nobs) { discA(ox[i], oy[i], orr[i], ir, ig, ib, 1.0); i++ }

  // ── dynamic window: the (vL, vR) reachable within one acceleration step, clamped to ±v_max ──
  let vlLo = rob[VL] - A, vlHi = rob[VL] + A
  let vrLo = rob[VR] - A, vrHi = rob[VR] + A
  if (vlLo < -VMAX) vlLo = -VMAX
  if (vlHi > VMAX) vlHi = VMAX
  if (vrLo < -VMAX) vrLo = -VMAX
  if (vrHi > VMAX) vrHi = VMAX

  let best = -1e30, bvl = 0.0, bvr = 0.0, haveAdm = 0
  let fbClr = -1e30, fvl = 0.0, fvr = 0.0    // safest arc — the escape if every reachable arc would collide

  let il = 0
  while (il < NS) {
    let vl = vlLo + (vlHi - vlLo) * il / (NS - 1)
    let ix2 = 0
    while (ix2 < NS) {
      let vr = vrLo + (vrHi - vrLo) * ix2 / (NS - 1)
      let dvr = vr - vl, v = (vl + vr) * 0.5

      // predict the EXACT differential-drive arc, step by step, tracking the closest obstacle/wall
      let ex = rx, ey = ry, eh = rh, clr = SAFE, lpx = rx, lpy = ry, s = 0
      while (s < STEPS) {
        if (dvr < SIG && dvr > -SIG) {              // straight line (vL ≈ vR)
          ex += Math.cos(eh) * v; ey += Math.sin(eh) * v
        } else {                                     // circular arc about the ICC
          let dth = dvr / L
          let R = (L * 0.5) * (vr + vl) / dvr
          let nth = eh + dth
          ex += R * (Math.sin(nth) - Math.sin(eh))
          ey -= R * (Math.cos(nth) - Math.cos(eh))
          eh = nth
        }
        let j = 0
        while (j < nobs) {
          let ddx = ex - ox[j], ddy = ey - oy[j]
          let d = Math.sqrt(ddx * ddx + ddy * ddy) - orr[j] - RR
          if (d < clr) clr = d
          j++
        }
        let wc = ex
        if (W - ex < wc) wc = W - ex
        if (ey < wc) wc = ey
        if (H - ey < wc) wc = H - ey
        wc -= RR
        if (wc < clr) clr = wc
        lineA(lpx, lpy, ex, ey, ir, ig, ib, 0.22)   // candidate path — faint white (the visible fan)
        lpx = ex; lpy = ey; s++
      }

      // score by the normalised objective; a colliding arc (clr < 0) is inadmissible — skipped, but kept
      // as the safest-fallback candidate so a boxed-in robot can still edge toward the least-bad arc
      if (clr > fbClr) { fbClr = clr; fvl = vl; fvr = vr }
      if (clr >= 0.0) {
        let gdx = goal[0] - ex, gdy = goal[1] - ey
        let gl = Math.sqrt(gdx * gdx + gdy * gdy) + 0.0001
        let head = 0.5 * (1.0 + (Math.cos(eh) * gdx + Math.sin(eh) * gdy) / gl)   // 1 = facing the goal
        let cN = clr > SAFE ? 1.0 : clr / SAFE                                     // clearance, normalised
        let velN = v > 0.0 ? v / VMAX : 0.0                                        // forward speed, normalised
        let benefit = AH * head + AC * cN + AV * velN
        if (benefit > best) { best = benefit; bvl = vl; bvr = vr; haveAdm = 1 }
      }
      ix2++
    }
    il++
  }

  if (haveAdm < 1) { bvl = fvl; bvr = fvr }   // boxed in → take the safest reachable arc and edge out

  // chosen arc: bright red (predict the same exact arc and draw it opaque)
  let cvl = bvl, cvr = bvr, cdvr = cvr - cvl, cv = (cvl + cvr) * 0.5
  let ex2 = rx, ey2 = ry, eh2 = rh, lpx3 = rx, lpy3 = ry, s2 = 0
  while (s2 < STEPS) {
    if (cdvr < SIG && cdvr > -SIG) {
      ex2 += Math.cos(eh2) * cv; ey2 += Math.sin(eh2) * cv
    } else {
      let dth = cdvr / L
      let R = (L * 0.5) * (cvr + cvl) / cdvr
      let nth = eh2 + dth
      ex2 += R * (Math.sin(nth) - Math.sin(eh2))
      ey2 -= R * (Math.cos(nth) - Math.cos(eh2))
      eh2 = nth
    }
    lineA(lpx3, lpy3, ex2, ey2, ACR | 0, ACG | 0, ACB | 0, 0.95)
    lpx3 = ex2; lpy3 = ey2; s2++
  }

  // goal — a hollow white ring + pip (distinct from the filled spheres)
  ringA(goal[0], goal[1], S * 0.019, 1.6, ir, ig, ib, 0.95)
  discA(goal[0], goal[1], S * 0.005, ir, ig, ib, 0.95)

  // the robot — a red arrowhead along its heading
  triA(rx, ry, Math.cos(rh), Math.sin(rh), RR * 1.4, ACR | 0, ACG | 0, ACB | 0)

  // collision alarm — should the planner ever fail, mark the contact in red
  let hit = -1, jc = 0
  while (jc < nobs) {
    let ddx = rx - ox[jc], ddy = ry - oy[jc], rsum = orr[jc] + RR
    if (ddx * ddx + ddy * ddy < rsum * rsum) hit = jc
    jc++
  }
  if (hit >= 0) {
    ringA(rx, ry, RR * 2.6, 2.0, ACR | 0, ACG | 0, ACB | 0, 1.0)
    ringA(ox[hit], oy[hit], orr[hit] + 1.5, 2.0, ACR | 0, ACG | 0, ACB | 0, 0.95)
  }

  // arrived? new goal + a fresh sphere (his demo grows the field)
  let dgx = goal[0] - rx, dgy = goal[1] - ry
  if (dgx * dgx + dgy * dgy < (RR + S * 0.02) * (RR + S * 0.02)) {
    newGoal()
    if (nobs < MAXO) { spawnObstacle(nobs); nobs++ }
    else spawnObstacle((rnd() * nobs) | 0)
  }

  // commit the winning wheel speeds for one tick (the same exact arc, one step)
  if (cdvr < SIG && cdvr > -SIG) {
    rob[RX] = rx + Math.cos(rh) * cv; rob[RY] = ry + Math.sin(rh) * cv; rob[RH] = rh
  } else {
    let dth = cdvr / L
    let R = (L * 0.5) * (cvr + cvl) / cdvr
    let nth = rh + dth
    rob[RX] = rx + R * (Math.sin(nth) - Math.sin(rh))
    rob[RY] = ry - R * (Math.cos(nth) - Math.cos(rh))
    rob[RH] = nth
  }
  rob[VL] = bvl; rob[VR] = bvr
  if (rob[RX] < RR) rob[RX] = RR
  if (rob[RX] > W - RR) rob[RX] = W - RR
  if (rob[RY] < RR) rob[RY] = RR
  if (rob[RY] > H - RR) rob[RY] = H - RR
}

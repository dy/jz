// Dynamic Window Approach — a faithful port of Andrew Davison's planner (https://www.doc.ic.ac.uk/~ajd/Planning/,
// after Fox, Burgard & Thrun 1997). The robot is differential drive (two wheels, track width L). Each tick it
// considers the 3×3 reachable wheel-speed pairs — each wheel may decelerate, hold, or accelerate by one
// acceleration step (vL,vR ∈ {v−aΔt, v, v+aΔt}) — predicts the single closed-form arc each traces over the
// horizon TAU = stepsAhead·dt, and scores it by Davison's benefit, evaluated at the predicted ENDPOINT:
//
//        benefit = FORWARDWEIGHT·(distance closed to the goal)  −  OBSTACLEWEIGHT·(safeDist − clearance)⁺
//
// i.e. reward progress, and subtract a steep penalty ONLY when the endpoint comes within safeDist of a sphere.
// FORWARDWEIGHT = 12, OBSTACLEWEIGHT = 6666, safeDist = robot radius — his fixed values. No heading term, no
// velocity term, no admissibility prune, no reverse penalty: reverse falls out naturally (backing toward a goal
// behind scores positive progress), which is why the robot steers AND backs up to elide. Spheres are advanced
// to their future positions for the check, so it anticipates the moving field. One arc is committed per tick.
//
// Look: black floor, white spheres, the faint candidate-arc fan, the chosen arc + the robot in red, a hollow
// target ring, a fading trail. (jz compiles the planner; the Canvas/DOM scaffolding of his page does not port.)
//
// All continuous state lives in Float64Arrays — a scalar f64 module global is i32-narrowed in jz.
// resize(w,h) → Uint32Array; frame(t) drives; setGoal(fx,fy) steers.

let W = 0, H = 0, px
let trail              // Uint8Array — fading trail intensity (0..255)
let SEED = 0

// robot pose + wheel velocities
let RX = 0, RY = 1, RH = 2, VL = 3, VR = 4
let rob = new Float64Array(5)
let goal = new Float64Array(4)   // gx, gy, gvx, gvy — a drifting target the robot chases (his moving "ghost" barrier)

// the flying spheres (uniform radius, like his barriers)
let MAXO = 24
let ox = new Float64Array(MAXO), oy = new Float64Array(MAXO)
let ovx = new Float64Array(MAXO), ovy = new Float64Array(MAXO)
let fobx = new Float64Array(MAXO), foby = new Float64Array(MAXO)   // predicted (future) positions for planning
let nobs = 0

// theme palette [paperR,G,B, inkR,G,B] — default = black floor, white spheres
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

// fling a fresh sphere across the arena (uniform radius; a gentle gaussian-ish drift, like his barrierVelocity)
let spawnObstacle = (i) => {
  let S = (W < H ? W : H)
  ox[i] = W * (0.12 + rnd() * 0.76); oy[i] = H * (0.1 + rnd() * 0.8)
  let a = rnd() * 6.2831853, sp = S * 0.0004 * (0.3 + rnd() * 1.0)
  ovx[i] = Math.cos(a) * sp; ovy[i] = Math.sin(a) * sp
}

// pick a fresh goal clear of every sphere and a good throw from the robot
let newGoal = () => {
  let S = (W < H ? W : H), OR = S * 0.018, tries = 0
  while (tries < 200) {
    let gx = W * (0.1 + rnd() * 0.8), gy = H * (0.1 + rnd() * 0.8)
    let ok = 1, i = 0
    while (i < nobs) {
      let dx = gx - ox[i], dy = gy - oy[i], m = OR + S * 0.05
      if (dx * dx + dy * dy < m * m) ok = 0
      i++
    }
    let dxr = gx - rob[RX], dyr = gy - rob[RY]
    if (ok > 0 && dxr * dxr + dyr * dyr > (S * 0.25) * (S * 0.25)) {
      goal[0] = gx; goal[1] = gy
      let a = rnd() * 6.2831853, sp = S * 0.0004 * (0.3 + rnd() * 1.0)
      goal[2] = Math.cos(a) * sp; goal[3] = Math.sin(a) * sp     // a gentle drift, like his barriers
      return
    }
    tries++
  }
  goal[0] = W * 0.5; goal[1] = H * 0.5; goal[2] = 0.0; goal[3] = 0.0
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
  nobs = 16
  let i = 0
  while (i < nobs) { spawnObstacle(i); i++ }
  newGoal()
}

// host steers the goal: click or drag (normalized coords)
export let setGoal = (fx, fy) => { goal[0] = fx * W; goal[1] = fy * H }

export let frame = (t) => {
  let S = (W < H ? W : H)
  let VMAX = S * 0.0032                   // max wheel velocity (px/step) — Davison 0.50 m/s
  let L = S * 0.036                        // wheel track width — Davison robotWidth 0.20 m
  let A = VMAX * 0.05                       // acceleration·dt — Davison 0.50 m/s² · 0.05 s = 5% of v_max
  let SIG = VMAX * 0.001                    // straight-line threshold (avoids the arc singularity at vL≈vR)
  let RR = S * 0.018                        // robot radius — Davison 0.10 m
  let OR = S * 0.018                        // sphere radius — Davison 0.10 m (uniform)
  let STEPS = 15                            // stepsAhead → TAU = STEPS · (one step) is the prediction horizon
  let SAFE = RR                             // safeDist = robot radius (Davison)
  let FW = 12.0, OW = 6666.0                // his forwardWeight / obstacleWeight (his exact 2-term benefit)

  // the spheres drift, bouncing off the walls
  let i = 0
  while (i < nobs) {
    ox[i] += ovx[i]; oy[i] += ovy[i]
    if (ox[i] < OR || ox[i] > W - OR) ovx[i] = -ovx[i]
    if (oy[i] < OR || oy[i] > H - OR) ovy[i] = -ovy[i]
    if (ox[i] < OR) ox[i] = OR
    if (ox[i] > W - OR) ox[i] = W - OR
    if (oy[i] < OR) oy[i] = OR
    if (oy[i] > H - OR) oy[i] = H - OR
    i++
  }

  // the target drifts too (his target is a moving "ghost" barrier the robot chases)
  goal[0] += goal[2]; goal[1] += goal[3]
  if (goal[0] < OR || goal[0] > W - OR) goal[2] = -goal[2]
  if (goal[1] < OR || goal[1] > H - OR) goal[3] = -goal[3]
  if (goal[0] < OR) goal[0] = OR
  if (goal[0] > W - OR) goal[0] = W - OR
  if (goal[1] < OR) goal[1] = OR
  if (goal[1] > H - OR) goal[1] = H - OR

  let rx = rob[RX], ry = rob[RY], rh = rob[RH]

  // fade the trail, then stamp the current spot
  let n = W * H, k = 0
  while (k < n) { trail[k] = (trail[k] * 253) >> 8; k++ }
  stamp(rx, ry, RR * 0.5)

  // composite floor (black paper) + trail (white, faint)
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  k = 0
  while (k < n) {
    let v = trail[k] / 255.0 * 0.5
    let r = (pr + (ir - pr) * v) | 0, g = (pg + (ig - pg) * v) | 0, b = (pb + (ib - pb) * v) | 0
    px[k] = (255 << 24) | (b << 16) | (g << 8) | r
    k++
  }

  // the spheres (white, solid, uniform)
  i = 0
  while (i < nobs) { discA(ox[i], oy[i], OR, ir, ig, ib, 1.0); i++ }

  // advance the spheres to where they'll be at the planning horizon — anticipate the moving field
  i = 0
  while (i < nobs) { fobx[i] = ox[i] + ovx[i] * STEPS; foby[i] = oy[i] + ovy[i] * STEPS; i++ }

  // ── plan: Davison's benefit over the 3×3 reachable (vL, vR) window ──
  // aim at where the target WILL be at the horizon (his prevTargetDist/newTargetDist use the advanced target)
  let fgx = goal[0] + goal[2] * STEPS, fgy = goal[1] + goal[3] * STEPS
  let prevD = Math.sqrt((rx - fgx) * (rx - fgx) + (ry - fgy) * (ry - fgy))
  let vlo = rob[VL], vro = rob[VR]
  let best = -1e30, bvl = vlo, bvr = vro
  let ia = 0
  while (ia < 3) {
    let vL = vlo + (ia - 1) * A                     // decelerate · hold · accelerate
    if (vL >= -VMAX && vL <= VMAX) {
      let ib = 0
      while (ib < 3) {
        let vR = vro + (ib - 1) * A
        if (vR >= -VMAX && vR <= VMAX) {
          let dvr = vR - vL, v = (vL + vR) * 0.5
          // predict the exact arc over the horizon, drawing the faint candidate path; keep the endpoint
          let ex = rx, ey = ry, eh = rh, lpx = rx, lpy = ry, s = 0
          while (s < STEPS) {
            if (dvr < SIG && dvr > -SIG) { ex += Math.cos(eh) * v; ey += Math.sin(eh) * v }
            else {
              let dth = dvr / L
              let R = (L * 0.5) * (vR + vL) / dvr
              let nth = eh + dth
              ex += R * (Math.sin(nth) - Math.sin(eh))
              ey -= R * (Math.cos(nth) - Math.cos(eh))
              eh = nth
            }
            lineA(lpx, lpy, ex, ey, ir, ig, ib, 0.16)
            lpx = ex; lpy = ey; s++
          }
          // clearance to the nearest (future) sphere or wall — AT THE ENDPOINT (his form)
          let distObs = 1e30, j = 0
          while (j < nobs) {
            let dx = ex - fobx[j], dy = ey - foby[j]
            let d = Math.sqrt(dx * dx + dy * dy) - OR - RR
            if (d < distObs) distObs = d
            j++
          }
          let wc = ex
          if (W - ex < wc) wc = W - ex
          if (ey < wc) wc = ey
          if (H - ey < wc) wc = H - ey
          wc -= RR
          if (wc < distObs) distObs = wc
          // benefit = progress − steep penalty only when the endpoint is within safeDist
          let newD = Math.sqrt((ex - fgx) * (ex - fgx) + (ey - fgy) * (ey - fgy))
          let cost = distObs < SAFE ? OW * (SAFE - distObs) : 0.0
          let benefit = FW * (prevD - newD) - cost
          if (benefit > best) { best = benefit; bvl = vL; bvr = vR }
        }
        ib++
      }
    }
    ia++
  }

  // chosen arc: bright red
  let dvrc = bvr - bvl, vc = (bvl + bvr) * 0.5
  let ex2 = rx, ey2 = ry, eh2 = rh, lpx3 = rx, lpy3 = ry, s2 = 0
  while (s2 < STEPS) {
    if (dvrc < SIG && dvrc > -SIG) { ex2 += Math.cos(eh2) * vc; ey2 += Math.sin(eh2) * vc }
    else {
      let dth = dvrc / L
      let R = (L * 0.5) * (bvr + bvl) / dvrc
      let nth = eh2 + dth
      ex2 += R * (Math.sin(nth) - Math.sin(eh2))
      ey2 -= R * (Math.cos(nth) - Math.cos(eh2))
      eh2 = nth
    }
    lineA(lpx3, lpy3, ex2, ey2, ACR | 0, ACG | 0, ACB | 0, 0.95)
    lpx3 = ex2; lpy3 = ey2; s2++
  }

  // goal — a hollow white ring + pip
  ringA(goal[0], goal[1], S * 0.019, 1.6, ir, ig, ib, 0.95)
  discA(goal[0], goal[1], S * 0.005, ir, ig, ib, 0.95)

  // the robot — a red arrowhead along its heading
  triA(rx, ry, Math.cos(rh), Math.sin(rh), RR * 1.1, ACR | 0, ACG | 0, ACB | 0)

  // collision alarm — his planner allows contact (no admissibility), so mark it when it happens
  let hit = -1, jc = 0
  while (jc < nobs) {
    let dx = rx - ox[jc], dy = ry - oy[jc], rs = OR + RR
    if (dx * dx + dy * dy < rs * rs) hit = jc
    jc++
  }
  if (hit >= 0) {
    ringA(rx, ry, RR * 1.9, 2.0, ACR | 0, ACG | 0, ACB | 0, 1.0)
    ringA(ox[hit], oy[hit], OR + 1.5, 2.0, ACR | 0, ACG | 0, ACB | 0, 0.95)
  }

  // arrived? relocate the goal and grow the field (his demo adds spheres on each reach)
  let dgx = goal[0] - rx, dgy = goal[1] - ry
  if (dgx * dgx + dgy * dgy < (RR + OR) * (RR + OR)) {
    newGoal()
    if (nobs < MAXO) { spawnObstacle(nobs); nobs++ }
  }

  // commit one tick of the winning wheel speeds (the same exact arc, one step)
  if (dvrc < SIG && dvrc > -SIG) {
    rob[RX] = rx + Math.cos(rh) * vc; rob[RY] = ry + Math.sin(rh) * vc; rob[RH] = rh
  } else {
    let dth = dvrc / L
    let R = (L * 0.5) * (bvr + bvl) / dvrc
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

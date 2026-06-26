// Dynamic Window Approach — a faithful port of Andrew Davison's planner (https://www.doc.ic.ac.uk/~ajd/Planning/,
// after Fox, Burgard & Thrun 1997). To keep every ratio exactly as his, the simulation runs in HIS world units
// (metres / radians / m·s⁻¹) and is scaled to pixels only for drawing — the planner math and constants are his.
//
// Each tick the differential-drive robot considers the 3×3 reachable wheel-speed pairs (each wheel may
// decelerate, hold, or accelerate by maxAccel·dt), predicts the exact circular arc each traces over the
// horizon TAU = stepsAhead·dt, and scores it at the predicted ENDPOINT by his benefit:
//
//        benefit = forwardWeight·(distance closed to the target)  −  obstacleWeight·(safeDist − clearance)⁺
//
// forwardWeight = 12, obstacleWeight = 6666, safeDist = robot radius. No heading/velocity/admissibility/reverse
// bias — so it backs up to reach a target behind it, exactly like his demo. The target is a drifting "ghost"
// barrier the robot chases; reaching it spawns more barriers. Obstacles are advanced to their future positions
// for the clearance check, so it anticipates the moving field. Only the planner ports; his Canvas/DOM does not.
//
// All continuous state lives in Float64Arrays (a scalar f64 module global is i32-narrowed in jz); the physics
// constants are f64 locals inside frame() for the same reason. resize(w,h) → Uint32Array; frame(t) drives.

let W = 0, H = 0, px
let trail              // Uint8Array — fading trail intensity
let SEED = 0

// robot pose + wheel velocities (metres, radians, m/s)
let RX = 0, RY = 1, RH = 2, VL = 3, VR = 4
let rob = new Float64Array(5)
let goal = new Float64Array(4)   // gx, gy, gvx, gvy — the drifting target

// the flying barriers (world metres), uniform radius
let MAXO = 40
let ox = new Float64Array(MAXO), oy = new Float64Array(MAXO)
let ovx = new Float64Array(MAXO), ovy = new Float64Array(MAXO)
let nobs = 0

// theme palette [paperR,G,B, inkR,G,B] — black floor, white barriers
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

// the one accent — red for the robot, the chosen arc, the collision alarm
let ACR = 232.0, ACG = 58.0, ACB = 42.0

let rnd = () => {
  SEED = (SEED * 1103515245 + 12345) | 0
  return ((SEED >>> 8) & 0xffff) / 65536.0
}
// approx normal via two uniforms (his barriers use a gaussian velocity)
let gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.9

// world half-extents (metres): his playfield is 5.7 m tall; width follows the canvas aspect
let halfH = () => 2.85
let halfW = () => 2.85 * (W / H)
let mpp = () => H / 5.7        // pixels per metre

// ── pixel drawing primitives (ARGB = 0xAABBGGRR) ──
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
  while (gd < 6000) {
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

// stamp the trail buffer at a pixel spot
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

// fling a fresh barrier (world metres) with a gaussian drift, like his
let spawnObstacle = (i) => {
  let hw = halfW(), hh = halfH()
  ox[i] = -hw + rnd() * 2.0 * hw; oy[i] = -hh + rnd() * 2.0 * hh
  ovx[i] = gauss() * 0.05; ovy[i] = gauss() * 0.05
}

// pick a fresh target clear of the barriers and a good throw from the robot (world metres)
let newGoal = () => {
  let hw = halfW(), hh = halfH(), tries = 0
  while (tries < 200) {
    let gx = -hw + rnd() * 2.0 * hw, gy = -hh + rnd() * 2.0 * hh
    let ok = 1, i = 0
    while (i < nobs) {
      let dx = gx - ox[i], dy = gy - oy[i]
      if (dx * dx + dy * dy < 0.35 * 0.35) ok = 0
      i++
    }
    let dxr = gx - rob[RX], dyr = gy - rob[RY]
    if (ok > 0 && dxr * dxr + dyr * dyr > 1.6 * 1.6) {
      goal[0] = gx; goal[1] = gy; goal[2] = gauss() * 0.05; goal[3] = gauss() * 0.05; return
    }
    tries++
  }
  goal[0] = 0.0; goal[1] = 0.0; goal[2] = 0.0; goal[3] = 0.0
}

export let resize = (w, h) => {
  W = w; H = h
  trail = new Uint8Array(w * h)
  px = new Uint32Array(w * h)
  return px
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

let baseSeed = 20240626         // layout seed — init() is deterministic; seed()/the randomize button re-roll it

let generate = () => {
  SEED = baseSeed
  rob[RX] = -halfW() + 0.35; rob[RY] = 0.0; rob[RH] = 0.0; rob[VL] = 0.0; rob[VR] = 0.0
  nobs = 28
  let i = 0
  while (i < nobs) { spawnObstacle(i); i++ }
  newGoal()
}

export let init = () => generate()
// host-set layout seed: a fresh combination of balls per page-load and on the randomize button
export let seed = (s) => { baseSeed = s | 0; generate() }

// host steers the target: click or drag (normalized screen coords → world metres)
export let setGoal = (fx, fy) => {
  let k = mpp()
  goal[0] = (fx * W - W * 0.5) / k
  goal[1] = (H * 0.5 - fy * H) / k
}

export let frame = (t) => {
  // ── his constants (metres / seconds) ──
  let RW = 0.2                  // robot width (wheel track)
  let RR = 0.1                  // robot radius
  let BR = 0.1                  // barrier radius
  let VMAXv = 0.5               // max wheel velocity
  let AMAX = 0.5                // max acceleration — his exact value (the limited dynamics ARE the point of DWA)
  let DT = 0.05                 // timestep
  let STEPS = 22                // steps ahead → TAU = STEPS·DT (a bit further than his 15 — same speed, just
                                // more far-sighted, so it can commit to an arc that rounds a cluster)
  let FW = 12.0, OW = 6666.0    // forward / obstacle weights — his exact two-term benefit (no heading bias)
  let SAFED = RR                // safeDist
  let TAU = DT * STEPS
  let AW = AMAX * DT            // one acceleration step
  let hw = halfW(), hh = halfH(), k = mpp(), u0 = W * 0.5, v0 = H * 0.5

  // drift the barriers, bouncing off the playfield walls
  let i = 0
  while (i < nobs) {
    ox[i] += ovx[i] * DT; oy[i] += ovy[i] * DT
    if (ox[i] < -hw || ox[i] > hw) ovx[i] = -ovx[i]
    if (oy[i] < -hh || oy[i] > hh) ovy[i] = -ovy[i]
    i++
  }
  // the target drifts too (his moving ghost barrier)
  goal[0] += goal[2] * DT; goal[1] += goal[3] * DT
  if (goal[0] < -hw || goal[0] > hw) goal[2] = -goal[2]
  if (goal[1] < -hh || goal[1] > hh) goal[3] = -goal[3]

  let rx = rob[RX], ry = rob[RY], rh = rob[RH]

  // stamp the robot's spot, then fade + composite the floor in ONE pass. Almost every pixel has no
  // trail (the floor is black), so fast-path those straight to the paper colour and only run the
  // per-pixel float lerp where the trail actually is — this skips that lerp for ~all of the canvas,
  // which is ~90% of the frame's work (and the part JSC vectorizes in JS but jz's wasm runs scalar).
  stamp(u0 + k * rx, v0 - k * ry, RR * k * 0.5)
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  let paper = (255 << 24) | ((pb | 0) << 16) | ((pg | 0) << 8) | (pr | 0)
  let n = W * H, c = 0
  while (c < n) {
    let ti = (trail[c] * 252) >> 8
    trail[c] = ti
    if (ti === 0) { px[c] = paper }
    else {
      let v = ti / 255.0 * 0.5
      let r = (pr + (ir - pr) * v) | 0, g = (pg + (ig - pg) * v) | 0, b = (pb + (ib - pb) * v) | 0
      px[c] = (255 << 24) | (b << 16) | (g << 8) | r
    }
    c++
  }

  // the barriers (white discs)
  let brp = BR * k
  i = 0
  while (i < nobs) { discA(u0 + k * ox[i], v0 - k * oy[i], brp, ir, ig, ib, 1.0); i++ }

  // the target's anticipated (future) position — his prevTargetDist/newTargetDist use the advanced target
  let fgx = goal[0] + goal[2] * TAU, fgy = goal[1] + goal[3] * TAU
  let prevD = Math.sqrt((rx - fgx) * (rx - fgx) + (ry - fgy) * (ry - fgy))

  // ── plan over the 3×3 reachable (vL, vR) window ──
  let vlo = rob[VL], vro = rob[VR]
  let best = -1e30, bvl = vlo, bvr = vro
  let ia = 0
  while (ia < 3) {
    let vL = vlo + (ia - 1) * AW
    if (vL >= -VMAXv && vL <= VMAXv) {
      let ib = 0
      while (ib < 3) {
        let vR = vro + (ib - 1) * AW
        if (vR >= -VMAXv && vR <= VMAXv) {
          // predict the exact arc over the horizon, tracking the closest approach to any MOVING ball along
          // the WHOLE path (Fox/Burgard/Thrun's dist term). Davison checks only the endpoint, which lets a
          // long arc punch through a wall — the full-path, space-time check is what lets it steer AROUND.
          let dvr = vR - vL
          let ex = rx, ey = ry, eh = rh, lpu = u0 + k * rx, lpv = v0 - k * ry, s = 0, distObs = 1e30
          while (s < STEPS) {
            if (dvr < 1e-6 && dvr > -1e-6) {
              ex += vL * DT * Math.cos(eh); ey += vL * DT * Math.sin(eh)
            } else {
              let R = (RW * 0.5) * (vR + vL) / dvr
              let dth = dvr * DT / RW
              let nth = eh + dth
              ex += R * (Math.sin(nth) - Math.sin(eh))
              ey -= R * (Math.cos(nth) - Math.cos(eh))
              eh = nth
            }
            let tt = (s + 1) * DT, j = 0
            while (j < nobs) {
              let dx = ex - (ox[j] + ovx[j] * tt), dy = ey - (oy[j] + ovy[j] * tt)
              let d = Math.sqrt(dx * dx + dy * dy) - BR - RR
              if (d < distObs) distObs = d
              j++
            }
            let u = u0 + k * ex, vv = v0 - k * ey
            lineA(lpu, lpv, u, vv, ir, ig, ib, 0.14)
            lpu = u; lpv = vv; s++
          }
          let newD = Math.sqrt((ex - fgx) * (ex - fgx) + (ey - fgy) * (ey - fgy))
          let cost = distObs < SAFED ? OW * (SAFED - distObs) : 0.0
          let benefit = FW * (prevD - newD) - cost
          if (benefit > best) { best = benefit; bvl = vL; bvr = vR }
        }
        ib++
      }
    }
    ia++
  }

  // chosen arc: bright red
  let ex2 = rx, ey2 = ry, eh2 = rh, lpu2 = u0 + k * rx, lpv2 = v0 - k * ry, s2 = 0
  while (s2 < STEPS) {
    if (bvr - bvl < 1e-6 && bvr - bvl > -1e-6) {
      ex2 += bvl * DT * Math.cos(eh2); ey2 += bvl * DT * Math.sin(eh2)
    } else {
      let R = (RW * 0.5) * (bvr + bvl) / (bvr - bvl)
      let dth = (bvr - bvl) * DT / RW
      let nth = eh2 + dth
      ex2 += R * (Math.sin(nth) - Math.sin(eh2))
      ey2 -= R * (Math.cos(nth) - Math.cos(eh2))
      eh2 = nth
    }
    let u = u0 + k * ex2, vv = v0 - k * ey2
    lineA(lpu2, lpv2, u, vv, ACR | 0, ACG | 0, ACB | 0, 0.95)
    lpu2 = u; lpv2 = vv; s2++
  }

  // target — a hollow white ring + pip
  ringA(u0 + k * goal[0], v0 - k * goal[1], BR * k, 1.6, ir, ig, ib, 0.95)
  discA(u0 + k * goal[0], v0 - k * goal[1], BR * k * 0.28, ir, ig, ib, 0.95)

  // the robot — a red disc. A circle has no "facing", so the planner's frequent reversing never reads
  // as driving backwards (and it matches his disc-shaped robot).
  discA(u0 + k * rx, v0 - k * ry, RR * k, ACR | 0, ACG | 0, ACB | 0, 1.0)

  // collision alarm — his planner allows contact, so mark it when it happens
  let hit = -1, jc = 0
  while (jc < nobs) {
    let dx = rx - ox[jc], dy = ry - oy[jc], rs = BR + RR
    if (dx * dx + dy * dy < rs * rs) hit = jc
    jc++
  }
  if (hit >= 0) {
    ringA(u0 + k * rx, v0 - k * ry, RR * k * 1.7, 2.0, ACR | 0, ACG | 0, ACB | 0, 1.0)
    ringA(u0 + k * ox[hit], v0 - k * oy[hit], BR * k + 1.5, 2.0, ACR | 0, ACG | 0, ACB | 0, 0.95)
  }

  // reached the target? throw a new one and add barriers (his demo grows the field)
  let dgx = goal[0] - rx, dgy = goal[1] - ry
  if (dgx * dgx + dgy * dgy < (BR + RR) * (BR + RR)) {
    newGoal()
    if (nobs < MAXO) { spawnObstacle(nobs); nobs++ }
    if (nobs < MAXO) { spawnObstacle(nobs); nobs++ }
  }

  // commit one timestep of the winning wheel speeds (his applyMotion: predict over DT)
  if (bvr - bvl < 1e-6 && bvr - bvl > -1e-6) {
    rob[RX] = rx + bvl * DT * Math.cos(rh); rob[RY] = ry + bvl * DT * Math.sin(rh); rob[RH] = rh
  } else {
    let R = (RW * 0.5) * (bvr + bvl) / (bvr - bvl)
    let dth = (bvr - bvl) * DT / RW
    let nth = rh + dth
    rob[RX] = rx + R * (Math.sin(nth) - Math.sin(rh))
    rob[RY] = ry - R * (Math.cos(nth) - Math.cos(rh))
    rob[RH] = nth
  }
  rob[VL] = bvl; rob[VR] = bvr
  // keep the robot on the playfield (his rarely leaves; we clamp so it stays on-screen)
  if (rob[RX] < -hw) rob[RX] = -hw
  if (rob[RX] > hw) rob[RX] = hw
  if (rob[RY] < -hh) rob[RY] = -hh
  if (rob[RY] > hh) rob[RY] = hh
}

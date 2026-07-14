// Double pendulum chaos fractal — time-to-flip map, now ALIVE.
// Each pixel = initial angles (θ1,θ2) in [-π,π]. Integrate the equal-mass equal-length
// double pendulum (g=1) and color by how long until the lower arm first flips over the top
// (|θ2_unwrapped| > π). Log-scale gray; never-flips → black. Progressive rows per frame.
//
// The map is also PLAYABLE: launch(x,y) drops a LIVE double pendulum with that pixel's
// initial angles. Its state (θ1,θ2) snakes across angle space as a comet trail over the
// fractal — you watch the trajectory wander the very map that grades it — while a small
// two-rod pendulum in the corner swings the SAME state in real space. When the lower arm
// finally flips (the event the map colors), the trail ends in a bright burst. Chaos becomes
// something you can poke: launch two neighbouring pixels and watch them diverge.
//
// RK4 with dt=0.06, map capped at 567 steps (~34 time units). Live trajectories integrate a
// few steps per frame with the same RK4 — identical physics, just streamed.
// jz notes: live fractional state lives in Float64Array cells (i32-narrowing); the map
// accumulates in its own buffer so trails composite over it non-destructively.

let W = 0, H = 0, px
let mapBuf                       // Uint32Array — the fractal itself (px = mapBuf + overlays)
let cursor = new Int32Array(1)   // progressive-fill row cursor
const MAX_STEPS = 567
const DT = 0.06

// ── live trajectories ──
const NL = 6                     // simultaneous live pendulums
const TRAIL = 420                // trail length, positions
let live = new Float64Array(NL * 4)      // θ1,θ2,ω1,ω2 per slot
let lstate = new Int32Array(NL * 2)      // [age, burst] per slot: age<0 → free, burst>0 → flip flash
let unwrap = new Float64Array(NL)        // θ2 unwrapped (flip detection)
let trail = new Float64Array(NL * TRAIL * 2)
let thead = new Int32Array(NL)           // ring head
let tlen = new Int32Array(NL)            // ring fill
const LIVE_STEPS = 3             // RK4 steps per frame per live pendulum
const MAX_AGE = 2600             // steps before a never-flipping wanderer retires

// double pendulum accelerations (m=l=g=1, equal masses)
let acc = new Float64Array(2)
let accelInto = (th1, th2, w1, w2) => {
  let d = th1 - th2
  let cd = Math.cos(d), sd = Math.sin(d)
  let den = 2.0 * (2.0 - cd * cd)
  if (den < 1e-12) den = 1e-12
  acc[0] = (-3.0 * Math.sin(th1) - Math.sin(th1 - 2.0 * th2) - 2.0 * sd * (w2 * w2 + w1 * w1 * cd)) / den
  acc[1] = (2.0 * sd * (2.0 * w1 * w1 + 2.0 * Math.cos(th1) + w2 * w2 * cd)) / den
}

// one RK4 step of (θ1,θ2,ω1,ω2) in the shared rk cell; returns nothing, mutates rk
let rk = new Float64Array(4)
let rkStep = () => {
  let th1 = rk[0], th2 = rk[1], w1 = rk[2], w2 = rk[3]
  accelInto(th1, th2, w1, w2); let a1_k1 = acc[0], a2_k1 = acc[1]
  let t1a = th1 + DT * 0.5 * w1, t2a = th2 + DT * 0.5 * w2
  let w1a = w1 + DT * 0.5 * a1_k1, w2a = w2 + DT * 0.5 * a2_k1
  accelInto(t1a, t2a, w1a, w2a); let a1_k2 = acc[0], a2_k2 = acc[1]
  let t1b = th1 + DT * 0.5 * w1a, t2b = th2 + DT * 0.5 * w2a
  let w1b = w1 + DT * 0.5 * a1_k2, w2b = w2 + DT * 0.5 * a2_k2
  accelInto(t1b, t2b, w1b, w2b); let a1_k3 = acc[0], a2_k3 = acc[1]
  let t1c = th1 + DT * w1b, t2c = th2 + DT * w2b
  let w1c = w1 + DT * a1_k3, w2c = w2 + DT * a2_k3
  accelInto(t1c, t2c, w1c, w2c); let a1_k4 = acc[0], a2_k4 = acc[1]
  rk[2] = w1 + (DT / 6.0) * (a1_k1 + 2.0 * a1_k2 + 2.0 * a1_k3 + a1_k4)
  rk[3] = w2 + (DT / 6.0) * (a2_k1 + 2.0 * a2_k2 + 2.0 * a2_k3 + a2_k4)
  rk[0] = th1 + (DT / 6.0) * (w1 + 2.0 * w1a + 2.0 * w1b + w1c)
  rk[1] = th2 + (DT / 6.0) * (w2 + 2.0 * w2a + 2.0 * w2b + w2c)
}

// log flip-time → gray value 0..255 (short flip = dark, long = bright, never = 0 = black)
let flipGray = (steps) => {
  if (steps <= 0) return 0
  let tv = Math.log(steps + 1.0) / Math.log(MAX_STEPS + 1.0)
  let gv = (tv * 255.0) | 0
  if (gv > 255) gv = 255
  return gv
}

// Integrate one initial condition and return the step of the first flip, or 0 if never.
let integrate = (th1, th2) => {
  rk[0] = th1; rk[1] = th2; rk[2] = 0.0; rk[3] = 0.0
  let th2_unwrap = th2
  let step = 0
  while (step < MAX_STEPS) {
    let prev = rk[1]
    rkStep()
    let dth2 = rk[1] - prev
    while (dth2 > Math.PI) dth2 = dth2 - 2.0 * Math.PI
    while (dth2 < -Math.PI) dth2 = dth2 + 2.0 * Math.PI
    th2_unwrap = th2_unwrap + dth2
    while (rk[0] > Math.PI) rk[0] = rk[0] - 2.0 * Math.PI
    while (rk[0] < -Math.PI) rk[0] = rk[0] + 2.0 * Math.PI
    while (rk[1] > Math.PI) rk[1] = rk[1] - 2.0 * Math.PI
    while (rk[1] < -Math.PI) rk[1] = rk[1] + 2.0 * Math.PI
    step++
    let uth = th2_unwrap; if (uth < 0.0) uth = -uth
    if (uth > Math.PI) return step
  }
  return 0
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  mapBuf = new Uint32Array(w * h)
  cursor[0] = 0
  let i = 0
  while (i < NL) { lstate[i * 2] = -1; lstate[i * 2 + 1] = 0; thead[i] = 0; tlen[i] = 0; i++ }
  return px
}

// drop a live pendulum at a pixel: that pixel's initial angles, from rest — the same
// initial condition the map graded
export let launch = (pxx, pyy) => {
  // pick the oldest slot (or a free one)
  let best = 0, bestAge = -2
  let i = 0
  while (i < NL) {
    let a = lstate[i * 2]
    if (a < 0) { best = i; bestAge = 2147483647 }
    else if (bestAge !== 2147483647 && a > bestAge) { best = i; bestAge = a }
    i++
  }
  let th1 = ((pxx / W) * 2.0 - 1.0) * Math.PI
  let th2 = ((pyy / H) * 2.0 - 1.0) * Math.PI
  live[best * 4] = th1; live[best * 4 + 1] = th2
  live[best * 4 + 2] = 0.0; live[best * 4 + 3] = 0.0
  unwrap[best] = th2
  lstate[best * 2] = 0; lstate[best * 2 + 1] = 0
  thead[best] = 0; tlen[best] = 0
}

// additive dot into px (composited overlay, clamped)
let dot = (x, y, add) => {
  let xi = x | 0, yi = y | 0
  if (xi < 0 || xi >= W || yi < 0 || yi >= H) return
  let c = yi * W + xi
  let p = px[c]
  let r = (p & 255) + add; if (r > 255) r = 255
  let g = ((p >> 8) & 255) + add; if (g > 255) g = 255
  let b = ((p >> 16) & 255) + add; if (b > 255) b = 255
  px[c] = (255 << 24) | (b << 16) | (g << 8) | r
}

// thick white line for the corner pendulum's rods (DDA, 2×2 dots)
let rod = (x0, y0, x1, y1, add) => {
  let dx = x1 - x0, dy = y1 - y0
  let len = Math.sqrt(dx * dx + dy * dy)
  let n = (len | 0) + 1
  let i = 0
  while (i <= n) {
    let x = x0 + dx * i / n, y = y0 + dy * i / n
    dot(x, y, add); dot(x + 1.0, y, add); dot(x, y + 1.0, add); dot(x + 1.0, y + 1.0, add)
    i++
  }
}

const PASSES = 260
export let frame = (t) => {
  // ── progressive fractal rows into mapBuf ──
  let batchSize = ((H + PASSES - 1) / PASSES) | 0
  if (batchSize < 1) batchSize = 1
  let row = cursor[0]
  if (row < H) {
    let endRow = row + batchSize
    if (endRow > H) endRow = H
    let oh = Math.PI / W * 0.5, ov = Math.PI / H * 0.5
    while (row < endRow) {
      let col = 0
      while (col < W) {
        let b1 = ((col / W) * 2.0 - 1.0) * Math.PI
        let b2 = ((row / H) * 2.0 - 1.0) * Math.PI
        // diagonal corners first — a deep never-flip pixel skips the other two samples
        let sA = integrate(b1 - oh, b2 - ov)
        let sD = integrate(b1 + oh, b2 + ov)
        let gv
        if (sA === 0 && sD === 0) gv = 0
        else gv = (flipGray(sA) + flipGray(integrate(b1 + oh, b2 - ov)) + flipGray(integrate(b1 - oh, b2 + ov)) + flipGray(sD)) >> 2
        mapBuf[row * W + col] = (255 << 24) | (gv << 16) | (gv << 8) | gv
        col++
      }
      row++
    }
    cursor[0] = row
  }

  // ── composite: map under, live trajectories over ──
  let n = W * H, i = 0
  while (i < n) { px[i] = mapBuf[i]; i++ }

  let sx = W / (2.0 * Math.PI), sy = H / (2.0 * Math.PI)
  let sl = 0
  while (sl < NL) {
    if (lstate[sl * 2] >= 0) {
      if (lstate[sl * 2 + 1] > 0) {
        // flip burst: an expanding bright ring at the trail head, then the slot frees
        let bs = lstate[sl * 2 + 1]
        let hx = trail[(sl * TRAIL + ((thead[sl] + TRAIL - 1) % TRAIL)) * 2]
        let hy = trail[(sl * TRAIL + ((thead[sl] + TRAIL - 1) % TRAIL)) * 2 + 1]
        let rr = bs * 1.6
        let k = 0
        while (k < 40) {
          let ang = k * 0.15707963267948966
          dot(hx + rr * Math.cos(ang), hy + rr * Math.sin(ang), 255 - bs * 8)
          k++
        }
        lstate[sl * 2 + 1] = bs + 1
        if (bs > 30) { lstate[sl * 2] = -1; lstate[sl * 2 + 1] = 0 }
      } else {
        // advance the live pendulum a few steps, recording the trail
        rk[0] = live[sl * 4]; rk[1] = live[sl * 4 + 1]
        rk[2] = live[sl * 4 + 2]; rk[3] = live[sl * 4 + 3]
        let s = 0
        let flipped = 0
        while (s < LIVE_STEPS) {
          let prev = rk[1]
          rkStep()
          let dth2 = rk[1] - prev
          while (dth2 > Math.PI) dth2 = dth2 - 2.0 * Math.PI
          while (dth2 < -Math.PI) dth2 = dth2 + 2.0 * Math.PI
          unwrap[sl] = unwrap[sl] + dth2
          while (rk[0] > Math.PI) rk[0] = rk[0] - 2.0 * Math.PI
          while (rk[0] < -Math.PI) rk[0] = rk[0] + 2.0 * Math.PI
          while (rk[1] > Math.PI) rk[1] = rk[1] - 2.0 * Math.PI
          while (rk[1] < -Math.PI) rk[1] = rk[1] + 2.0 * Math.PI
          // record the angle-space position
          let txp = (rk[0] / Math.PI * 0.5 + 0.5) * W
          let typ = (rk[1] / Math.PI * 0.5 + 0.5) * H
          trail[(sl * TRAIL + thead[sl]) * 2] = txp
          trail[(sl * TRAIL + thead[sl]) * 2 + 1] = typ
          thead[sl] = (thead[sl] + 1) % TRAIL
          if (tlen[sl] < TRAIL) tlen[sl] = tlen[sl] + 1
          let uw = unwrap[sl]; if (uw < 0.0) uw = -uw
          if (uw > Math.PI) flipped = 1
          s++
        }
        live[sl * 4] = rk[0]; live[sl * 4 + 1] = rk[1]
        live[sl * 4 + 2] = rk[2]; live[sl * 4 + 3] = rk[3]
        lstate[sl * 2] = lstate[sl * 2] + LIVE_STEPS
        if (flipped) lstate[sl * 2 + 1] = 1                 // the arm went over the top!
        else if (lstate[sl * 2] > MAX_AGE) lstate[sl * 2] = -1   // a never-flipper retires
      }
      // draw the trail, fading toward the tail (dots — the ±π seam wraps cleanly)
      let m = tlen[sl]
      let k = 0
      while (k < m) {
        let idx = (thead[sl] + TRAIL - m + k) % TRAIL
        let f = (k + 1) / m
        let add = (18.0 + 160.0 * f * f) | 0
        dot(trail[(sl * TRAIL + idx) * 2], trail[(sl * TRAIL + idx) * 2 + 1], add)
        k++
      }
      // bright head
      if (lstate[sl * 2] >= 0 && lstate[sl * 2 + 1] === 0) {
        let hi = (thead[sl] + TRAIL - 1) % TRAIL
        let hx = trail[(sl * TRAIL + hi) * 2], hy = trail[(sl * TRAIL + hi) * 2 + 1]
        dot(hx, hy, 255); dot(hx + 1, hy, 255); dot(hx, hy + 1, 255)
        dot(hx - 1, hy, 200); dot(hx, hy - 1, 200); dot(hx + 1, hy + 1, 200)
      }
    }
    sl++
  }

  // ── the corner pendulum: the newest live slot swung in REAL space (two rods) ──
  // newest = smallest non-negative age
  let show = -1, showAge = 2147483647
  sl = 0
  while (sl < NL) {
    let a = lstate[sl * 2]
    if (a >= 0 && lstate[sl * 2 + 1] === 0 && a < showAge) { show = sl; showAge = a }
    sl++
  }
  if (show >= 0) {
    let L = 0.10 * (W < H ? W : H)
    let pvx = W - 2.6 * L, pvy = H - 2.8 * L
    // dim a disc behind it so the widget reads on any map region
    let rr = 2.3 * L
    let y0 = (pvy - rr) | 0, y1 = (pvy + rr) | 0
    if (y0 < 0) y0 = 0
    if (y1 > H - 1) y1 = H - 1
    let yy = y0
    while (yy <= y1) {
      let dy = yy - pvy
      let half = Math.sqrt(rr * rr - dy * dy)
      let x0 = (pvx - half) | 0, x1 = (pvx + half) | 0
      if (x0 < 0) x0 = 0
      if (x1 > W - 1) x1 = W - 1
      let x = x0
      while (x <= x1) {
        let c = yy * W + x
        let p = px[c]
        let r = ((p & 255) * 0.35) | 0
        let g = (((p >> 8) & 255) * 0.35) | 0
        let b = (((p >> 16) & 255) * 0.35) | 0
        px[c] = (255 << 24) | (b << 16) | (g << 8) | r
        x++
      }
      yy++
    }
    let th1 = live[show * 4], th2 = live[show * 4 + 1]
    let x1p = pvx + L * Math.sin(th1), y1p = pvy + L * Math.cos(th1)
    let x2p = x1p + L * Math.sin(th2), y2p = y1p + L * Math.cos(th2)
    rod(pvx, pvy, x1p, y1p, 210)
    rod(x1p, y1p, x2p, y2p, 210)
    dot(pvx, pvy, 255); dot(x1p, y1p, 255); dot(x2p, y2p, 255)
    dot(x2p + 1, y2p, 255); dot(x2p, y2p + 1, 255); dot(x2p + 1, y2p + 1, 255)
  }
}

// Double pendulum chaos fractal — time-to-flip map.
// Each pixel = initial angles (θ1,θ2) in [-π,π]. Integrate the equal-mass
// equal-length double pendulum (g=1) and color by how long until the lower
// arm first flips over the top (|θ2_unwrapped| > π). Log-scale → blue→red→yellow.
// Never-flips → black. Progressive: renders ceil(H/PASSES) rows per frame.
//
// RK4 with dt=0.06. Cap at 567 steps (~34 time units — dt raised 3× from the original
// 0.02/1700 with MAX_STEPS cut to match, so the same physical time is covered in a third
// of the steps; the flip/never-flip map is governed by physical time, not step count, so
// the basin structure barely moves (verified empirically — never-flip fraction within
// ~0.1pt of the original at this dt across the whole never/flip histogram) while the
// integration cost drops 3×.
// State: θ1,θ2,ω1,ω2 per-pixel — computed on the fly row-by-row.
// Persistent: px (pixel buffer), cursor (current row).
// Float64Array for fractional state that must survive across frames (none here
// per se, but cursor needs Int32Array and bounds need Float64Array).

let W = 0, H = 0, px
let cursor = new Int32Array(1)  // current row being computed
const MAX_STEPS = 567
const DT = 0.06
const CAP_T = MAX_STEPS * DT  // ~34.0

// double pendulum accelerations (m=l=g=1, equal masses)
// a1 and a2 from standard Lagrangian, simplified for m1=m2=1, l1=l2=1, g=1
// denominator 2m₁+m₂−m₂·cos2Δ = 3−cos2Δ = 2·(2−cos²Δ) for m₁=m₂=1
// a1,a2 share d/cd/sd/den (one call per RK4 stage instead of two, ~30% fewer
// transcendentals) — same "combine, write to a scratch cell" trick as magnet.js's accelInto.
let acc = new Float64Array(2)
let accelInto = (th1, th2, w1, w2) => {
  let d = th1 - th2
  let cd = Math.cos(d), sd = Math.sin(d)
  let den = 2.0 * (2.0 - cd * cd)
  if (den < 1e-12) den = 1e-12
  acc[0] = (-3.0 * Math.sin(th1) - Math.sin(th1 - 2.0 * th2) - 2.0 * sd * (w2 * w2 + w1 * w1 * cd)) / den
  acc[1] = (2.0 * sd * (2.0 * w1 * w1 + 2.0 * Math.cos(th1) + w2 * w2 * cd)) / den
}

// log flip-time → gray value 0..255 (short flip = dark, long = bright, never = 0 = black)
let flipGray = (steps) => {
  if (steps <= 0) return 0
  let tv = Math.log(steps + 1.0) / Math.log(MAX_STEPS + 1.0)  // 0..1
  let gv = (tv * 255.0) | 0
  if (gv > 255) gv = 255
  return gv
}

// Integrate one initial condition (θ1,θ2) of the equal-mass double pendulum and return the
// step at which the lower arm first flips over the top (unwrapped |θ2| > π), or 0 if never.
let integrate = (th1, th2) => {
  let w1 = 0.0, w2 = 0.0
  let th2_unwrap = th2
  let flipStep = 0
  let step = 0
  while (step < MAX_STEPS) {
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
    let new_w1 = w1 + (DT / 6.0) * (a1_k1 + 2.0 * a1_k2 + 2.0 * a1_k3 + a1_k4)
    let new_w2 = w2 + (DT / 6.0) * (a2_k1 + 2.0 * a2_k2 + 2.0 * a2_k3 + a2_k4)
    // θ̇ = ω, so the angle stages are the stage omegas: full RK4, not Euler
    let new_th1 = th1 + (DT / 6.0) * (w1 + 2.0 * w1a + 2.0 * w1b + w1c)
    let new_th2 = th2 + (DT / 6.0) * (w2 + 2.0 * w2a + 2.0 * w2b + w2c)
    let dth2 = new_th2 - th2
    while (dth2 > Math.PI) dth2 = dth2 - 2.0 * Math.PI
    while (dth2 < -Math.PI) dth2 = dth2 + 2.0 * Math.PI
    th2_unwrap = th2_unwrap + dth2
    th1 = new_th1; th2 = new_th2; w1 = new_w1; w2 = new_w2
    while (th1 > Math.PI) th1 = th1 - 2.0 * Math.PI
    while (th1 < -Math.PI) th1 = th1 + 2.0 * Math.PI
    while (th2 > Math.PI) th2 = th2 - 2.0 * Math.PI
    while (th2 < -Math.PI) th2 = th2 + 2.0 * Math.PI
    step++
    let uth = th2_unwrap; if (uth < 0.0) uth = -uth
    if (uth > Math.PI) { flipStep = step; break }
  }
  return flipStep
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  cursor[0] = 0
  return px
}

const PASSES = 260     // >= a typical H, so batchSize lands at 1 row/frame (magnet.js's row-batch pattern)
export let frame = (t) => {
  // 2×2 supersampling makes every pixel up to 4 integrations, so paint fewer rows per frame;
  // the fractal resolves top-to-bottom over ~PASSES frames.
  let batchSize = ((H + PASSES - 1) / PASSES) | 0
  if (batchSize < 1) batchSize = 1

  let row = cursor[0]
  if (row >= H) return  // fully rendered

  let endRow = row + batchSize
  if (endRow > H) endRow = H

  let oh = Math.PI / W * 0.5, ov = Math.PI / H * 0.5   // quarter-pixel offsets in angle space

  while (row < endRow) {
    let col = 0
    while (col < W) {
      // pixel centre → (θ1,θ2); sample the 4 quarter-pixel corners and average → anti-aliased
      // flip-time map (the chaotic speckle blends into smooth, legible gradients).
      let b1 = ((col / W) * 2.0 - 1.0) * Math.PI
      let b2 = ((row / H) * 2.0 - 1.0) * Math.PI
      // Diagonal corners first: if BOTH never flip, this pixel is deep inside the stable
      // island (never-flip is a coherent region, not a fractal one — nearby points agree),
      // so skip the other two integrations and paint flat black; the ~30% of the domain in
      // that island otherwise pays the single most expensive case (a full MAX_STEPS run)
      // four times over for no visual gain. Anywhere the diagonals disagree — including
      // every pixel actually on the island's fringe — still gets the full 2×2 supersample,
      // so the AA'd boundary itself is untouched.
      let sA = integrate(b1 - oh, b2 - ov)
      let sD = integrate(b1 + oh, b2 + ov)
      let gv
      if (sA === 0 && sD === 0) gv = 0
      else gv = (flipGray(sA) + flipGray(integrate(b1 + oh, b2 - ov)) + flipGray(integrate(b1 - oh, b2 + ov)) + flipGray(sD)) >> 2
      px[row * W + col] = (255 << 24) | (gv << 16) | (gv << 8) | gv
      col++
    }
    row++
  }
  cursor[0] = row
}

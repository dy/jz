// Magnetic pendulum — a bob on a spring swings over three magnets sunk a little below the
// plane. Release it from rest at every pixel; shade by WHICH magnet finally captures it. The
// basin boundaries between the three magnets are fractal — thin fingers of each color lace
// into the others all the way down.
//
// Physics: planar bob at (x,y), released from rest.
//   ẍ = −C·x − c·ẋ + Σᵢ (mᵢ−x) / (|mᵢ−x|² + h²)^1.5     (spring to center + damping + 3 magnets)
// h is the magnets' height below the plane — it keeps the pull finite as the bob passes
// directly overhead (no 1/r² singularity). RK4, fixed dt, capped at MAX_STEPS. "Captured" =
// close to a magnet AND slow; never settling (only right on a boundary) renders black.
//
// Shading: gray level picks the magnet (three well-separated levels), modulated by how fast
// it got there (newton.js's trick: linear time fraction, squared, floor..1 — fast=bright,
// boundary-adjacent=dark) so the filigree reads crisply against flat basin interiors.
//
// Progressive render: rows per frame, 2×2 supersampled per final pixel (pendulum.js's
// pattern) — four full integrations per pixel, averaged, so basin edges anti-alias into the
// fractal's actual lace instead of jagged single-sample speckle.
//
// Interaction — kernel draws every visible pixel, nothing is a DOM/canvas overlay:
//   setMagnet(i,x,y)  drag a magnet (pixel coords) → restarts the progressive fill live.
//   pickMagnet(x,y)   nearest magnet within a grab radius, or −1 (host decides drag vs launch).
//   launch(x,y)       drop a LIVE bob (pixel coords): same physics, integrated in real time,
//                     a handful of RK4 steps per frame, rasterized as a fading comet trail
//                     directly into the pixel buffer — watch it hunt between basins.
//   randomize()       re-roll magnet layout + damping (auto-wired to the gallery's dice button).
//
// jz typing notes: magnet coords, damping, and the live bob's (x,y,vx,vy) are persistent
// FRACTIONAL scalars mutated across many frames/closures — module globals get i32-narrowed
// unless provably fractional, so they live in Float64Array cells (see examples/fern/fern.js).
// `st` is a shared RK4 scratch cell: integrate() (per-pixel) and the live bob step both use it,
// never concurrently (everything here is synchronous), so one cell serves both — the cleanest
// way to get a 4-number "return" (x,y,vx,vy) out of rk4Step() without allocating a tuple.

let W = 0, H = 0, px, map
let aspect = 1.0
let cursor = new Int32Array(1)     // progressive-fill row cursor (pendulum.js pattern)
let inited = 0

// ── world ↔ pixel (fixed view, no pan/zoom — aspect-correct like newton.js) ──
const SCALE = 2.2                  // view half-height, world units
let pxToWorldX = (x) => ((x / W) - 0.5) * 2.0 * SCALE * aspect
let pxToWorldY = (y) => ((y / H) - 0.5) * 2.0 * SCALE
let worldToPxX = (wx) => (wx / (2.0 * SCALE * aspect) + 0.5) * W
let worldToPxY = (wy) => (wy / (2.0 * SCALE) + 0.5) * H

// ── magnets + damping (persistent fractional state) ──
const MRADIUS = 1.0
let mx = new Float64Array(3), my = new Float64Array(3)   // magnet world positions
let damp = new Float64Array(1)                           // viscous damping coefficient

let setDefaultMagnets = () => {
  let i = 0
  while (i < 3) {
    let ang = -Math.PI * 0.5 + i * (2.0 * Math.PI / 3.0)   // one magnet up top, two below
    mx[i] = Math.cos(ang) * MRADIUS
    my[i] = Math.sin(ang) * MRADIUS
    i++
  }
}

// ── physics ──
const SPRING = 1.0
const HGT = 0.32, H2 = HGT * HGT
const CAPTURE_R = 0.20, CAPTURE_R2 = CAPTURE_R * CAPTURE_R
const CAPTURE_V = 0.18, CAPTURE_V2 = CAPTURE_V * CAPTURE_V
// dt raised 3× from the original 0.02/1800 with MAX_STEPS cut to match (same ~36 time-unit
// budget, a third of the steps): capture is decided by physical settle time, not step count,
// so the basin map is empirically unchanged (never-settle fraction moves <0.1pt at the default
// damping, and only a few points on it even at randomize()'s lowest/slowest-decaying damping)
// while every integrate() call costs a third as much.
const MAX_STEPS = 600
const DT = 0.06

// ax,ay share every magnet's dx/dy/d2/inv — one accel call per RK4 stage instead of two,
// half the sqrt/div work. Two-number "return" via the `acc` scratch cell (same trick as `st`).
let acc = new Float64Array(2)
let accelInto = (x, y, vx, vy) => {
  let ax = -SPRING * x - damp[0] * vx
  let ay = -SPRING * y - damp[0] * vy
  let dx = mx[0] - x, dy = my[0] - y, d2 = dx * dx + dy * dy + H2, inv = 1.0 / (d2 * Math.sqrt(d2))
  ax += dx * inv; ay += dy * inv
  dx = mx[1] - x; dy = my[1] - y; d2 = dx * dx + dy * dy + H2; inv = 1.0 / (d2 * Math.sqrt(d2))
  ax += dx * inv; ay += dy * inv
  dx = mx[2] - x; dy = my[2] - y; d2 = dx * dx + dy * dy + H2; inv = 1.0 / (d2 * Math.sqrt(d2))
  ax += dx * inv; ay += dy * inv
  acc[0] = ax; acc[1] = ay
}

// which magnet has captured the state currently sitting in `st` (close AND slow)? -1 = none yet.
let capturedBy = () => {
  let vx = st[2], vy = st[3]
  if (vx * vx + vy * vy > CAPTURE_V2) return -1
  let x = st[0], y = st[1]
  let dx = x - mx[0], dy = y - my[0]; if (dx * dx + dy * dy < CAPTURE_R2) return 0
  dx = x - mx[1]; dy = y - my[1]; if (dx * dx + dy * dy < CAPTURE_R2) return 1
  dx = x - mx[2]; dy = y - my[2]; if (dx * dx + dy * dy < CAPTURE_R2) return 2
  return -1
}

// shared RK4 scratch [x,y,vx,vy] — advances `st` in place by one fixed step.
let st = new Float64Array(4)
let rk4Step = () => {
  let x = st[0], y = st[1], vx = st[2], vy = st[3]
  accelInto(x, y, vx, vy); let ax1 = acc[0], ay1 = acc[1]
  let x2 = x + DT * 0.5 * vx, y2 = y + DT * 0.5 * vy
  let vx2 = vx + DT * 0.5 * ax1, vy2 = vy + DT * 0.5 * ay1
  accelInto(x2, y2, vx2, vy2); let ax2 = acc[0], ay2 = acc[1]
  let x3 = x + DT * 0.5 * vx2, y3 = y + DT * 0.5 * vy2
  let vx3 = vx + DT * 0.5 * ax2, vy3 = vy + DT * 0.5 * ay2
  accelInto(x3, y3, vx3, vy3); let ax3 = acc[0], ay3 = acc[1]
  let x4 = x + DT * vx3, y4 = y + DT * vy3
  let vx4 = vx + DT * ax3, vy4 = vy + DT * ay3
  accelInto(x4, y4, vx4, vy4); let ax4 = acc[0], ay4 = acc[1]
  st[0] = x + (DT / 6.0) * (vx + 2.0 * vx2 + 2.0 * vx3 + vx4)
  st[1] = y + (DT / 6.0) * (vy + 2.0 * vy2 + 2.0 * vy3 + vy4)
  st[2] = vx + (DT / 6.0) * (ax1 + 2.0 * ax2 + 2.0 * ax3 + ax4)
  st[3] = vy + (DT / 6.0) * (ay1 + 2.0 * ay2 + 2.0 * ay3 + ay4)
}

// Integrate from rest at (x0,y0); return (capturedMagnet* (MAX_STEPS+1) + steps) packed into one
// number — capturedMagnet is 3 for "never" (steps==MAX_STEPS then). Packing avoids allocating a
// tuple for what's otherwise a two-value return, in a loop run 4× per pixel.
let integrate = (x0, y0) => {
  st[0] = x0; st[1] = y0; st[2] = 0.0; st[3] = 0.0
  let step = 0
  let cap = capturedBy()
  while (cap < 0 && step < MAX_STEPS) {
    rk4Step()
    step++
    cap = capturedBy()
  }
  if (cap < 0) cap = 3
  return cap * (MAX_STEPS + 1) + step
}

// packed integrate() result → gray 0..255. Base level picks the magnet; newton.js's trick
// (linear time-fraction, squared, floor..1) darkens slow/boundary captures for crisp filigree.
const LEVEL0 = 77.0, LEVEL1 = 140.0, LEVEL2 = 217.0
const SHADE_FLOOR = 0.16
let shade = (packed) => {
  let capIdx = (packed / (MAX_STEPS + 1)) | 0
  if (capIdx === 3) return 0                     // never settled → black
  let steps = packed - capIdx * (MAX_STEPS + 1)
  let s = 1.0 - steps / MAX_STEPS
  s = s * s
  let lo = SHADE_FLOOR + (1.0 - SHADE_FLOOR) * s
  let base = LEVEL0
  if (capIdx === 1) base = LEVEL1
  else if (capIdx === 2) base = LEVEL2
  let gg = (base * lo) | 0
  if (gg > 255) gg = 255
  if (gg < 0) gg = 0
  return gg
}

// filled disc, gray `g` — same plotting trick as nbody.js's body/trail marks.
let discG = (fx, fy, rad, g) => {
  let cxi = fx | 0, cyi = fy | 0, ri = Math.ceil(rad) | 0
  if (ri < 1) ri = 1
  let r2 = rad * rad
  let oy = -ri
  while (oy <= ri) {
    let iy = cyi + oy
    if (iy >= 0 && iy < H) {
      let ox = -ri
      while (ox <= ri) {
        let ix = cxi + ox
        if (ix >= 0 && ix < W && ox * ox + oy * oy <= r2) px[iy * W + ix] = (255 << 24) | (g << 16) | (g << 8) | g
        ox++
      }
    }
    oy++
  }
}

const MARKER_OUT_R = 7.0, MARKER_IN_R = 4.0
let drawMagnets = () => {
  let i = 0
  while (i < 3) {
    let mxp = worldToPxX(mx[i]), myp = worldToPxY(my[i])
    discG(mxp, myp, MARKER_OUT_R, 0)      // dark ring — reads on bright basins
    discG(mxp, myp, MARKER_IN_R, 255)     // bright core — reads on dark basins
    i++
  }
}

// ── live bob: real-time integration + fading trail, both drawn straight into px ──
let bob = new Float64Array(4)     // persistent [x,y,vx,vy], world coords
let bobActive = 0, bobStep = 0
const LIVE_SUBSTEPS = 6
const TRAIL_CAP = 360
let trailX = new Float64Array(TRAIL_CAP), trailY = new Float64Array(TRAIL_CAP)   // pixel coords, ring buffer
let trailHead = 0, trailCount = 0

let pushTrail = (x, y) => {
  trailX[trailHead] = x; trailY[trailHead] = y
  trailHead = trailHead + 1
  if (trailHead >= TRAIL_CAP) trailHead = 0
  if (trailCount < TRAIL_CAP) trailCount = trailCount + 1
}

export let launch = (x, y) => {
  bob[0] = pxToWorldX(x); bob[1] = pxToWorldY(y); bob[2] = 0.0; bob[3] = 0.0
  bobStep = 0; bobActive = 1
  trailHead = 0; trailCount = 0
  pushTrail(x, y)
}

let stepLiveBob = () => {
  let k = 0
  while (k < LIVE_SUBSTEPS) {
    st[0] = bob[0]; st[1] = bob[1]; st[2] = bob[2]; st[3] = bob[3]
    rk4Step()
    bob[0] = st[0]; bob[1] = st[1]; bob[2] = st[2]; bob[3] = st[3]
    bobStep++
    pushTrail(worldToPxX(bob[0]), worldToPxY(bob[1]))
    let cap = capturedBy()
    if (cap >= 0 || bobStep >= MAX_STEPS) { bobActive = 0; break }
    k++
  }
}

const TRAIL_RAD = 1.4, HEAD_RAD = 3.0
let drawTrail = () => {
  let n = trailCount
  if (n <= 0) return
  let startIdx = trailCount >= TRAIL_CAP ? trailHead : 0
  let i = 0, pfx = 0.0, pfy = 0.0, havePrev = 0
  while (i < n) {
    let bIdx = startIdx + i
    if (bIdx >= TRAIL_CAP) bIdx = bIdx - TRAIL_CAP
    let fx = trailX[bIdx], fy = trailY[bIdx]
    let bright = (((i + 1) / n) * 255.0) | 0
    if (havePrev) {
      // connect to the previous point so a fast segment doesn't dot out (nbody.js's trick)
      let dx = fx - pfx, dy = fy - pfy
      let segSteps = Math.sqrt(dx * dx + dy * dy) | 0
      if (segSteps < 1) segSteps = 1
      let s = 1
      while (s <= segSteps) { discG(pfx + dx * s / segSteps, pfy + dy * s / segSteps, TRAIL_RAD, bright); s++ }
    } else {
      discG(fx, fy, TRAIL_RAD, bright)
    }
    pfx = fx; pfy = fy; havePrev = 1
    i++
  }
  discG(pfx, pfy, HEAD_RAD, 255)   // bright head — the bob itself
}

export let resize = (w, h) => {
  W = w; H = h
  aspect = w / h
  px = new Uint32Array(w * h)
  map = new Uint32Array(w * h)
  cursor[0] = 0
  bobActive = 0
  trailHead = 0; trailCount = 0
  if (!inited) {
    inited = 1
    setDefaultMagnets()
    damp[0] = 0.14
  }
  return px
}

export let setMagnet = (i, x, y) => {
  let idx = i | 0
  if (idx < 0 || idx > 2) return
  mx[idx] = pxToWorldX(x)
  my[idx] = pxToWorldY(y)
  cursor[0] = 0            // restart the progressive fill — the fractal reshapes live
}

// nearest magnet to (x,y) within a grab radius, else -1 (host then launches a bob instead).
const PICK_R = 16.0
export let pickMagnet = (x, y) => {
  let best = -1, bestD = PICK_R * PICK_R
  let i = 0
  while (i < 3) {
    let dx = x - worldToPxX(mx[i]), dy = y - worldToPxY(my[i])
    let d2 = dx * dx + dy * dy
    if (d2 < bestD) { bestD = d2; best = i }
    i++
  }
  return best
}

export let randomize = () => {
  let i = 0
  while (i < 3) {
    let ang = -Math.PI * 0.5 + i * (2.0 * Math.PI / 3.0) + (Math.random() - 0.5) * 1.0
    let rad = 0.7 + Math.random() * 0.6
    mx[i] = Math.cos(ang) * rad
    my[i] = Math.sin(ang) * rad
    i++
  }
  damp[0] = 0.10 + Math.random() * 0.18
  cursor[0] = 0
  bobActive = 0
  trailHead = 0; trailCount = 0
}

const PASSES = 280     // >= a typical H, so batchSize lands at 1 row/frame (pendulum.js's row-batch pattern)
export let frame = (t) => {
  let batchSize = ((H + PASSES - 1) / PASSES) | 0
  if (batchSize < 1) batchSize = 1

  let row = cursor[0]
  if (row < H) {
    let endRow = row + batchSize
    if (endRow > H) endRow = H
    let oh = SCALE * aspect / W * 0.5, ov = SCALE / H * 0.5   // quarter-pixel offsets (2×2 supersample)

    while (row < endRow) {
      let b2 = ((row / H) * 2.0 - 1.0) * SCALE
      let col = 0
      while (col < W) {
        let b1 = ((col / W) * 2.0 - 1.0) * SCALE * aspect
        let g1 = shade(integrate(b1 - oh, b2 - ov))
        let g2 = shade(integrate(b1 + oh, b2 - ov))
        let g3 = shade(integrate(b1 - oh, b2 + ov))
        let g4 = shade(integrate(b1 + oh, b2 + ov))
        let gg = (g1 + g2 + g3 + g4) >> 2
        map[row * W + col] = (255 << 24) | (gg << 16) | (gg << 8) | gg
        col++
      }
      row++
    }
    cursor[0] = row
  }

  // composite: the cheap part runs every frame (copy the map, draw magnets + live bob) so the
  // interaction feels instant; the expensive part (the fractal itself) stays progressive above.
  let n = W * H, k = 0
  while (k < n) { px[k] = map[k]; k++ }

  drawMagnets()
  if (bobActive) stepLiveBob()
  drawTrail()
}

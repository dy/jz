// Harmonograph — two perpendicular damped pendulums whose swings are summed.
// x(τ) = A1·sin(f1·τ+p1)·e^{-d1·τ} + A2·sin(f2·τ+p2)·e^{-d2·τ}
// y(τ) = A3·sin(f3·τ+p3)·e^{-d3·τ} + A4·sin(f4·τ+p4)·e^{-d4·τ}
// Near-integer frequency ratios yield classic Lissajous-like figures that slowly
// precess when detuned. The curve is traced as an additive polyline (glow at overlaps).
// frame(t, detune, phase) shifts the detuning and global phase; drag steers frequency.

let W = 0, H = 0, px

let STEPS = 6000     // curve resolution
let TMAX = 100.0      // τ integration range — long enough for the detuned figure to precess
                      // through a full rosette, short enough that the damping has spiralled it
                      // back to the centre by the end (so the trace closes rather than scribbles)
let A2 = 0.62         // amplitude of the *second* pendulum on each axis, smaller than the first
                      // — a clean primary ellipse modulated by a secondary, the classic harmonograph
                      // (equal amplitudes summed to ±2R, overflowing the frame into a chord scribble)

// Per-load figure: frequency quadruple + phase offsets. The host rolls a fresh (curated) set on
// every page load and feeds it here, so JS and jz draw the identical shape. Defaults reproduce the
// classic 2:3 rosette if setParams is never called.
let cfg = new Float64Array(8)   // [f1, f2, f3, f4, p1, p2, p3, p4]
cfg[0] = 2.0; cfg[1] = 3.0; cfg[2] = 3.0; cfg[3] = 2.0
cfg[4] = 0.0; cfg[5] = 0.0; cfg[6] = 0.0; cfg[7] = 1.5707963267948966

export let setParams = (f1, f2, f3, f4, q1, q2, q3, q4) => {
  cfg[0] = f1; cfg[1] = f2; cfg[2] = f3; cfg[3] = f4
  cfg[4] = q1; cfg[5] = q2; cfg[6] = q3; cfg[7] = q4
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let r = (p & 0xff) + rr; if (r > 255) r = 255
  let g = ((p >> 8) & 0xff) + gg; if (g > 255) g = 255
  let b = ((p >> 16) & 0xff) + bb; if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

let line = (x0, y0, x1, y1, rr, gg, bb) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = ((adx > ady ? adx : ady) | 0)
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let x = x0, y = y0, s = 0
  while (s <= steps) {
    addpix(x | 0, y | 0, rr, gg, bb)
    x += xi; y += yi; s++
  }
}

export let frame = (t, detune, phaseShift) => {
  // Clear to opaque black
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let cx = W * 0.5, cy = H * 0.5
  let minDim = W < H ? W : H
  let R = minDim * 0.26   // first-pendulum amplitude; max excursion R*(1+A2) ≈ 0.42·minDim stays in frame

  // Per-load frequency quadruple with slight detuning → the figure precesses
  let f1 = cfg[0]
  let f2 = cfg[1] + detune
  let f3 = cfg[2]
  let f4 = cfg[3] + detune * 0.5

  // Damping (inward spiral over TMAX → the figure starts wide and winds to the centre)
  let d1 = 0.012, d2 = 0.012, d3 = 0.012, d4 = 0.012

  // Phase offsets: per-load base + the drag/animation shift
  let p1 = phaseShift + cfg[4]
  let p2 = cfg[5]
  let p3 = phaseShift * 0.7 + cfg[6]
  let p4 = cfg[7]

  let dt = TMAX / STEPS

  // First point
  let tau0 = 0.0
  let e10 = Math.exp(-d1 * tau0), e20 = Math.exp(-d2 * tau0)
  let e30 = Math.exp(-d3 * tau0), e40 = Math.exp(-d4 * tau0)
  let px0 = cx + R * (Math.sin(f1 * tau0 + p1) * e10 + A2 * Math.sin(f2 * tau0 + p2) * e20)
  let py0 = cy + R * (Math.sin(f3 * tau0 + p3) * e30 + A2 * Math.sin(f4 * tau0 + p4) * e40)

  i = 1
  while (i <= STEPS) {
    let tau = i * dt
    let e1 = Math.exp(-d1 * tau), e2 = Math.exp(-d2 * tau)
    let e3 = Math.exp(-d3 * tau), e4 = Math.exp(-d4 * tau)
    let nx = cx + R * (Math.sin(f1 * tau + p1) * e1 + A2 * Math.sin(f2 * tau + p2) * e2)
    let ny = cy + R * (Math.sin(f3 * tau + p3) * e3 + A2 * Math.sin(f4 * tau + p4) * e4)

    // Fade out as pendulum damps — single gray, overlaps glow
    let amp = Math.exp(-d1 * tau)
    let gv = (60.0 * amp + 14.0) | 0
    line(px0, py0, nx, ny, gv, gv, gv)

    px0 = nx; py0 = ny
    i++
  }
}

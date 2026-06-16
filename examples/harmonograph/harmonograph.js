// Harmonograph — two perpendicular damped pendulums whose swings are summed.
// x(τ) = A1·sin(f1·τ+p1)·e^{-d1·τ} + A2·sin(f2·τ+p2)·e^{-d2·τ}
// y(τ) = A3·sin(f3·τ+p3)·e^{-d3·τ} + A4·sin(f4·τ+p4)·e^{-d4·τ}
// Near-integer frequency ratios yield classic Lissajous-like figures that slowly
// precess when detuned. The curve is traced as an additive polyline (glow at overlaps).
// frame(t, detune, phase) shifts the detuning and global phase; drag steers frequency.

let W = 0, H = 0, px

let STEPS = 6500     // curve resolution
let TMAX = 130.0      // τ integration range — long enough for the detuned figure to precess
                      // through a full rosette and for damping to spiral it gently inward

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
  let R = minDim * 0.44

  // Frequency ratios 2:3 with slight detuning → figure precesses
  let f1 = 2.0
  let f2 = 3.0 + detune
  let f3 = 3.0
  let f4 = 2.0 + detune * 0.5

  // Damping (gentle inward spiral over TMAX → the figure fills a rosette band)
  let d1 = 0.006, d2 = 0.006, d3 = 0.006, d4 = 0.006

  // Phase offsets (evolve with t for animation)
  let p1 = phaseShift
  let p2 = 0.0
  let p3 = phaseShift * 0.7
  let p4 = 1.5707963267948966  // π/2

  let dt = TMAX / STEPS

  // First point
  let tau0 = 0.0
  let e10 = Math.exp(-d1 * tau0), e20 = Math.exp(-d2 * tau0)
  let e30 = Math.exp(-d3 * tau0), e40 = Math.exp(-d4 * tau0)
  let px0 = cx + R * (Math.sin(f1 * tau0 + p1) * e10 + Math.sin(f2 * tau0 + p2) * e20)
  let py0 = cy + R * (Math.sin(f3 * tau0 + p3) * e30 + Math.sin(f4 * tau0 + p4) * e40)

  i = 1
  while (i <= STEPS) {
    let tau = i * dt
    let e1 = Math.exp(-d1 * tau), e2 = Math.exp(-d2 * tau)
    let e3 = Math.exp(-d3 * tau), e4 = Math.exp(-d4 * tau)
    let nx = cx + R * (Math.sin(f1 * tau + p1) * e1 + Math.sin(f2 * tau + p2) * e2)
    let ny = cy + R * (Math.sin(f3 * tau + p3) * e3 + Math.sin(f4 * tau + p4) * e4)

    // Color: hue shifts along curve, glows cyan→magenta→gold
    let fi = i / STEPS
    let h6 = fi * 6.0
    let rr = Math.abs(h6 - 3.0) - 1.0
    let gg = 2.0 - Math.abs(h6 - 2.0)
    let bb = 2.0 - Math.abs(h6 - 4.0)
    if (rr < 0.0) rr = 0.0; if (rr > 1.0) rr = 1.0
    if (gg < 0.0) gg = 0.0; if (gg > 1.0) gg = 1.0
    if (bb < 0.0) bb = 0.0; if (bb > 1.0) bb = 1.0

    // Fade out as pendulum damps
    let amp = Math.exp(-d1 * tau)
    let INT = 60.0 * amp + 14.0
    line(px0, py0, nx, ny, (rr * INT) | 0, (gg * INT) | 0, (bb * INT) | 0)

    px0 = nx; py0 = ny
    i++
  }
}

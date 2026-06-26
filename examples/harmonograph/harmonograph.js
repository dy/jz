// Harmonograph — four-pendulum damped oscillator: two per axis (lateral + rotary).
// x(τ) = A1·sin(f1·τ+p1)·e^{-d1·τ} + A2·sin(f2·τ+p2)·e^{-d2·τ}
// y(τ) = A3·sin(f3·τ+p3)·e^{-d3·τ} + A4·sin(f4·τ+p4)·e^{-d4·τ}
//
// Drawn white on black: overlapping strokes accumulate additively, so the densely-wound
// centre knot glows bright while the sparse outer loops stay faint — the trace doubles as a
// density map. Many fine segments (high STEPS) over a long integration (TMAX) → lots of lines.
//
// Near-integer frequency ratios produce the canonical precessional rosette:
// exactly rational → closed static figure; slightly detuned → breathing rotation.
// The interesting regime lives at the edge between those two.
//
// frame(t, detune, damp) — detune shifts frequency ratio, damp sets envelope speed.
// Drag in index.html: x→detune, y→damp. Idle: slow LFO cycles both.
// setParams(f1,f2,f3,f4, p1,p2,p3,p4) rolls a fresh figure each page load.

let W = 0, H = 0, px

let STEPS = 24000    // curve resolution — many fine strokes (more lines), honest compute work
let TMAX  = 420.0    // integration range — traces deeper into the wound-up centre (more loops)

let A2 = 0.58        // secondary-pendulum amplitude ratio (< 1 keeps figure inside frame)

// Per-load figure: frequency quadruple + phase offsets.
// The host rolls a fresh (curated) set on every page load and feeds it here.
let cfg = new Float64Array(8)  // [f1, f2, f3, f4, p1, p2, p3, p4]
cfg[0] = 2.0; cfg[1] = 3.0; cfg[2] = 3.0; cfg[3] = 2.0
cfg[4] = 0.0; cfg[5] = 1.1;  cfg[6] = 0.4; cfg[7] = 1.5707963267948966

export let setParams = (f1, f2, f3, f4, q1, q2, q3, q4) => {
  cfg[0] = f1; cfg[1] = f2; cfg[2] = f3; cfg[3] = f4
  cfg[4] = q1; cfg[5] = q2; cfg[6] = q3; cfg[7] = q4
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// Additive pixel blend: accumulate light, clamp to white (dense overlaps glow bright)
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

// frame(t, detune, damp)
//   detune  — frequency offset (0 = locked figure, ±0.06 = slow precession)
//   damp    — damping speed factor (0.5 = slow decay / large figure, 2.0 = fast spiral to knot)
export let frame = (t, detune, damp) => {
  // Clear to opaque black
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let cx = W * 0.5, cy = H * 0.5
  let minDim = W < H ? W : H
  // R scaled so max excursion R*(1+A2) ≈ 0.44·minDim — stays comfortably inside frame
  let R = minDim * 0.27

  // Frequency quadruple: small-integer base from cfg + detune on both axes for symmetric precession
  let f1 = cfg[0]
  let f2 = cfg[1] + detune
  let f3 = cfg[2]
  let f4 = cfg[3] + detune * 0.5   // half-rate on y → figure twists rather than just sliding

  // Asymmetric damping: different per-pendulum rates create the characteristic figure collapse
  // where the x-envelope and y-envelope die at different speeds, generating the skewed final knot.
  // damp scales the overall rate; individual ratios stay fixed for consistent character.
  let d1 = 0.010 * damp
  let d2 = 0.014 * damp   // secondary x-pendulum damps slightly faster
  let d3 = 0.013 * damp
  let d4 = 0.009 * damp   // y-primary damps slowest → the spiral outlasts the x-knot

  // Phase offsets: per-load base + symmetric phase shift on ALL four oscillators.
  // Equal phase shift to all four → clean precessional rotation, no axis distortion.
  let phShift = t * 0.003   // very slow idle drift; host adds faster term on interaction
  let p1 = phShift + cfg[4]
  let p2 = phShift + cfg[5]
  let p3 = phShift * 0.9 + cfg[6]  // slight differential on y gives gentle breathing
  let p4 = phShift * 0.9 + cfg[7]

  let dt = TMAX / STEPS

  // First sample
  let tau0 = 0.0
  let px0 = cx + R * (Math.sin(f1 * tau0 + p1) * Math.exp(-d1 * tau0)
                    + A2 * Math.sin(f2 * tau0 + p2) * Math.exp(-d2 * tau0))
  let py0 = cy + R * (Math.sin(f3 * tau0 + p3) * Math.exp(-d3 * tau0)
                    + A2 * Math.sin(f4 * tau0 + p4) * Math.exp(-d4 * tau0))

  i = 1
  while (i <= STEPS) {
    let tau = i * dt
    let e1 = Math.exp(-d1 * tau), e2 = Math.exp(-d2 * tau)
    let e3 = Math.exp(-d3 * tau), e4 = Math.exp(-d4 * tau)
    let nx = cx + R * (Math.sin(f1 * tau + p1) * e1 + A2 * Math.sin(f2 * tau + p2) * e2)
    let ny = cy + R * (Math.sin(f3 * tau + p3) * e3 + A2 * Math.sin(f4 * tau + p4) * e4)

    // White on black, additive: every stroke deposits the same faint light, so where the curve
    // crosses itself the ink builds toward white — the bright centre knot is a pure density map.
    let inten = 26
    line(px0, py0, nx, ny, inten, inten, inten)

    px0 = nx; py0 = ny
    i++
  }
}

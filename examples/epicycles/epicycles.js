// Fourier Epicycles — draw any closed curve; watch it emerge from spinning circles.
//
// The DFT decomposes the curve into N frequency components. Sorted by magnitude, each
// becomes one spinning arm. frame(t, phi, terms) renders the chain using only the first
// `terms` components: sweep from 1 (blocky silhouette) to 256 (exact reconstruction).
// High-freq arms draw thinner and dimmer, low-freq arms thick and bright, so the chain
// reads big→small. The ghost curve shows the full target; the bright traced path accumulates.
// Gibbs ringing is visible at sharp corners when terms ≈ 20–60.
//
// Interaction (host-side): ptr.down paints a custom closed path → DFT on release.
// Idle LFO sweeps terms 1→256 so the pedagogical arc plays automatically.
//
// jz rules: f64 by default; i32 for bitwise. All fractional persistent state in typed arrays.
// resize(w,h) → Uint32Array; init() computes DFT; frame(t, phi, terms) renders.

let W = 0, H = 0
let px

let N = 256
let TRACE_STEPS = 256

// DFT outputs — Float64Array to avoid i32-narrowing
let C_re   = new Float64Array(N)
let C_im   = new Float64Array(N)
let mags   = new Float64Array(N)
let freqs  = new Float64Array(N)

// Sorted index list — Int32Array keeps loop counters i32-clean
let sortedIdx = new Int32Array(N)

// Curve samples — allocated at module scope (NOT inside init) to avoid detaching px ArrayBuffer
let hx = new Float64Array(N)
let hy = new Float64Array(N)

// Pre-computed trace path at TRACE_STEPS resolution (screen coords, for current T)
// Allocated here so resize never triggers detach
let traceX = new Float64Array(TRACE_STEPS)
let traceY = new Float64Array(TRACE_STEPS)

// ext[0] = max |coord| of sampled curve for fit-scaling
let ext = new Float64Array(2)

// Which preset shape. i32 module global — safe to reassign.
let SHAPE = 0

export let setShape = (id) => { SHAPE = id | 0 }

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// Sample the chosen closed curve into hx/hy
let sampleCurve = () => {
  let PI2 = 6.283185307179586
  let n = 0
  while (n < N) {
    let u = n / N, x = 0.0, y = 0.0
    if (SHAPE == 1) {                        // five-petal rose
      let tau = PI2 * u, r = Math.cos(5.0 * tau) * 14.0
      x = r * Math.cos(tau); y = r * Math.sin(tau)
    } else if (SHAPE == 2) {                 // five-lobed star
      let tau = PI2 * u, r = (0.58 + 0.42 * Math.cos(5.0 * tau)) * 15.0
      x = r * Math.cos(tau); y = r * Math.sin(tau)
    } else if (SHAPE == 3) {                 // figure-eight (Gerono lemniscate)
      let tau = PI2 * u
      x = 15.0 * Math.cos(tau)
      y = 15.0 * Math.sin(tau) * Math.cos(tau)
    } else if (SHAPE == 4) {                 // spirograph hypotrochoid — closes after 3 loops
      let tau = PI2 * 3.0 * u
      x = (2.0 * Math.cos(tau) + 5.0 * Math.cos(2.0 * tau / 3.0)) * 2.2
      y = (2.0 * Math.sin(tau) - 5.0 * Math.sin(2.0 * tau / 3.0)) * 2.2
    } else if (SHAPE == 5) {                 // five-cusp epicycloid
      let tau = PI2 * u
      x = (6.0 * Math.cos(tau) - Math.cos(6.0 * tau)) * 2.4
      y = (6.0 * Math.sin(tau) - Math.sin(6.0 * tau)) * 2.4
    } else {                                 // heart (default)
      let tau = PI2 * u, s = Math.sin(tau)
      x = 16.0 * s * s * s
      y = -(13.0 * Math.cos(tau) - 5.0 * Math.cos(2.0 * tau) - 2.0 * Math.cos(3.0 * tau) - Math.cos(4.0 * tau))
    }
    hx[n] = x; hy[n] = y
    n++
  }
  // record max half-extent for fit-scaling
  let m = 1.0, k = 0
  while (k < N) {
    let ax = hx[k] < 0.0 ? -hx[k] : hx[k]
    let ay = hy[k] < 0.0 ? -hy[k] : hy[k]
    if (ax > m) m = ax
    if (ay > m) m = ay
    k++
  }
  ext[0] = m
}

// Compute DFT and sort by magnitude descending
let computeDFT = () => {
  let PI2 = 6.283185307179586
  let k = 0
  while (k < N) {
    let re = 0.0, im = 0.0, ni = 0
    while (ni < N) {
      let ang = PI2 * k * ni / N
      let ca = Math.cos(ang), sa = Math.sin(ang)
      re += hx[ni] * ca + hy[ni] * sa
      im += -hx[ni] * sa + hy[ni] * ca
      ni++
    }
    C_re[k] = re / N
    C_im[k] = im / N
    mags[k] = Math.sqrt(C_re[k] * C_re[k] + C_im[k] * C_im[k])
    freqs[k] = k <= (N / 2) ? k : k - N
    k++
  }
  // initialize sorted indices 0..N-1
  let si = 0
  while (si < N) { sortedIdx[si] = si; si++ }
  // insertion sort by magnitude descending (256 elements, done once)
  let i = 1
  while (i < N) {
    let key = sortedIdx[i], keyMag = mags[key], j = i - 1
    while (j >= 0 && mags[sortedIdx[j]] < keyMag) {
      sortedIdx[j + 1] = sortedIdx[j]; j--
    }
    sortedIdx[j + 1] = key; i++
  }
}

export let init = () => {
  sampleCurve()
  computeDFT()
}

// Set one drawn sample point (host calls this N times before recompute)
export let setDrawn = (i, x, y) => {
  let idx = i | 0
  hx[idx] = x; hy[idx] = y
}

// Called from host when user finishes drawing: hx/hy are already filled, then recompute
export let recompute = () => {
  let m = 1.0, k = 0
  while (k < N) {
    let ax = hx[k] < 0.0 ? -hx[k] : hx[k]
    let ay = hy[k] < 0.0 ? -hy[k] : hy[k]
    if (ax > m) m = ax
    if (ay > m) m = ay
    k++
  }
  ext[0] = m
  computeDFT()
}

// Blend pixel at idx toward (r,g,b) with alpha a
let bl = (idx, r, g, b, a) => {
  let p = px[idx]
  let pr = p & 255, pg = (p >> 8) & 255, pb = (p >> 16) & 255
  let nr = (pr + (r - pr) * a) | 0
  let ng = (pg + (g - pg) * a) | 0
  let nb = (pb + (b - pb) * a) | 0
  px[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr
}

// Additive saturating pixel write
let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let r = (p & 0xff) + rr, g = ((p >> 8) & 0xff) + gg, b = ((p >> 16) & 0xff) + bb
  if (r > 255) r = 255
  if (g > 255) g = 255
  if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

// Thick line using Bresenham + parallel offsets for ~3px width
let lineThick = (x0, y0, x1, y1, rr, gg, bb, a) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  // perpendicular unit vector scaled to 1px
  let len = Math.sqrt(dx * dx + dy * dy)
  let px0 = 0.0, py0 = 0.0
  if (len > 0.5) { px0 = -dy / len; py0 = dx / len }
  let cx = x0, cy = y0, s = 0
  while (s <= steps) {
    let ix = cx | 0, iy = cy | 0
    if (ix >= 0 && ix < W && iy >= 0 && iy < H) bl(iy * W + ix, rr, gg, bb, a)
    // +1 in perp direction
    let ix1 = (cx + px0) | 0, iy1 = (cy + py0) | 0
    if (ix1 >= 0 && ix1 < W && iy1 >= 0 && iy1 < H) bl(iy1 * W + ix1, rr, gg, bb, a * 0.7)
    // -1 in perp direction
    let ix2 = (cx - px0) | 0, iy2 = (cy - py0) | 0
    if (ix2 >= 0 && ix2 < W && iy2 >= 0 && iy2 < H) bl(iy2 * W + ix2, rr, gg, bb, a * 0.7)
    cx += xi; cy += yi; s++
  }
}

// Simple blend line
let lineBlend = (x0, y0, x1, y1, r, g, b, a) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let cx = x0, cy = y0, s = 0
  while (s <= steps) {
    let ix = cx | 0, iy = cy | 0
    if (ix >= 0 && ix < W && iy >= 0 && iy < H) bl(iy * W + ix, r, g, b, a)
    cx += xi; cy += yi; s++
  }
}

let lineAdd = (x0, y0, x1, y1, rr, gg, bb) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let cx = x0, cy = y0, s = 0
  while (s <= steps) {
    addpix(cx | 0, cy | 0, rr, gg, bb)
    cx += xi; cy += yi; s++
  }
}

// Draw circle via line segments — clearly visible thin ring
let circleBlend = (ccx, ccy, r, rr, gg, bb, a) => {
  if (r < 1.0) return
  let SEGS = 64
  let inv = 6.283185307179586 / SEGS
  let px0 = ccx + r, py0 = ccy
  let si = 1
  while (si <= SEGS) {
    let ang = si * inv
    let px1 = ccx + r * Math.cos(ang), py1 = ccy + r * Math.sin(ang)
    lineBlend(px0, py0, px1, py1, rr, gg, bb, a)
    px0 = px1; py0 = py1; si++
  }
}

// frame(t, phi, terms): phi = angle [0, 2π], terms = 1..N (int)
export let frame = (t, phi, terms) => {
  let T = terms | 0
  if (T < 1) T = 1
  if (T > N) T = N

  // Clear to pure black
  let total = W * H, ci = 0
  while (ci < total) { px[ci] = (255 << 24) | 0; ci++ }

  let halfMin = (W < H ? W : H) * 0.5
  let scale = halfMin * 0.88 / ext[0]
  let ocx = W * 0.5, ocy = H * 0.5
  let PI2 = 6.283185307179586

  // ── Pre-compute full trace path for current T ──
  // TRACE_STEPS points covering 0..2π give the complete reconstructed curve
  let ti = 0
  while (ti < TRACE_STEPS) {
    let dphi = (ti / TRACE_STEPS) * PI2
    let ex = ocx, ey = ocy
    let tki = 0
    while (tki < T) {
      let tk = sortedIdx[tki] | 0
      let tang = freqs[tk] * dphi + Math.atan2(C_im[tk], C_re[tk])
      ex += mags[tk] * scale * Math.cos(tang)
      ey += mags[tk] * scale * Math.sin(tang)
      tki++
    }
    traceX[ti] = ex
    traceY[ti] = ey
    ti++
  }

  // ── Ghost: full target curve, dim grey ──
  let ghx0 = ocx + scale * hx[0], ghy0 = ocy + scale * hy[0]
  let gj = 0
  while (gj < N - 1) {
    let ghx1 = ocx + scale * hx[gj + 1], ghy1 = ocy + scale * hy[gj + 1]
    lineBlend(ghx0, ghy0, ghx1, ghy1, 78, 78, 78, 0.75)
    ghx0 = ghx1; ghy0 = ghy1; gj++
  }
  lineBlend(ghx0, ghy0, ocx + scale * hx[0], ocy + scale * hy[0], 78, 78, 78, 0.75)

  // ── Traced curve: accumulated path from 0 to phi ──
  let frac = phi / PI2
  if (frac < 0.0) frac = 0.0
  if (frac > 1.0) frac = 1.0
  let traceCount = (frac * TRACE_STEPS) | 0
  if (traceCount < 1) traceCount = 1
  if (traceCount > TRACE_STEPS - 1) traceCount = TRACE_STEPS - 1

  // Draw the traced path bright with a soft additive glow
  let tj2 = 0
  while (tj2 < traceCount) {
    let tx0 = traceX[tj2], ty0 = traceY[tj2]
    let tx1 = traceX[tj2 + 1], ty1 = traceY[tj2 + 1]
    // Core: bright white, thick
    lineThick(tx0, ty0, tx1, ty1, 245, 245, 245, 0.95)
    // Glow: wider softer aura
    lineAdd(tx0, ty0, tx1, ty1, 55, 55, 55)
    tj2++
  }

  // ── Epicycle chain: circles and arms ──
  let ex = ocx, ey = ocy
  let ki = 0
  while (ki < T) {
    let k = sortedIdx[ki] | 0
    let freq = freqs[k]
    let mag = mags[k] * scale
    let phase = Math.atan2(C_im[k], C_re[k])
    let ang = freq * phi + phase

    let nx = ex + mag * Math.cos(ang)
    let ny = ey + mag * Math.sin(ang)

    // rank: 0 = biggest/slowest arm, 1 = smallest/fastest
    let rank = ki / (N - 1)

    let magNorm = mag / (scale * ext[0])
    // Arm: always visible — big arms solid, small arms still drawn
    let armAlpha = 0.55 + magNorm * 0.45
    if (armAlpha > 0.98) armAlpha = 0.98

    // Circle: clearly visible — minimum 0.5 alpha
    let circAlpha = 0.5 + magNorm * 0.4
    if (circAlpha > 0.88) circAlpha = 0.88

    // B&W: big slow arms bright white, tiny fast arms dim grey
    let lum = (230.0 - rank * 120.0) | 0
    let cr = lum, cg = lum, cb = lum

    // Circle ring — draw all circles with radius > 2px
    if (mag >= 2.0) circleBlend(ex, ey, mag, cr, cg, cb, circAlpha)

    // Arm line — thick for large arms
    if (mag > scale * 0.06) {
      lineThick(ex, ey, nx, ny, cr, cg, cb, armAlpha)
    } else {
      lineBlend(ex, ey, nx, ny, cr, cg, cb, armAlpha)
    }

    ex = nx; ey = ny
    ki++
  }

  // ── Pen tip: bright white dot ──
  let tipR = 5
  let dty = -tipR
  while (dty <= tipR) {
    let dtx = -tipR
    while (dtx <= tipR) {
      if (dtx * dtx + dty * dty <= tipR * tipR) {
        let ix = (ex + dtx) | 0, iy = (ey + dty) | 0
        if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
          px[iy * W + ix] = (255 << 24) | (255 << 16) | (255 << 8) | 255
        }
      }
      dtx++
    }
    dty++
  }
}

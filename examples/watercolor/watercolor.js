// Watercolor / suminagashi — ink on flowing water: an incompressible fluid (Stam's
// "stable fluids") with VORTICITY CONFINEMENT, carrying ink as optical ABSORBANCE.
// Two grids, like the real thing: the velocity field lives at HALF resolution (the flow
// is smooth — the pressure solve there costs a quarter), the ink at full resolution.
// Each frame: measure the curl and push velocity toward each eddy's core (F = ε·ω·N̂⊥,
// N̂ = ∇|ω|/|∇|ω|| — re-sharpening the swirls numerical diffusion smears out), project
// divergence-free (warm-started Gauss–Seidel), self-advect the velocity, then carry the
// ink MacCormack error-compensated (forward + backward gather, half the round-trip error
// added back, min-max limited) so drops fold into crisp filaments instead of fog.
// Rendered by Beer–Lambert: paper → ink by 1 − e^(−A) — washes layer translucently and
// deepen where filaments fold, never clipping. A press blooms a drop; a drag combs
// marbled tendrils — one bath does watercolor AND marbling. Stencil sweeps, bilinear
// gathers and a Gauss–Seidel solve — memory-bound work for jz.
// resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px      // ink (dye) grid = canvas
let WV = 0, HV = 0        // velocity grid — half resolution
let u, v, u0, v0          // velocity + snapshot (WV×HV)
let A, A0, A1             // ink absorbance + snapshot + forward-pass scratch (W×H)
let pr, dv, crl           // pressure (warm-started), divergence, curl (WV×HV)
let ITER = 12             // Gauss–Seidel sweeps — the warm start converges it across frames

const VDAMP = 0.996    // velocity dissipation per frame
const CONF = 0.12      // vorticity confinement strength — keeps the eddies alive & lacy
const PUFF = 0.05      // a drop's outward bloom impulse (most of a drop's motion should come
                       // from the stroke/kick — pure divergence just gets projected away)
const INK = 1.5        // absorbance a full-strength splat deposits
const ACAP = 4.0       // absorbance ceiling (e⁻⁴ ≈ solid ink — deeper never shows)
const PRK = 0.8        // pressure warm-start decay (last frame's field seeds the solve)
const BLEED = 0.004    // capillary bleed — a whisper of feathering, not fog
const FADE = 0.9992    // ink wash-out (~14 s half-life) — the render curve keeps haze invisible,
                       // so washes can linger and marble before they clear

// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; the gallery feeds black paper /
// white ink so the bath reads the same in either site theme.
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0
export let setTheme = (pr_, pg, pb, ir, ig, ib) => { th[0] = pr_; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

export let resize = (w, h) => {
  W = w; H = h
  WV = w >> 1; HV = h >> 1
  let n = w * h, m = WV * HV
  u = new Float64Array(m); v = new Float64Array(m); u0 = new Float64Array(m); v0 = new Float64Array(m)
  pr = new Float64Array(m); dv = new Float64Array(m); crl = new Float64Array(m)
  A = new Float64Array(n); A0 = new Float64Array(n); A1 = new Float64Array(n)
  px = new Uint32Array(n)
  return px
}

export let clear = () => {
  let n = W * H, m = WV * HV, i = 0
  while (i < m) { u[i] = 0.0; v[i] = 0.0; pr[i] = 0.0; i++ }
  i = 0
  while (i < n) { A[i] = 0.0; i++ }
}

// gaussian splat (dye-grid coords): a compact ink blob + a WIDER velocity kick around it —
// the flow grabs the whole drop and folds it, instead of tearing just its middle
let splat = (cx, cy, r, fx, fy, ink) => {
  let x0 = cx - r * 2.2 | 0, x1 = cx + r * 2.2 | 0, y0 = cy - r * 2.2 | 0, y1 = cy + r * 2.2 | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let invI = 1.0 / (0.4 * r * r)
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      let a = A[row + x] + ink * Math.exp(-(dx * dx + dy * dy) * invI)
      if (a > ACAP) a = ACAP
      A[row + x] = a
      x++
    }
    y++
  }
  // velocity: half-res grid, half-res coords, velocities in vel-grid px/frame
  let vcx = cx * 0.5, vcy = cy * 0.5, vr = r * 0.5
  x0 = vcx - vr * 3.6 | 0; x1 = vcx + vr * 3.6 | 0; y0 = vcy - vr * 3.6 | 0; y1 = vcy + vr * 3.6 | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > WV - 2) x1 = WV - 2
  if (y1 > HV - 2) y1 = HV - 2
  let invV = 1.0 / (1.3 * vr * vr)
  y = y0
  while (y <= y1) {
    let dy = y - vcy, row = y * WV, x = x0
    while (x <= x1) {
      let dx = x - vcx
      let g = Math.exp(-(dx * dx + dy * dy) * invV)
      u[row + x] += g * (dx * PUFF + fx * 0.5)
      v[row + x] += g * (dy * PUFF + fy * 0.5)
      x++
    }
    y++
  }
}

// brush: drop/drag ink with force (fx,fy = the stroke's velocity, dye px/frame)
export let paint = (cx, cy, r, fx, fy) => splat(cx, cy, r, fx, fy, INK)
// stir: move the bath only — ambient currents, ink-less combing
export let stir = (cx, cy, r, fx, fy) => splat(cx, cy, r, fx, fy, 0.0)

// bilinear sample of grid f (dims w×h) at (x,y), clamped to the interior
let samp = (f, x, y, w, h) => {
  if (x < 0.5) x = 0.5; else if (x > w - 1.5) x = w - 1.5
  if (y < 0.5) y = 0.5; else if (y > h - 1.5) y = h - 1.5
  let i0 = x | 0, j0 = y | 0
  let sx = x - i0, sy = y - j0
  let b = j0 * w + i0
  let a = f[b], c = f[b + 1], d = f[b + w], e = f[b + w + 1]
  return a * (1.0 - sx) * (1.0 - sy) + c * sx * (1.0 - sy) + d * (1.0 - sx) * sy + e * sx * sy
}

// vorticity confinement (vel grid): curl sweep, then push velocity toward each eddy's core
let confine = () => {
  let w = WV, h = HV
  let y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      crl[c] = 0.5 * (v[c + 1] - v[c - 1] - u[c + w] + u[c - w])
      x++
    }
    y++
  }
  y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      let gx = Math.abs(crl[c + 1]) - Math.abs(crl[c - 1])
      let gy = Math.abs(crl[c + w]) - Math.abs(crl[c - w])
      let s = CONF * crl[c] / (Math.sqrt(gx * gx + gy * gy) + 0.00001)
      u[c] += s * gy
      v[c] -= s * gx
      x++
    }
    y++
  }
}

// make velocity divergence-free (Gauss–Seidel pressure projection, warm-started)
let project = () => {
  let w = WV, h = HV
  let y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      dv[c] = -0.5 * (u[c + 1] - u[c - 1] + v[c + w] - v[c - w])
      pr[c] = pr[c] * PRK
      x++
    }
    y++
  }
  let k = 0
  while (k < ITER) {
    y = 1
    while (y < h - 1) {
      let r = y * w, x = 1
      while (x < w - 1) {
        let c = r + x
        pr[c] = (dv[c] + pr[c - 1] + pr[c + 1] + pr[c - w] + pr[c + w]) * 0.25
        x++
      }
      y++
    }
    k++
  }
  y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      u[c] -= 0.5 * (pr[c + 1] - pr[c - 1])
      v[c] -= 0.5 * (pr[c + w] - pr[c - w])
      x++
    }
    y++
  }
}

// self-advect velocity (vel grid): backtrace along the snapshot flow, gather bilinear
let advectVel = (s, s0) => {
  let w = WV, h = HV, y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      s[c] = samp(s0, x - u0[c], y - v0[c], w, h) * VDAMP
      x++
    }
    y++
  }
}

// MacCormack ink transport (dye grid, velocity sampled off the half-res flow ×2):
// forward gather, backward gather, add back HALF the round-trip error, clamped to the
// forward stencil's range (no ringing) — drops fold into crisp filaments, not fog.
let inkStep = () => {
  let w = W, h = H, y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      let ux = 2.0 * samp(u0, x * 0.5, y * 0.5, WV, HV)
      let uy = 2.0 * samp(v0, x * 0.5, y * 0.5, WV, HV)
      A1[c] = samp(A0, x - ux, y - uy, w, h)
      x++
    }
    y++
  }
  y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      let ux = 2.0 * samp(u0, x * 0.5, y * 0.5, WV, HV)
      let uy = 2.0 * samp(v0, x * 0.5, y * 0.5, WV, HV)
      let a = A1[c] + 0.5 * (A0[c] - samp(A1, x + ux, y + uy, w, h))
      let sx = x - ux, sy = y - uy                 // the forward stencil bounds the result
      if (sx < 0.5) sx = 0.5; else if (sx > w - 1.5) sx = w - 1.5
      if (sy < 0.5) sy = 0.5; else if (sy > h - 1.5) sy = h - 1.5
      let b = (sy | 0) * w + (sx | 0)
      let q00 = A0[b], q10 = A0[b + 1], q01 = A0[b + w], q11 = A0[b + w + 1]
      let lo = q00, hi = q00
      if (q10 < lo) lo = q10; else if (q10 > hi) hi = q10
      if (q01 < lo) lo = q01; else if (q01 > hi) hi = q01
      if (q11 < lo) lo = q11; else if (q11 > hi) hi = q11
      if (a < lo) a = lo; else if (a > hi) a = hi
      A[c] = a
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let n = W * H, m = WV * HV
  confine()                            // re-energize the flow's own eddies
  project()                            // divergence-free before transport
  let i = 0
  while (i < m) { u0[i] = u[i]; v0[i] = v[i]; i++ }
  advectVel(u, u0)                     // self-advection (+ dissipation)
  advectVel(v, v0)
  i = 0
  while (i < n) { A0[i] = A[i]; i++ }
  inkStep()                            // carry the ink along the flow, error-compensated
  // capillary bleed + slow wash-out — the wet-paper feathering
  i = 0
  while (i < n) { A0[i] = A[i]; i++ }
  let kk = BLEED, w2 = W, y2 = 1
  while (y2 < H - 1) {
    let r = y2 * w2, x2 = 1
    while (x2 < w2 - 1) {
      let c = r + x2
      A[c] = (A0[c] * (1.0 - 4.0 * kk) + kk * (A0[c - 1] + A0[c + 1] + A0[c - w2] + A0[c + w2])) * FADE
      x2++
    }
    y2++
  }
  // Beer–Lambert: paper → ink by 1 − e^(−A), through a smoothstep response — thin haze
  // drops away, mid washes steepen: it reads as INK in water, not smoke
  i = 0
  while (i < n) {
    let mm = 1.0 - Math.exp(-A[i])
    mm = mm * mm * (3.0 - 2.0 * mm)
    let r = (th[0] + (th[3] - th[0]) * mm) | 0
    let g = (th[1] + (th[4] - th[1]) * mm) | 0
    let b = (th[2] + (th[5] - th[2]) * mm) | 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}

// Waves as CAUSTICS — the 2D wave equation u_tt = c²∇²u seen the way you see a pool floor:
// every texel of the surface refracts one vertical light ray, the ray lands on the floor
// displaced by the surface gradient (x' = x − F·∇u, F = focal depth), and the landing spots
// are accumulated into a photon-density map. Where the refraction map FOLDS, rays pile onto
// a curve — the knife-edge white filaments of real caustics; where a trough spreads rays
// apart the floor falls dark. Nothing is drawn — the filaments are genuine fold
// singularities of the light map. After KZ_LAB_E's caustics simulation
// (x.com/KZ_LAB_E/status/1979210373921411098).
//
// The pool is CALM: a steady drizzle of soft zero-mean plops (deterministic xorshift),
// barely damped, accumulates into a gentle random swell — and gentle swell under a deep
// focus is exactly the classic swimming-pool caustic net, slowly shimmering. The pointer is
// a fingertip: a light touch trailing ripples, not a churn. A 9-point isotropic Laplacian
// keeps fronts round, an edge sponge swallows wall reflections, one 3×3 blur softens the
// photon map, and the tone LUT maps light onto POOL WATER — white caustics over turquoise,
// deep teal in the shadows. frame(t, sx, sy, stir): fingertip position (px) + touch 0..1.
// drop(x,y) splashes; clear() stills the pool. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let L                  // photon-density map (the pool floor), rebuilt every frame
let Ls                 // blur scratch
let dampField          // per-cell damping = global damp × edge sponge
let rs = 0             // xorshift32 — the rain (i32 wraps identically in JS and jz)
let glut               // Int32Array(1024) — photon density → pool-water color

const C2 = 0.35        // wave speed² (CFL-stable for the 9-point stencil at ≤0.5)
const SUB = 1          // one leapfrog substep per frame — the pool shimmers, it doesn't race
const DAMP = 0.9985    // barely damped: the drizzle accumulates into a standing gentle swell
const MARGIN = 18      // edge-sponge width (cells)
const MARGINDAMP = 0.94
const RAIN = 9.0       // soft plops per second — the source of the swell
const RAINA = 0.16     // plop amplitude (signs alternate → zero-mean surface)
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  L = new Float64Array(w * h); Ls = new Float64Array(w * h)
  dampField = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  rs = 421127287
  // per-cell damping: global DAMP, ramped down within MARGIN cells of any edge
  let y = 0
  while (y < h) {
    let x = 0
    while (x < w) {
      let ed = x
      if (y < ed) ed = y
      let rxe = w - 1 - x; if (rxe < ed) ed = rxe
      let rye = h - 1 - y; if (rye < ed) ed = rye
      let s = DAMP
      if (ed < MARGIN) s = MARGINDAMP + (DAMP - MARGINDAMP) * (ed / MARGIN)
      dampField[y * w + x] = s
      x++
    }
    y++
  }
  // tone curve → POOL WATER: photon density through a filmic shoulder, then onto a
  // deep-teal → turquoise → white ramp — sunlit water over a painted pool floor
  glut = new Int32Array(1024)
  let i = 0
  while (i < 1024) {
    let v = i * 0.00390625                 // bucket ↔ density v = i/256, range 0..4
    let vp = v * Math.sqrt(Math.sqrt(v))   // v^1.25 — mild gamma steepens the fold flanks
    let t = 1.0 - Math.exp(-0.7 * vp)
    let r = 0.0, g = 0.0, bl = 0.0
    if (t < 0.55) {
      let f = t / 0.55
      r = 6.0 + (44.0 - 6.0) * f
      g = 32.0 + (178.0 - 32.0) * f
      bl = 54.0 + (195.0 - 54.0) * f
    } else {
      let f = (t - 0.55) / 0.45
      r = 44.0 + (255.0 - 44.0) * f
      g = 178.0 + (255.0 - 178.0) * f
      bl = 195.0 + (255.0 - 195.0) * f
    }
    glut[i] = (255 << 24) | ((bl | 0) << 16) | ((g | 0) << 8) | (r | 0)
    i++
  }
  return px
}

export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

let rnd = () => {
  rs = rs ^ (rs << 13)
  rs = rs ^ (rs >>> 17)
  rs = rs ^ (rs << 5)
  return (((rs >>> 9) | 0) + 1) / 8388609.0
}

// gaussian plop pressed into the current field — a splash that rings out as a real front
export let drop = (cx, cy) => { plop(cx, cy, 4.5, -2.2) }

let plop = (cx, cy, r, amp) => {
  let rO = r * 3.0
  let x0 = (cx - rO) | 0, x1 = (cx + rO) | 0, y0 = (cy - rO) | 0, y1 = (cy + rO) | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let ir2 = 1.0 / (r * r)
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      let q = (dx * dx + dy * dy) * ir2
      if (q < 9.0) a[row + x] = a[row + x] + amp * Math.exp(-q)
      x++
    }
    y++
  }
}

// one leapfrog substep of the linear wave equation
let step = () => {
  let w = W, h = H
  let y = 1
  while (y < h - 1) {
    let rc = y * w, rn = rc - w, rsw = rc + w, x = 1
    while (x < w - 1) {
      let c = rc + x, ac = a[c]
      let lap = O * (a[c - 1] + a[c + 1] + a[rn + x] + a[rsw + x])
        + D * (a[rn + x - 1] + a[rn + x + 1] + a[rsw + x - 1] + a[rsw + x + 1]) + CEN * ac
      b[c] = (2.0 * ac - b[c] + C2 * lap) * dampField[c]
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp              // swap → a is current
}

// foc = focal depth × refraction: how far a ray shears per unit slope — the POOL DEPTH.
// Shallow (≈50) barely bends the light; deep (≈140) folds every ripple into hard caustics.
export let frame = (t, sx, sy, stir, foc) => {
  let w = W, h = H, n = w * h

  // drizzle: soft alternating-sign plops accumulate into the pool's gentle standing swell
  let drops = (RAIN / 60.0 + rnd()) | 0    // fractional rate via random rounding
  let d = 0
  while (d < drops) {
    let sgn = rnd() < 0.5 ? -1.0 : 1.0
    plop(6.0 + rnd() * (w - 12.0), 6.0 + rnd() * (h - 12.0), 4.0 + rnd() * 5.0, sgn * RAINA * (0.4 + rnd()))
    d++
  }

  let s = 0
  while (s < SUB) { step(); s++ }
  // the fingertip: a light touch at (sx,sy) — dragging it trails gentle ripples
  if (stir > 0.0) {
    let R = 0.016 * (w < h ? w : h) + 2.0
    let x0 = (sx - 3.0 * R) | 0, x1 = (sx + 3.0 * R) | 0, y0 = (sy - 3.0 * R) | 0, y1 = (sy + 3.0 * R) | 0
    if (x0 < 1) x0 = 1
    if (y0 < 1) y0 = 1
    if (x1 > w - 2) x1 = w - 2
    if (y1 > h - 2) y1 = h - 2
    let ir2 = 1.0 / (R * R)
    let press = 0.25 * stir
    let yy = y0
    while (yy <= y1) {
      let dy = yy - sy, row = yy * w, x = x0
      while (x <= x1) {
        let dx = x - sx
        let q = (dx * dx + dy * dy) * ir2
        if (q < 9.0) {
          let c = row + x
          let E = Math.exp(-q)
          a[c] = a[c] + (-1.4 * stir * E - a[c]) * press * E
        }
        x++
      }
      yy++
    }
  }

  // ── caustics: refract one ray per texel through the surface, splat where it lands ──
  let i = 0
  while (i < n) { L[i] = 0.0; i++ }
  let y = 1
  while (y < h - 1) {
    let row = y * w, x = 1
    while (x < w - 1) {
      let c = row + x
      let gx = (a[c + 1] - a[c - 1]) * 0.5
      let gy = (a[c + w] - a[c - w]) * 0.5
      // refraction bends the ray TOWARD the surface normal (air → water), so the floor hit
      // shifts DOWNHILL: crests converge light (bright), pressed dimples diverge it (dark)
      let xf = x + foc * gx
      let yf = y + foc * gy
      if (xf >= 0.0 && xf < w - 1.001 && yf >= 0.0 && yf < h - 1.001) {
        let xi = xf | 0, yi = yf | 0
        let fx = xf - xi, fy = yf - yi
        let c2 = yi * w + xi
        L[c2] = L[c2] + (1.0 - fx) * (1.0 - fy)
        L[c2 + 1] = L[c2 + 1] + fx * (1.0 - fy)
        L[c2 + w] = L[c2 + w] + (1.0 - fx) * fy
        L[c2 + w + 1] = L[c2 + w + 1] + fx * fy
      }
      x++
    }
    y++
  }
  // one separable 3-tap blur pass — softens splat shimmer into the silky reference look
  let bp = 0
  while (bp < 1) {
    y = 0
    while (y < h) {
      let row = y * w
      Ls[row] = L[row]
      let x = 1
      while (x < w - 1) { let c = row + x; Ls[c] = (L[c - 1] + L[c] + L[c] + L[c + 1]) * 0.25; x++ }
      Ls[row + w - 1] = L[row + w - 1]
      y++
    }
    let x = 0
    while (x < w) {
      L[x] = Ls[x]
      let yy = 1
      while (yy < h - 1) { let c = yy * w + x; L[c] = (Ls[c - w] + Ls[c] + Ls[c] + Ls[c + w]) * 0.25; yy++ }
      L[(h - 1) * w + x] = Ls[(h - 1) * w + x]
      x++
    }
    bp++
  }
  // ── tone map: photon density → pool water through the color LUT ──
  i = 0
  while (i < n) {
    let q = (L[i] * 256.0) | 0
    if (q > 1023) q = 1023
    px[i] = glut[q]
    i++
  }
}

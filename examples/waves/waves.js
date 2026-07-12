// Waves as CAUSTICS — the 2D wave equation u_tt = c²∇²u seen the way you see a pool floor:
// every texel of the surface refracts one vertical light ray, the ray lands on the floor
// displaced by the surface gradient (x' = x − F·∇u, F = focal depth), and the landing spots
// are accumulated into a photon-density map. Where the refraction map FOLDS, rays pile onto
// a curve — the knife-edge white filaments of real caustics; where a trough spreads rays
// apart the floor falls dark. Nothing is drawn — the filaments are genuine fold
// singularities of the light map. After KZ_LAB_E's caustics simulation
// (x.com/KZ_LAB_E/status/1979210373921411098).
//
// The surface is stirred two ways: a STIRRER — a pressed dimple the host drags along the
// pointer (or wanders on its own) whose moving wake throws the big loops — and a fine RAIN
// of tiny plops (deterministic xorshift) that keeps the whole pool webbed with fine
// cellular caustics. A 9-point isotropic Laplacian keeps fronts round, an edge sponge
// swallows wall reflections, and one 3×3 blur softens the photon map before a LUT
// tone-map. frame(t, sx, sy, stir): stirrer position (px) + press strength 0..1.
// drop(x,y) splashes; clear() stills the pool. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let L                  // photon-density map (the pool floor), rebuilt every frame
let Ls                 // blur scratch
let dampField          // per-cell damping = global damp × edge sponge
let rs = 0             // xorshift32 — the rain (i32 wraps identically in JS and jz)
let glut               // Int32Array(1024) — photon density → gray tone curve

const C2 = 0.42        // wave speed² (CFL-stable for the 9-point stencil at ≤0.5)
const SUB = 3          // leapfrog substeps per frame → fronts travel ~2 px/frame
const DAMP = 0.996     // global ring-down — ripples churn and fade, they don't haunt the pool
const MARGIN = 18      // edge-sponge width (cells)
const MARGINDAMP = 0.94
const RAIN = 14.0      // plops per second — the soft cellular webbing between the wake bands
const RAINA = 0.3      // plop amplitude
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
  // tone curve: density 1 (undisturbed floor) → mid gray ~0.42, folds (v ≥ ~3) saturate to
  // white through a filmic shoulder, diverged voids fall toward black — the pool-floor look
  glut = new Int32Array(1024)
  let i = 0
  while (i < 1024) {
    let v = i * 0.00390625                 // bucket ↔ density v = i/256, range 0..4
    let vp = v * Math.sqrt(Math.sqrt(v))   // v^1.25 — mild gamma steepens the fold flanks
    let g = 1.0 - Math.exp(-0.7 * vp)
    let gi = (g * 255.0) | 0
    if (gi > 255) gi = 255
    glut[i] = gi
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
export let drop = (cx, cy) => { plop(cx, cy, 4.5, -3.6) }

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

  // rain: a steady drizzle of tiny plops keeps the fine cellular webbing alive
  let drops = (RAIN / 60.0 + rnd()) | 0    // fractional rate via random rounding
  let d = 0
  while (d < drops) {
    plop(6.0 + rnd() * (w - 12.0), 6.0 + rnd() * (h - 12.0), 3.5 + rnd() * 4.5, RAINA * (0.4 + rnd()))
    d++
  }

  let s = 0
  while (s < SUB) { step(); s++ }
  // the stirrer: a dimple pressed into the surface at (sx,sy) — DRAGGING it radiates the
  // big loopy wake. One gaussian evaluation per cell, pressed once per frame.
  if (stir > 0.0) {
    let R = 0.07 * (w < h ? w : h) + 2.0
    let x0 = (sx - 3.0 * R) | 0, x1 = (sx + 3.0 * R) | 0, y0 = (sy - 3.0 * R) | 0, y1 = (sy + 3.0 * R) | 0
    if (x0 < 1) x0 = 1
    if (y0 < 1) y0 = 1
    if (x1 > w - 2) x1 = w - 2
    if (y1 > h - 2) y1 = h - 2
    let ir2 = 1.0 / (R * R)
    let press = 0.6 * stir
    let yy = y0
    while (yy <= y1) {
      let dy = yy - sy, row = yy * w, x = x0
      while (x <= x1) {
        let dx = x - sx
        let q = (dx * dx + dy * dy) * ir2
        if (q < 9.0) {
          let c = row + x
          let E = Math.exp(-q)
          a[c] = a[c] + (-5.5 * stir * E - a[c]) * press * E
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
  // ── tone map: photon density → gray through the LUT ──
  i = 0
  while (i < n) {
    let q = (L[i] * 256.0) | 0
    if (q > 1023) q = 1023
    let g = glut[q]
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

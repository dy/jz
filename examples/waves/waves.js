// Waves as CAUSTICS — the 2D wave equation u_tt = c²∇²u seen the way you see a pool floor:
// every texel of the surface refracts one vertical light ray, the ray lands on the floor
// displaced by the surface gradient (x' = x − F·∇u, F = focal depth), and the landing spots
// are accumulated into a photon-density map. Where the refraction map FOLDS, rays pile onto
// a curve — the knife-edge white filaments of real caustics; where a trough spreads rays
// apart the floor falls dark. Nothing is drawn — the filaments are genuine fold
// singularities of the light map. After KZ_LAB_E's caustics simulation
// (x.com/KZ_LAB_E/status/1979210373921411098).
//
// The pool is CALM: an occasional soft plop (deterministic xorshift) sustains a gentle
// random swell — and gentle swell under a deep focus is exactly the classic swimming-pool
// caustic net, slowly shimmering. drop(x,y) presses a dip and lets the PHYSICS make the
// ring; dragging presses a small moving dimple — a stick drawn through the water, one
// continuous wake. The water is VISCOUS: a per-frame frequency-selective smoothing kills
// fine ripples fast while the broad swell rolls on — thick, syrupy motion, and no lattice
// junk survives. A 9-point isotropic Laplacian keeps fronts round, an edge sponge swallows
// wall reflections, one 3×3 blur softens the photon map, and the tone LUT maps light onto
// POOL WATER — hard white caustics over turquoise, deep navy shadows.
// frame(t, sx, sy, stick, foc): stick > 0 presses the moving dimple at (sx,sy).
// clear() stills the pool. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let L                  // photon-density map (the pool floor), rebuilt every frame
let Ls                 // blur scratch
let dampField          // per-cell damping = global damp × edge sponge
let rs = 0             // xorshift32 — the rain (i32 wraps identically in JS and jz)
let glut               // Int32Array(1024) — photon density → pool-water color
let sp = new Float64Array(3)   // stick trail: previous (x, y) + active flag — fractional
                               // module scalars live in a Float64Array (i32-narrowing)

const C2 = 0.20        // wave speed² (CFL-stable for the 9-point stencil at ≤0.5) — unhurried
const SUB = 1          // one leapfrog substep per frame — the pool shimmers, it doesn't race
const DAMP = 0.9955    // rings reverberate — a drop stays audible for a good while
const MARGIN = 26      // edge-sponge width (cells) — wide and gentle: an abrupt sponge
const MARGINDAMP = 0.95   // reflects, and reflections pile up as corner surges
const RAIN = 0.7       // a rare soft plop — the pool mostly rests
const RAINA = 0.35     // plop amplitude (signs alternate → zero-mean surface)
const VISC = 0.015     // per-frame ∇² smoothing of the surface: fine chop still dies in a
                       // beat, but a drop's ring — a longer wave — now rolls on and on
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
    let vp = v * Math.sqrt(v)              // v^1.5 — hard gamma: darks crush, folds blaze
    let t = 1.0 - Math.exp(-0.8 * vp)
    let r = 0.0, g = 0.0, bl = 0.0
    if (t < 0.55) {
      let f = t / 0.55
      r = 3.0 + (44.0 - 3.0) * f
      g = 18.0 + (178.0 - 18.0) * f
      bl = 34.0 + (195.0 - 34.0) * f
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

// a soft gaussian bump. both=0: written to the current buffer only — an implicit velocity
// kick whose broadband ringing is exactly what sustains the pool's cellular caustic web
// (the drizzle wants that churn). both=1: written to BOTH leapfrog buffers — a zero-velocity
// release that relaxes smoothly, for the splash's centre dip.
let plop = (cx, cy, r, amp, both) => {
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
      if (q < 9.0) {
        let v = amp * Math.exp(-q)
        a[row + x] = a[row + x] + v
        if (both > 0) b[row + x] = b[row + x] + v
      }
      x++
    }
    y++
  }
}

// the click: press a dip and let the WATER make the ring — a zero-velocity release relaxes
// into a natural outgoing wave, nothing hand-drawn. Wide and shallow: the dip wall's slope
// is what the caustic amplifies, so gentleness here is a soft first front out there.
export let drop = (cx, cy) => { plop(cx, cy, 9.5, -0.9, 1) }

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
export let frame = (t, sx, sy, stick, foc) => {
  let w = W, h = H, n = w * h

  // drizzle: soft alternating-sign plops sustain the ambient swell — released with ZERO
  // velocity like the clicks (a velocity-kick plop injects far more energy than it looks,
  // and with the long reverb those kicks piled up into corner surges). Paused while the
  // stick is in the water, so a drag is YOUR wave alone.
  if (stick <= 0.0) {
    let drops = (RAIN / 60.0 + rnd()) | 0  // fractional rate via random rounding
    let d = 0
    while (d < drops) {
      let sgn = rnd() < 0.5 ? -1.0 : 1.0
      plop(20.0 + rnd() * (w - 40.0), 20.0 + rnd() * (h - 40.0), 7.0 + rnd() * 7.0, sgn * RAINA * (0.4 + rnd()), 1)
      d++
    }
  }

  let s = 0
  while (s < SUB) { step(); s++ }

  // the stick: a dimple SWEPT along the drag as a capsule — the press covers the whole
  // segment from last frame's position to this one, so a fast stroke is one continuous
  // groove, never a chain of stamps. BOTH leapfrog sheets relax toward the dimple: a
  // displacement constraint, no direct velocity injection — pressing only the current
  // sheet is a velocity kick every frame, and circular strokes then meet their own wake
  // in phase and pump it exponentially (measured ×1.4 per lap). Constraining both sheets
  // also makes the stick locally ABSORBING, like a real stick held in ripples.
  if (stick > 0.0) {
    let R = 0.018 * (w < h ? w : h) + 2.0
    let ax0 = sp[2] > 0.5 ? sp[0] : sx, ay0 = sp[2] > 0.5 ? sp[1] : sy
    let vx = sx - ax0, vy = sy - ay0
    let vv = vx * vx + vy * vy
    let bx0 = (ax0 < sx ? ax0 : sx) - 3.0 * R, bx1 = (ax0 > sx ? ax0 : sx) + 3.0 * R
    let by0 = (ay0 < sy ? ay0 : sy) - 3.0 * R, by1 = (ay0 > sy ? ay0 : sy) + 3.0 * R
    let x0 = bx0 | 0, x1 = bx1 | 0, y0 = by0 | 0, y1 = by1 | 0
    if (x0 < 1) x0 = 1
    if (y0 < 1) y0 = 1
    if (x1 > w - 2) x1 = w - 2
    if (y1 > h - 2) y1 = h - 2
    let ir2 = 1.0 / (R * R)
    let yy = y0
    while (yy <= y1) {
      let row = yy * w, x = x0
      while (x <= x1) {
        // distance to the swept SEGMENT (point projected onto it, clamped to its ends)
        let tt = 0.0
        if (vv > 1e-9) {
          tt = ((x - ax0) * vx + (yy - ay0) * vy) / vv
          if (tt < 0.0) tt = 0.0
          if (tt > 1.0) tt = 1.0
        }
        let dx = x - (ax0 + tt * vx), dy = yy - (ay0 + tt * vy)
        let q = (dx * dx + dy * dy) * ir2
        if (q < 9.0) {
          let c = row + x
          let E = Math.exp(-q)
          let tgt = -1.1 * stick * E
          let g = 0.2 * E
          a[c] = a[c] + (tgt - a[c]) * g
          b[c] = b[c] + (tgt - b[c]) * g
        }
        x++
      }
      yy++
    }
    sp[0] = sx; sp[1] = sy; sp[2] = 1.0
  } else {
    sp[2] = 0.0
  }

  // viscosity: smooth BOTH leapfrog sheets a little every frame — a frequency-selective
  // loss (∝ k²) that snuffs fine chop in a beat while the broad swell rolls on
  let vp = 0
  while (vp < 2) {
    let f = vp === 0 ? a : b
    let y = 1
    while (y < h - 1) {
      let row = y * w, x = 1
      while (x < w - 1) {
        let c = row + x
        Ls[c] = f[c] * (1.0 - 4.0 * VISC) + (f[c - 1] + f[c + 1] + f[c - w] + f[c + w]) * VISC
        x++
      }
      y++
    }
    y = 1
    while (y < h - 1) {
      let row = y * w, x = 1
      while (x < w - 1) { f[row + x] = Ls[row + x]; x++ }
      y++
    }
    vp++
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
      // shifts DOWNHILL: crests converge light (bright), pressed dimples diverge it (dark).
      // Each ray starts from a hash-jittered sub-pixel origin — one ray per exact texel
      // centre imprints the sampling GRID wherever the refraction map stretches (a dotted
      // lattice in every dark core); the jitter turns that into noise the blur then absorbs.
      let hj = (x * 1103515245 + 12345) ^ (y * 12820163 + 9301)
      let xf = x + foc * gx + ((hj & 255) - 127.5) * 0.0035
      let yf = y + foc * gy + (((hj >> 8) & 255) - 127.5) * 0.0035
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
  // two separable 3-tap blur passes — the hard tone gamma would re-expose splat noise
  let bp = 0
  while (bp < 2) {
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

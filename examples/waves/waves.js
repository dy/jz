// Waves — the 2D wave equation u_tt = c²∇²u on a height field, shaded by where
// light lands after bending through the surface: each texel's ray lands shifted
// by the local gradient (x' = x − F·∇u), landings accumulate into a density map,
// and density maps to monochrome exposure. Still water is neutral gray; wave
// fronts read as bright seams against darker troughs — genuine density changes,
// nothing outlined.
//
// drop(x,y) presses a dip and lets the physics make the ring. Dragging carves a
// small moving dimple. A 9-point isotropic Laplacian keeps fronts round, an edge
// sponge absorbs wall reflections, mild ∇² smoothing merges brush chop while the
// broad swell rolls on.
// frame(t, sx, sy, stick, foc): stick > 0 presses the moving dimple at (sx,sy).
// clear() stills the sheet. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let L                  // light-density map, rebuilt every frame
let Ls                 // blur scratch
let dampField          // per-cell damping = global damp × edge sponge
let glut               // Int32Array(1024) — density → exposure
let sp = new Float64Array(3)   // stick trail: previous (x, y) + active flag — fractional
                               // module scalars live in a Float64Array (i32-narrowing)

const C2 = 0.45        // wave speed² — deliberately NEAR the stencil's stability limit
                       // (≤0.75): leapfrog dispersion vanishes toward the limit and blooms
                       // far below it, and that dispersion was the "high-frequency
                       // side-waves" flanking every front at the old C2 = 0.20
const SUB = 1          // one leapfrog substep per frame
const DAMP = 0.9985    // rings linger — a drop keeps ringing long after it lands
const MARGIN = 26      // edge-sponge width (cells) — wide and gentle: an abrupt sponge
const MARGINDAMP = 0.95   // reflects, and reflections pile up as corner surges
const VISC = 0.02      // a whisper of ∇² smoothing — with dispersion tamed at the source,
                       // this only eats residual grid wiggles; more blunts the fronts
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  L = new Float64Array(w * h); Ls = new Float64Array(w * h)
  dampField = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  sp[2] = 0.0
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
      if (ed < MARGIN) {
        // QUADRATIC ramp — zero slope where the sponge begins, so waves enter it without
        // seeing a boundary (a linear ramp's kink partially reflects, and that read as the
        // pool having a padded inner wall)
        let f = (MARGIN - ed) / MARGIN
        s = DAMP - (DAMP - MARGINDAMP) * f * f
      }
      dampField[y * w + x] = s
      x++
    }
    y++
  }
  // Neutral exposure: one undisturbed ray per pixel is #9e9e9e. The v^1.5 shoulder
  // keeps broad converging regions silver and reserves pure white for the sharpest
  // seams, while stretched regions can still fall all the way to black.
  glut = new Int32Array(1024)
  let i = 0
  while (i < 1024) {
    let v = i * 0.00390625                 // bucket ↔ density v = i/256, range 0..4
    let lum = 255.0 * (1.0 - Math.exp(-0.967 * v * v))   // v² gamma: same #9e9e9e at v = 1,
                                           // but mids fall darker and folds blaze harder
    let c = lum | 0
    glut[i] = (255 << 24) | (c << 16) | (c << 8) | c
    i++
  }
  return px
}

export let clear = () => {
  let n = W * H, i = 0
  while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ }
  sp[2] = 0.0
}

// A soft Gaussian pressed into BOTH leapfrog buffers: a zero-velocity release that relaxes
// smoothly into an outgoing ring instead of exploding as an artificial velocity kick.
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
      if (q < 9.0) {
        let v = amp * Math.exp(-q)
        a[row + x] = a[row + x] + v
        b[row + x] = b[row + x] + v
      }
      x++
    }
    y++
  }
}

// the click: press a dip and let the WATER make the ring — a zero-velocity release relaxes
// into a natural outgoing wave, nothing hand-drawn. Steep enough to fold the light hard:
// the dip wall's slope IS the caustic's strength.
export let drop = (cx, cy) => { plop(cx, cy, 7.0, -1.4) }

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

// foc: how far a ray shears per unit slope — the pool depth. Shallow (≈50) barely
// bends the light; deep (≈140) turns every ripple into hard bright seams.
export let frame = (t, sx, sy, stick, foc) => {
  let w = W, h = H, n = w * h

  let s = 0
  while (s < SUB) { step(); s++ }

  // the stick: a dimple CARVED along the drag as a capsule — the sweep covers the whole
  // segment from last frame's position to this one, and every touched cell is pressed to
  // the full dimple depth at once (min on BOTH leapfrog sheets). Depth is instant and
  // uniform at any stroke speed — a relaxation press deepens with dwell time, so fast
  // strokes came out shallow and banded, reading as a chain of small drops. Carving both
  // sheets injects no velocity and is locally ABSORBING (it can only remove motion), so
  // circular strokes cannot pump their own wake.
  if (stick > 0.0) {
    let R = 0.020 * (w < h ? w : h) + 2.0
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
          let tgt = -1.3 * stick * E
          // fast soft blend toward the carve depth (~96% in 4 frames) — a hard min splices
          // the surface with curvature kinks whose high frequencies flank the stroke
          if (a[c] > tgt) a[c] = a[c] + (tgt - a[c]) * 0.55
          if (b[c] > tgt) b[c] = b[c] + (tgt - b[c]) * 0.55
        }
        x++
      }
      yy++
    }
    // settle the fresh trail: one stronger local smoothing over the carve box — the moving
    // rear edge releases cells at slightly different phases, and unsmoothed that chop
    // herringbones inside the groove
    let vp2 = 0
    while (vp2 < 2) {
      let f = vp2 === 0 ? a : b
      let yy2 = y0 > 1 ? y0 : 2
      let yl2 = y1 < h - 2 ? y1 : h - 3
      while (yy2 <= yl2) {
        let row = yy2 * w, x = x0 > 1 ? x0 : 2
        let xl = x1 < w - 2 ? x1 : w - 3
        while (x <= xl) {
          let c = row + x
          Ls[c] = f[c] * 0.6 + (f[c - 1] + f[c + 1] + f[c - w] + f[c + w]) * 0.1
          x++
        }
        yy2++
      }
      yy2 = y0 > 1 ? y0 : 2
      while (yy2 <= yl2) {
        let row = yy2 * w, x = x0 > 1 ? x0 : 2
        let xl = x1 < w - 2 ? x1 : w - 3
        while (x <= xl) { f[row + x] = Ls[row + x]; x++ }
        yy2++
      }
      vp2++
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

  // ── shade: bend one ray per texel through the surface, splat where it lands ──
  let i = 0
  while (i < n) { L[i] = 0.0; i++ }
  let y = 1
  while (y < h - 1) {
    let row = y * w, x = 1
    while (x < w - 1) {
      let c = row + x
      let gx = (a[c + 1] - a[c - 1]) * 0.5
      let gy = (a[c + w] - a[c - w]) * 0.5
      // The ray bends toward the surface normal, so the hit shifts DOWNHILL: crests
      // converge light (bright), pressed dimples diverge it (dark). Exact texel centres
      // make a perfectly flat sheet perfectly flat; the blur below absorbs the sparse
      // sampling only where the map stretches.
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
  // one separable 3-tap blur pass — enough to absorb splat grain, and no more:
  // a second pass visibly blunts the seams
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
  // The interior ray loop cannot feed the outermost texels on a flat sheet, and the
  // blur spreads that deficit inward. Pin the three-pixel frame to neutral exposure
  // instead of showing a synthetic black outline around an otherwise flat field.
  let edge = 0
  while (edge < 3) {
    let ex = 0
    while (ex < w) { L[edge * w + ex] = 1.0; L[(h - 1 - edge) * w + ex] = 1.0; ex++ }
    let ey = edge + 1
    while (ey < h - 1 - edge) { L[ey * w + edge] = 1.0; L[ey * w + w - 1 - edge] = 1.0; ey++ }
    edge++
  }

  // ── tone map: density → monochrome exposure ──
  i = 0
  while (i < n) {
    let q = (L[i] * 256.0) | 0
    if (q > 1023) q = 1023
    px[i] = glut[q]
    i++
  }
}

// Waves — the 2D wave equation u_tt = c²∇²u on a height field, shaded by where
// light lands after bending through the surface: each texel's ray lands shifted
// by the local gradient (x' = x − F·∇u), landings accumulate into a density map,
// and density maps to monochrome exposure. Still water is neutral gray; wave
// fronts read as bright seams against darker troughs — genuine density changes,
// nothing outlined. After KZ_LAB_E's caustics simulation
// (x.com/KZ_LAB_E/status/1979210373921411098).
//
// drop(x,y) presses a dip and lets the physics make the ring — then the crater
// REBOUNDS: a smaller opposite pulse ~⅓ s later and a fainter dip after that,
// the damped oscillation of a real drop, so each splash rings outward as a
// TRAIN of waves. Dragging carves a moving dimple that leaves a viscous WAKE —
// briefly lossy water, so the groove collapses without the elastic rebound
// ridge that would draw a bright line along the stroke's spine.
//
// The light pass casts FOUR rays per texel from quarter-offset origins, with
// gradients bilinearly interpolated from the gradient field: the sampling
// lattice that a single centre ray imprints wherever the map stretches simply
// never forms, with no jitter noise — and a flat sheet stays exactly flat by
// symmetry. One 3-tap blur absorbs the residual grain; the tone LUT anchors
// density 1 at neutral #9e9e9e with a v^2.5 contrast around it.
//
// frame(t, sx, sy, stick, foc): stick > 0 presses the moving dimple at (sx,sy);
// foc is the pool depth — how far a ray shears per unit slope.
// clear() stills the sheet. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let L                  // light-density map, rebuilt every frame
let Ls                 // blur scratch
let gxF, gyF           // gradient field of the surface, rebuilt every frame
let sponge             // per-cell sponge multiplier (1 inside, dips at the walls)
let wk                 // per-cell WAKE damping — the stick's trail is briefly lossy water
let glut               // Int32Array(1024) — density → exposure
let sp = new Float64Array(3)   // stick trail: previous (x, y) + active flag — fractional
                               // module scalars live in a Float64Array (i32-narrowing)

const C2 = 0.45        // wave speed² — deliberately NEAR the stencil's stability limit
                       // (≤0.75): leapfrog dispersion vanishes toward the limit and blooms
                       // far below it (the "high-frequency side-waves" of low C2)
const SUB = 1          // one leapfrog substep per frame
const DAMP = 0.999     // rings LAST — the pool holds several generations of waves at once,
                       // and interference webbing needs them all alive together
const VISC = 0.05      // ∇² smoothing per frame — thick water: fine chop dies in a beat,
                       // the broad swell rolls on, bands render smooth and heavy
const MARGIN = 26      // edge-sponge width (cells) — wide and gentle: an abrupt sponge
                       // reflects, and reflections pile up as corner surges
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

// the drop's rebound train: 8 slots × (x, y, countdown, stage)
const NQ = 8
let dq = new Float64Array(NQ * 4)
const REBOUND = 21     // frames between the pulses of one splash (~⅓ s)

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  L = new Float64Array(w * h); Ls = new Float64Array(w * h)
  gxF = new Float64Array(w * h); gyF = new Float64Array(w * h)
  sponge = new Float32Array(w * h)
  wk = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  sp[2] = 0.0
  let i = 0
  while (i < NQ * 4) { dq[i] = 0.0; i++ }
  i = 0
  while (i < w * h) { wk[i] = 1.0; i++ }
  // sponge: full strength inside, an extra ~5% loss at the very wall, ramped QUADRATICALLY —
  // zero slope where the sponge begins, so waves enter it without seeing a boundary (a
  // linear ramp's kink partially reflects, and that read as a padded inner wall)
  let y = 0
  while (y < h) {
    let x = 0
    while (x < w) {
      let ed = x
      if (y < ed) ed = y
      let rxe = w - 1 - x; if (rxe < ed) ed = rxe
      let rye = h - 1 - y; if (rye < ed) ed = rye
      let s = 1.0
      if (ed < MARGIN) {
        let f = (MARGIN - ed) / MARGIN
        s = 1.0 - 0.0486 * f * f
      }
      sponge[y * w + x] = s
      x++
    }
    y++
  }
  // Neutral exposure: one undisturbed ray per pixel is #9e9e9e. The v^2.5 contrast pulls
  // mids dark and lets folds blaze, anchored so still water never shifts tone.
  glut = new Int32Array(1024)
  i = 0
  while (i < 1024) {
    let v = i * 0.00390625                 // bucket ↔ density v = i/256, range 0..4
    let vp = v * v                         // v² — strong but GRADED: overlapping rings
    let lum = 255.0 * (1.0 - Math.exp(-0.967 * vp))   // modulate instead of crushing to flat
                                           // black (v³ made bands binary and killed the
                                           // interference); density 1 stays #9e9e9e
    let c = lum | 0
    glut[i] = (255 << 24) | (c << 16) | (c << 8) | c
    i++
  }
  return px
}

export let clear = () => {
  let n = W * H, i = 0
  while (i < n) { a[i] = 0.0; b[i] = 0.0; wk[i] = 1.0; i++ }
  sp[2] = 0.0
  i = 0
  while (i < NQ * 4) { dq[i] = 0.0; i++ }
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

// the click: press a dip and let the WATER make the ring — then schedule the crater's
// rebound (a smaller upward pulse) and its second collapse, the damped oscillation a real
// drop makes. Each pulse launches its own ring: a reverberating train, like actual water.
export let drop = (cx, cy) => {
  plop(cx, cy, 7.0, -2.0)
  let k = 0
  while (k < NQ) {
    let o = k * 4
    if (dq[o + 3] < 0.5) {                 // a free slot
      dq[o] = cx; dq[o + 1] = cy
      dq[o + 2] = REBOUND
      dq[o + 3] = 1.0                      // stage 1: awaiting the rebound peak
      k = NQ
    }
    k++
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
      b[c] = (2.0 * ac - b[c] + C2 * lap) * (DAMP * sponge[c] * wk[c])
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp              // swap → a is current
}

// foc: how far a ray shears per unit slope — the pool depth. Shallow (≈80) barely
// bends the light; deep (≈300) turns every ripple into hard bright seams.
export let frame = (t, sx, sy, stick, foc) => {
  let w = W, h = H, n = w * h

  // the rebound train: fire scheduled pulses of every live splash
  let k = 0
  while (k < NQ) {
    let o = k * 4
    if (dq[o + 3] > 0.5) {
      dq[o + 2] = dq[o + 2] - 1.0
      if (dq[o + 2] <= 0.0) {
        if (dq[o + 3] < 1.5) {             // stage 1 → the crater rebounds upward
          plop(dq[o], dq[o + 1], 5.5, 1.2)
          dq[o + 2] = REBOUND
          dq[o + 3] = 2.0
        } else {                           // stage 2 → a fainter second collapse, then done
          plop(dq[o], dq[o + 1], 5.0, -0.65)
          dq[o + 3] = 0.0
        }
      }
    }
    k++
  }

  // the wake heals: stirred water settles back to normal loss over a few seconds
  let iw = 0
  while (iw < n) { let v = wk[iw]; if (v < 1.0) wk[iw] = v + (1.0 - v) * 0.018; iw++ }

  let s = 0
  while (s < SUB) { step(); s++ }

  // the stick: a dimple CARVED along the drag as a capsule — the sweep covers the whole
  // segment from last frame's position to this one, every touched cell pressed toward the
  // full dimple depth by a fast soft blend (~96% in 4 frames): depth is uniform at any
  // stroke speed, and no hard min splices curvature kinks into the surface. Pressing BOTH
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
          let tgt = -1.8 * stick * E
          if (a[c] > tgt) a[c] = a[c] + (tgt - a[c]) * 0.55
          if (b[c] > tgt) b[c] = b[c] + (tgt - b[c]) * 0.55
          // the stick's WAKE: stirred water is briefly lossy, so the released groove
          // collapses critically damped — no elastic rebound ridge along the stroke's
          // spine (that rebound crest was focusing a white centerline into the black).
          // The groove mode's period is ~30 frames, so critical damping needs ~0.8 here.
          let wt = 1.0 - 0.20 * E
          if (wk[c] > wt) wk[c] = wt
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

  // viscosity — the water's thickness: smooth BOTH leapfrog sheets a little every frame, a
  // frequency-selective loss (∝ k²) that snuffs fine chop while the broad swell rolls on
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

  // ── shade: FOUR rays per texel, from quarter-offset origins with gradients bilinearly
  // interpolated from the gradient field. A single centre ray imprints the sampling
  // lattice wherever the map stretches (a checkered tiling around every wave); jittering
  // it trades the lattice for visible noise. Supersampling does neither: the lattice
  // never forms, and a flat sheet stays EXACTLY flat by symmetry. ──
  let i = 0
  while (i < n) { L[i] = 0.0; gxF[i] = 0.0; gyF[i] = 0.0; i++ }
  let y = 1
  while (y < h - 1) {
    let row = y * w, x = 1
    while (x < w - 1) {
      let c = row + x
      gxF[c] = (a[c + 1] - a[c - 1]) * 0.5
      gyF[c] = (a[c + w] - a[c - w]) * 0.5
      x++
    }
    y++
  }
  y = 1
  while (y < h - 1) {
    let row = y * w, x = 1
    while (x < w - 1) {
      let c = row + x
      // the four sub-rays at (x±¼, y±¼); gradient bilinearly mixed toward each corner
      let sub = 0
      while (sub < 4) {
        let ox = sub === 0 || sub === 2 ? -0.25 : 0.25
        let oy = sub < 2 ? -0.25 : 0.25
        let cnx = ox < 0.0 ? c - 1 : c + 1
        let cny = oy < 0.0 ? c - w : c + w
        let cnd = oy < 0.0 ? cnx - w : cnx + w
        // bilinear weights for a ±¼ offset: 0.5625 / 0.1875 / 0.1875 / 0.0625
        let gx = gxF[c] * 0.5625 + gxF[cnx] * 0.1875 + gxF[cny] * 0.1875 + gxF[cnd] * 0.0625
        let gy = gyF[c] * 0.5625 + gyF[cnx] * 0.1875 + gyF[cny] * 0.1875 + gyF[cnd] * 0.0625
        // the ray bends toward the surface normal: the hit shifts DOWNHILL — crests
        // converge light (bright), pressed dimples diverge it (dark)
        let xf = x + ox + foc * gx
        let yf = y + oy + foc * gy
        if (xf >= 0.0 && xf < w - 1.001 && yf >= 0.0 && yf < h - 1.001) {
          let xi = xf | 0, yi = yf | 0
          let fx = xf - xi, fy = yf - yi
          let c2i = yi * w + xi
          L[c2i] = L[c2i] + 0.25 * (1.0 - fx) * (1.0 - fy)
          L[c2i + 1] = L[c2i + 1] + 0.25 * fx * (1.0 - fy)
          L[c2i + w] = L[c2i + w] + 0.25 * (1.0 - fx) * fy
          L[c2i + w + 1] = L[c2i + w + 1] + 0.25 * fx * fy
        }
        sub++
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
  // The interior ray loop cannot feed the outermost texels on a flat sheet, and the blur
  // spreads that deficit inward. Pin the three-pixel frame to neutral exposure instead of
  // showing a synthetic black outline around an otherwise flat field.
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

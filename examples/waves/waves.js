// Wave ripples — a REAL simulation of the 2D wave equation u_tt = c²∇²u, integrated by a
// finite-difference leapfrog in time over two height buffers (current a, previous b):
//   u(t+dt) = 2·u(t) − u(t−dt) + c²·∇²u · dt²,  lightly damped.
// ∇² is an isotropic 9-point Laplacian (so wavefronts stay circular, not squircular). The rings,
// their reflection off the walls, and their interference are all EMERGENT from the physics — the
// only non-physical touch is the render (|height|² glow + a star-flare drawn at constructive peaks).
// resize(w,h) → Uint32Array; drop() seeds an outgoing circular pulse.

let W = 0, H = 0, px
let a, b              // height now / previous
let glow              // Float32 star-seed buffer (brightness^4) for the streak bloom
let C2 = 0.16         // wave speed² (isotropic 9-point stencil is stable to ≈0.75; low → calm, slow rings)
let DAMP = 0.9965     // slow damping → rings persist and travel far (large, faint) before dissolving
let GAIN = 5.5        // render brightness of the |height| field — keeps lone rings thin & unsaturated

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  glow = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// radial pulse profile: ONE dominant crest at the wavefront (the rim) with a fast-decaying ripple
// tail toward the centre — an ADSR-shaped single front, not a train of equal rings.
let prof = (d, r, amp) => {
  if (d < 0.0) return 0.0
  if (d > r) return 0.0
  let behind = (r - d) / r                                  // 0 at the rim/front .. 1 at centre
  let attack = d > r * 0.80 ? (r - d) / (r * 0.20) : 1.0    // taper the rim → clean leading edge, no cliff
  let env = Math.exp(-behind * 4.0)                         // strong front, quickly-decaying tail
  return amp * Math.cos(6.5 * behind) * env * attack        // ~1 cycle: a single crest
}

// Seed an OUTGOING circular wave. A zero-velocity bump splits into an outward AND an inward wave
// (the inward one re-focuses at the centre → a phantom SECOND front); instead we set the previous
// frame one step further IN — u(t−dt)=f(d+c·dt) — so the leapfrog launches a single front outward.
export let drop = (cx, cy, r, amp) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let r2 = r * r
  let speed = Math.sqrt(C2)            // wavefront travel per step, in grid cells
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx, d2 = dx * dx + dy * dy
      if (d2 <= r2) {
        let d = Math.sqrt(d2)
        a[row + x] += prof(d, r, amp)
        b[row + x] += prof(d + speed, r, amp)   // one step earlier the crest sat further in → moves OUT
      }
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let w = W, h = H, y = 1
  while (y < h - 1) {
    let rc = y * w, rn = rc - w, rs = rc + w, x = 1
    while (x < w - 1) {
      let c = rc + x
      // ISOTROPIC 9-point Laplacian (ortho 2/3, diagonal 1/6) — the plain 5-point stencil travels
      // faster along the axes than the diagonals, deforming rings into squircles; the diagonal terms
      // restore near-circular wavefronts.
      let lap = 0.66667 * (a[rn + x] + a[rs + x] + a[c - 1] + a[c + 1])
              + 0.16667 * (a[rn + x - 1] + a[rn + x + 1] + a[rs + x - 1] + a[rs + x + 1])
              - 3.33333 * a[c]
      b[c] = (2.0 * a[c] - b[c] + C2 * lap) * DAMP    // next height → into b
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp                          // swap: a is now current

  // render: black field; |height|² makes thin bright rings and lets a constructive crossing (two
  // crests summed → ~4× a single ring here) bloom far brighter. The star SEED = brightness⁴ isolates
  // those crossings — a single ring barely registers — so only crossings spawn bright stars.
  let n = w * h, i = 0
  while (i < n) {
    let v = a[i]
    let m = v < 0.0 ? -v : v
    let g = m * GAIN
    g = g * g
    if (g > 1.0) g = 1.0
    let gi = (g * 255.0) | 0
    px[i] = (255 << 24) | (gi << 16) | (gi << 8) | gi
    // star seed: UNclipped |height|⁶ — a crossing (≈2× a ring's amplitude) seeds 2⁶ ≈ 64× more
    // streak than a lone ring, independent of how bright the display clips the ring to.
    glow[i] = m * m * m * m * m * m
    i++
  }

  // STREAK BLOOM: each seed emits an exponentially-decaying ray; separable (horizontal then vertical,
  // each swept both ways) so it's O(n). Only the crossings seed a strong-enough ray to read as a
  // bright 4-point diffraction star; lone rings stay rings.
  let DEC = 0.90, STR = 230000.0
  let yy = 0
  while (yy < h) {
    let row = yy * w
    let acc = 0.0, x = 0
    while (x < w) { let s = glow[row + x]; acc = acc * DEC; if (s > acc) acc = s; if (acc > 0.000008) addpx(row + x, (acc * STR) | 0); x++ }
    acc = 0.0; x = w - 1
    while (x >= 0) { let s = glow[row + x]; acc = acc * DEC; if (s > acc) acc = s; if (acc > 0.000008) addpx(row + x, (acc * STR) | 0); x-- }
    yy++
  }
  let xx = 0
  while (xx < w) {
    let acc = 0.0, y2 = 0
    while (y2 < h) { let idx = y2 * w + xx; let s = glow[idx]; acc = acc * DEC; if (s > acc) acc = s; if (acc > 0.000008) addpx(idx, (acc * STR) | 0); y2++ }
    acc = 0.0; y2 = h - 1
    while (y2 >= 0) { let idx = y2 * w + xx; let s = glow[idx]; acc = acc * DEC; if (s > acc) acc = s; if (acc > 0.000008) addpx(idx, (acc * STR) | 0); y2-- }
    xx++
  }
}

// additive white into a pixel (clamped) — used by the sparkle flares
let addpx = (idx, add) => {
  let p = px[idx]
  let r = (p & 0xff) + add; if (r > 255) r = 255
  px[idx] = (255 << 24) | (r << 16) | (r << 8) | r
}

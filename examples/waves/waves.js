// Wave ripples — a REAL simulation of the 2D wave equation u_tt = c²∇²u, integrated by a
// finite-difference leapfrog in time over two height buffers (current a, previous b):
//   u(t+dt) = 2·u(t) − u(t−dt) + c²·∇²u · dt²,  lightly damped.
// ∇² is an isotropic 9-point Laplacian (so wavefronts stay circular, not squircular). The rings,
// their reflection off the walls, and their interference are all EMERGENT from the physics — the
// only non-physical touch is the render (|height|² glow + a star-flare drawn at constructive peaks).
// resize(w,h) → Uint32Array; drop() seeds an outgoing circular pulse.

let W = 0, H = 0, px
let a, b              // height now / previous
let gbuf, bloomA      // glow bloom: bright-source map + horizontal-blur scratch
// C2 near 0.5 is the LOW-DISPERSION regime for this stencil: every wavelength travels at the same
// speed, so a ring keeps a constant pace (a low C2 disperses → the front visibly slows as it fades,
// and smears a wake behind it). The display pace is kept calm by throttling the step rate in the host.
let C2 = 0.5
let DAMP = 0.995      // damping → rings fade as they spread (and so appear to slow & stop) yet last long enough to cross
let GAIN = 9.0        // render brightness of the crest field — keeps lone rings thin & unsaturated

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  gbuf = new Float32Array(w * h); bloomA = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// radial pulse profile: a single ALL-POSITIVE crest (no trough) with a STEEP leading edge — a fast
// ADSR attack at the wavefront, then a quick decay behind it. Positivity is what makes crossings add
// (bright) instead of crest-meeting-trough cancelling (black), and gives one clean ring per drop.
let prof = (d, r, amp) => {
  if (d < 0.0) return 0.0
  if (d > r) return 0.0
  let behind = (r - d) / r                                  // 0 at the rim/front .. 1 at centre
  let front = d > r * 0.93 ? (r - d) / (r * 0.07) : 1.0     // steep outer edge → fast attack as the front passes
  let tail = Math.exp(-behind * 8.5)                        // quick decay inward → a THIN positive ring
  return amp * front * tail
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
  let w = W, h = H
  let y = 1
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

  // ABSORBING (Mur 1st-order) boundary: a ring reaching the wall passes THROUGH and leaves, instead
  // of reflecting back and cluttering the pond with a mess of returning ripples. u(edge)^{n+1} =
  // u(in)^n + k·(u(in)^{n+1} − u(edge)^n), k=(c−1)/(c+1) with per-step speed c=√C2.
  let cc = Math.sqrt(C2), kk = (cc - 1.0) / (cc + 1.0)
  let ey = 0
  while (ey < h) {
    let row = ey * w
    b[row] = a[row + 1] + kk * (b[row + 1] - a[row])                                   // left
    b[row + w - 1] = a[row + w - 2] + kk * (b[row + w - 2] - a[row + w - 1])            // right
    ey++
  }
  let ex = 0
  while (ex < w) {
    b[ex] = a[w + ex] + kk * (b[w + ex] - a[ex])                                        // top
    b[(h - 1) * w + ex] = a[(h - 2) * w + ex] + kk * (b[(h - 2) * w + ex] - a[(h - 1) * w + ex])  // bottom
    ex++
  }

  let tmp = a; a = b; b = tmp                          // swap: a is now current

  // render: black field, CREST-ONLY (troughs → black) so each wavefront is ONE clean ring; a crossing
  // of two crests ADDS (2× height → 8× via the cube) → a bright glint, never the cancelling black that
  // |height| produced. The cube also crushes the dim 2D wake (the afterglow a pulse trails in 2D)
  // toward black, so the interior stays clean — just sharp leading rings and glowing intersections.
  let n = w * h, i = 0
  while (i < n) {
    let m = a[i]
    if (m < 0.0) m = 0.0
    let g = m * GAIN
    g = g * g; g = g * g            // ^4 — crushes the faint 2D wake to black, keeps rings + crossings bright
    if (g > 1.0) g = 1.0
    let gi = (g * 255.0) | 0
    px[i] = (255 << 24) | (gi << 16) | (gi << 8) | gi
    // bloom source: only the BRIGHT part (mostly the constructive crossings) seeds the glow
    let s = g - 0.45
    gbuf[i] = s > 0.0 ? s : 0.0
    i++
  }

  // GLOW BLOOM: separable box blur of the bright source, added back, so the intersections (and the
  // source dots) glow with a soft HALO — the "glowing around the intersections" effect, which is just
  // light bloom. Symmetric → no directional burst on a fresh drop; the thin rings sit below the bright
  // threshold so they don't bloom and stay crisp.
  let R = 4, inv = 1.0 / (2.0 * R + 1.0)
  let yy = 0
  while (yy < h) {
    let row = yy * w
    let sum = 0.0, x = 0
    while (x <= R) { sum = sum + gbuf[row + x]; x++ }
    x = 0
    while (x < w) {
      bloomA[row + x] = sum * inv
      let ad = x + R + 1, sb = x - R
      if (ad < w) sum = sum + gbuf[row + ad]
      if (sb >= 0) sum = sum - gbuf[row + sb]
      x++
    }
    yy++
  }
  let xx = 0
  while (xx < w) {
    let sum = 0.0, y2 = 0
    while (y2 <= R) { sum = sum + bloomA[y2 * w + xx]; y2++ }
    y2 = 0
    while (y2 < h) {
      let bl = sum * inv
      let add = (bl * 900.0) | 0
      if (add > 2) addpx(y2 * w + xx, add)
      let ad = y2 + R + 1, sb = y2 - R
      if (ad < h) sum = sum + bloomA[ad * w + xx]
      if (sb >= 0) sum = sum - bloomA[sb * w + xx]
      y2++
    }
    xx++
  }
}

// additive white into a pixel (clamped) — used by the glow bloom
let addpx = (idx, add) => {
  let p = px[idx]
  let r = (p & 0xff) + add; if (r > 255) r = 255
  px[idx] = (255 << 24) | (r << 16) | (r << 8) | r
}

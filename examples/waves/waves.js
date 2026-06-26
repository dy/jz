// Wave ripples — the 2D wave equation u_tt = c²∇²u on a grid, le-frog in time over two
// height buffers (current, previous): next = 2·cur − prev + c²·laplacian, lightly damped.
// Click drops a pulse; circular ripples spread, ring for a while, reflect off the edges and
// interfere as they cross, then settle. A pure 5-point stencil sweep — memory-bound, the
// kind of loop jz vectorizes well. resize(w,h) → Uint32Array; drop() to disturb the surface.

let W = 0, H = 0, px
let a, b              // height now / previous
let C2 = 0.42         // wave speed² (isotropic 9-point stencil is stable up to ≈0.75)
let DAMP = 0.99       // damping → a ring fades QUICKLY as it spreads (no energy build-up / standing "mountains")

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// drop with an ADSR-shaped radial profile: ONE dominant crest at the wavefront (attack), then a
// quickly-decaying ripple tail toward the centre (decay→sustain→release). The phase is measured
// from the rim, so the outermost — first to propagate out — is the strong leading oscillation, with
// the rest tapering off behind it (not a train of equal rings, which read as several wavefronts).
// r = packet radius, amp = strength.
export let drop = (cx, cy, r, amp) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx, d2 = dx * dx + dy * dy
      if (d2 <= r2) {
        let d = Math.sqrt(d2)
        let behind = (r - d) / r                                  // 0 at the rim/front .. 1 at centre
        let attack = d > r * 0.82 ? (r - d) / (r * 0.18) : 1.0    // taper the rim → clean front, no cliff
        let env = Math.exp(-behind * 2.8)                         // strong front, fast-decaying tail
        let val = amp * Math.cos(8.5 * behind) * env * attack     // ~1.3 cycles: one crest, then a decaying ripple
        a[row + x] += val; b[row + x] += val
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
      // ISOTROPIC 9-point Laplacian (ortho 2/3, diagonal 1/6) — the plain 5-point stencil propagates
      // faster along the axes than the diagonals, which deforms expanding rings into squircles; the
      // diagonal terms restore near-circular wavefronts.
      let lap = 0.66667 * (a[rn + x] + a[rs + x] + a[c - 1] + a[c + 1])
              + 0.16667 * (a[rn + x - 1] + a[rn + x + 1] + a[rs + x - 1] + a[rs + x + 1])
              - 3.33333 * a[c]
      b[c] = (2.0 * a[c] - b[c] + C2 * lap) * DAMP    // next height → into b
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp                          // swap: a is now current

  // render: black field; the oscillating surface glows as thin bright rings. brightness = |height|²
  // (squared) sharpens the crests to crisp rings and makes constructive crossings — where two
  // wavefronts sum — bloom far brighter than either ring alone.
  let n = w * h, i = 0
  while (i < n) {
    let v = a[i]
    let m = v < 0.0 ? -v : v
    let g = m * 9.5
    g = g * g
    if (g > 1.0) g = 1.0
    let gi = (g * 255.0) | 0
    px[i] = (255 << 24) | (gi << 16) | (gi << 8) | gi
    i++
  }

  // sparkle pass: at the brightest constructive peaks (ring crossings), splat a small additive
  // star-cross so the intersections read as glints, like overlapping ripples catching the light.
  let yy = 3
  while (yy < h - 3) {
    let xx = 3
    while (xx < w - 3) {
      let c = yy * w + xx
      let vc = a[c], mc = vc < 0.0 ? -vc : vc
      if (mc > 0.18) {                                  // a strong spot — candidate glint
        let ml = a[c - 1] < 0.0 ? -a[c - 1] : a[c - 1]
        let mr = a[c + 1] < 0.0 ? -a[c + 1] : a[c + 1]
        let mu = a[c - w] < 0.0 ? -a[c - w] : a[c - w]
        let md = a[c + w] < 0.0 ? -a[c + w] : a[c + w]
        // STRICT 2D peak: a single ring is flat along its tangent (ties) so it won't fire; only a
        // ring–ring crossing makes a true bump in every direction → the star sits exactly there.
        if (mc > ml & mc > mr & mc > mu & mc > md) {
          let L = 7, j = 1
          while (j <= L) {
            let f = ((L - j) * 235) / L | 0             // additive white, fading along each ray
            addpx(c + j, f); addpx(c - j, f)
            addpx(c + j * w, f); addpx(c - j * w, f)
            j++
          }
        }
      }
      xx++
    }
    yy++
  }
}

// additive white into a pixel (clamped) — used by the sparkle flares
let addpx = (idx, add) => {
  let p = px[idx]
  let r = (p & 0xff) + add; if (r > 255) r = 255
  px[idx] = (255 << 24) | (r << 16) | (r << 8) | r
}

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
let C2 = 0.42         // base wave speed² (low enough that the amplitude-speed has range to slow down)
let KAMP = 1.5        // amplitude-dependent speed (shallow-water c²∝height): tall fresh crest is FAST,
                      // and DECELERATES as it loses height over ~1s — the friction-like slow-down
let CAP = 1.4         // hard amplitude clamp — backstop so piled-up splashes can never run away to white
let DAMP = 0.993      // damping strong enough that old wakes clear instead of piling into a low-freq web
let GC = 4.0          // crest brightness — DIM lone rings (so crossings stand out)
let GH = 24.0         // height² boost — a 2-crest overlap ≈4×, a 3-crest overlap ≈9× → multi-wave glare

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  gbuf = new Float32Array(w * h); bloomA = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// drop profile: a compact bump peaked at the CENTRE (d=0), falling off to the drop radius. The drop
// therefore starts as a point and the ring grows OUTWARD from radius 0 (rather than appearing as a
// ready-made ring of radius r). It is a thin RING pulse peaked at the rim with almost nothing at the
// centre — so there's no central energy to converge and refocus into a bright blob.
let prof = (d, r, amp) => {
  if (d > r) return 0.0
  let behind = (r - d) / r                                 // 0 at the rim/front .. 1 at the centre
  let front = d > r * 0.86 ? (r - d) / (r * 0.14) : 1.0    // taper the rim → clean leading edge
  let tail = Math.exp(-behind * 7.0)                       // steep decay → a THIN ring, ~0 at the centre
  return amp * front * tail
}

// Seed a central bump that radiates purely OUTWARD (single clean front growing from radius 0). The
// previous frame is the bump one step further IN — u(t−dt)=f(d+c·dt) — which encodes outgoing velocity,
// so the centre doesn't rebound and re-radiate a phantom precursor ahead of the main crest.
export let drop = (cx, cy, r, amp) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let r2 = r * r
  let speed = Math.sqrt(C2)
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx, d2 = dx * dx + dy * dy
      if (d2 <= r2) {
        let d = Math.sqrt(d2)
        a[row + x] += prof(d, r, amp)
        b[row + x] += prof(d + speed, r, amp)   // one step earlier the bump sat further in → moves OUT
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
      // amplitude-dependent speed → the friction-like slow-down: a tall fresh crest travels fast and
      // DECELERATES as it flattens over ~1s. (Cost: the dispersion spreads the pulse into a short train
      // of rings — the price of a visible slow-down.) Clamped under stability; CAP saturates the loop.
      let ac = a[c] < 0.0 ? -a[c] : a[c]
      let c2l = C2 + C2 * KAMP * ac
      if (c2l > 0.66) c2l = 0.66
      let nb = (2.0 * a[c] - b[c] + c2l * lap) * DAMP
      if (nb > CAP) nb = CAP
      else if (nb < -CAP) nb = -CAP
      b[c] = nb
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

  // render: wave ENERGY (kinetic u_t² + potential c²|∇u|²) — always ≥ 0, so interference only ever
  // ADDS. Two ring fronts cross at an angle, so their gradients combine in quadrature and the energy
  // SUMS (brightens) at the crossing — no dark destructive gaps a height render leaves. The energy
  // concentrates in the thin wavefront → one crisp ring per drop; the faint 2D wake stays near zero.
  let bx0 = 0
  while (bx0 < w) { px[bx0] = 255 << 24; px[(h - 1) * w + bx0] = 255 << 24; gbuf[bx0] = 0.0; gbuf[(h - 1) * w + bx0] = 0.0; bx0++ }
  let by0 = 0
  while (by0 < h) { px[by0 * w] = 255 << 24; px[by0 * w + w - 1] = 255 << 24; gbuf[by0 * w] = 0.0; gbuf[by0 * w + w - 1] = 0.0; by0++ }
  let ry = 1
  while (ry < h - 1) {
    let row = ry * w, rx = 1
    while (rx < w - 1) {
      let c = row + rx
      // render the CREST itself (the wave height) — so the brightest point is the PEAK, with nothing
      // ahead of it (the energy render lit the slopes, which put a false pre-wave in front of the
      // crest). crest·GC is the ring; it fades ∝ amplitude (gently, like a real ripple).
      let crest = a[c] > 0.0 ? a[c] : 0.0
      // height² term: where two crests physically ride over each other (a constructive overlap — a
      // REGION around the intersection, not just a point) the height ≈ doubles, so this lands ≈4×
      // brighter → the intersections and their proximity light up.
      let g = crest * GC + crest * crest * GH
      if (g > 1.0) g = 1.0
      let gi = (g * 255.0) | 0
      px[c] = (255 << 24) | (gi << 16) | (gi << 8) | gi
      let s = g - 0.45                              // bloom source: the bright overlaps glow into their surroundings
      gbuf[c] = s > 0.0 ? s : 0.0
      rx++
    }
    ry++
  }

  // GLOW BLOOM: separable box blur of the bright source, added back, so the intersections (and the
  // source dots) glow with a soft HALO — the "glowing around the intersections" effect, which is just
  // light bloom. Symmetric → no directional burst on a fresh drop; the thin rings sit below the bright
  // threshold so they don't bloom and stay crisp.
  let R = 6, inv = 1.0 / (2.0 * R + 1.0)
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
      let add = (bl * 1050.0) | 0
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

// Ripple waves — the 2D wave equation u_tt = c²∇²u, but NONLINEAR: the local wave speed grows with
// amplitude, c²(u) = C0·(1 + K·u²) (clamped for stability). So a fresh, strong wavefront travels FAST and,
// as it damps, genuinely SLOWS DOWN — real wave physics that also decelerates (a linear wave can't). The
// drop is a ring pulse; the equation propagates it, trails a natural wake, and fades out over ~10s. A
// 9-point isotropic Laplacian keeps ripples round; an absorbing edge sponge stops wall reflections.
//
// Render: Reinhard tone-map of the crest (rings read at a consistent brightness across age, dim grey,
// with their smooth profile preserved). Where DIFFERENT circles SUM, crest² clears a gate and is added as
// a white-hot glint core plus a two-scale bloom (tight star + wide round halo) → the intersections GLARE.
//
// A genuine memory-bound jz kernel (a stencil sweep + separable blurs). resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // height now / previous
let base, blm, btmp, btmp2   // display field / bloom excess / blur scratch (×2 for a round double-blur)
let glow               // accumulated intersection glow (builds up over frames, decays slowly → bright+persistent)
let dampField          // per-cell damping = global damp × edge sponge

const C0 = 0.05        // base wave speed² (the SLOW speed a faded ripple settles to)
const KAMP = 8.0       // amplitude → speed coupling: a strong front goes faster, then slows as it damps
const CAP = 0.55       // clamp on the local c² (keeps the 9-point stencil stable)
const DAMP = 0.995     // global damping ⇒ the ripple fades out & disappears by ~10s
const SPEED = 0.2236   // √C0 — the outgoing-bias offset for a drop
const MARGIN = 16      // edge-sponge width (cells): absorbs the wave so it doesn't reflect off the walls
const MARGINDAMP = 0.82
const DROPR = 10.0, DROPW = 3.5   // ring-pulse initial radius + half-width
const DROPAMP = 1.0
const GAIN = 2.6       // render scale — crest² gives a crisp bright front on black (wake crushed dark)
const BTHRESH = 0.45   // glare gate on crest² (above a single front) → only cross-circle overlaps glare
const GLOWDECAY = 0.82 // intersection glow accumulates frame-to-frame and decays at this rate → it builds
                       // up to white-hot while the circles keep crossing, then fades when they part
const CROSSADD = 0.5   // accumulated glow added straight into the display → a white-hot glint core
const BRAD = 6         // tight bloom radius → the glint/star
const BRAD2 = 30       // wide bloom radius → the soft round glow halo
const BLOOMADD = 12.0
const BLOOMADD2 = 24.0
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  base = new Float32Array(w * h); blm = new Float32Array(w * h)
  btmp = new Float32Array(w * h); btmp2 = new Float32Array(w * h)
  glow = new Float32Array(w * h)
  dampField = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  // per-cell damping: global DAMP, ramped down to MARGINDAMP within MARGIN cells of any edge (sponge)
  let y = 0
  while (y < h) {
    let x = 0
    while (x < w) {
      let ed = x
      if (y < ed) ed = y
      let rx = w - 1 - x; if (rx < ed) ed = rx
      let ry = h - 1 - y; if (ry < ed) ed = ry
      let s = DAMP
      if (ed < MARGIN) s = MARGINDAMP + (DAMP - MARGINDAMP) * (ed / MARGIN)
      dampField[y * w + x] = s
      x++
    }
    y++
  }
  return px
}

export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; glow[i] = 0.0; i++ } }

// ring-pulse drop at (cx,cy): a thin annulus at DROPR, outgoing-biased (b is the same ring one step
// further IN) so the wave moves outward.
export let drop = (cx, cy) => {
  let rO = DROPR + DROPW + 2.0
  let x0 = (cx - rO) | 0, x1 = (cx + rO) | 0, y0 = (cy - rO) | 0, y1 = (cy + rO) | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let inv = 1.0 / DROPW
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx, d = Math.sqrt(dx * dx + dy * dy)
      let e = (d - DROPR) * inv
      if (e > -1.0 && e < 1.0) a[row + x] = a[row + x] + DROPAMP * (1.0 - e * e)
      let e2 = (d - (DROPR - SPEED)) * inv
      if (e2 > -1.0 && e2 < 1.0) b[row + x] = b[row + x] + DROPAMP * (1.0 - e2 * e2)
      x++
    }
    y++
  }
}

// Blur the bloom excess (blm) by radius R, run TWICE (≈ Gaussian → round halo), add weight×it to base.
// Four separable passes: blm →1H→ btmp →1V→ btmp2 →2H→ btmp →2V→ base. (buffers referenced directly.)
let blurAdd = (R, weight) => {
  let w = W, h = H, inv = 1.0 / (2.0 * R + 1.0)
  let y = 0
  while (y < h) {                         // 1H: blm → btmp
    let row = y * w, s = 0.0, x = 0
    while (x <= R) { s = s + blm[row + x]; x++ }
    x = 0
    while (x < w) {
      btmp[row + x] = s * inv
      if (x + R + 1 < w) s = s + blm[row + x + R + 1]
      if (x - R >= 0) s = s - blm[row + x - R]
      x++
    }
    y++
  }
  let x2 = 0
  while (x2 < w) {                        // 1V: btmp → btmp2
    let s = 0.0, yy = 0
    while (yy <= R) { s = s + btmp[yy * w + x2]; yy++ }
    yy = 0
    while (yy < h) {
      btmp2[yy * w + x2] = s * inv
      if (yy + R + 1 < h) s = s + btmp[(yy + R + 1) * w + x2]
      if (yy - R >= 0) s = s - btmp[(yy - R) * w + x2]
      yy++
    }
    x2++
  }
  y = 0
  while (y < h) {                         // 2H: btmp2 → btmp
    let row = y * w, s = 0.0, x = 0
    while (x <= R) { s = s + btmp2[row + x]; x++ }
    x = 0
    while (x < w) {
      btmp[row + x] = s * inv
      if (x + R + 1 < w) s = s + btmp2[row + x + R + 1]
      if (x - R >= 0) s = s - btmp2[row + x - R]
      x++
    }
    y++
  }
  x2 = 0
  while (x2 < w) {                        // 2V: btmp → accumulate into base
    let s = 0.0, yy = 0
    while (yy <= R) { s = s + btmp[yy * w + x2]; yy++ }
    yy = 0
    while (yy < h) {
      base[yy * w + x2] = base[yy * w + x2] + weight * (s * inv)
      if (yy + R + 1 < h) s = s + btmp[(yy + R + 1) * w + x2]
      if (yy - R >= 0) s = s - btmp[(yy - R) * w + x2]
      yy++
    }
    x2++
  }
}

export let frame = (t) => {
  let w = W, h = H, n = w * h
  // one leapfrog step with AMPLITUDE-DEPENDENT speed: strong crests move faster, slowing as they damp
  let y = 1
  while (y < h - 1) {
    let rc = y * w, rn = rc - w, rs = rc + w, x = 1
    while (x < w - 1) {
      let c = rc + x, ac = a[c]
      let lap = O * (a[c - 1] + a[c + 1] + a[rn + x] + a[rs + x])
        + D * (a[rn + x - 1] + a[rn + x + 1] + a[rs + x - 1] + a[rs + x + 1]) + CEN * ac
      let c2l = C0 * (1.0 + KAMP * ac * ac); if (c2l > CAP) c2l = CAP
      b[c] = (2.0 * ac - b[c] + c2l * lap) * dampField[c]
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp              // swap → a is current

  // Reinhard-toned rings (consistent + rich) + a white-hot glint and bloom where circles SUM
  let i = 0
  while (i < n) {
    let cst = a[i]; if (cst < 0.0) cst = 0.0
    let v = cst * GAIN
    let e = cst * cst - BTHRESH                          // a lone front stays under; overlaps clear it
    let ex = e > 0.0 ? e : 0.0
    let g = glow[i] * GLOWDECAY + ex                     // accumulate the overlap → builds bright & persists
    glow[i] = g
    blm[i] = g                                          // → wide bloom halo (below)
    base[i] = v * v + CROSSADD * g                       // crisp crest² front on black + white-hot glint core
    i++
  }
  blurAdd(BRAD, BLOOMADD)                  // tight glint/star
  blurAdd(BRAD2, BLOOMADD2)               // wide round glow halo

  // tone-map → white on black
  i = 0
  while (i < n) {
    let g = base[i]; if (g > 1.0) g = 1.0
    let v = (g * 255.0) | 0
    px[i] = (255 << 24) | (v << 16) | (v << 8) | v
    i++
  }
}

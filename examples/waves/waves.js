// Ripple waves — the 2D wave equation u_tt = c²∇²u, leapfrog in time over two height buffers, with a
// 9-point isotropic Laplacian (so ripples stay round). Real physics: each drop is a RING pulse and the
// equation propagates it outward and trails a soft wake. The speed is slow (small c²) and rings fade
// gently; an absorbing edge sponge stops wall reflections. (A real wavefront travels at a CONSTANT speed,
// so it cannot decelerate — that's physics, not a knob.)
//
// Render is a TWO-STAGE map of the crest so every ring shows at the SAME brightness regardless of age (no
// "some dark, some bright"): stage 1 — any crest above HI sits at a consistent RINGLEVEL grey, while the
// low wake & faded tails fall to black; stage 2 — a crest beyond what a single ring can reach (i.e. where
// DIFFERENT circles overlap) rises ABOVE ringlevel toward white. Then a TWO-SCALE BLOOM fed by crest²
// (tight glint + wide round halo) makes those cross-circle intersections glow. Lone rings never glow.
//
// A genuine memory-bound jz kernel (a stencil sweep + separable blurs). resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // height now / previous
let base, blm, btmp, btmp2   // display field / bloom excess / blur scratch (×2 for a round double-blur)
let dampField          // per-cell damping = global damp × edge sponge

const C2 = 0.08        // wave speed² — small ⇒ SLOW propagation (keep < ~0.7 for 9-point stability)
const DAMP = 0.996     // global damping per step ⇒ rings fade, but linger a while (gentle)
const SPEED = 0.28284  // √C2 — the outgoing-bias offset for a drop
const MARGIN = 16      // edge-sponge width (cells): absorbs the wave so it doesn't reflect off the walls
const MARGINDAMP = 0.82
const DROPR = 18.0, DROPW = 4.0   // ring-pulse initial radius + half-width (large enough that the inward
const DROPAMP = 0.95              // part converges late & damped → no central flash)
// Two-stage display so EVERY ring renders the same brightness regardless of age. Stage 1: crest>HI →
// a consistent RINGLEVEL grey; the low wake & faded tails fall to black; a ring fades only once its
// crest drops through [LO,HI].
const LO = 0.20, HI = 0.44, RINGLEVEL = 0.5
// Stage 2: a crest beyond a single ring's reach (where DIFFERENT circles sum) rises above ringlevel.
const CROSSLO = 1.05, CROSSHI = 1.9
const BTHRESH = 1.2    // bloom gate on crest² → only cross-circle overlaps feed the glow (not lone rings)
const BRAD = 6         // tight bloom radius → the glint at the intersection
const BRAD2 = 26       // wide bloom radius → the soft round glow halo around it
const BLOOMADD = 22.0
const BLOOMADD2 = 40.0
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  base = new Float32Array(w * h); blm = new Float32Array(w * h)
  btmp = new Float32Array(w * h); btmp2 = new Float32Array(w * h)
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

export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// ring-pulse drop at (cx,cy): a thin annulus at DROPR, outgoing-biased (b is the same ring one step
// further IN) so the wave moves outward instead of splitting into an inward half that refocuses.
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

// Blur the bloom excess (blm) by radius R and add weight × blurred into base. A box blur of a bright
// point is a square; running it TWICE (≈ a Gaussian) gives a ROUND, soft halo. Four separable passes:
// blm →1H→ btmp →1V→ btmp2 →2H→ btmp →2V→ base. (No array params — jz wants the buffers referenced direct.)
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
  // one leapfrog step: next height → b, from the 9-point Laplacian of a, times the per-cell damping
  let y = 1
  while (y < h - 1) {
    let rc = y * w, rn = rc - w, rs = rc + w, x = 1
    while (x < w - 1) {
      let c = rc + x
      let lap = O * (a[c - 1] + a[c + 1] + a[rn + x] + a[rs + x])
        + D * (a[rn + x - 1] + a[rn + x + 1] + a[rs + x - 1] + a[rs + x + 1]) + CEN * a[c]
      b[c] = (2.0 * a[c] - b[c] + C2 * lap) * dampField[c]
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp              // swap → a is current

  // two-stage display (consistent rings + brighter overlaps) + crest² bloom source
  let i = 0
  while (i < n) {
    let cst = a[i]; if (cst < 0.0) cst = 0.0
    let tt = (cst - LO) / (HI - LO); if (tt < 0.0) tt = 0.0; else if (tt > 1.0) tt = 1.0
    let uu = (cst - CROSSLO) / (CROSSHI - CROSSLO); if (uu < 0.0) uu = 0.0; else if (uu > 1.0) uu = 1.0
    base[i] = RINGLEVEL * (tt * tt * (3.0 - 2.0 * tt)) + (1.0 - RINGLEVEL) * (uu * uu * (3.0 - 2.0 * uu))
    let hh = cst * cst, e = hh - BTHRESH
    blm[i] = e > 0.0 ? e : 0.0
    i++
  }
  blurAdd(BRAD, BLOOMADD)                  // tight glint
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

// Water-drop waves — the 2D wave equation u_tt = c²∇²u, NONLINEAR: the local speed grows
// with amplitude, c²(u) = C0·(1 + K·u²) (clamped for stability). A fresh strong front
// BURSTS out fast and genuinely slows as it damps — and because it's the real PDE, not
// drawn circles, every front trails an oscillating wake and crossing waves INTERFERE.
// A 9-point isotropic Laplacian keeps rings round; an edge sponge absorbs wall
// reflections; global damping fades a drop out in ~6 s.
//
// Each drop also registers a SHADOW RING integrated by the same speed law — the analytic
// twin of the PDE front. Where two shadow rings cross, the crossing is splatted as a lens
// glare: a hot core plus a gaussian arm along each ring's ARC — red fringed just outside
// the arc, blue just inside (chromatic aberration) — so the wavefronts flare and shimmer
// where they meet. A drop's sloshing heart is render-muted while its ring lives. One
// stencil sweep + local splats — memory-bound jz work. resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px
let a, b               // wave height now / previous (leapfrog pair)
let base               // brightness field, rebuilt every frame
let chr                // chromatic differential of the glints (red +, blue −), same rebuild
let lo, lo2            // box-blur scratch — the field's low-frequency part, dropped at render
let dampField          // per-cell damping = global damp × edge sponge

// CFL caps a single PDE step below ~1 px/step, but a real drop's first wave is FAST. So the
// substep RATE follows the youngest front — fast while the water is excited, easing to a
// glide as it calms — accumulated against REAL elapsed time, so wave speed is identical on
// any display refresh rate. The field is still the true wave equation throughout.
const C0 = 0.06        // base wave speed² — the SLOW glide a faded front settles to
const KAMP = 2.0       // amplitude → speed coupling (mild) — enough to sharpen crests,
                       // NOT enough to sharpen the launch agitation into bright speckle
const CAP = 0.35       // clamp on the local c² (keeps the 9-point stencil CFL-stable)
const DAMP = 0.998     // damping per substep ⇒ a drop rings out and fades over ~6 s
const MARGIN = 16      // edge-sponge width (cells): absorbs the wave, no wall reflections
const MARGINDAMP = 0.93
const AGED = 0.9975    // a drop's excitement decay per substep — drives the pace
const RATE = 60.0      // substeps per second when the water is calm (the glide)
const BURST = 2.8      // extra pace × excitement²: a fresh drop runs ~3.8× (the burst),
                       // easing back down CONTINUOUSLY as it ages — no visible gear shifts
const CSH = 0.21       // the front's measured lattice speed, px per substep — the shadow's pace
const DROPR = 8.0, DROPW = 4.2   // ring-pulse initial radius + half-width — narrow: a thin
                                 // crest whose wake ripples fine and tight, on the front's heels
const DROPAMP = 1.0
const GAIN = 26.0      // front render scale — the crest³ of the BAND-PASSED field
const HPR = 5          // band-pass radius: an 11-px box mean is subtracted before rendering —
                       // wider than the front's own crest, so the front survives SHARP and
                       // bright while the drop's wide slosh is filtered out
const O = 0.66667, D = 0.16667, CEN = -3.33333   // 9-point isotropic Laplacian weights

// shadow rings — analytic twins of the PDE fronts, they only place the glints
const MAXN = 18
let rx = new Float64Array(MAXN), ry = new Float64Array(MAXN), rr = new Float64Array(MAXN)
let ad = new Float64Array(MAXN)   // accumulated damping of the front (drives speed & glare)
let ae = new Float64Array(MAXN)   // per-frame: effective front amplitude (damping × spreading)
let count = 0
let tPrev = -1.0, budget = 0.0   // real-time pacing: clock memory + fractional substeps
const GCUT = 0.028     // front amplitude below which a crossing no longer glints

const MAXG = 40        // crossings rendered per frame (2 points per ring pair)
let gx = new Float64Array(MAXG), gy = new Float64Array(MAXG), gs = new Float64Array(MAXG)
let g1 = new Float64Array(MAXG), g2 = new Float64Array(MAXG)   // the two rings that cross

const GLARE = 6.5      // glare of a fresh crossing (≫1 ⇒ clips white-hot)
const CORE = 1.0       // hot-core weight
const ARM = 0.9        // arc-arm weight
const HALO = 0.11      // soft round glow pooled around the crossing — the lens-bloom feel
const SIGC = 3.2       // core radius (px)
const SIGA = 1.9       // arc-arm gaussian width AT the crossing (px) — a crisp flare…
const SIGB = 0.9       // …tapering to a hairline at the arm's end: the arm becomes the front
const CAB = 0.8        // chromatic aberration at the crossing: red/blue offset off the arc
                       // (px), tapering with the arm so hairline ends stay neutral
const MREF = 9.0       // tangency margin (px) at which a crossing reaches half glare
let GEXT = 0.0         // arm half-length along the arcs (px) — set from the canvas size

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  base = new Float32Array(w * h); chr = new Float32Array(w * h)
  lo = new Float64Array(w * h); lo2 = new Float64Array(w * h)
  dampField = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  GEXT = 0.11 * (w < h ? w : h)
  count = 0
  // per-cell damping: global DAMP, ramped down to MARGINDAMP within MARGIN cells of any edge
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
  return px
}

export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } count = 0; tPrev = -1.0; budget = 0.0 }

// drop: seed the PDE with an outgoing ring pulse + register its shadow ring
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
      if (e > -1.0 && e < 1.0) {
        let amp = DROPAMP * (1.0 - e * e)
        let va = a[row + x] + amp
        if (va > 1.2) va = 1.2            // stacked drops saturate, they don't blow white
        else if (va < -1.2) va = -1.2
        a[row + x] = va
        // outgoing d'Alembert offset, PER POINT: each part of the pulse is set one substep
        // back at its OWN local speed (the crest races, the skirts crawl) — a clean launch,
        // no ingoing rebound flash, no speed-mismatch grid residue
        let c2l = C0 * (1.0 + KAMP * amp * amp); if (c2l > CAP) c2l = CAP
        let e2 = (d - DROPR + Math.sqrt(c2l)) * inv
        let vb = b[row + x] + (e2 > -1.0 && e2 < 1.0 ? DROPAMP * (1.0 - e2 * e2) : 0.0)
        if (vb > 1.2) vb = 1.2
        else if (vb < -1.2) vb = -1.2
        b[row + x] = vb
      }
      x++
    }
    y++
  }
  // shadow ring: replace the faintest when full
  let i = count
  if (count < MAXN) count++
  else {
    let low = 2.0, j = 0
    i = 0
    while (j < MAXN) { if (ad[j] < low) { low = ad[j]; i = j } j++ }
  }
  rx[i] = cx; ry[i] = cy; rr[i] = DROPR; ad[i] = 1.0
}

// one leapfrog substep, amplitude-dependent speed: strong crests race, then stall
let step = () => {
  let w = W, h = H
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
}

export let frame = (t) => {
  let w = W, h = H, n = w * h
  // pace against REAL time: substeps accrue at RATE·(1 + BURST·excitement²) per second —
  // a smooth glide from burst to stall, identical on any display refresh rate. `t` is a
  // clock in seconds; a jump back (reseed) or a stall (hidden tab) falls back to 1/60.
  let dt = t - tPrev
  tPrev = t
  if (dt <= 0.0 || dt > 0.06) dt = 0.016666666666666666
  let maxq = 0.0, i = 0
  while (i < count) { if (ad[i] > maxq) maxq = ad[i]; i++ }
  budget = budget + dt * RATE * (1.0 + BURST * maxq * maxq)
  let sub = budget | 0
  if (sub > 6) sub = 6
  budget = budget - sub
  let s = 0
  while (s < sub) { step(); s++ }
  // ── advance the shadow rings at the front's lattice speed; retire the faded ──
  i = 0
  while (i < count) {
    let q = ad[i]
    let k = 0
    while (k < sub) { q = q * AGED; k++ }
    let r = rr[i] + CSH * sub
    let e = q * Math.sqrt(DROPR / r)       // age × geometric spreading ≈ front amplitude
    if (e < GCUT) {                        // too faint to glint — recycle the slot
      count--
      rx[i] = rx[count]; ry[i] = ry[count]; rr[i] = rr[count]; ad[i] = ad[count]
    } else {
      ad[i] = q; rr[i] = r; ae[i] = e
      i++
    }
  }
  // ── crossings of the shadow rings: intersection points + front tangents ──
  let gn = 0
  i = 0
  while (i < count) {
    let j = i + 1
    while (j < count) {
      if (gn < MAXG) {
        let dx = rx[j] - rx[i], dy = ry[j] - ry[i]
        let D2 = dx * dx + dy * dy
        let ri = rr[i], rj = rr[j]
        let sum = ri + rj, dif = ri - rj
        if (D2 < sum * sum && D2 > dif * dif && D2 > 2.25) {
          let iD = 1.0 / Math.sqrt(D2)
          let aa = 0.5 * (D2 + ri * ri - rj * rj) * iD   // center-i → chord midpoint
          let h2 = ri * ri - aa * aa
          if (h2 > 0.81) {
            let hh = Math.sqrt(h2)
            let ux = dx * iD, uy = dy * iD               // unit i→j
            let mx = rx[i] + aa * ux, my = ry[i] + aa * uy
            // strength fades every way a crossing can end — smoothly: with the fronts
            // (ae → GCUT ramp, hitting 0 BEFORE the ring retires) and with the geometry:
            // the TANGENCY MARGIN m (how far past touching / from nesting) grows linearly
            // in time, so m/(m+MREF) fades the glare IN as circles meet and OUT as one
            // swallows the other — no pop at either end (h² itself jumps like √overlap)
            let Dd = D2 * iD
            let m = sum - Dd
            let m2 = Dd - (dif < 0.0 ? -dif : dif)
            if (m2 < m) m = m2
            let s = GLARE * Math.sqrt((ae[i] - GCUT) * (ae[j] - GCUT)) * (m / (m + MREF))
            let k = 0
            while (k < 2) {
              if (gn < MAXG) {
                let sg = k === 0 ? 1.0 : -1.0
                gx[gn] = mx - sg * hh * uy               // m ± h·perp(u)
                gy[gn] = my + sg * hh * ux
                gs[gn] = s
                g1[gn] = i; g2[gn] = j
                gn++
              }
              k++
            }
          }
        }
      }
      j++
    }
    i++
  }
  // ── band-passed render: subtract a separable box mean (the LOW frequencies — the
  // drop's wide slosh) and render the crest⁴ of what remains: the front comes out as a
  // sharp bright line, trailed by its fine ripples and interference beading ──
  let inv = 1.0 / (2.0 * HPR + 1.0)
  let yb = 0
  while (yb < h) {                         // horizontal pass: a → lo
    let row = yb * w, s2 = 0.0, x = 0
    while (x <= HPR) { s2 = s2 + a[row + x]; x++ }
    x = 0
    while (x < w) {
      lo[row + x] = s2 * inv
      if (x + HPR + 1 < w) s2 = s2 + a[row + x + HPR + 1]
      if (x - HPR >= 0) s2 = s2 - a[row + x - HPR]
      x++
    }
    yb++
  }
  let xb = 0
  while (xb < w) {                         // vertical pass: lo → lo2
    let s2 = 0.0, yy = 0
    while (yy <= HPR) { s2 = s2 + lo[yy * w + xb]; yy++ }
    yy = 0
    while (yy < h) {
      lo2[yy * w + xb] = s2 * inv
      if (yy + HPR + 1 < h) s2 = s2 + lo[(yy + HPR + 1) * w + xb]
      if (yy - HPR >= 0) s2 = s2 - lo[(yy - HPR) * w + xb]
      yy++
    }
    xb++
  }
  i = 0
  while (i < n) {
    let cst = a[i] - lo2[i]; if (cst < 0.0) cst = 0.0
    let v = cst * GAIN
    let g = v * v * v
    base[i] = g * 1.6 / (1.0 + g)
    chr[i] = 0.0
    i++
  }
  // ── glints: a hot gaussian core + an arm along EACH RING'S ARC with PROGRESSIVE blur —
  // widest right at the crossing, tapering to the ring's own hairline at the arm's end,
  // so the glare continues the circle. Red fringes just outside the arc, blue just
  // inside (chromatic aberration), the fringe tapering with the arm ──
  let g = 0
  while (g < gn) {
    let cx = gx[g], cy = gy[g], s = gs[g]
    let x0 = cx - GEXT | 0, x1 = cx + GEXT | 0, y0 = cy - GEXT | 0, y1 = cy + GEXT | 0
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 > w - 1) x1 = w - 1
    if (y1 > h - 1) y1 = h - 1
    let iL2 = 1.0 / (GEXT * GEXT), iC2 = 1.0 / (SIGC * SIGC)
    let i1 = g1[g] | 0, i2 = g2[g] | 0
    let ax = rx[i1], ay = ry[i1], ar = rr[i1]
    let bx = rx[i2], by = ry[i2], br = rr[i2]
    let yy = y0
    while (yy <= y1) {
      let dy = yy - cy, rw2 = yy * w, x = x0
      while (x <= x1) {
        let dx = x - cx
        let q2 = dx * dx + dy * dy
        let el = 1.0 - q2 * iL2                  // 1 at the crossing → 0 at the arm's end
        if (el > 0.0) {
          let env = el * el * el
          let add = CORE * Math.exp(-q2 * iC2)   // soft hot core
            + HALO * env                         // glow pooled around the crossing
          let sig = SIGB + (SIGA - SIGB) * el    // progressive blur: wide → hairline
          let iA2 = 1.0 / (sig * sig)
          let ca = CAB * el                      // the fringe tapers with the arm
          let dr = 0.0
          let ex = x - ax, ey = yy - ay
          let da = Math.sqrt(ex * ex + ey * ey) - ar   // signed distance to ring i's arc
          let em = da - ca, ep = da + ca
          let eaR = Math.exp(-em * em * iA2)     // red: just outside the arc
          let eaB = Math.exp(-ep * ep * iA2)     // blue: just inside
          add += ARM * env * 0.5 * (eaR + eaB)
          dr += eaR - eaB
          ex = x - bx; ey = yy - by
          da = Math.sqrt(ex * ex + ey * ey) - br
          em = da - ca; ep = da + ca
          eaR = Math.exp(-em * em * iA2)
          eaB = Math.exp(-ep * ep * iA2)
          add += ARM * env * 0.5 * (eaR + eaB)
          dr += eaR - eaB
          let c = rw2 + x
          base[c] += s * add
          chr[c] += s * ARM * env * 0.5 * dr
        }
        x++
      }
      yy++
    }
    g++
  }
  // ── tone map: grey water, glints clipping white with a red/blue lens fringe ──
  i = 0
  while (i < n) {
    let vv = base[i], d = chr[i]
    let r = vv + d; if (r > 1.0) r = 1.0; else if (r < 0.0) r = 0.0
    let gg = vv; if (gg > 1.0) gg = 1.0
    let bb = vv - d; if (bb > 1.0) bb = 1.0; else if (bb < 0.0) bb = 0.0
    px[i] = (255 << 24) | (((bb * 255.0) | 0) << 16) | (((gg * 255.0) | 0) << 8) | ((r * 255.0) | 0)
    i++
  }
}

// N-body gravity — a few heavy bodies pulling on each other, each wearing a disk of stars.
// Starts as 3 randomly-placed bodies (the classic chaotic dance); click-hold to drop more.
// The bodies attract pairwise; every star feels every body (Toomre & Toomre's restricted
// n-body, ApJ 178:623, 1972), so each close pass tears the disks into tidal bridges and tails
// and the chaos becomes visible as streams of light. Space is periodic (toroidal): forces use the
// nearest wrapped image and anything that leaves one edge re-enters the opposite one, so the
// system stays bounded and on-screen forever. The oldest stars slowly re-condense into their
// birth disk, so the disks survive the stirring instead of dissolving into a uniform haze.
// Stars splat additively into a fading u8 ink buffer, so motion leaves short streaks.
// resize(w,h) → Uint32Array; frame() steps + draws.

let W = 0, H = 0, px
let AW = 1.0                           // world width: the torus is AW × 1, so disks stay round on screen
let ink                                // Uint8Array — per-pixel trail ink (the orbit smears)
let lut = new Uint32Array(256)         // ink → pixel colour (tone curve × theme)
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; default = dark theme (black space, light orbits)
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

let MAXN = 64                       // heavy bodies
let x = new Float64Array(MAXN)      // world coords in [0,AW)×[0,1), toroidal
let y = new Float64Array(MAXN)
let vx = new Float64Array(MAXN)
let vy = new Float64Array(MAXN)
let m = new Float64Array(MAXN)
let count = 0
let held = -1

// Stars: massless tracers of the bodies' field. Their count scales with the backing height, so a
// retina canvas shows the same streak density as a small one (coverage ∝ stars / height).
let NS = 0
let sx, sy, svx, svy
let sr, sa                          // birth orbit radius (signed by spin) + phase — to re-lay a disk
let own                             // body a star was born around (-1: none yet)
let next = 0                        // ring cursor: a new body recycles the oldest stars
let rec = 0                         // ring cursor: stars re-condensing into their birth disk
let PER = 0                         // stars laid per spawned body
let REC = 0                         // stars re-condensed per frame (full turnover ≈ 11 s)

let G = 0.0000011, EPS = 0.0016, ES = 0.0008, SUB = 4, DT = 0.0625

export let resize = (w, h) => {
  W = w; H = h
  AW = H > 0 ? W / H : 1.0
  ink = new Uint8Array(W * H)
  px = new Uint32Array(W * H)
  NS = H * 32
  if (NS < 6000) NS = 6000
  if (NS > 60000) NS = 60000
  sx = new Float64Array(NS); sy = new Float64Array(NS)
  svx = new Float64Array(NS); svy = new Float64Array(NS)
  sr = new Float64Array(NS); sa = new Float64Array(NS)
  own = new Int32Array(NS)
  let k = 0
  while (k < NS) { own[k] = -1; k++ }
  count = 0; held = -1; next = 0; rec = 0
  PER = (NS / 6) | 0
  REC = (NS / 660) | 0
  return px
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

// Lay star k on a circular orbit of radius r, phase a, around body b (spin ±1), moving with it.
// v² = G m r² / (r² + ES)^1.5 is the softened circular speed, so the disk starts in equilibrium.
let lay = (k, b, r, a, spin) => {
  let c = Math.cos(a), s = Math.sin(a), d2 = r * r + ES
  let v = Math.sqrt(G * m[b] * r * r / (d2 * Math.sqrt(d2))) * spin
  let px0 = x[b] + c * r, py0 = y[b] + s * r
  if (px0 < 0.0) px0 += AW; else if (px0 >= AW) px0 -= AW
  if (py0 < 0.0) py0 += 1.0; else if (py0 >= 1.0) py0 -= 1.0
  sx[k] = px0; sy[k] = py0
  svx[k] = vx[b] - s * v; svy[k] = vy[b] + c * v
}

// Give body b a fresh disk of n stars spinning ±1, denser toward the centre.
let disk = (b, n, spin) => {
  let rmax = 0.07 + Math.sqrt(m[b]) * 0.035
  let i = 0
  while (i < n) {
    let k = next
    next++
    if (next >= NS) next = 0
    let u = Math.random()
    let r = 0.012 + rmax * u * Math.sqrt(u)
    let a = Math.random() * 6.283185307179586
    sr[k] = r * spin; sa[k] = a; own[k] = b
    lay(k, b, r, a, spin)
    i++
  }
}

// Three bodies on a shared, eccentric orbit about the frame centre: enough angular momentum that
// they swing past each other instead of colliding head-on, which is what draws out long tails.
// Disks mostly spin with the orbit (prograde) — the encounters that grow Toomre's bridges.
export let init = () => {
  count = 0; held = -1; next = 0
  let k = 0
  while (k < NS) { own[k] = -1; k++ }
  let sense = Math.random() < 0.5 ? -1.0 : 1.0, a0 = Math.random() * 6.283185307179586
  let mt = 0.0
  let i = 0
  while (i < 3) { m[i] = 2.5 + Math.random() * 2.0; mt += m[i]; i++ }
  i = 0
  while (i < 3) {
    let a = a0 + i * 2.0943951023931953 + (Math.random() - 0.5) * 0.6
    let R = 0.18 + Math.random() * 0.08
    let v = Math.sqrt(G * mt / R) * (0.3 + Math.random() * 0.2) * sense
    x[i] = AW * 0.5 + Math.cos(a) * R
    y[i] = 0.5 + Math.sin(a) * R
    vx[i] = -Math.sin(a) * v
    vy[i] = Math.cos(a) * v
    count = i + 1
    i++
  }
  // centre of mass at the frame centre, at rest — the dance stays in view
  let cx = 0.0, cy = 0.0, px0 = 0.0, py0 = 0.0
  i = 0
  while (i < 3) { cx += m[i] * x[i]; cy += m[i] * y[i]; px0 += m[i] * vx[i]; py0 += m[i] * vy[i]; i++ }
  i = 0
  while (i < 3) {
    x[i] += AW * 0.5 - cx / mt; y[i] += 0.5 - cy / mt
    vx[i] -= px0 / mt; vy[i] -= py0 / mt
    i++
  }
  i = 0
  while (i < 3) { disk(i, (NS / 3) | 0, Math.random() < 0.8 ? sense : -sense); i++ }
  let n = W * H
  i = 0
  while (i < n) { ink[i] = 0; i++ }
}

export let spawn = (px0, py0) => {
  if (count >= MAXN) { held = count - 1 } else { held = count; count++ }
  x[held] = px0 * AW; y[held] = py0; vx[held] = 0.0; vy[held] = 0.0; m[held] = 1.5
  disk(held, PER, Math.random() < 0.5 ? -1.0 : 1.0)
}
// while held, the body follows the pointer and gains mass; its disk is re-laid each call
// at the current mass, so on release the stars orbit in equilibrium around the grown body
export let grow = (px0, py0) => {
  if (held < 0) return 0.0
  x[held] = px0 * AW; y[held] = py0; vx[held] = 0.0; vy[held] = 0.0
  let mm = m[held] + 0.6
  if (mm > 40.0) mm = 40.0
  m[held] = mm
  let k = 0
  while (k < NS) {
    if (own[k] === held) { let r = sr[k]; lay(k, held, r < 0.0 ? -r : r, sa[k], r < 0.0 ? -1.0 : 1.0) }
    k++
  }
  return 0.0
}
export let release = () => { held = -1 }

let step = () => {
  let i = 0
  while (i < count) {
    if (i !== held) {
      let xi = x[i], yi = y[i], ax = 0.0, ay = 0.0
      let j = 0
      while (j < count) {
        if (j !== i) {
          let dx = x[j] - xi, dy = y[j] - yi
          if (dx > AW * 0.5) dx -= AW; else if (dx < -AW * 0.5) dx += AW   // nearest wrapped image
          if (dy > 0.5) dy -= 1.0; else if (dy < -0.5) dy += 1.0
          let d2 = dx * dx + dy * dy + EPS
          let f = G * m[j] / (d2 * Math.sqrt(d2))
          ax += f * dx; ay += f * dy
        }
        j++
      }
      vx[i] += ax * DT; vy[i] += ay * DT
    }
    i++
  }
  i = 0
  while (i < count) {
    if (i !== held) {
      x[i] += vx[i] * DT; y[i] += vy[i] * DT
      if (x[i] < 0.0) x[i] += AW; else if (x[i] >= AW) x[i] -= AW   // wrap
      if (y[i] < 0.0) y[i] += 1.0; else if (y[i] >= 1.0) y[i] -= 1.0
    }
    i++
  }
  // stars: kick by every body, then drift (symplectic Euler)
  let hw = AW * 0.5
  let k = 0
  while (k < NS) {
    if (own[k] >= 0) {
      let xk = sx[k], yk = sy[k], ax = 0.0, ay = 0.0
      let j = 0
      while (j < count) {
        let dx = x[j] - xk, dy = y[j] - yk
        if (dx > hw) dx -= AW; else if (dx < -hw) dx += AW
        if (dy > 0.5) dy -= 1.0; else if (dy < -0.5) dy += 1.0
        let d2 = dx * dx + dy * dy + ES
        let f = G * m[j] / (d2 * Math.sqrt(d2))
        ax += f * dx; ay += f * dy
        j++
      }
      let nvx = svx[k] + ax * DT, nvy = svy[k] + ay * DT
      svx[k] = nvx; svy[k] = nvy
      xk += nvx * DT; yk += nvy * DT
      if (xk < 0.0) xk += AW; else if (xk >= AW) xk -= AW
      if (yk < 0.0) yk += 1.0; else if (yk >= 1.0) yk -= 1.0
      sx[k] = xk; sy[k] = yk
    }
    k++
  }
}

// additive, saturating splat of weight a at pixel (ix, iy)
let add = (ix, iy, a) => {
  if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
    let p = iy * W + ix, v = ink[p] + a
    ink[p] = v > 255 ? 255 : v
  }
}

// a body's bulge: a soft glow falling off as (1 − d/r)², brightest at the core
let glow = (fx, fy, rad) => {
  let cxi = fx | 0, cyi = fy | 0, ri = (rad | 0) + 1
  let oy = -ri
  while (oy <= ri) {
    let ox = -ri
    while (ox <= ri) {
      let d = Math.sqrt(ox * ox + oy * oy) / rad
      if (d < 1.0) { let e = 1.0 - d; add(cxi + ox, cyi + oy, (e * e * 120.0) | 0) }
      ox++
    }
    oy++
  }
}

export let frame = (t) => {
  let s = 0
  while (s < SUB) { step(); s++ }

  // re-condense the oldest stars into their birth disk (a body lost to a merger keeps none)
  let r = 0
  while (r < REC) {
    let k = rec
    rec++
    if (rec >= NS) rec = 0
    let b = own[k]
    if (b >= 0 && b !== held) {
      let u = Math.random(), rr = sr[k]
      let rad = (0.012 + (0.07 + Math.sqrt(m[b]) * 0.035) * u * Math.sqrt(u)) * (rr < 0.0 ? -1.0 : 1.0)
      sr[k] = rad; sa[k] = Math.random() * 6.283185307179586
      lay(k, b, rad < 0.0 ? -rad : rad, sa[k], rad < 0.0 ? -1.0 : 1.0)
    }
    r++
  }

  // fade the ink for smooth trails
  let n = W * H, i = 0
  while (i < n) { ink[i] = (ink[i] * 234) >> 8; i++ }

  // stars: bilinear splat so a moving star draws an anti-aliased streak, not a stair of pixels
  let k = 0
  while (k < NS) {
    if (own[k] >= 0) {
      let fx = sx[k] * H - 0.5, fy = sy[k] * H - 0.5
      let ix = Math.floor(fx), iy = Math.floor(fy)
      let ux = fx - ix, uy = fy - iy
      add(ix, iy, ((1.0 - ux) * (1.0 - uy) * 30.0) | 0)
      add(ix + 1, iy, (ux * (1.0 - uy) * 30.0) | 0)
      add(ix, iy + 1, ((1.0 - ux) * uy * 30.0) | 0)
      add(ix + 1, iy + 1, (ux * uy * 30.0) | 0)
    }
    k++
  }

  let rscale = H * 0.012
  i = 0
  while (i < count) { glow(x[i] * H, y[i] * H, Math.sqrt(m[i]) * rscale); i++ }

  // composite through a 256-entry tone curve: v^0.6 lifts the faint streaks of the tails while the
  // dense disks still saturate; lerp(paper, ink) keeps the orbits in the page ink over the paper.
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  i = 0
  while (i < 256) {
    let v = Math.pow(i / 255.0, 0.6)
    let cr = (pr + (ir - pr) * v) | 0
    let cg = (pg + (ig - pg) * v) | 0
    let cb = (pb + (ib - pb) * v) | 0
    lut[i] = (255 << 24) | (cb << 16) | (cg << 8) | cr
    i++
  }
  i = 0
  while (i < n) { px[i] = lut[ink[i]]; i++ }
}

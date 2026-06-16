// Apollonian gasket — recursive circle packing via Descartes' Circle Theorem. Start with
// three mutually tangent circles inside an enclosing circle, then fill every gap with the
// unique Soddy circle tangent to all three neighbors. Repeat until circles are sub-pixel.
//
// Descartes: (k1+k2+k3+k4)² = 2(k1²+k2²+k3²+k4²) where k = 1/r (curvature, negative for
// the enclosing circle). The center follows: k4·z4 = k1·z1+k2·z2+k3·z3 ± 2√(sum of products).
// Complex arithmetic stays in Float64Arrays — no module-level fractional globals that jz would
// narrow to i32. Everything persistent lives in typed arrays; frame() args are f64-safe.
// resize(w,h) → Uint32Array; frame(t, panX, panY, zoom) renders.

let W = 0, H = 0, px

// circle store: up to 6000 circles (cx, cy, cr each as f64)
let MAX = 6000
let cx_ = new Float64Array(MAX)
let cy_ = new Float64Array(MAX)
let cr_ = new Float64Array(MAX)
let dep_ = new Float64Array(MAX)  // depth for coloring
let ncircles = 0

// stack for the recursion: each entry = 9 f64 (k1,cx1,cy1, k2,cx2,cy2, k3,cx3,cy3) + 1 f64 depth
// 8000 entries × 10 f64 = 80000 slots
let SMAX = 80000
let stk = new Float64Array(SMAX)
let stk_sp = 0  // stack pointer (counts slots, each entry = 10)

// push a triple onto the stack
let spush = (k1, x1, y1, k2, x2, y2, k3, x3, y3, d) => {
  if (stk_sp + 10 > SMAX) return
  stk[stk_sp]   = k1; stk[stk_sp+1] = x1; stk[stk_sp+2] = y1
  stk[stk_sp+3] = k2; stk[stk_sp+4] = x2; stk[stk_sp+5] = y2
  stk[stk_sp+6] = k3; stk[stk_sp+7] = x3; stk[stk_sp+8] = y3
  stk[stk_sp+9] = d
  stk_sp = stk_sp + 10
}

// complex square root of (a + b*i) → [re, im]
// We store result in two module-level Float64Array slots to avoid returning objects
let csqrt_buf = new Float64Array(2)
let csqrt = (a, b) => {
  let m = Math.sqrt(a * a + b * b)
  let re = Math.sqrt((m + a) * 0.5)
  let im = b < 0.0 ? -Math.sqrt((m - a) * 0.5) : Math.sqrt((m - a) * 0.5)
  csqrt_buf[0] = re
  csqrt_buf[1] = im
}

// additive saturating pixel write — overlaps bloom toward white
let addpix = (x, y, r, g, b) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let rr = (p & 0xff) + r; if (rr > 255) rr = 255
  let gg = ((p >> 8) & 0xff) + g; if (gg > 255) gg = 255
  let bb = ((p >> 16) & 0xff) + b; if (bb > 255) bb = 255
  px[idx] = (255 << 24) | (bb << 16) | (gg << 8) | rr
}

// HSV rainbow by depth: depth=0 → red, deeper → blue→violet
let depthColor = (d, buf) => {
  let h = (d * 0.18) % 1.0   // full rainbow cycle over ~5-6 depth levels
  let h6 = h * 6.0
  let s = 1.0, v = 1.0
  let i = h6 | 0
  let f = h6 - i
  let p2 = v * (1.0 - s)
  let q2 = v * (1.0 - s * f)
  let t2 = v * (1.0 - s * (1.0 - f))
  let rr = 0.0, gg = 0.0, bb = 0.0
  if (i == 0) { rr = v; gg = t2; bb = p2 }
  else if (i == 1) { rr = q2; gg = v; bb = p2 }
  else if (i == 2) { rr = p2; gg = v; bb = t2 }
  else if (i == 3) { rr = p2; gg = q2; bb = v }
  else if (i == 4) { rr = t2; gg = p2; bb = v }
  else { rr = v; gg = p2; bb = q2 }
  buf[0] = (rr * 120.0) | 0
  buf[1] = (gg * 120.0) | 0
  buf[2] = (bb * 120.0) | 0
}

let color_buf = new Float64Array(3)

// build the Apollonian gasket from scratch, storing circles
let buildGasket = (R) => {
  ncircles = 0
  stk_sp = 0

  // outer enclosing circle
  let k0 = -1.0 / R
  cx_[0] = 0.0; cy_[0] = 0.0; cr_[0] = R; dep_[0] = 0.0
  ncircles = 1

  // 3 equal inner circles: r1 = R * sqrt(3) / (2 + sqrt(3))
  let sq3 = Math.sqrt(3.0)
  let r1 = R * sq3 / (2.0 + sq3)
  let k1 = 1.0 / r1
  // centers at distance (R - r1) from origin, at angles 90°, 210°, 330°
  let dist1 = R - r1
  let PI = Math.PI
  let a0 = PI * 0.5
  let a1 = PI * 0.5 + PI * 2.0 / 3.0
  let a2 = PI * 0.5 + PI * 4.0 / 3.0
  let x0 = Math.cos(a0) * dist1, y0 = Math.sin(a0) * dist1
  let x1 = Math.cos(a1) * dist1, y1 = Math.sin(a1) * dist1
  let x2 = Math.cos(a2) * dist1, y2 = Math.sin(a2) * dist1

  cx_[1] = x0; cy_[1] = y0; cr_[1] = r1; dep_[1] = 1.0
  cx_[2] = x1; cy_[2] = y1; cr_[2] = r1; dep_[2] = 1.0
  cx_[3] = x2; cy_[3] = y2; cr_[3] = r1; dep_[3] = 1.0
  ncircles = 4

  // central circle tangent to all 3 inner circles
  // by Descartes: (k0 + k1 + k1 + k1 + k4)² = ... → k4 = k1+k1+k1+k0 + 2*sqrt(...)
  // For 3 equal circles symmetric, the center circle is at origin
  // k4 = -k0 + 2*k1 (Soddy for inversion) — actually: k4 = k1*3 + k0 + 2*sqrt(3*k1^2+3*k1*k0)
  let k4_pre = k1 + k1 + k1 + k0
  let sq_in = k1 * k1 + k1 * k1 + k1 * k1 + k1 * k0 + k1 * k0 + k1 * k0
  // sq_in = 3*k1^2 + 3*k1*k0
  let kc = k4_pre + 2.0 * Math.sqrt(sq_in)
  let rc = 1.0 / kc
  cx_[4] = 0.0; cy_[4] = 0.0; cr_[4] = rc; dep_[4] = 1.0
  ncircles = 5

  // seed the stack with initial tangent triples (each gap)
  // gaps: (outer, c0, c1), (outer, c1, c2), (outer, c2, c0)
  // and inner: (c0, c1, center), (c1, c2, center), (c2, c0, center)
  spush(k0, 0.0, 0.0, k1, x0, y0, k1, x1, y1, 2.0)
  spush(k0, 0.0, 0.0, k1, x1, y1, k1, x2, y2, 2.0)
  spush(k0, 0.0, 0.0, k1, x2, y2, k1, x0, y0, 2.0)
  spush(k1, x0, y0, k1, x1, y1, kc, 0.0, 0.0, 2.0)
  spush(k1, x1, y1, k1, x2, y2, kc, 0.0, 0.0, 2.0)
  spush(k1, x2, y2, k1, x0, y0, kc, 0.0, 0.0, 2.0)

  // Cutoff in NORMALIZED gasket units (the gasket is built with outer radius R=1, then
  // scaled to the screen at draw time). 0.0022 keeps circles down to ~0.3–0.9 px across the
  // thumbnail→full-screen range — deep enough that the gap-filling recursion really descends.
  let minPxR = 0.0022

  while (stk_sp > 0 && ncircles < MAX) {
    // pop
    stk_sp = stk_sp - 10
    let ka = stk[stk_sp],   xa = stk[stk_sp+1], ya = stk[stk_sp+2]
    let kb = stk[stk_sp+3], xb = stk[stk_sp+4], yb = stk[stk_sp+5]
    let kc2 = stk[stk_sp+6], xc = stk[stk_sp+7], yc = stk[stk_sp+8]
    let dep = stk[stk_sp+9]

    // Descartes: k4 = ka+kb+kc2 ± 2*sqrt(ka*kb + kb*kc2 + kc2*ka)
    let ksum = ka + kb + kc2
    let disc = ka * kb + kb * kc2 + kc2 * ka
    if (disc < 0.0) disc = 0.0
    let sqd = Math.sqrt(disc)
    let k4a = ksum + 2.0 * sqd
    let k4b = ksum - 2.0 * sqd

    // pick the positive branch (the new circle, not the parent)
    // We want k4 > 0 and r4 not huge
    let k4 = k4a > k4b ? k4a : k4b
    if (k4 <= 0.0) continue
    let r4 = 1.0 / k4
    // skip if too small (less than ~1px)
    if (r4 < minPxR) continue

    // center: k4*z4 = ka*za + kb*zb + kc2*zc ± 2*sqrt(ka*kb*za*zb + kb*kc2*zb*zc + kc2*ka*zc*za)
    // complex products: za*zb = (xa+ya*i)*(xb+yb*i) = (xa*xb-ya*yb) + (xa*yb+ya*xb)*i
    let s_re = ka*kb*(xa*xb - ya*yb) + kb*kc2*(xb*xc - yb*yc) + kc2*ka*(xc*xa - yc*ya)
    let s_im = ka*kb*(xa*yb + ya*xb) + kb*kc2*(xb*yc + yb*xc) + kc2*ka*(xc*ya + yc*xa)
    csqrt(s_re, s_im)
    let sq_re = csqrt_buf[0], sq_im = csqrt_buf[1]

    let base_re = ka*xa + kb*xb + kc2*xc
    let base_im = ka*ya + kb*yb + kc2*yc

    // two candidates for z4
    let z4a_re = (base_re + 2.0 * sq_re) / k4
    let z4a_im = (base_im + 2.0 * sq_im) / k4
    let z4b_re = (base_re - 2.0 * sq_re) / k4
    let z4b_im = (base_im - 2.0 * sq_im) / k4

    // pick the one inside the outer circle: distance from origin + r4 < R + eps
    let da = Math.sqrt(z4a_re * z4a_re + z4a_im * z4a_im)
    let db = Math.sqrt(z4b_re * z4b_re + z4b_im * z4b_im)
    let eps = r4 * 0.01 + 1e-6
    let z4_re, z4_im, chosen_da
    if (da + r4 < R + eps && (!(db + r4 < R + eps) || da < db)) {
      z4_re = z4a_re; z4_im = z4a_im; chosen_da = da
    } else if (db + r4 < R + eps) {
      z4_re = z4b_re; z4_im = z4b_im; chosen_da = db
    } else {
      // neither fits cleanly — pick closer to origin
      if (da < db) { z4_re = z4a_re; z4_im = z4a_im; chosen_da = da }
      else { z4_re = z4b_re; z4_im = z4b_im; chosen_da = db }
    }

    // store circle
    let ci = ncircles
    cx_[ci] = z4_re; cy_[ci] = z4_im; cr_[ci] = r4; dep_[ci] = dep
    ncircles = ci + 1

    // push 3 new triples (each neighbor replaced by the new circle)
    let newdep = dep + 1.0
    spush(kb, xb, yb, kc2, xc, yc, k4, z4_re, z4_im, newdep)
    spush(ka, xa, ya, kc2, xc, yc, k4, z4_re, z4_im, newdep)
    spush(ka, xa, ya, kb, xb, yb, k4, z4_re, z4_im, newdep)
  }
}

// state for pan/zoom across frames — in Float64Array to avoid i32 narrowing
let state = new Float64Array(4)  // [panX, panY, zoom, lastR]
let gasket_built = 0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  state[3] = -1.0  // force rebuild
  return px
}

export let frame = (t, panX, panY, zoom) => {
  let half = (W < H ? W : H) * 0.5
  let R = half * 0.9   // gasket radius in screen pixels

  // rebuild gasket in gasket-space (unit: gasket coords where outer circle has radius 1)
  // we build once in normalized coords (R=1) then scale at draw time
  if (state[3] < 0.0 || gasket_built == 0) {
    buildGasket(1.0)
    state[3] = 1.0
    gasket_built = 1
  }

  // clear to black
  let total = W * H
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  // auto-animation: gentle zoom oscillation + slow drift
  let autozoom = zoom * (1.0 + Math.sin(t * 0.23) * 0.08)
  let autopanX = panX + Math.sin(t * 0.11) * 0.04
  let autopanY = panY + Math.cos(t * 0.07) * 0.03

  let cx0 = W * 0.5 + autopanX * W
  let cy0 = H * 0.5 + autopanY * H
  let scale = R * autozoom

  // draw each circle as sampled ring
  let ci = 0
  while (ci < ncircles) {
    let gx = cx_[ci], gy = cy_[ci], gr = cr_[ci], dep = dep_[ci]
    // transform to screen
    let sx = cx0 + gx * scale
    let sy = cy0 - gy * scale   // flip Y for screen coords
    let sr = gr * scale

    if (sr < 0.4) { ci++; continue }   // sub-pixel, skip

    // color by depth
    depthColor(dep, color_buf)
    let cr = color_buf[0] | 0
    let cg = color_buf[1] | 0
    let cb = color_buf[2] | 0

    if (ci == 0) {
      // outer circle: faint white ring
      cr = 40; cg = 40; cb = 40
    }

    // sample circumference: step ~1.2px
    let step = 1.2 / sr
    if (step > 0.3) step = 0.3   // at least a few samples even for tiny circles
    let theta = 0.0
    let TWO_PI = 6.283185307179586
    while (theta < TWO_PI) {
      let px2 = sx + Math.cos(theta) * sr
      let py2 = sy + Math.sin(theta) * sr
      addpix(px2, py2, cr, cg, cb)
      theta = theta + step
    }

    ci++
  }
}

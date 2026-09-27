// Apollonian gasket — recursive circle packing via Descartes' Circle Theorem. Start with
// three mutually tangent circles inside an enclosing circle, then fill every gap with the
// unique Soddy circle tangent to all three neighbors. Repeat until circles are sub-pixel.
//
// Descartes: (k1+k2+k3+k4)² = 2(k1²+k2²+k3²+k4²) where k = 1/r (curvature, negative for
// the enclosing circle). The center follows: k4·z4 = k1·z1+k2·z2+k3·z3 ± 2√(sum of products).
// Complex arithmetic stays in Float64Arrays — no module-level fractional globals that jz would
// narrow to i32. Everything persistent lives in typed arrays; frame() args are f64-safe.
//
// Current meshes through the packing like gears: a pulse runs round its circle, and at the tangency
// point with a chosen neighbour it crosses over and turns the other way. Neighbours are found by the
// tangency test itself (centre distance = r₁ + r₂, or R − r against the enclosing circle), searched
// only when a pulse picks its next hop. Heads splat into a fading heat field; spark(fx, fy) starts
// pulses on the ring nearest a touch.
// resize(w,h) → Uint32Array; frame(t, panX, panY, zoom) renders.

let W = 0, H = 0, px, heat

// circle store: up to 16000 circles (cx, cy, cr each as f64) — deep enough that zooming keeps
// finding fresh generations instead of bottoming out on bare gaps
let MAX = 16000
let cx_ = new Float64Array(MAX)
let cy_ = new Float64Array(MAX)
let cr_ = new Float64Array(MAX)
let dep_ = new Float64Array(MAX)  // depth for coloring
let ncircles = 0

// stack for the recursion: each entry = a tangent QUADRUPLE (a,b,c,d) = 12 f64 (k,x,y per
// circle) + 1 f64 depth = 13 f64 per entry. Sized for the deeper recursion above.
let SMAX = 700000
let stk = new Float64Array(SMAX)
let stk_sp = 0  // stack pointer (counts slots, each entry = 13)

// push a tangent quadruple (a,b,c,d). d is the circle "across" the gap among a,b,c — the
// next circle to drop in is the OTHER one tangent to a,b,c, namely  e = 2(a+b+c) − d.
let spush = (ka, xa, ya, kb, xb, yb, kc, xc, yc, kd, xd, yd, d) => {
  if (stk_sp + 13 > SMAX) return
  stk[stk_sp]    = ka; stk[stk_sp+1]  = xa; stk[stk_sp+2]  = ya
  stk[stk_sp+3]  = kb; stk[stk_sp+4]  = xb; stk[stk_sp+5]  = yb
  stk[stk_sp+6]  = kc; stk[stk_sp+7]  = xc; stk[stk_sp+8]  = yc
  stk[stk_sp+9]  = kd; stk[stk_sp+10] = xd; stk[stk_sp+11] = yd
  stk[stk_sp+12] = d
  stk_sp = stk_sp + 13
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

// Gray level by depth: spread 80..255
let depthColor = (d, buf) => {
  let g = (45 + (d * 29) % 70) | 0
  buf[0] = g
  buf[1] = g
  buf[2] = g
}

let color_buf = new Float64Array(3)

// pulses: circle, angle, rotation sense (±1), the neighbour it will hop to and the tangency angle there
let NA = 28, MAXP = 80
let pc = new Int32Array(MAXP), pn = new Int32Array(MAXP)
let pa = new Float64Array(MAXP), pd = new Float64Array(MAXP), pt = new Float64Array(MAXP)
let np = 0
let view = new Float64Array(4)   // last frame's transform: centre x, y, scale (px per unit), armed
let tch = new Float64Array(3)    // a pending touch: x, y px, armed

// a random neighbour of circle c tangent to it and big enough to see; writes pn/pt for pulse k
let pickHop = (k) => {
  let c = pc[k], x = cx_[c], y = cy_[c], r = cr_[c]
  let seen = 0, best = -1, j = 0
  let minR = 2.5 / view[2]
  while (j < ncircles) {
    if (j !== c && cr_[j] > minR) {
      let dx = cx_[j] - x, dy = cy_[j] - y
      let d = Math.sqrt(dx * dx + dy * dy)
      let gap = c === 0 || j === 0 ? d - Math.abs(r - cr_[j]) : d - (r + cr_[j])
      if (gap < 1e-6 * (r + cr_[j]) && gap > -1e-6 * (r + cr_[j])) {
        seen++
        if (Math.random() * seen < 1.0) best = j
      }
    }
    j++
  }
  pn[k] = best
  if (best >= 0) {
    // the tangency point lies on the line of centres: toward the neighbour, except that a circle touches
    // the enclosing ring on its far side from the origin
    pt[k] = best === 0 ? Math.atan2(y, x) : Math.atan2(cy_[best] - y, cx_[best] - x)
  }
}

let place = (k, c) => {
  pc[k] = c; pa[k] = Math.random() * 6.283185307179586; pd[k] = Math.random() < 0.5 ? -1.0 : 1.0
  pickHop(k)
}

// hot dot into the heat field
let dot = (hx, hy, r) => {
  let x0 = (hx - r) | 0, x1 = (hx + r + 1.0) | 0, y0 = (hy - r) | 0, y1 = (hy + r + 1.0) | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let ir2 = 1.0 / (r * r)
  let y = y0
  while (y <= y1) {
    let x = x0
    while (x <= x1) {
      let dx = x + 0.5 - hx, dy = y + 0.5 - hy
      let q = 1.0 - (dx * dx + dy * dy) * ir2
      if (q > 0.0) { let p = y * W + x; if (heat[p] < q) heat[p] = q }
      x++
    }
    y++
  }
}

// a touch: pulses on the ring nearest (fx, fy) ∈ 0..1, both ways round
export let spark = (fx, fy) => { tch[0] = fx * W; tch[1] = fy * H; tch[2] = 1.0 }

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

  // Central Soddy circle filling the curvilinear triangle between the three inner circles.
  // Descartes on the THREE EQUAL inner circles (k1,k1,k1) — NOT the outer: (3k1+kc)² = 2(3k1²+kc²)
  // ⇒ kc = k1·(3 + 2√3). The old form folded in the outer k0, which made kc too small (rc too
  // big), so the central circle OVERLAPPED — crossed — each inner circle instead of kissing it.
  let kc = k1 * (3.0 + 2.0 * sq3)
  let rc = 1.0 / kc
  cx_[4] = 0.0; cy_[4] = 0.0; cr_[4] = rc; dep_[4] = 1.0
  ncircles = 5

  // Seed the 6 curvilinear gaps of the {outer, c0, c1, c2} + central configuration as tangent
  // quadruples (a,b,c,d): 3 lunes against the outer circle, 3 around the central circle. Each
  // gap will be filled by  e = 2(a+b+c) − d.
  spush(k0,0.0,0.0, k1,x0,y0, k1,x1,y1, k1,x2,y2, 2.0)   // outer ∪ c0,c1   (away from c2)
  spush(k0,0.0,0.0, k1,x1,y1, k1,x2,y2, k1,x0,y0, 2.0)   // outer ∪ c1,c2   (away from c0)
  spush(k0,0.0,0.0, k1,x0,y0, k1,x2,y2, k1,x1,y1, 2.0)   // outer ∪ c0,c2   (away from c1)
  spush(kc,0.0,0.0, k1,x0,y0, k1,x1,y1, k1,x2,y2, 2.0)   // center ∪ c0,c1  (away from c2)
  spush(kc,0.0,0.0, k1,x1,y1, k1,x2,y2, k1,x0,y0, 2.0)   // center ∪ c1,c2  (away from c0)
  spush(kc,0.0,0.0, k1,x0,y0, k1,x2,y2, k1,x1,y1, 2.0)   // center ∪ c0,c2  (away from c1)

  // Cutoff radius in NORMALIZED gasket units (outer radius = 1, scaled to screen at draw time).
  // The gasket's circle count to radius ε grows like ε^-1.3, so 0.0006 yields ~15k circles —
  // still sub-pixel at the thumbnail, but a deep scroll-zoom keeps resolving fresh ones.
  let minR = 0.0006

  while (stk_sp > 0 && ncircles < MAX) {
    stk_sp = stk_sp - 13
    let ka = stk[stk_sp],    xa = stk[stk_sp+1],  ya = stk[stk_sp+2]
    let kb = stk[stk_sp+3],  xb = stk[stk_sp+4],  yb = stk[stk_sp+5]
    let kc2 = stk[stk_sp+6], xc = stk[stk_sp+7],  yc = stk[stk_sp+8]
    let kd = stk[stk_sp+9],  xd = stk[stk_sp+10], yd = stk[stk_sp+11]
    let dep = stk[stk_sp+12]

    // The OTHER circle tangent to a,b,c (the one that isn't d). Linear Descartes — exact,
    // no square root and no inner/outer sign ambiguity (that ambiguity is what broke the gasket).
    let ke = 2.0 * (ka + kb + kc2) - kd
    if (ke <= 0.0) continue              // keep only positive-curvature (gap-filling) circles
    let re = 1.0 / ke
    if (re < minR) continue              // sub-pixel — stop descending this branch
    let ex = (2.0 * (ka*xa + kb*xb + kc2*xc) - kd*xd) * re
    let ey = (2.0 * (ka*ya + kb*yb + kc2*yc) - kd*yd) * re

    let ci = ncircles
    cx_[ci] = ex; cy_[ci] = ey; cr_[ci] = re; dep_[ci] = dep
    ncircles = ci + 1

    // recurse into the 3 fresh sub-gaps formed by e with each pair of {a,b,c}
    let nd = dep + 1.0
    spush(ka,xa,ya, kb,xb,yb,  ke,ex,ey, kc2,xc,yc, nd)   // (a,b,e) away from c
    spush(kb,xb,yb, kc2,xc,yc, ke,ex,ey, ka,xa,ya, nd)    // (b,c,e) away from a
    spush(ka,xa,ya, kc2,xc,yc, ke,ex,ey, kb,xb,yb, nd)    // (a,c,e) away from b
  }
}

// state for pan/zoom across frames — in Float64Array to avoid i32 narrowing
let state = new Float64Array(4)  // [panX, panY, zoom, lastR]
let gasket_built = 0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  heat = new Float32Array(w * h)
  np = 0
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
    if (sx + sr < 0.0 || sx - sr > W || sy + sr < 0.0 || sy - sr > H) { ci++; continue }   // off screen

    // color by depth
    depthColor(dep, color_buf)
    let cr = color_buf[0] | 0
    let cg = color_buf[1] | 0
    let cb = color_buf[2] | 0

    if (ci == 0) {
      // outer circle: faint gray ring
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

  // the current: place missing pulses, advance each ~1 px per sub-step, hop at the tangency point
  view[0] = cx0; view[1] = cy0; view[2] = scale; view[3] = 1.0
  if (tch[2] > 0.5) {
    tch[2] = 0.0
    let best = -1, bd = 1e30, j = 0
    while (j < ncircles) {
      let dx = cx0 + cx_[j] * scale - tch[0], dy = cy0 - cy_[j] * scale - tch[1]
      let e = Math.abs(Math.sqrt(dx * dx + dy * dy) - cr_[j] * scale)
      if (e < bd && cr_[j] * scale > 2.5) { bd = e; best = j }
      j++
    }
    if (best >= 0) {
      let a = Math.atan2(-(tch[1] - cy0) / scale - cy_[best], (tch[0] - cx0) / scale - cx_[best])
      let q = 0
      while (q < 4 && np < MAXP) { pc[np] = best; pa[np] = a; pd[np] = q < 2 ? 1.0 : -1.0; pickHop(np); np++; q++ }
    }
  }
  while (np < NA) { place(np, 1 + ((Math.random() * (ncircles < 400 ? ncircles - 1 : 400)) | 0)); np++ }
  let k = 0
  while (k < np) {
    let sub = 0
    while (sub < 3) {
      let c = pc[k], r = cr_[c]
      let step = 0.55 / (r * scale)
      let a = pa[k] + pd[k] * step
      pa[k] = a
      dot(cx0 + (cx_[c] + Math.cos(a) * r) * scale, cy0 - (cy_[c] + Math.sin(a) * r) * scale, 2.2)
      // reached the tangency point? cross to the neighbour, turning the other way
      let n = pn[k]
      if (n >= 0) {
        let da = a - pt[k]
        da = da - Math.floor(da / 6.283185307179586 + 0.5) * 6.283185307179586
        if (da < step && da > -step) {
          let tx = cx_[c] + Math.cos(pt[k]) * r, ty = cy_[c] + Math.sin(pt[k]) * r
          pc[k] = n; pa[k] = Math.atan2(ty - cy_[n], tx - cx_[n]); pd[k] = -pd[k]
          pickHop(k)
        }
      }
      sub++
    }
    if (k >= NA && Math.random() < 0.004) { np--; pc[k] = pc[np]; pa[k] = pa[np]; pd[k] = pd[np]; pn[k] = pn[np]; pt[k] = pt[np]; k-- }
    k++
  }

  // composite the heat over the rings, and let it cool
  i = 0
  while (i < total) {
    let hh = heat[i]
    if (hh > 0.004) {
      let p = px[i] & 255
      let g = p + ((255 - p) * hh) | 0
      px[i] = (255 << 24) | (g << 16) | (g << 8) | g
      heat[i] = hh * 0.965
    }
    i++
  }
}

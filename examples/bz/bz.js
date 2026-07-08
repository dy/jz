// Belousov–Zhabotinsky excitable medium — the Barkley model (Barkley 1991), THE standard
// 2-variable PDE for spiral waves: a fast activator u and a slow recovery v, ping-ponged like
// examples/diffusion (four permanently-named arrays uA/vA/uB/vB; a flip bit picks which half is
// "read" this substep — jz needs the array identity to stay static, so we never swap references,
// only toggle which named pair is current).
//
//   u_t = D·∇²u + (1/eps)·u·(1−u)·(u − (v+b)/a)     fast activator, 5-point Laplacian, no-flux
//   v_t = u − v                                       slow recovery, purely local (no diffusion)
//
// Seeded with the classic broken-wavefront / cross-field protocol: excite one half-plane (u=1)
// while a PERPENDICULAR line splits v into low (excitable) / raised (temporarily refractory) —
// the one point where both lines cross is a free end that immediately curls into a rotating
// spiral. Idle frames occasionally auto-fire a target wave elsewhere so the field stays busy.
// Dragging the erase brush cuts a gap through a live front; the two cut ends are new free ends
// that curl into a counter-rotating spiral PAIR — "stirring" spirals into existence by hand.
//
// Parameters: a=0.75, b=0.1, eps=0.02 — Barkley's meandering-spiral regime. D=10 spreads the
// front over several grid cells (a smaller D reads numerically boxy — the 5-point Laplacian's
// grid anisotropy shows through — not the smooth curve a real BZ front draws) and, combined with
// b=0.1, keeps the medium's no-flux walls from seeding stray secondary spirals for minutes of
// play instead of seconds. dt=0.015 sits safely under both the diffusion CFL limit (dx²/4D
// ≈0.025) and the reaction term's own stiffness bound — 0.02 is already enough to ring the
// classic finite-difference checkerboard mode.

let W = 0, H = 0
let uA, vA, uB, vB   // ping-pong double-buffered fields (Float64Array)
let px                // Uint32 pixel output
let flip = 0          // 0: read A write B  |  1: read B write A
let SUB = 16          // substeps per rendered frame
let pa = 0.75, pb = 0.1, eps = 0.02   // Barkley kinetics: a, b, epsilon
let D = 10.0          // u diffusion coefficient
let dt = 0.015        // substep timestep (CFL- and reaction-stiffness-safe)
let nextStim = 260    // frames until the next automatic target-wave stimulus

// Allocate + blank. Does NOT plant a spiral — a plain resize (window resize, fullscreen/
// screensaver toggle, JS⇄jz engine swap) must not silently swap in a fresh random spiral and
// discard whatever pattern the field currently shows. The host calls seed() explicitly after
// resize (first load: fresh random config; later: the SAME remembered config — see index.html).
export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  uA = new Float64Array(n); vA = new Float64Array(n)
  uB = new Float64Array(n); vB = new Float64Array(n)
  px = new Uint32Array(n)
  clear()
  return px
}

// Reset both ping-pong halves to the quiescent rest state (u=0, v=0).
export let clear = () => {
  let n = W * H, i = 0
  while (i < n) {
    uA[i] = 0.0; vA[i] = 0.0
    uB[i] = 0.0; vB[i] = 0.0
    i++
  }
  flip = 0
  nextStim = 200 + (Math.random() * 280 | 0)   // ~3.3-8s of idle at 60fps before the first auto-stim
}

// Classic broken-wavefront seed: u splits into excited/rest across one axis, v splits into
// low/raised across the PERPENDICULAR axis — their crossing is the single free end that curls
// into a spiral immediately. Pure function of its args (no RNG) so the host can reproduce the
// SAME spiral after a resize; the host draws the randomness (fresh on first load / randomize).
//   horiz: 0 = front runs vertically (u splits along x); non-0 = front runs horizontally
//   s1: front position fraction (~0.42-0.58);  s2: perpendicular refractory-split fraction
export let seed = (horiz, s1, s2) => {
  clear()
  let vHi = pa * 0.5
  let y = 0
  while (y < H) {
    let row = y * W, fy = y / H
    let x = 0
    while (x < W) {
      let c = row + x, fx = x / W
      let fu = horiz !== 0 ? fy : fx
      let fv = horiz !== 0 ? fx : fy
      let uSeed = fu < s1 ? 1.0 : 0.0
      let vSeed = fv < s2 ? 0.0 : vHi
      uA[c] = uSeed; uB[c] = uSeed
      vA[c] = vSeed; vB[c] = vSeed
      x++
    }
    y++
  }
}

// Excite u in a small disk, into BOTH ping-pong halves (so it shows regardless of which is the
// current read buffer — same convention as diffusion's seedBrush/eraseBrush).
let stimDisk = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) {
        uA[row + x] = 1.0; uB[row + x] = 1.0
      }
      x++
    }
    y++
  }
}

// Point stimulus (click): raise u to the excited state in a small disk. Whether it actually
// fires depends on the local recovery v (refractory tissue resists — physically correct).
export let stim = (cx, cy) => {
  let r = W < H ? W * 0.032 : H * 0.032
  if (r < 3.0) r = 3.0
  stimDisk(cx, cy, r)
}

// Erase brush (drag): wipe a disk back to quiescent rest. Dragged through a live wavefront it
// cuts a gap; the two cut ends are fresh free ends that curl into a counter-rotating pair.
export let erase = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) {
        uA[row + x] = 0.0; uB[row + x] = 0.0
        vA[row + x] = 0.0; vB[row + x] = 0.0
      }
      x++
    }
    y++
  }
}

// One Barkley sub-step reading from (uA,vA), writing to (uB,vB). No-flux (Neumann) boundary:
// the missing outside neighbour is replaced by the centre value itself (zero gradient).
let stepAtoB = () => {
  let w = W, h = H, du = D, invEps = 1.0 / eps, invA = 1.0 / pa, bb = pb, h2 = dt
  let y = 0
  while (y < h) {
    let yN = y === 0 ? 0 : y - 1
    let yS = y === h - 1 ? h - 1 : y + 1
    let rowC = y * w, rowN = yN * w, rowS = yS * w
    let x = 0
    while (x < w) {
      let xW = x === 0 ? 0 : x - 1
      let xE = x === w - 1 ? w - 1 : x + 1
      let c = rowC + x
      let uC = uA[c], vC = vA[c]
      let lap = uA[rowN + x] + uA[rowS + x] + uA[rowC + xW] + uA[rowC + xE] - 4.0 * uC
      let th = (vC + bb) * invA
      let react = invEps * uC * (1.0 - uC) * (uC - th)
      let nu = uC + h2 * (du * lap + react)
      if (nu < -0.5) nu = -0.5; else if (nu > 1.5) nu = 1.5
      uB[c] = nu
      vB[c] = vC + h2 * (uC - vC)
      x++
    }
    y++
  }
}

let stepBtoA = () => {
  let w = W, h = H, du = D, invEps = 1.0 / eps, invA = 1.0 / pa, bb = pb, h2 = dt
  let y = 0
  while (y < h) {
    let yN = y === 0 ? 0 : y - 1
    let yS = y === h - 1 ? h - 1 : y + 1
    let rowC = y * w, rowN = yN * w, rowS = yS * w
    let x = 0
    while (x < w) {
      let xW = x === 0 ? 0 : x - 1
      let xE = x === w - 1 ? w - 1 : x + 1
      let c = rowC + x
      let uC = uB[c], vC = vB[c]
      let lap = uB[rowN + x] + uB[rowS + x] + uB[rowC + xW] + uB[rowC + xE] - 4.0 * uC
      let th = (vC + bb) * invA
      let react = invEps * uC * (1.0 - uC) * (uC - th)
      let nu = uC + h2 * (du * lap + react)
      if (nu < -0.5) nu = -0.5; else if (nu > 1.5) nu = 1.5
      uA[c] = nu
      vA[c] = vC + h2 * (uC - vC)
      x++
    }
    y++
  }
}

export let frame = () => {
  nextStim = nextStim - 1
  if (nextStim <= 0) {
    let rx = W * 0.15 + Math.random() * W * 0.7
    let ry = H * 0.15 + Math.random() * H * 0.7
    stim(rx, ry)
    nextStim = 200 + (Math.random() * 280 | 0)
  }

  let s = 0
  while (s < SUB) {
    if (flip === 0) { stepAtoB(); flip = 1 } else { stepBtoA(); flip = 0 }
    s++
  }

  // render: luminous grayscale from u (crisp bright fronts), with a touch of v mixed in so the
  // refractory tail glows dimly as it decays instead of snapping straight to black.
  let n = W * H, i = 0
  while (i < n) {
    let u = flip === 0 ? uA[i] : uB[i]
    let v = flip === 0 ? vA[i] : vB[i]
    let lum = u + v * 0.3
    if (lum < 0.0) lum = 0.0; else if (lum > 1.0) lum = 1.0
    let g = (lum * 255.0) | 0
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

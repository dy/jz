// Lattice-Boltzmann fluid (D2Q9) — wind blows past a cylinder and sheds a von Kármán
// vortex street. Each cell holds 9 distribution functions that relax toward local
// equilibrium (collide) and shift to neighbours (stream), with bounce-back on the cylinder
// and channel walls. A passive dye field rides on top: semi-Lagrangian backtrace (one
// bilinear gather) along the macroscopic velocity, fed by a thin filament injected at the
// left edge every frame — the dye threads downstream and wraps into the shed
// vortices, the classic smoke-wire picture. It's a dense, fully-parallel stencil over 9
// fields — a heavy, cache-bound number cruncher, exactly where jz earns its keep. Rendered
// as the dye (bright, primary) over a dim vorticity field; solids dark.
// resize(w,h) → Uint32Array; frame() advances; reseed() reinitializes.

let W = 0, H = 0, px
let f, ft             // distributions: 9 fields packed as k*n + c
let ux, uy            // macroscopic velocity (for rendering vorticity + advecting the dye)
let solid             // obstacle mask
let ex, ey, wt, opp   // D2Q9 lattice
let bcx = new Float64Array(8), bcy = new Float64Array(8), bcr = new Float64Array(8), nb = 0  // blob circles
let n = 0
let U0 = 0.09         // inflow speed
let TAU = 0.62        // relaxation time (>0.5 for stability)
let SUB = 4           // LBM steps per rendered frame

let dye, dye0         // passive dye tracer + its pre-advect snapshot
let DYE_FADE = 0.9993 // slow fade (~16s half-life) — the ribbon persists long enough to wrap the street
let DYE_SRC = 1.0     // filament source strength
let injX = 0, injY0 = 0, injY1 = 0   // thin filament source, at the left edge (upstream of the obstacle cluster)

export let resize = (w, h) => {
  W = w; H = h; n = w * h
  f = new Float64Array(9 * n); ft = new Float64Array(9 * n)
  ux = new Float64Array(n); uy = new Float64Array(n)
  solid = new Int32Array(n)
  ex = new Int32Array(9); ey = new Int32Array(9); wt = new Float64Array(9); opp = new Int32Array(9)
  ex[0] = 0; ex[1] = 1; ex[2] = 0; ex[3] = -1; ex[4] = 0; ex[5] = 1; ex[6] = -1; ex[7] = -1; ex[8] = 1
  ey[0] = 0; ey[1] = 0; ey[2] = 1; ey[3] = 0; ey[4] = -1; ey[5] = 1; ey[6] = 1; ey[7] = -1; ey[8] = -1
  wt[0] = 0.4444444; wt[1] = 0.1111111; wt[2] = 0.1111111; wt[3] = 0.1111111; wt[4] = 0.1111111
  wt[5] = 0.0277778; wt[6] = 0.0277778; wt[7] = 0.0277778; wt[8] = 0.0277778
  opp[0] = 0; opp[1] = 3; opp[2] = 4; opp[3] = 1; opp[4] = 2; opp[5] = 7; opp[6] = 8; opp[7] = 5; opp[8] = 6
  dye = new Float64Array(n); dye0 = new Float64Array(n)
  injX = 1   // the leftmost column the render/advect loops touch (x=0 is a 1px stencil border,
             // never drawn) — inject right at that edge so the dye fills from the true left edge,
             // no dead gap before the visible streak begins
  injY0 = (H * 0.5 - H * 0.05) | 0; injY1 = (H * 0.5 + H * 0.05) | 0
  reseed()
  return px = new Uint32Array(n)
}

export let reseed = () => {
  // a cylinder a third of the way in
  // random blob: a cluster of overlapping circles a third of the way in
  let ox = W * 0.28, oy = H * 0.5, base = (H < W ? H : W) * 0.1
  nb = 4 + (Math.random() * 3 | 0)
  let i = 0
  while (i < nb) {
    bcx[i] = ox + (Math.random() - 0.5) * base * 1.2
    bcy[i] = oy + (Math.random() - 0.5) * base * 1.6
    bcr[i] = base * (0.5 + Math.random() * 0.7)
    i++
  }
  let y = 0
  while (y < H) {
    let x = 0
    while (x < W) {
      let c = y * W + x
      let s = (y === 0 || y === H - 1) ? 1 : 0
      if (s === 0) {
        let k = 0
        while (k < nb) { let dx = x - bcx[k], dy = y - bcy[k]; if (dx * dx + dy * dy < bcr[k] * bcr[k]) { s = 1; k = nb } else k++ }
      }
      solid[c] = s
      dye[c] = 0.0
      let k2 = 0
      while (k2 < 9) {
        let eu = ex[k2] * U0
        f[k2 * n + c] = wt[k2] * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * U0 * U0)
        k2++
      }
      x++
    }
    y++
  }
}

// draw a circular obstacle (hold + grow) at (cx,cy)
export let addObstacle = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let r2 = r * r, y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) { let dx = x - cx; if (dx * dx + dy * dy <= r2) solid[row + x] = 1; x++ }
    y++
  }
}

// bilinear sample of grid arr (dims W×H), clamped to the interior
let samp = (arr, x, y) => {
  if (x < 0.5) x = 0.5; else if (x > W - 1.5) x = W - 1.5
  if (y < 0.5) y = 0.5; else if (y > H - 1.5) y = H - 1.5
  let i0 = x | 0, j0 = y | 0
  let sx = x - i0, sy = y - j0
  let b = j0 * W + i0
  let a = arr[b], c = arr[b + 1], d = arr[b + W], e = arr[b + W + 1]
  return a * (1.0 - sx) * (1.0 - sy) + c * sx * (1.0 - sy) + d * (1.0 - sx) * sy + e * sx * sy
}

let collideStream = () => {
  // collide (relax toward equilibrium), writing back into f
  let c = 0
  while (c < n) {
    if (solid[c] === 0) {
      let rho = 0.0, mx = 0.0, my = 0.0, k = 0
      while (k < 9) { let fk = f[k * n + c]; rho += fk; mx += ex[k] * fk; my += ey[k] * fk; k++ }
      let vx = mx / rho, vy = my / rho
      ux[c] = vx; uy[c] = vy
      let usq = vx * vx + vy * vy
      k = 0
      while (k < 9) {
        let eu = ex[k] * vx + ey[k] * vy
        let feq = wt[k] * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * usq)
        let idx = k * n + c
        f[idx] += (feq - f[idx]) / TAU
        k++
      }
    }
    c++
  }
  // stream into ft with bounce-back off solids/walls
  let y = 0
  while (y < H) {
    let x = 0
    while (x < W) {
      let cc = y * W + x
      if (solid[cc] === 0) {
        let k = 0
        while (k < 9) {
          let nx = x + ex[k], ny = y + ey[k]
          if (nx < 0) nx += W; else if (nx >= W) nx -= W      // periodic left/right
          let nc = ny * W + nx
          if (ny < 0 || ny >= H || solid[nc] === 1) ft[opp[k] * n + cc] = f[k * n + cc]  // bounce back
          else ft[k * n + nc] = f[k * n + cc]
          k++
        }
      }
      x++
    }
    y++
  }
  let s = f; f = ft; ft = s

  // drive inflow on the left column toward U0 (and zero-gradient outflow on the right)
  let yy = 1
  while (yy < H - 1) {
    let cL = yy * W, cR = yy * W + (W - 1), cR1 = cR - 1, k = 0
    while (k < 9) {
      let eu = ex[k] * U0
      f[k * n + cL] = wt[k] * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * U0 * U0)
      f[k * n + cR] = f[k * n + cR1]
      k++
    }
    yy++
  }
}

// carry the dye along the macroscopic flow: semi-Lagrangian backtrace, one bilinear
// gather per cell. ux/uy are per-LBM-step velocities and SUB steps elapse per rendered
// frame, so the backtrace distance is scaled by SUB (one gather stands in for the frame).
let advectDye = () => {
  let i = 0
  while (i < n) { dye0[i] = dye[i]; i++ }
  let y = 1
  while (y < H - 1) {
    let x = 1
    while (x < W - 1) {
      let c = y * W + x
      if (solid[c] === 0) dye[c] = samp(dye0, x - ux[c] * SUB, y - uy[c] * SUB) * DYE_FADE
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let s = 0
  while (s < SUB) { collideStream(); s++ }

  advectDye()

  // continuous thin dye filament, injected at the left edge every frame — flow fills from
  // the edge, no gap before the visible streak begins
  let yy = injY0
  while (yy <= injY1) { dye[yy * W + injX] = DYE_SRC; yy++ }

  // render: the dye as a bright primary layer over a dim vorticity field; solids dark
  let y = 1
  while (y < H - 1) {
    let x = 1
    while (x < W - 1) {
      let c = y * W + x
      let g = 30
      if (solid[c] === 0) {
        let curl = (uy[c + 1] - uy[c - 1]) - (ux[c + W] - ux[c - W])
        let dim = 45.0 + curl * 1800.0
        if (dim < 4.0) dim = 4.0
        if (dim > 150.0) dim = 150.0
        // display-only lift (x^0.25 via two sqrts — cheap): a single semi-Lagrangian gather
        // is diffusive, so the filament arrives diluted after wrapping a few turns; this
        // keeps it visible without a second (correcting) gather pass
        let bright = Math.sqrt(Math.sqrt(dye[c])) * 255.0
        if (bright > 255.0) bright = 255.0
        let v = dim + bright
        if (v > 255.0) v = 255.0
        g = v | 0
      }
      px[c] = (255 << 24) | (g << 16) | (g << 8) | g
      x++
    }
    y++
  }
}

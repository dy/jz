// Watercolor / sumi-e — an actual incompressible fluid (Stam's "stable fluids") carrying
// ink. Each frame: project the velocity field divergence-free (Gauss–Seidel pressure
// solve), semi-Lagrangian advect velocity and ink along it, and fade. A brush injects ink
// plus an outward puff of velocity, so a press blooms like a drop in water and a drag
// pulls flowing tendrils. The Jacobi/advect sweeps are grid stencils + gathers — a
// memory-bound workout for jz. White paper, black ink. resize(w,h) → Uint32Array.

let W = 0, H = 0, px
let u, v, u0, v0     // velocity + scratch
let dn, dn0          // ink density + scratch
let pr, dv           // pressure, divergence
let ITER = 20
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; default = light theme (its native white
// paper / black ink). In dark theme it flips to light ink on dark paper.
let th = new Float64Array(6)
th[0] = 250.0; th[1] = 250.0; th[2] = 250.0; th[3] = 6.0; th[4] = 6.0; th[5] = 6.0
export let setTheme = (pr_, pg, pb, ir, ig, ib) => { th[0] = pr_; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  u = new Float64Array(n); v = new Float64Array(n); u0 = new Float64Array(n); v0 = new Float64Array(n)
  dn = new Float64Array(n); dn0 = new Float64Array(n)
  pr = new Float64Array(n); dv = new Float64Array(n)
  px = new Uint32Array(n)
  return px
}

export let clear = () => {
  let n = W * H, i = 0
  while (i < n) { u[i] = 0.0; v[i] = 0.0; dn[i] = 0.0; i++ }
}

// Brush: inject ink + an outward velocity puff (drag direction added on top).
export let paint = (cx, cy, r, fx, fy) => {
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
        let c = row + x
        let w = 1.0 - d2 / (r2 + 1.0)
        let di = dn[c] + w * 0.6
        if (di > 1.5) di = 1.5
        dn[c] = di
        u[c] += dx * 0.12 + fx          // outward bloom + drag
        v[c] += dy * 0.12 + fy
      }
      x++
    }
    y++
  }
}

// bilinear sample of field f at (x,y), clamped to the interior
let samp = (f, x, y) => {
  if (x < 0.5) x = 0.5; else if (x > W - 1.5) x = W - 1.5
  if (y < 0.5) y = 0.5; else if (y > H - 1.5) y = H - 1.5
  let i0 = x | 0, j0 = y | 0, i1 = i0 + 1, j1 = j0 + 1
  let sx = x - i0, sy = y - j0
  let a = f[j0 * W + i0], b = f[j0 * W + i1], c = f[j1 * W + i0], d = f[j1 * W + i1]
  return a * (1.0 - sx) * (1.0 - sy) + b * sx * (1.0 - sy) + c * (1.0 - sx) * sy + d * sx * sy
}

// make velocity divergence-free (Gauss–Seidel pressure projection)
let project = () => {
  let w = W, h = H
  let y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      dv[c] = -0.5 * (u[c + 1] - u[c - 1] + v[c + w] - v[c - w])
      pr[c] = 0.0
      x++
    }
    y++
  }
  let k = 0
  while (k < ITER) {
    y = 1
    while (y < h - 1) {
      let r = y * w, x = 1
      while (x < w - 1) {
        let c = r + x
        pr[c] = (dv[c] + pr[c - 1] + pr[c + 1] + pr[c - w] + pr[c + w]) * 0.25
        x++
      }
      y++
    }
    k++
  }
  y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      u[c] -= 0.5 * (pr[c + 1] - pr[c - 1])
      v[c] -= 0.5 * (pr[c + w] - pr[c - w])
      x++
    }
    y++
  }
}

let advect = (s, s0) => {
  let w = W, h = H, y = 1
  while (y < h - 1) {
    let r = y * w, x = 1
    while (x < w - 1) {
      let c = r + x
      s[c] = samp(s0, x - u[c], y - v[c])
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let n = W * H, i = 0
  // damp velocity slightly, copy to scratch
  while (i < n) { u[i] = u[i] * 0.999; v[i] = v[i] * 0.999; u0[i] = u[i]; v0[i] = v[i]; i++ }

  project()
  advect(u, u0); advect(v, v0)        // self-advection of velocity
  project()

  i = 0
  while (i < n) { dn0[i] = dn[i]; i++ }
  advect(dn, dn0)                     // carry ink along the flow
  // soft capillary bleed (light blur) + slow settle — the watercolor feathering
  i = 0
  while (i < n) { dn0[i] = dn[i]; i++ }
  let kk = 0.045, w2 = W, y2 = 1
  while (y2 < H - 1) {
    let r = y2 * w2, x2 = 1
    while (x2 < w2 - 1) {
      let c = r + x2
      dn[c] = (dn0[c] * (1.0 - 4.0 * kk) + kk * (dn0[c - 1] + dn0[c + 1] + dn0[c - w2] + dn0[c + w2])) * 0.9978
      x2++
    }
    y2++
  }

  // render: paper → ink by ink density, in the page theme
  i = 0
  while (i < n) {
    let m = dn[i] * 1.9
    if (m > 1.0) m = 1.0
    let r = (th[0] + (th[3] - th[0]) * m) | 0
    let g = (th[1] + (th[4] - th[1]) * m) | 0
    let b = (th[2] + (th[5] - th[2]) * m) | 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}

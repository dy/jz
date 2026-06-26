// Particle fluid — a smoothed-particle-style liquid. Every pair within the smoothing
// radius exchanges a soft repulsion (so the fluid resists compression) and a viscosity
// pull toward the neighbourhood's average velocity (so it flows cohesively); gravity and a
// container do the rest. It's the classic O(N²) neighbour sum — dense f64 multiply-add that
// jz turns into tight wasm. Drag to stir. resize(w,h) → Uint32Array.

let W = 0, H = 0, px
let N = 700
let x = new Float64Array(N)
let y = new Float64Array(N)
let vx = new Float64Array(N)
let vy = new Float64Array(N)
let px_ = 0.5, py_ = 0.5, pdown = 0.0

let R = 0.026, R2 = 0.026 * 0.026   // interaction radius
let KREP = 0.65                     // repulsion stiffness
let KVISC = 0.4                     // viscosity (high → cohesive, not bouncy)
let GRAV = 0.00007, DT = 1.0, EL = 0.2, DAMP = 0.985

export let setPointer = (a, b, d) => { px_ = a; py_ = b; pdown = d }

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

export let init = () => {
  // drop the particles as a block in the upper half so they splash down
  let i = 0, cols = 34
  while (i < N) {
    x[i] = 0.18 + (i % cols) * 0.0125 + (Math.random() - 0.5) * 0.004
    y[i] = 0.08 + ((i / cols) | 0) * 0.0125
    vx[i] = 0.0; vy[i] = 0.0
    i++
  }
}

// re-roll: drop the block at a random spot with a random sideways shove → a different splash each time
export let randomize = () => {
  let i = 0, cols = 34
  let ox = 0.10 + Math.random() * 0.55
  let v0 = (Math.random() < 0.5 ? -1.0 : 1.0) * (0.002 + Math.random() * 0.005)
  while (i < N) {
    x[i] = ox + (i % cols) * 0.0125 + (Math.random() - 0.5) * 0.02
    y[i] = 0.05 + ((i / cols) | 0) * 0.0125
    vx[i] = v0; vy[i] = 0.0
    i++
  }
}

let splat = (fx, fy, rad, g) => {
  let cxi = fx | 0, cyi = fy | 0, ri = rad | 0
  if (ri < 1) ri = 1
  let inv = 1.0 / (rad * rad)
  let oy = -ri
  while (oy <= ri) {
    let iy = cyi + oy
    if (iy >= 0 && iy < H) {
      let ox = -ri
      while (ox <= ri) {
        let ix = cxi + ox
        if (ix >= 0 && ix < W) {
          let d2 = ox * ox + oy * oy
          let w = 1.0 - d2 * inv
          if (w > 0.0) {
            let off = iy * W + ix, p = px[off]
            let v = (p & 255) + (g * w) | 0
            if (v > 255) v = 255
            px[off] = (255 << 24) | (v << 16) | (v << 8) | v
          }
        }
        ox++
      }
    }
    oy++
  }
}

export let frame = (t) => {
  // pairwise repulsion + viscosity (O(N²))
  let i = 0
  while (i < N) {
    let xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i]
    let fx = 0.0, fy = 0.0
    let j = i + 1
    while (j < N) {
      let dx = x[j] - xi, dy = y[j] - yi
      let d2 = dx * dx + dy * dy
      if (d2 < R2 && d2 > 1e-9) {
        let d = Math.sqrt(d2)
        let q = 1.0 - d / R
        let inv = 1.0 / d
        let nx = dx * inv, ny = dy * inv
        let rep = q * q * KREP                    // soft repulsion (bounded)
        fx -= nx * rep; fy -= ny * rep
        // viscosity: pull velocities together
        let rvx = vx[j] - vxi, rvy = vy[j] - vyi
        let vc = q * KVISC
        fx += rvx * vc; fy += rvy * vc
        // equal & opposite on j
        vx[j] += (nx * rep - rvx * vc) * 0.001
        vy[j] += (ny * rep - rvy * vc) * 0.001
      }
      j++
    }
    vx[i] = vxi + fx * 0.001
    vy[i] = vyi + fy * 0.001 + GRAV
    i++
  }

  // pointer stir + integrate + container
  i = 0
  while (i < N) {
    if (pdown !== 0.0) {
      let dx = x[i] - px_, dy = y[i] - py_, d2 = dx * dx + dy * dy
      if (d2 < 0.03) { let inv = 1.0 / (d2 + 0.004); vx[i] += dx * inv * 0.00022; vy[i] += dy * inv * 0.00022 }
    }
    vx[i] *= DAMP; vy[i] *= DAMP        // drag → calmer, slower, more cohesive
    x[i] += vx[i] * DT; y[i] += vy[i] * DT
    let r = 0.008
    if (x[i] < r) { x[i] = r; vx[i] = -vx[i] * EL } else if (x[i] > 1.0 - r) { x[i] = 1.0 - r; vx[i] = -vx[i] * EL }
    if (y[i] < r) { y[i] = r; vy[i] = -vy[i] * EL } else if (y[i] > 1.0 - r) { y[i] = 1.0 - r; vy[i] = -vy[i] * EL }
    i++
  }

  // render: additive white blobs on black → a fluid body
  let n = W * H, k = 0
  while (k < n) { px[k] = (255 << 24); k++ }
  let rad = (W < H ? W : H) * 0.026
  i = 0
  while (i < N) { splat(x[i] * W, y[i] * H, rad, 205.0); i++ }
}

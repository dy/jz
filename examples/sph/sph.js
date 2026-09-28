// Particle fluid — a smoothed-particle-style liquid. Every pair within the smoothing
// radius exchanges a soft repulsion (so the fluid resists compression) and a viscosity
// pull toward the neighbourhood's average velocity (so it flows cohesively); gravity and a
// container do the rest. It's the classic O(N²) neighbour sum — dense f64 multiply-add that
// jz turns into tight wasm. The tank rocks (gravity swings ±17° on a period near the tank's own
// slosh period, two steps per frame), so the liquid sloshes, climbs the walls and breaks forever;
// drag to stir.
// Render: each particle splats a smooth kernel into a density field and a speed field. The liquid
// is the density iso-surface — anti-aliased at the edge, a bright meniscus along it, a body lit
// from the surface down (brightness falls off with depth below the local surface, tracked per
// column as the rows scan down), and white aeration wherever the flow runs fast.
// resize(w,h) → Uint32Array; frame(t) steps + draws.

let W = 0, H = 0, px, dens, spd
let top                             // Int32Array per column: row where the liquid under it begins (-1: in air)
let HW = 0.62                       // tank height (world units): sized so the liquid fills a third of it
let AW = 1.0                        // tank width: HW × the screen aspect, so drops stay round
let N = 1100
let x = new Float64Array(N)
let y = new Float64Array(N)
let vx = new Float64Array(N)
let vy = new Float64Array(N)
let px_ = 0.5, py_ = 0.5, pdown = 0.0

let R = 0.026, R2 = 0.026 * 0.026   // interaction radius
let KREP = 0.65                     // repulsion stiffness
let KVISC = 0.4                     // viscosity (high → cohesive, not bouncy)
let GRAV = 0.00007, DT = 1.0, EL = 0.2, DAMP = 0.991
let TILT = 0.3                      // rocking amplitude (rad)
let ISO = 0.9                       // density level of the liquid surface

export let setPointer = (a, b, d) => { px_ = a; py_ = b; pdown = d }

export let resize = (w, h) => {
  W = w; H = h
  AW = H > 0 ? HW * W / H : HW
  px = new Uint32Array(w * h)
  dens = new Float32Array(w * h)
  spd = new Float32Array(w * h)
  top = new Int32Array(w)
  return px
}

// drop the particles as a block, cols wide, starting at world x = ox, with sideways speed v0
let block = (ox, v0, jit) => {
  let i = 0, cols = 44
  while (i < N) {
    x[i] = ox + (i % cols) * 0.0125 + (Math.random() - 0.5) * jit
    y[i] = 0.06 + ((i / cols) | 0) * 0.0125
    vx[i] = v0; vy[i] = 0.0
    i++
  }
}

// drop the block in the upper left so it splashes down
export let init = () => { block(0.1 * AW, 0.0, 0.004) }

// re-roll: drop the block at a random spot with a random sideways shove → a different splash each time
export let randomize = () => {
  block((0.05 + Math.random() * 0.5) * AW, (Math.random() < 0.5 ? -1.0 : 1.0) * (0.002 + Math.random() * 0.005), 0.02)
}

// smooth kernel (1 − d²/r²)² into the density field, weighted by speed into the speed field
let splat = (fx, fy, rad, s) => {
  let cxi = fx | 0, cyi = fy | 0, ri = (rad | 0) + 1
  let inv = 1.0 / (rad * rad)
  let oy = -ri
  while (oy <= ri) {
    let iy = cyi + oy
    if (iy >= 0 && iy < H) {
      let ox = -ri
      while (ox <= ri) {
        let ix = cxi + ox
        if (ix >= 0 && ix < W) {
          let dx = ix + 0.5 - fx, dy = iy + 0.5 - fy
          let w = 1.0 - (dx * dx + dy * dy) * inv
          if (w > 0.0) {
            let off = iy * W + ix
            w = w * w
            dens[off] += w
            spd[off] += w * s
          }
        }
        ox++
      }
    }
    oy++
  }
}

let step = (t) => {
  // the tank rocks: gravity swings ±TILT on two incommensurate periods, so no slosh repeats
  let ang = TILT * (Math.sin(t * 1.05) * 0.7 + Math.sin(t * 0.29 + 1.0) * 0.3)
  let gx = GRAV * Math.sin(ang), gy = GRAV * Math.cos(ang)

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
    vx[i] = vxi + fx * 0.001 + gx
    vy[i] = vyi + fy * 0.001 + gy
    i++
  }

  // pointer stir + integrate + container
  let pxw = px_ * AW, pyw = py_ * HW
  i = 0
  while (i < N) {
    if (pdown !== 0.0) {
      let dx = x[i] - pxw, dy = y[i] - pyw, d2 = dx * dx + dy * dy
      if (d2 < 0.03) { let inv = 1.0 / (d2 + 0.004); vx[i] += dx * inv * 0.00022; vy[i] += dy * inv * 0.00022 }
    }
    vx[i] *= DAMP; vy[i] *= DAMP        // drag → calmer, slower, more cohesive
    x[i] += vx[i] * DT; y[i] += vy[i] * DT
    let r = 0.008
    if (x[i] < r) { x[i] = r; vx[i] = -vx[i] * EL } else if (x[i] > AW - r) { x[i] = AW - r; vx[i] = -vx[i] * EL }
    if (y[i] < r) { y[i] = r; vy[i] = -vy[i] * EL } else if (y[i] > HW - r) { y[i] = HW - r; vy[i] = -vy[i] * EL }
    i++
  }
}

export let frame = (t) => {
  step(t)
  step(t + 0.008)

  // render: density + speed fields → liquid body, meniscus rim, aeration
  let n = W * H, k = 0
  while (k < n) { dens[k] = 0.0; spd[k] = 0.0; k++ }
  let sc = H / HW, rad = sc * 0.034
  let i = 0
  while (i < N) {
    let s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * 260.0   // speed, in units where a brisk flow ≈ 1
    splat(x[i] * sc, y[i] * sc, rad, s)
    i++
  }
  let ix = 0
  while (ix < W) { top[ix] = -1; ix++ }
  let fall = 1.0 / (H * 0.09)
  let iy = 0
  while (iy < H) {
    let row = iy * W
    ix = 0
    while (ix < W) {
      let d = dens[row + ix]
      let v = 0.0
      if (d > ISO - 0.35) {
        if (top[ix] < 0 && d > ISO) top[ix] = iy        // entering liquid from the air above
        let a = (d - (ISO - 0.12)) * 4.2              // coverage across the iso band → anti-aliased edge
        a = a < 0.0 ? 0.0 : a > 1.0 ? 1.0 : a
        let e = (d - ISO) * 3.0                        // meniscus: a bright line hugging the surface
        let rim = 1.0 - e * e
        rim = rim < 0.0 ? 0.0 : rim
        let foam = spd[row + ix] / (d + 0.0001)        // density-weighted mean speed
        foam = foam > 1.0 ? 1.0 : foam
        let db = top[ix] < 0 ? 0 : iy - top[ix]
        let lit = 1.0 / (1.0 + db * fall)             // light from the surface, fading with depth
        let body = 0.07 + lit * lit * 0.4 + foam * foam * 0.6
        v = a * body + rim * rim * 0.62
      } else top[ix] = -1                              // an air gap: the next liquid below has its own surface
      let g = v >= 1.0 ? 255 : (v * 255.0) | 0
      px[row + ix] = (255 << 24) | (g << 16) | (g << 8) | g
      ix++
    }
    iy++
  }
}

// Spring-mass cloth — a grid of point masses linked by distance constraints, integrated
// with Verlet (position-only) and relaxed by several constraint passes per frame. The top
// row is pinned; gravity pulls the rest into a hanging sheet you can grab and swing. The
// constraint relaxation is pointer-chasing over the node grid — a memory-layout stress for
// jz, unlike the flat pixel kernels. Drawn as a wire mesh, dark on light.
// resize(w,h) → Uint32Array; frame() steps; grab/drag/release to interact.

let W = 0, H = 0, px
let GX = 96, GY = 64       // cloth resolution — finer mesh, ~6k nodes
let N = GX * GY
let nx, ny, ox, oy         // node pos + previous pos (Verlet)
let pin                    // 1 = pinned
let L = 1.0                // rest length (px)
let R = 0                  // grab pick radius (px) — set from screen, not grid
let grabbed = -1
let ITER = 4

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  nx = new Float64Array(N); ny = new Float64Array(N)
  ox = new Float64Array(N); oy = new Float64Array(N)
  pin = new Int32Array(N)
  init()
  return px
}

export let init = () => {
  L = (W < H ? W : H) * 0.85 / GX
  R = (W < H ? W : H) * 0.1                                       // ~6 cells at 52-wide; fixed in px so finer grids stay grabbable
  let pinStep = Math.round(GX / 8.7)                              // hold the swag spacing (~9 anchors) as the grid scales
  let x0 = (W - (GX - 1) * L) * 0.5, y0 = H * 0.12
  let j = 0
  while (j < GY) {
    let i = 0
    while (i < GX) {
      let k = j * GX + i
      nx[k] = x0 + i * L; ny[k] = y0 + j * L
      ox[k] = nx[k]; oy[k] = ny[k]
      pin[k] = (j === 0 && (i % pinStep === 0 || i === GX - 1)) ? 1 : 0   // top row pinned at intervals
      k++
      i++
    }
    j++
  }
  grabbed = -1
}

// grab the nearest node to (gx,gy)
export let grab = (gx, gy) => {
  let best = 1e18, bi = -1, i = 0
  while (i < N) {
    let dx = nx[i] - gx, dy = ny[i] - gy, d = dx * dx + dy * dy
    if (d < best) { best = d; bi = i }
    i++
  }
  if (best < R * R) grabbed = bi
}
export let drag = (gx, gy) => { if (grabbed >= 0) { nx[grabbed] = gx; ny[grabbed] = gy; ox[grabbed] = gx; oy[grabbed] = gy } }
export let release = () => { grabbed = -1 }

let relax = (a, b) => {
  let dx = nx[b] - nx[a], dy = ny[b] - ny[a]
  let d = Math.sqrt(dx * dx + dy * dy) + 0.0001
  let diff = (d - L) / d * 0.5
  let mx = dx * diff, my = dy * diff
  let pa = pin[a] | (a === grabbed ? 1 : 0)
  let pb = pin[b] | (b === grabbed ? 1 : 0)
  if (pa === 0 && pb === 0) { nx[a] += mx; ny[a] += my; nx[b] -= mx; ny[b] -= my }
  else if (pa === 0) { nx[a] += mx * 2.0; ny[a] += my * 2.0 }
  else if (pb === 0) { nx[b] -= mx * 2.0; ny[b] -= my * 2.0 }
}

let line = (x0, y0, x1, y1, col) => {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx - dy, x = x0, y = y0
  let guard = 0
  while (guard < 4000) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = col
    if (x === x1 && y === y1) break
    let e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
    guard++
  }
}

export let frame = (t) => {
  // Verlet integrate
  let i = 0
  while (i < N) {
    if (pin[i] === 0 && i !== grabbed) {
      let vx = (nx[i] - ox[i]) * 0.99, vy = (ny[i] - oy[i]) * 0.99
      ox[i] = nx[i]; oy[i] = ny[i]
      nx[i] += vx; ny[i] += vy + 0.5            // gravity
    }
    i++
  }
  // satisfy structural constraints (right + down links)
  let k = 0
  while (k < ITER) {
    let j = 0
    while (j < GY) {
      let ii = 0
      while (ii < GX) {
        let a = j * GX + ii
        if (ii < GX - 1) relax(a, a + 1)
        if (j < GY - 1) relax(a, a + GX)
        ii++
      }
      j++
    }
    k++
  }

  // render: light paper, dark mesh
  let n = W * H, p = 0
  while (p < n) { px[p] = 0xfff3f1ec; p++ }
  let col = (255 << 24) | (40 << 16) | (36 << 8) | 34
  let j2 = 0
  while (j2 < GY) {
    let ii = 0
    while (ii < GX) {
      let a = j2 * GX + ii
      if (ii < GX - 1) { let b = a + 1; line(nx[a] | 0, ny[a] | 0, nx[b] | 0, ny[b] | 0, col) }
      if (j2 < GY - 1) { let b = a + GX; line(nx[a] | 0, ny[a] | 0, nx[b] | 0, ny[b] | 0, col) }
      ii++
    }
    j2++
  }
}

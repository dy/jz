// Diffusion-limited aggregation — a crystal grows by random walk. Thousands of walkers
// drift (random ±1 steps); when one touches the frozen cluster it sticks, then respawns
// on a ring just outside. From this you get a branching, coral-like fractal. The hot loop
// is scattered grid reads + cheap RNG per walker — a pointer-chasing stress for jz.
// resize(w,h) → Uint32Array; frame() grows the cluster.

let W = 0, H = 0, px
let grid              // Int32: 0 empty, else stick-order (for shading)
let wx, wy            // walker positions
let NW = 0
let gen = 1
let cxg = 0, cyg = 0  // cluster center
let maxR = 4.0        // current cluster radius
let SUB = 10          // walker substeps per frame

export let resize = (w, h) => {
  W = w; H = h
  grid = new Int32Array(w * h)
  px = new Uint32Array(w * h)
  NW = Math.min(40000, (w * h / 22) | 0)
  wx = new Float64Array(NW); wy = new Float64Array(NW)
  return px
}

let spawnR = () => maxR + 10.0
let killR = () => maxR + 40.0

let respawn = (i) => {
  let a = Math.random() * 6.283185307179586, r = spawnR()
  wx[i] = cxg + Math.cos(a) * r
  wy[i] = cyg + Math.sin(a) * r
}

export let seed = () => {
  let n = W * H, i = 0
  while (i < n) { grid[i] = 0; i++ }
  cxg = W * 0.5; cyg = H * 0.5; maxR = 4.0; gen = 1
  grid[(cyg | 0) * W + (cxg | 0)] = 1                 // central seed
  i = 0
  while (i < NW) { respawn(i); i++ }
}

let stuck = (xi, yi) => {
  if (xi < 1 || xi >= W - 1 || yi < 1 || yi >= H - 1) return 0
  let c = yi * W + xi
  if (grid[c - 1] !== 0 || grid[c + 1] !== 0 || grid[c - W] !== 0 || grid[c + W] !== 0) return 1
  return 0
}

export let frame = (t) => {
  let s = 0
  while (s < SUB) {
    let i = 0
    while (i < NW) {
      let xi = wx[i] | 0, yi = wy[i] | 0
      if (stuck(xi, yi)) {
        grid[yi * W + xi] = gen; gen++
        let dx = xi - cxg, dy = yi - cyg, r = Math.sqrt(dx * dx + dy * dy)
        if (r > maxR) maxR = r
        respawn(i)
      } else {
        // random step (8-neighbourhood drift)
        wx[i] += (Math.random() * 2.0 - 1.0)
        wy[i] += (Math.random() * 2.0 - 1.0)
        let dx = wx[i] - cxg, dy = wy[i] - cyg
        if (dx * dx + dy * dy > killR() * killR()) respawn(i)
      }
      i++
    }
    s++
  }

  // render: frozen cells white→gray by age, faint walkers as a dim dust
  let n = W * H, i = 0
  while (i < n) {
    let v = grid[i]
    let g = 0
    if (v !== 0) { g = 90 + (v * 255 / (gen + 1)) | 0; if (g > 255) g = 255 }
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
  // overlay walkers faintly so the "diffusion" is visible
  i = 0
  while (i < NW) {
    let xi = wx[i] | 0, yi = wy[i] | 0
    if (xi >= 0 && xi < W && yi >= 0 && yi < H) {
      let c = yi * W + xi
      if (grid[c] === 0) px[c] = (255 << 24) | (40 << 16) | (40 << 8) | 40
    }
    i++
  }
}

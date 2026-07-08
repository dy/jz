// Diffusion-limited aggregation — crystals grow by random walk. Thousands of walkers drift
// (random ±1 steps); when one touches a frozen crystal it sticks to THAT crystal, then
// respawns on a ring around a RANDOMLY CHOSEN crystal — so every crystal, wherever it was
// planted, keeps drawing a fair share of the shared walker supply instead of ones tucked
// behind a bigger neighbour going permanently hungry. Click plants a new seed crystal;
// double-click still resets to one central seed. Crystals compete and screen each other
// where their branches actually meet — a walker sticks to WHICHEVER crystal it touches
// first, so a crystal that reaches further into the shared space intercepts its neighbour's
// walkers. Each crystal shades a distinct grayscale band (cycling if seeds outnumber bands)
// with the usual dark→light age gradient inside its own band, so competitors stay visually
// distinguishable as they grow. Grid cells pack (ownerId<<24 | stickOrder) — 0 stays empty.
// The hot loop is scattered grid reads + cheap RNG per walker — a pointer-chasing stress for jz.
// resize(w,h) → Uint32Array; frame() grows the clusters; addSeed(x,y) plants a new crystal.

let W = 0, H = 0, px
let grid              // Int32: 0 empty, else (ownerId<<24 | stickOrder) — packed owner + age
let wx, wy            // walker positions
let wk                // which crystal (index) each walker last spawned near — for its kill radius
let NW = 0
let gen = 1
let SUB = 10          // walker substeps per frame
let NS = 0            // number of crystals seeded so far
let MAXSEEDS = 24     // cap — keeps the packed owner id and the shading bands sane
let BANDS = 6         // distinct grayscale bands; seeds beyond this cycle back to band 0
let sx, sy            // per-crystal seed center (fixed at plant time)
let sr                // per-crystal current growth radius (own ring, grows as IT sticks cells)

export let resize = (w, h) => {
  W = w; H = h
  grid = new Int32Array(w * h)
  px = new Uint32Array(w * h)
  NW = Math.min(40000, (w * h / 22) | 0)
  wx = new Float64Array(NW); wy = new Float64Array(NW)
  wk = new Int32Array(NW)
  sx = new Float64Array(MAXSEEDS); sy = new Float64Array(MAXSEEDS); sr = new Float64Array(MAXSEEDS)
  return px
}

let respawn = (i) => {
  let k = (Math.random() * NS) | 0
  if (k >= NS) k = NS - 1
  wk[i] = k
  let a = Math.random() * 6.283185307179586, r = sr[k] + 10.0
  wx[i] = sx[k] + Math.cos(a) * r
  wy[i] = sy[k] + Math.sin(a) * r
}

// Plant crystal index k at (xi,yi): stake its center/radius and freeze its first cell.
let plant = (k, xi, yi) => {
  sx[k] = xi; sy[k] = yi; sr[k] = 4.0
  grid[yi * W + xi] = ((k + 1) << 24) | gen; gen++
}

export let seed = () => {
  let n = W * H, i = 0
  while (i < n) { grid[i] = 0; i++ }
  gen = 1; NS = 1
  plant(0, W * 0.5 | 0, H * 0.5 | 0)
  i = 0
  while (i < NW) { respawn(i); i++ }
}

// Plant a new competing crystal at (x,y) — it draws from the same shared walker supply,
// spawning its own fair share on its own ring (see respawn), regardless of where it sits
// relative to any other crystal already growing.
export let addSeed = (x, y) => {
  if (NS >= MAXSEEDS) return
  let xi = x | 0, yi = y | 0
  if (xi < 1 || xi >= W - 1 || yi < 1 || yi >= H - 1) return
  plant(NS, xi, yi)
  NS++
}

// which crystal (ownerId, 1-based) occupies a neighbour of (xi,yi); 0 if none is stuck there
let stuck = (xi, yi) => {
  if (xi < 1 || xi >= W - 1 || yi < 1 || yi >= H - 1) return 0
  let c = yi * W + xi
  let v = grid[c - 1]; if (v !== 0) return v >>> 24
  v = grid[c + 1]; if (v !== 0) return v >>> 24
  v = grid[c - W]; if (v !== 0) return v >>> 24
  v = grid[c + W]; if (v !== 0) return v >>> 24
  return 0
}

export let frame = (t) => {
  let s = 0
  while (s < SUB) {
    let i = 0
    while (i < NW) {
      let xi = wx[i] | 0, yi = wy[i] | 0
      let owner = stuck(xi, yi)
      if (owner !== 0) {
        grid[yi * W + xi] = (owner << 24) | gen; gen++
        let k = owner - 1
        let dx = xi - sx[k], dy = yi - sy[k], r = Math.sqrt(dx * dx + dy * dy)
        if (r > sr[k]) sr[k] = r
        respawn(i)
      } else {
        // random step (8-neighbourhood drift)
        wx[i] += (Math.random() * 2.0 - 1.0)
        wy[i] += (Math.random() * 2.0 - 1.0)
        let k = wk[i]
        let dx = wx[i] - sx[k], dy = wy[i] - sy[k], kr = sr[k] + 40.0
        if (dx * dx + dy * dy > kr * kr) respawn(i)
      }
      i++
    }
    s++
  }

  // render: each crystal its own gray band (dark→light age gradient within it), faint
  // walkers overlaid as a dim dust
  let n = W * H, i = 0
  while (i < n) {
    let v = grid[i]
    let g = 0
    if (v !== 0) {
      let owner = v >>> 24, age = v & 0xffffff
      let base = 60 + ((owner - 1) % BANDS) * 30
      g = base + ((age * 20 / (gen + 1)) | 0)
      if (g > 255) g = 255
    }
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

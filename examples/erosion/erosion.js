// Hydraulic erosion — a fractal heightmap carved by thousands of rain droplets. Each
// droplet rolls downhill (gradient + inertia), erodes terrain when it has spare capacity
// (steep/fast/full of water) and deposits sediment when it slows or climbs — so valleys,
// ridges and deltas emerge. Every droplet also deposits water-flux along its path into a
// field that decays slowly frame to frame; where droplets keep converging (valleys) it
// accumulates, and rendering brightness ∝ log(flux) — gated to roughly the top tenth of
// cells, so it stays a thin accent — turns that into a faintly cool river network over the
// grayscale hill-shaded relief — a dendritic drainage pattern emerges on its own over a few
// seconds. Click for a local rain burst. Lots of
// gradient sampling + scattered read-modify-write over the grid: a memory + branch
// workout for jz. resize(w,h) → Uint32Array; frame() rains; reseed() makes new terrain.

let W = 0, H = 0, px
let hmap              // height field
let flux               // water-flux accumulation (rivers) — decays slowly, fed by every droplet step
let fluxRef            // Float64Array[1] — running peak flux, so the river curve below self-calibrates
                        // regardless of canvas resolution (DROPS is a fixed count spread over W×H cells)
let DROPS = 700, STEPS = 34
let FLUX_DECAY = 0.992                        // slow per-frame decay — trails outlive any single frame
// fraction of peak below which flux is ambient scatter, not a channel. At steady state the
// per-cell flux distribution is broad, not a sharp channel/background split: the MEDIAN cell
// already sits at ~0.16 of peak and the top quartile clears ~0.25 — so the old 0.2 floor let
// over a third of every frame's cells tint blue, reading as a pale wash instead of a network
// (measured: 28–37% of cells lit, mean intensity ~0.15). 0.3 keeps roughly the top tenth.
let FLUX_BASE_FRAC = 0.36
let FLUX_GAIN = 3.0, FLUX_SCALE = 0.55        // log(excess above the floor) → 0..1 river intensity
                                               // (SCALE trimmed 0.65→0.55: even a fully-qualifying
                                               // cell now blends toward the river colour rather
                                               // than replacing it outright, so relief still reads
                                               // through the strongest channels)
let RIVER_R = 15.0, RIVER_G = 130.0, RIVER_B = 255.0   // thin tint, faintly cool (water-tinted)
let RAIN_DROPS = 140, RAIN_R = 3.0            // a click's local burst: droplets clustered near the cursor

export let resize = (w, h) => {
  W = w; H = h
  hmap = new Float64Array(w * h)
  flux = new Float64Array(w * h)
  fluxRef = new Float64Array(1)
  px = new Uint32Array(w * h)
  reseed()
  return px
}

let hash = (i, j) => {
  let s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
  return s - Math.floor(s)
}
let smooth = (t) => t * t * (3.0 - 2.0 * t)
let vnoise = (x, y) => {
  let xi = Math.floor(x), yi = Math.floor(y)
  let fx = smooth(x - xi), fy = smooth(y - yi)
  let a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

export let reseed = () => {
  let off = Math.random() * 1000.0
  let y = 0
  while (y < H) {
    let row = y * W, x = 0
    while (x < W) {
      let nx = x / W, ny = y / H
      let e = 0.0, amp = 1.0, fr = 3.0
      let o = 0
      while (o < 5) { e += amp * vnoise(nx * fr + off, ny * fr + off); amp *= 0.5; fr *= 2.0; o++ }
      hmap[row + x] = e
      flux[row + x] = 0.0
      x++
    }
    y++
  }
  fluxRef[0] = 0.0
}

let hAt = (xi, yi) => hmap[yi * W + xi]

// Roll one droplet from (fx,fy): gradient + inertia steering, erode/deposit sediment, and
// deposit flux at every cell it passes through — the shared step behind both ambient rain
// (frame(), random starts) and a local rain() burst (clustered around a click).
let dropOne = (fx, fy) => {
  let dx = 0.0, dy = 0.0, speed = 0.0, water = 1.0, sed = 0.0
  let s = 0
  while (s < STEPS) {
    let xi = fx | 0, yi = fy | 0
    if (xi < 1 || xi >= W - 1 || yi < 1 || yi >= H - 1) break
    let u = fx - xi, v = fy - yi
    // bilinear gradient
    let gx = (hAt(xi + 1, yi) - hAt(xi, yi)) * (1 - v) + (hAt(xi + 1, yi + 1) - hAt(xi, yi + 1)) * v
    let gy = (hAt(xi, yi + 1) - hAt(xi, yi)) * (1 - u) + (hAt(xi + 1, yi + 1) - hAt(xi + 1, yi)) * u
    // steer: blend old direction (inertia) with downhill
    dx = dx * 0.85 - gx * 0.15
    dy = dy * 0.85 - gy * 0.15
    let dl = Math.sqrt(dx * dx + dy * dy) + 0.0001
    dx /= dl; dy /= dl
    let nfx = fx + dx, nfy = fy + dy
    let nxi = nfx | 0, nyi = nfy | 0
    if (nxi < 1 || nxi >= W - 1 || nyi < 1 || nyi >= H - 1) break
    let hOld = hAt(xi, yi), hNew = hAt(nxi, nyi)
    let dh = hNew - hOld
    let here = yi * W + xi
    flux[here] += water                    // rivers = the cells droplets keep passing through
    if (dh > 0.0) {
      // climbing → drop sediment to fill (up to the bump)
      let dep = sed < dh ? sed : dh
      hmap[here] += dep; sed -= dep
    } else {
      let cap = (-dh) * speed * water * 4.0 + 0.001
      if (sed > cap) { let dep = (sed - cap) * 0.3; hmap[here] += dep; sed -= dep }
      else { let ero = (cap - sed) * 0.3; if (ero > -dh) ero = -dh; hmap[here] -= ero; sed += ero }
    }
    let arg = speed * speed - dh * 4.0       // dh<0 downhill speeds up; clamp so no NaN uphill
    if (arg < 0.0) arg = 0.0
    speed = Math.sqrt(arg + 0.0001)
    water *= 0.98
    fx = nfx; fy = nfy
    if (water < 0.01) break
    s++
  }
}

export let frame = (t) => {
  let d = 0
  while (d < DROPS) {
    dropOne(Math.random() * (W - 2) + 1, Math.random() * (H - 2) + 1)
    d++
  }

  // render: grayscale hill-shading (light from upper-left) + a thin river tint on the
  // strongest-flux cells only, brightness ∝ log(flux); the flux field decays here too, once per frame
  let lx = -0.5, ly = -0.6, lz = 0.62
  let ref = fluxRef[0]; if (ref < 1.0) ref = 1.0     // last frame's peak — this frame's normalizer
  let peak = 0.0
  let y = 0
  while (y < H) {
    let row = y * W, x = 0
    while (x < W) {
      let c = row + x
      let yn = y > 0 ? c - W : c, ys = y < H - 1 ? c + W : c
      // Strong relief: a big slope scale + a shading-dominated ramp on a dark base so the carved
      // ridges and valleys read as real topography (the old 8×/40+70·h+150·sh washed the eroded,
      // near-flat terrain to a flat light gray — the relief barely showed).
      let nx = (hmap[c - (x > 0 ? 1 : 0)] - hmap[c + (x < W - 1 ? 1 : 0)]) * 20.0
      let ny = (hmap[yn] - hmap[ys]) * 20.0
      let inv = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0)
      let sh = (nx * lx + ny * ly + lz) * inv
      if (sh < 0.0) sh = 0.0
      let g = 18.0 + hmap[c] * 40.0 + sh * 210.0
      if (g > 255.0) g = 255.0
      if (g < 0.0) g = 0.0

      let fl = flux[c]
      if (fl > peak) peak = fl
      let fn = fl / ref - FLUX_BASE_FRAC         // normalized 0..~1, floor stripped off as ambient scatter
      let riv = fn > 0.0 ? Math.log(fn * FLUX_GAIN + 1.0) * FLUX_SCALE : 0.0
      if (riv > 1.0) riv = 1.0
      let r = (g + (RIVER_R - g) * riv) | 0
      let gg = (g + (RIVER_G - g) * riv) | 0
      let b = (g + (RIVER_B - g) * riv) | 0
      px[c] = (255 << 24) | (b << 16) | (gg << 8) | r

      flux[c] = fl * FLUX_DECAY
      x++
    }
    y++
  }
  fluxRef[0] = ref * 0.7 + peak * 0.3          // smoothed running peak for next frame's normalizer
}

// A local rain burst: droplets clustered near (x,y) — click a spot and watch a tiny
// drainage fan carve outward and join the flux network.
export let rain = (x, y) => {
  let k = 0
  while (k < RAIN_DROPS) {
    let ang = Math.random() * 6.283185307, rad = Math.random() * RAIN_R
    let fx = x + Math.cos(ang) * rad, fy = y + Math.sin(ang) * rad
    if (fx < 1.0) fx = 1.0; else if (fx > W - 2.0) fx = W - 2.0
    if (fy < 1.0) fy = 1.0; else if (fy > H - 2.0) fy = H - 2.0
    dropOne(fx, fy)
    k++
  }
}

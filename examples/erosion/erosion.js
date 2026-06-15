// Hydraulic erosion — a fractal heightmap carved by thousands of rain droplets. Each
// droplet rolls downhill (gradient + inertia), erodes terrain when it has spare capacity
// (steep/fast/full of water) and deposits sediment when it slows or climbs — so valleys,
// ridges and deltas emerge. The terrain is drawn as a grayscale hill-shaded relief. Lots
// of gradient sampling + scattered read-modify-write over the grid: a memory + branch
// workout for jz. resize(w,h) → Uint32Array; frame() rains; reseed() makes new terrain.

let W = 0, H = 0, px
let hmap              // height field
let DROPS = 700, STEPS = 34

export let resize = (w, h) => {
  W = w; H = h
  hmap = new Float64Array(w * h)
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
      x++
    }
    y++
  }
}

let hAt = (xi, yi) => hmap[yi * W + xi]

export let frame = (t) => {
  let d = 0
  while (d < DROPS) {
    let fx = Math.random() * (W - 2) + 1, fy = Math.random() * (H - 2) + 1
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
    d++
  }

  // render: grayscale hill-shading (light from upper-left) + height tint
  let lx = -0.5, ly = -0.6, lz = 0.62
  let y = 0
  while (y < H) {
    let row = y * W, x = 0
    while (x < W) {
      let c = row + x
      let xw = x > 0 ? x - 1 : x, xe = x < W - 1 ? x + 1 : x
      let yn = y > 0 ? c - W : c, ys = y < H - 1 ? c + W : c
      let nx = (hmap[c - (x > 0 ? 1 : 0)] - hmap[c + (x < W - 1 ? 1 : 0)]) * 8.0
      let ny = (hmap[yn] - hmap[ys]) * 8.0
      let inv = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0)
      let sh = (nx * lx + ny * ly + lz) * inv
      if (sh < 0.0) sh = 0.0
      let g = (40.0 + hmap[c] * 70.0 + sh * 150.0) | 0
      if (g > 255) g = 255
      if (g < 0) g = 0
      px[c] = (255 << 24) | (g << 16) | (g << 8) | g
      x++
    }
    y++
  }
}

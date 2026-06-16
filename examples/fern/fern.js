// Barnsley fern — chaos game IFS (Iterated Function System). Four affine maps are chosen
// at random by probability; repeated application drives a point toward the fern attractor.
// State (x, y) is persistent: each frame() adds ~40000 iterations, accumulating a density
// map that is log-tone-mapped to green-channel pixels, giving a smooth luminosity gradient.
//
// Wind sway: f2 (the main stem/leaf map, p=0.85) is perturbed each frame by `sway`, a
// small sinusoidal offset passed from the host, so the fern bends gently in the breeze.
// Drag the mouse to steer the sway manually.
//
// jz typing notes: x/y must live in Float64Array (module globals are i32-narrowed).
// dens is Uint32Array. Loop counters and indices are i32. No closures over mutable locals.

let W = 0, H = 0, px
let dens           // Uint32Array — hit count per pixel
let st             // Float64Array[2] — current (x, y) of the chaos-game point

// Fern bounding box: x∈[-2.2, 2.7], y∈[0, 10]. Tall, not wide — fit to height.
// scaleX, scaleY, offX, offY map fern coords → pixel coords.
let scaleY = 0.0, scaleX = 0.0, offX = 0.0, offY = 0.0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  dens = new Uint32Array(w * h)
  st = new Float64Array(2)  // [x, y]
  // fit fern height [0,10] to canvas height with small margin
  scaleY = (h - 4.0) / 10.0
  scaleX = scaleY           // isotropic
  // fern x center is (-2.2+2.7)/2 = 0.25; map that to canvas center
  offX = w * 0.5 - 0.25 * scaleX
  offY = h - 2.0            // y=0 (stem base) near bottom
  return px
}

export let init = () => {
  let n = W * H, i = 0
  while (i < n) { dens[i] = 0; px[i] = 255 << 24; i++ }
  st[0] = 0.0; st[1] = 0.0
}

export let clear = () => {
  init()
}

export let frame = (t, sway) => {
  let x = st[0], y = st[1]

  // f2 coefficients with wind sway
  let f2a = 0.85 + sway * 0.02
  let f2b = 0.04 + sway
  let f2c = -0.04 - sway
  let f2d = 0.85

  let iter = 0
  while (iter < 40000) {
    let r = Math.random()
    let nx = 0.0, ny = 0.0
    if (r < 0.01) {
      // f1: stem base — maps everything near the base
      nx = 0.0
      ny = 0.16 * y
    } else if (r < 0.86) {
      // f2: main leaflets (with wind sway)
      nx = f2a * x + f2b * y
      ny = f2c * x + f2d * y + 1.6
    } else if (r < 0.93) {
      // f3: left leaflet
      nx = 0.2 * x - 0.26 * y
      ny = 0.23 * x + 0.22 * y + 1.6
    } else {
      // f4: right leaflet
      nx = -0.15 * x + 0.28 * y
      ny = 0.26 * x + 0.24 * y + 0.44
    }
    x = nx; y = ny

    // map fern coords to pixel
    let px_ = (x * scaleX + offX) | 0
    let py_ = (offY - y * scaleY) | 0

    if (px_ >= 0 & px_ < W & py_ >= 0 & py_ < H) {
      let idx = py_ * W + px_
      dens[idx] = dens[idx] + 1
    }
    iter++
  }

  st[0] = x; st[1] = y

  // log tone-map: density → gray (white fern on black)
  let n = W * H, i = 0
  while (i < n) {
    let d = dens[i]
    if (d === 0) {
      px[i] = 255 << 24
    } else {
      let g = (Math.log(d + 1.0) * 44.0) | 0
      if (g > 255) g = 255
      px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    }
    i++
  }
}

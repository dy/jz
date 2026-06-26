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
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed. The fern paints in the page ink over the
// page paper (B&W by default — the palette button can still colorize it). Default = dark theme.
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0
export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

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

let acc = 0   // frames accumulated since the last restart (view change)

// panX/panY (backing pixels) + zoom give the fern a pan/zoom view; sway still bends it in the wind.
// restart=1 clears + restarts the accumulation (view moved, or animating at home); 0 accumulates.
export let frame = (t, sway, panX, panY, zoom, restart) => {
  let cxv = W * 0.5, cyv = H * 0.5   // zoom pivots about the screen centre

  let nc = W * H
  if (restart != 0) { let c0 = 0; while (c0 < nc) { dens[c0] = 0; c0++ } acc = 0 }

  // A deeper zoom dilutes each frame's points across more screen pixels, so let detail BUILD UP over
  // ~zoom² frames until the magnified window is as dense as the home view, then hold the finished
  // image. The host freezes the sway this deep, so nothing smears — and the count self-normalises
  // brightness (≈zoom² more frames exactly offsets the ≈zoom² dilution).
  let target = zoom * zoom
  if (target < 1.0) target = 1.0
  if (target > 320.0) target = 320.0

  let x = st[0], y = st[1]
  if (acc < target) {
    let f2a = 0.85 + sway * 0.02, f2b = 0.04 + sway, f2c = -0.04 - sway, f2d = 0.85
    let iters = 200000, iter = 0
    while (iter < iters) {
      let r = Math.random()
      let nx = 0.0, ny = 0.0
      if (r < 0.01) { nx = 0.0; ny = 0.16 * y }                                  // f1: stem base
      else if (r < 0.86) { nx = f2a * x + f2b * y; ny = f2c * x + f2d * y + 1.6 } // f2: main leaflets (sway)
      else if (r < 0.93) { nx = 0.2 * x - 0.26 * y; ny = 0.23 * x + 0.22 * y + 1.6 } // f3: left leaflet
      else { nx = -0.15 * x + 0.28 * y; ny = 0.26 * x + 0.24 * y + 0.44 }         // f4: right leaflet
      x = nx; y = ny
      // fern coords → pixel, then the pan/zoom view (zoom about screen centre + pan)
      let bx = x * scaleX + offX, by = offY - y * scaleY
      let px_ = ((bx - cxv) * zoom + cxv + panX) | 0
      let py_ = ((by - cyv) * zoom + cyv + panY) | 0
      if (px_ >= 0 & px_ < W & py_ >= 0 & py_ < H) { let idx = py_ * W + px_; dens[idx] = dens[idx] + 1 }
      iter++
    }
    st[0] = x; st[1] = y
    acc = acc + 1
  }

  // tone-map: density → ink, composited paper→ink (accumulation supplies the density now).
  let pr = th[0], pg = th[1], pb = th[2], ir = th[3], ig = th[4], ib = th[5]
  let pk = (255 << 24) | ((pb | 0) << 16) | ((pg | 0) << 8) | (pr | 0)   // packed paper
  let n = W * H, i = 0
  while (i < n) {
    let d = dens[i]
    if (d === 0) {
      px[i] = pk                                            // bare ground = page paper
    } else {
      let v = (Math.log(d + 1.0) * 44.0) / 255.0            // density → 0..1
      if (v > 1.0) v = 1.0
      let r = (pr + (ir - pr) * v) | 0                      // paper → ink frond
      let g = (pg + (ig - pg) * v) | 0
      let b = (pb + (ib - pb) * v) | 0
      px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    }
    i++
  }
}

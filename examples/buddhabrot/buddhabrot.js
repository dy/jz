// Buddhabrot — density histogram of complex trajectories that escape the Mandelbrot set.
// Unlike Mandelbrot (color = escape time for THIS pixel's c), Buddhabrot counts how many
// trajectories PASS THROUGH each pixel. The result accumulates across frames into a luminous
// nebula. frame(t, vcx, vcy, vscale) plots through a view centred at (vcx,vcy) with half-height
// vscale — the host drives those from scroll-zoom / drag-pan.
//
// The density is a DECAYING accumulator (dens *= DECAY each frame, then new samples add), so it
// holds a rolling ~1/(1−DECAY) ≈ 25 frames of orbits. On pan/zoom the old view fades out over
// ~½s while the new view sharpens IN PLACE — no hard wipe, no flash to black. That is the
// "retain quality on zoom": detail is always present and continuously refining. dens is f64 so
// the decay multiply stays smooth (a u32 histogram would quantise the fade to steps).
let W = 0, H = 0, px, dens, aspect = 1.0
let DECAY = 0.985          // longer rolling window (~66 frames) → a smoother, deeper-exposed nebula
let MAXIT = 320            // longer orbits resolve the fine filaments you see when zoomed in
// trajectory scratch: store (x,y) pairs for up to MAXIT steps
let traj  // Float64Array of length 2*MAXIT
let pk = new Float64Array(1)   // smoothed normalization peak (EMA) — kills per-frame brightness flicker
let plut = new Int32Array(256) // tone-curve LUT: quantized brightness → γ-mapped gray; rebuilt per frame

export let resize = (w, h) => {
  W = w; H = h; aspect = w / h
  dens = new Float64Array(w * h)
  px = new Uint32Array(w * h)
  traj = new Float64Array(640)  // 2*MAXIT
  pk[0] = 1.0
  return px
}

export let init = () => {
  let i = 0, n = W * H
  while (i < n) { dens[i] = 0.0; i++ }
}

export let clear = () => {
  let i = 0, n = W * H
  while (i < n) { dens[i] = 0.0; i++ }
}

export let frame = (t, vcx, vcy, vscale) => {
  // Fade the rolling accumulator before adding this frame's orbits (temporal averaging).
  let di = 0, dn = W * H
  while (di < dn) { dens[di] = dens[di] * DECAY; di++ }

  // Concentrate more samples as you zoom in: the visible window catches a smaller slice of orbits,
  // so a fixed count thins out and goes grainy. Scale with zoom depth (1.5 = the home half-height),
  // capped, so a deep view keeps resolving the filaments instead of speckling.
  let zf = 1.5 / vscale; if (zf < 1.0) zf = 1.0; if (zf > 3.0) zf = 3.0
  let samples = (45000.0 * zf) | 0
  let halfW = vscale * aspect      // half-width of the view in world units (aspect-corrected)
  let s = 0
  while (s < samples) {
    // random point in c-plane (bounding box of Mandelbrot)
    let cx = Math.random() * 3.0 - 2.0   // [-2.0, 1.0]
    let cy = Math.random() * 3.0 - 1.5   // [-1.5, 1.5]
    // iterate z = z^2 + c, storing trajectory
    let x = 0.0, y = 0.0
    let it = 0
    // store trajectory in scratch
    while (it < MAXIT) {
      let nx = x * x - y * y + cx
      let ny = 2.0 * x * y + cy
      x = nx; y = ny
      traj[it * 2] = x
      traj[it * 2 + 1] = y
      if (x * x + y * y > 4.0) break
      it++
    }
    // only plot escaped trajectories
    if (it < MAXIT) {
      // replay trajectory up to escape
      let k = 0
      while (k < it) {
        let tx = traj[k * 2]
        let ty = traj[k * 2 + 1]
        // map world (tx,ty) → pixel through the current view (centre vcx,vcy, half-height vscale)
        let ix = (((tx - vcx) / halfW * 0.5 + 0.5) * W) | 0
        let iy = (((ty - vcy) / vscale * 0.5 + 0.5) * H) | 0
        if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
          let idx = iy * W + ix
          dens[idx] = dens[idx] + 1
        }
        // mirror point (the set is symmetric about the real axis y=0)
        let iym = (((-ty - vcy) / vscale * 0.5 + 0.5) * H) | 0
        if (ix >= 0 && ix < W && iym >= 0 && iym < H) {
          let idxm = iym * W + ix
          dens[idxm] = dens[idxm] + 1
        }
        k++
      }
    }
    s++
  }

  // tone-map → grayscale, NORMALIZED by the current max so it never blows out to white as
  // samples accumulate (it sharpens over time). LINEAR ratio with γ>1 — the diffuse background
  // (~10% of peak) is crushed toward black so only the bright nebula filaments stand out. A log
  // curve here lifts that background to gray and washes the whole image out.
  let i = 0, n = W * H
  let maxD = 1
  while (i < n) { if (dens[i] > maxD) maxD = dens[i]; i++ }
  // Normalize by a SMOOTHED peak (EMA), not the instantaneous frame max — the random sampling makes
  // the raw max jitter frame-to-frame, and dividing by it flickers the whole image. Smoothing holds
  // the exposure steady so the nebula sharpens instead of strobing.
  pk[0] = pk[0] * 0.9 + maxD * 0.1
  let inv = 1.0 / pk[0]
  // The γ-curve v→gv yields only 256 distinct grays (gv is a u8), and the per-pixel Math.pow is the
  // one place jz's polyfill trails V8's native pow. Precompute the curve once per frame (as bifurcation
  // already does for its log tonemap) and make the per-pixel pass a gather — bit-exact JS≡jz (both
  // build the same table) and faster on both engines.
  let k = 0
  while (k < 256) {
    let g = (Math.pow(k / 255.0, 1.2) * 255.0) | 0   // γ>1: bg (~0.1 of peak) → ~16 (dark); filaments bright
    if (g > 255) g = 255
    plut[k] = g
    k++
  }
  i = 0
  while (i < n) {
    let d = dens[i]
    let gv = 0
    if (d > 0) {
      let q = (d * inv * 255.0) | 0            // brightness 0..1 → bucket 0..255
      if (q > 255) q = 255
      gv = plut[q]
    }
    px[i] = (255 << 24) | (gv << 16) | (gv << 8) | gv
    i++
  }
}

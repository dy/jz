// Bifurcation diagram — logistic map x_{n+1} = r·x·(1−x) orbit diagram.
// Each pixel column corresponds to a growth rate r. For each r, warm up the
// orbit, then record where it dwells: density[row*W+col]++. Log-tonemap to
// amber: period-1 → period-2 → period-4 → … cascade → chaos, with bright
// Feigenbaum windows. r0/r1 window comes in as frame args (f64) so it stays
// fractional. Internal fractional state uses Float64Array (not scalar globals,
// which would be i32-narrowed in jz).

let W = 0, H = 0, dens, px
let tone  // Uint8Array — density→gray log-tonemap LUT, precomputed once (no per-pixel Math.log)

// r0, r1, x window bounds live in Float64Array to preserve f64 in jz
let st = new Float64Array(2) // [r0, r1] — fallback in case args missing

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)
  px = new Uint32Array(w * h)
  st[0] = 2.5
  st[1] = 4.0
  // Precompute the log tonemap: gray = min(255, log(d+1)·90). It saturates at 255 by d≈16 and the
  // per-column density caps at PLOT, so a 512-entry LUT covers every value — turning the hot
  // tonemap into a flat table read (fast in JS AND jz; a gather won't trip the transcendental
  // map-vectorizer that made the per-pixel log slower than scalar). tone[0]=0 → v=0 stays black.
  tone = new Uint8Array(512)
  let k = 0
  while (k < 512) {
    let L = Math.log(k + 1.0) * 90.0
    if (L > 255.0) L = 255.0
    tone[k] = L | 0
    k++
  }
  return px
}

// (r0,r1) = horizontal growth-rate window; (x0,x1) = vertical orbit-value window. Both shrink to
// zoom into the self-similar Feigenbaum cascade; panning slides the windows. All f64 args.
export let frame = (t, r0, r1, x0, x1) => {
  let lo = r0, hi = r1
  let invXspan = 1.0 / (x1 - x0)
  let n = W * H, i = 0
  while (i < n) { dens[i] = 0; i++ }

  let WARMUP = 300, PLOT = 300
  let col = 0
  while (col < W) {
    let r = lo + (col / W) * (hi - lo)
    let x = 0.5
    // warmup: let transients die
    let k = 0
    while (k < WARMUP) { x = r * x * (1.0 - x); k++ }
    // plot: record where orbit dwells (mapped through the visible x-window: x1 at top, x0 at bottom)
    k = 0
    while (k < PLOT) {
      x = r * x * (1.0 - x)
      let row = ((x1 - x) * invXspan * H) | 0
      if (row >= 0 && row < H) {
        let idx = row * W + col
        dens[idx] = dens[idx] + 1
      }
      k++
    }
    col++
  }

  // log-tonemap density → grayscale via the precomputed LUT (flat table read, no per-pixel log)
  i = 0
  while (i < n) {
    let v = dens[i]
    if (v > 511) v = 511
    let gv = tone[v]
    px[i] = (255 << 24) | (gv << 16) | (gv << 8) | gv
    i++
  }
}

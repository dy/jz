// Bifurcation diagram — logistic map x_{n+1} = r·x·(1−x) orbit diagram.
// Each pixel column corresponds to a growth rate r. For each r, warm up the
// orbit, then record where it dwells: density[row*W+col]++. Log-tonemap to
// amber: period-1 → period-2 → period-4 → … cascade → chaos, with bright
// Feigenbaum windows. r0/r1 window comes in as frame args (f64) so it stays
// fractional. Internal fractional state uses Float64Array (not scalar globals,
// which would be i32-narrowed in jz).

let W = 0, H = 0, dens, px

// r0, r1, x window bounds live in Float64Array to preserve f64 in jz
let st = new Float64Array(2) // [r0, r1] — fallback in case args missing

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)
  px = new Uint32Array(w * h)
  st[0] = 2.5
  st[1] = 4.0
  return px
}

export let frame = (t, r0, r1) => {
  // use frame args if provided (they're f64), else fall back to st[]
  let lo = r0, hi = r1
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
    // plot: record where orbit dwells
    k = 0
    while (k < PLOT) {
      x = r * x * (1.0 - x)
      let row = ((1.0 - x) * H) | 0
      if (row >= 0 && row < H) {
        let idx = row * W + col
        dens[idx] = dens[idx] + 1
      }
      k++
    }
    col++
  }

  // log-tonemap density → grayscale
  i = 0
  while (i < n) {
    let v = dens[i]
    if (v > 0) {
      let L = Math.log(v + 1.0) * 90.0
      if (L > 255.0) L = 255.0
      let gv = L | 0
      px[i] = (255 << 24) | (gv << 16) | (gv << 8) | gv
    } else {
      px[i] = (255 << 24)
    }
    i++
  }
}

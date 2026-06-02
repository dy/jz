// Strange attractor — Peter de Jong's map, iterated a few million times into a
// density histogram, then log-tone-mapped to a luminous curve:
//   xₙ₊₁ = sin(a·yₙ) − cos(b·xₙ)
//   yₙ₊₁ = sin(c·xₙ) − cos(d·yₙ)
// The hot loop is four transcendentals per iteration over millions of iterations —
// jz's exact sweet spot. The same source is the V8 baseline (imported) and compiles
// to wasm. (The map is chaotic, so jz's sub-ulp sin/cos make individual points drift
// from V8's, but the attractor's shape — its invariant density — is identical.)
let W = 0, H = 0, dens, px

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)   // integer hit-counts; half the memory traffic of f64
  px = new Uint32Array(w * h)
  return px
}

export let frame = (a, b, c, d, iters) => {
  let n = W * H, i = 0
  while (i < n) { dens[i] = 0; i++ }

  let x = 0.1, y = 0.1
  let cx = W * 0.5, cy = H * 0.5, scale = (W < H ? W : H) * 0.245
  let k = 0
  while (k < iters) {
    let nx = Math.sin(a * y) - Math.cos(b * x)
    let ny = Math.sin(c * x) - Math.cos(d * y)
    x = nx; y = ny
    let ix = (cx + x * scale) | 0
    let iy = (cy + y * scale) | 0
    if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
      let idx = iy * W + ix
      dens[idx] = dens[idx] + 1
    }
    k++
  }

  // log density → brightness, dark → teal → warm white
  i = 0
  while (i < n) {
    let v = dens[i]
    let L = v > 0.0 ? Math.log(v + 1.0) * 44.0 : 0.0
    if (L > 255.0) L = 255.0
    let g = L | 0
    let r = (g * g / 255) | 0
    let bl = (g * 210 / 255) | 0
    px[i] = (255 << 24) | (bl << 16) | (g << 8) | r
    i++
  }
}

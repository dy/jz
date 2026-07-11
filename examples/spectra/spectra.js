// Spectra — ⋃ᵢ spec(Aᵢ) ⊂ ℂ for a stream of random 6×6 real matrices, splatted into a rolling
// density map over the complex plane. Reproduces Simone Conradi's random-matrix piece
// (x.com/S_Conradi/status/2075661669854843080) with the exact formula from its title card:
//   Aᵢ ∈ ℂ^{6×6},  Re(a_jk) ~iid 2·Beta(α,β) − 1,  Im(a_jk) = 0,  β = 0.010, α animated
// (his earlier 3×3 study: x.com/S_Conradi/status/2074212837770092691). For tiny α,β an entry
// is almost a coin flip between ±1 — "Bohemian" matrices whose spectra form a crisp wireframe
// of arcs and starbursts — and the rare entries that land BETWEEN ±1 sweep those arcs into
// glowing filigree. As α grows the lace melts into the smooth double-lobed cloud of continuous
// random matrices. Complex eigenvalues come in conjugate pairs (the figure is exactly mirror-
// symmetric); real ones line the bright axis.
//
// Per matrix: Beta(α,β) sampled via the log-space Gamma ratio X = 1/(1+exp(lnU₂/β − lnU₁/α))
// (exact where it matters — the α,β ≪ 1 regime), the characteristic polynomial by
// Faddeev–LeVerrier (exact traces, no factorization), roots by Durand–Kerner — all six
// eigenvalues refined simultaneously to sub-pixel accuracy in a few dozen sweeps. The density
// DECAYS each frame (buddhabrot-style rolling exposure), so morphing α leaves a smooth trail
// and a held α converges. frame(t, alpha, beta); reseed(s); resize(w,h) → px.
let W = 0, H = 0, px, dens
let rs = 0            // xorshift32 state — i32 wraps identically in JS and jz
let DECAY = 0.975
let MATS = 3000       // matrices per frame → 18k eigenvalues; the rolling window holds ~720k
let N = 6
let A = new Float64Array(36)    // the random matrix
let FM = new Float64Array(36)   // Faddeev–LeVerrier accumulator M_k
let FT = new Float64Array(36)   // scratch A·M_k
let co = new Float64Array(7)    // char poly λ⁶ + co[1]λ⁵ + … + co[6]
let zr = new Float64Array(6), zi = new Float64Array(6)   // Durand–Kerner root set
let llut              // Int32Array(1024) — log tone curve, rebuilt in resize

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  dens = new Float64Array(w * h)
  rs = 88172645
  llut = new Int32Array(1024)
  let i = 0
  while (i < 1024) {
    // bucket i ↔ lifted density q = i/8: g = 255·ln(1+q)/ln(1+128) — clips the cores, lifts lace
    let g = (255.0 * Math.log(1.0 + i * 0.125) / 4.859812404361672) | 0
    if (g > 255) g = 255
    llut[i] = g
    i++
  }
  return px
}

export let reseed = (s) => {
  let v = s | 0
  if (v === 0) v = 88172645
  rs = v
  let i = 0, n = W * H
  while (i < n) { dens[i] = 0.0; i++ }
}

// xorshift32 → uniform (0,1]
let rnd = () => {
  rs = rs ^ (rs << 13)
  rs = rs ^ (rs >>> 17)
  rs = rs ^ (rs << 5)
  return (((rs >>> 9) | 0) + 1) / 8388609.0
}

export let frame = (t, alpha, beta) => {
  let n = W * H
  let i = 0
  while (i < n) { dens[i] = dens[i] * DECAY; i++ }

  let ia = 1.0 / alpha, ib = 1.0 / beta
  let halfH = 3.4, halfW = halfH * W / H
  let sx = W / (2.0 * halfW), sy = H / (2.0 * halfH)
  let cx = W * 0.5, cy = H * 0.5

  let m = 0
  while (m < MATS) {
    // 36 i.i.d. entries 2·Beta(α,β)−1 via the log-space Gamma ratio
    let e = 0
    while (e < 36) {
      A[e] = 2.0 / (1.0 + Math.exp(Math.log(rnd()) * ib - Math.log(rnd()) * ia)) - 1.0
      e++
    }

    // Faddeev–LeVerrier: c_k = −tr(A·M_{k−1})/k, M_k = A·M_{k−1} + c_k·I, M_0 = I
    i = 0
    while (i < 36) { FM[i] = 0.0; i++ }
    FM[0] = 1.0; FM[7] = 1.0; FM[14] = 1.0; FM[21] = 1.0; FM[28] = 1.0; FM[35] = 1.0
    let k = 1
    while (k <= N) {
      let r = 0
      while (r < N) {
        let c = 0
        while (c < N) {
          let s = 0.0
          let j = 0
          while (j < N) { s = s + A[r * N + j] * FM[j * N + c]; j++ }
          FT[r * N + c] = s
          c++
        }
        r++
      }
      let tr = FT[0] + FT[7] + FT[14] + FT[21] + FT[28] + FT[35]
      let ck = -tr / k
      co[k] = ck
      i = 0
      while (i < 36) { FM[i] = FT[i]; i++ }
      FM[0] = FM[0] + ck; FM[7] = FM[7] + ck; FM[14] = FM[14] + ck
      FM[21] = FM[21] + ck; FM[28] = FM[28] + ck; FM[35] = FM[35] + ck
      k++
    }

    // Durand–Kerner: all six roots refined together from a fixed asymmetric starting hexagon
    let j = 0
    while (j < N) {
      let th = 1.0471975511965976 * j + 0.7
      zr[j] = 1.4 * Math.cos(th)
      zi[j] = 1.4 * Math.sin(th)
      j++
    }
    let it = 0
    while (it < 40) {
      let mv = 0.0
      j = 0
      while (j < N) {
        // p(z_j) by Horner (real coefficients, complex argument)
        let pr = 1.0, pi = 0.0
        k = 1
        while (k <= N) {
          let nr = pr * zr[j] - pi * zi[j] + co[k]
          pi = pr * zi[j] + pi * zr[j]
          pr = nr
          k++
        }
        // ∏_{k≠j} (z_j − z_k)
        let dr = 1.0, di = 0.0
        k = 0
        while (k < N) {
          if (k !== j) {
            let ar = zr[j] - zr[k], ai = zi[j] - zi[k]
            let nr = dr * ar - di * ai
            di = dr * ai + di * ar
            dr = nr
          }
          k++
        }
        let dd = dr * dr + di * di
        if (dd > 1e-30) {
          let cr = (pr * dr + pi * di) / dd
          let ci = (pi * dr - pr * di) / dd
          zr[j] = zr[j] - cr
          zi[j] = zi[j] - ci
          let am = (cr < 0.0 ? -cr : cr) + (ci < 0.0 ? -ci : ci)
          if (am > mv) mv = am
        }
        j++
      }
      if (mv < 1e-5) break               // ~10⁻³ px at this view — far below splat resolution
      it++
    }

    j = 0
    while (j < N) {
      let ix = (cx + zr[j] * sx) | 0
      let iy = (cy + zi[j] * sy) | 0
      if (ix >= 0 && ix < W && iy >= 0 && iy < H) dens[iy * W + ix] = dens[iy * W + ix] + 1.0
      j++
    }
    m++
  }

  // exposure: fixed gain from the steady-state mean density (6 roots × MATS / (1−DECAY) spread
  // over the frame), so brightness holds steady while α morphs — no flicker, no EMA needed
  let G = 1.2 * (1.0 - DECAY) * n / (6.0 * MATS)
  let p = 0
  while (p < n) {
    let qd = (dens[p] * G * 32.0) | 0     // → llut buckets of 1/8: q = dens·G·4
    if (qd > 1023) qd = 1023
    let g = llut[qd]
    px[p] = (255 << 24) | (g << 16) | (g << 8) | g
    p++
  }
}

// Dithering — four ways to render a smooth grayscale image with only black & white pixels.
// A shaded sphere over a soft gradient (continuous tone, lit by a circling light) is reduced to
// 1-bit by four classic methods, selected by `mode`:
//   0 threshold · 1 ordered (Bayer 8×8) · 2 Floyd–Steinberg · 3 Atkinson
// Threshold and ordered are per-pixel; the two error-diffusion passes are inherently SEQUENTIAL
// — each pixel pushes its quantization error onto pixels not yet visited — a tight scalar sweep
// that jz turns into clean wasm. resize(w,h) → Uint32Array; frame(t, mode) renders.

let W = 0, H = 0, px
let gray            // Float64Array — continuous-tone source AND the error-diffusion work buffer
let bayer           // Int32Array(64) — 8×8 ordered-dither threshold matrix (values 0..63)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  gray = new Float64Array(w * h)
  // Classic 8×8 Bayer matrix (recursive dispersed-dot), values 0..63.
  bayer = new Int32Array([
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ])
  return px
}

// Fill gray[] with the continuous-tone source: a Lambert-shaded sphere lit by a circling light,
// over a gentle vertical gradient. Smooth ramps + a specular-ish highlight are exactly what makes
// the difference between the dithering methods legible.
let source = (t) => {
  let aspect = W / H, R = 0.40
  let lx = Math.cos(t * 0.6), ly = 0.45, lz = Math.sin(t * 0.6)
  let il = 1.0 / Math.sqrt(lx * lx + ly * ly + lz * lz)
  lx = lx * il; ly = ly * il; lz = lz * il
  let py = 0
  while (py < H) {
    let ny = (py / H - 0.5) * 2.0
    let qx = 0
    while (qx < W) {
      let nx = (qx / W - 0.5) * 2.0 * aspect
      // background: a soft diagonal gradient sweeping the FULL tonal range 0.16 → 0.72, so the
      // dither has real midtones to render (not a near-black field). The ball sits on top.
      let lum = 0.16 + 0.56 * (qx / W * 0.5 + (1.0 - py / H) * 0.5)
      let r2 = nx * nx + ny * ny
      if (r2 < R * R) {
        let z = Math.sqrt(R * R - r2)
        let inv = 1.0 / R
        let d = (nx * inv) * lx + (ny * inv) * ly + (z * inv) * lz
        if (d < 0.0) d = 0.0
        lum = 0.04 + 0.96 * Math.pow(d, 0.8)     // ambient + diffuse — full black→white sphere
      }
      gray[py * W + qx] = lum
      qx++
    }
    py++
  }
}

let putBW = (idx, on) => {
  let v = on ? 255 : 0
  px[idx] = (255 << 24) | (v << 16) | (v << 8) | v
}

export let frame = (t, mode) => {
  source(t)
  let md = mode | 0
  let n = W * H

  if (md === 0) {
    // Threshold at 50% — pure black/white, no spatial dither
    let i = 0
    while (i < n) { putBW(i, gray[i] >= 0.5 ? 1 : 0); i++ }
  } else if (md === 1) {
    // Ordered dithering — compare each pixel to its Bayer-matrix threshold
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let thr = (bayer[(py & 7) * 8 + (qx & 7)] + 0.5) / 64.0
        putBW(idx, gray[idx] >= thr ? 1 : 0)
        qx++
      }
      py++
    }
  } else if (md === 2) {
    // Floyd–Steinberg — push the quantization error to 4 forward neighbours (7,3,5,1)/16
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let err = old - on
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + err * 0.4375
        if (py + 1 < H) {
          if (qx > 0) gray[idx + W - 1] = gray[idx + W - 1] + err * 0.1875
          gray[idx + W] = gray[idx + W] + err * 0.3125
          if (qx + 1 < W) gray[idx + W + 1] = gray[idx + W + 1] + err * 0.0625
        }
        putBW(idx, on)
        qx++
      }
      py++
    }
  } else {
    // Atkinson — spread only 6/8 of the error to 6 neighbours (1/8 each) → airier, higher contrast
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let err = (old - on) * 0.125
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + err
        if (qx + 2 < W) gray[idx + 2] = gray[idx + 2] + err
        if (py + 1 < H) {
          if (qx > 0) gray[idx + W - 1] = gray[idx + W - 1] + err
          gray[idx + W] = gray[idx + W] + err
          if (qx + 1 < W) gray[idx + W + 1] = gray[idx + W + 1] + err
        }
        if (py + 2 < H) gray[idx + 2 * W] = gray[idx + 2 * W] + err
        putBW(idx, on)
        qx++
      }
      py++
    }
  }
}

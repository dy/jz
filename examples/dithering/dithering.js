// Dithering — eight ways to render a smooth grayscale image with only black & white pixels.
// A shaded sphere over a soft gradient (continuous tone, lit by a circling light) is reduced to
// 1-bit by `mode`:
//   0 threshold · 1 random · 2 ordered Bayer 4×4 · 3 ordered Bayer 8×8 · 4 clustered-dot halftone
//   5 Floyd–Steinberg · 6 Jarvis–Judice–Ninke · 7 Atkinson
// The threshold/random/ordered/halftone passes are per-pixel; the three error-diffusion passes
// are inherently SEQUENTIAL — each pixel pushes its quantization error onto pixels not yet visited
// — a tight scalar sweep that jz turns into clean wasm. resize(w,h) → Uint32Array; frame(t,mode).
// Everything is deterministic (the "random" mode is a per-pixel hash), so JS and jz match exactly.

let W = 0, H = 0, px
let gray            // Float64Array — continuous-tone source AND the error-diffusion work buffer
let bayer4          // Int32Array(16) — 4×4 ordered-dither threshold matrix (values 0..15)
let bayer8          // Int32Array(64) — 8×8 dispersed-dot threshold matrix (values 0..63)
let halftone        // Int32Array(64) — 8×8 clustered-dot screen (ink grows as a dot from the centre)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  gray = new Float64Array(w * h)
  bayer4 = new Int32Array([
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5
  ])
  // Classic 8×8 Bayer matrix (recursive dispersed-dot), values 0..63.
  bayer8 = new Int32Array([
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ])
  // Clustered-dot halftone screen: threshold lowest at each 8×8 tile's centre, rising outward, so
  // as a region darkens the ink fills from the centre into a growing dot — the newspaper look.
  halftone = new Int32Array(64)
  let i = 0
  while (i < 64) {
    let x = i % 8, y = (i / 8) | 0
    let fx = ((x + 0.5) / 8.0) * 2.0 - 1.0
    let fy = ((y + 0.5) / 8.0) * 2.0 - 1.0
    let v = Math.cos(Math.PI * fx) + Math.cos(Math.PI * fy)   // 2 at centre → −2 at corners
    halftone[i] = (((2.0 - v) / 4.0) * 63.0) | 0              // 0 at centre (fills first)
    i++
  }
  return px
}

// Deterministic per-pixel hash → [0,1): an integer scramble (i32 wraps identically in JS and jz),
// so "random" dithering is reproducible and JS/jz stay bit-exact.
let hash01 = (x, y) => {
  let h = (x * 1103515245 + 12345) ^ (y * 12820163 + 9301)
  h = h & 0x7fffffff
  return (h % 4096) / 4096.0
}

// Fill gray[] with the continuous-tone source: a Lambert-shaded sphere lit by a circling light,
// over a gentle vertical gradient. Smooth ramps + a specular-ish highlight are exactly what makes
// the difference between the dithering methods legible.
// Continuous-tone source image to be dithered. `shape` swaps the subject (re-roll picks one) — all
// are smooth full-tonal-range fields so the difference between the dither algorithms reads clearly.
//   0 = lit sphere   1 = two lit spheres   2 = rolling sine field   3 = lit cone
let source = (t, shape) => {
  let aspect = W / H, R = 0.40
  let lx = Math.cos(t * 0.6), ly = 0.45, lz = Math.sin(t * 0.6)
  let il = 1.0 / Math.sqrt(lx * lx + ly * ly + lz * lz)
  lx = lx * il; ly = ly * il; lz = lz * il
  let sh = shape | 0
  let py = 0
  while (py < H) {
    let ny = (py / H - 0.5) * 2.0
    let qx = 0
    while (qx < W) {
      let nx = (qx / W - 0.5) * 2.0 * aspect
      // background: a soft diagonal gradient sweeping the FULL tonal range, so there are real
      // midtones to render (not a near-black field). The subject sits on top.
      let lum = 0.16 + 0.56 * (qx / W * 0.5 + (1.0 - py / H) * 0.5)
      if (sh === 2) {
        // rolling sine field — a smooth animated gradient over the whole frame
        lum = 0.5 + 0.42 * Math.sin(nx * 3.0 + t * 0.5) * Math.cos(ny * 3.0 - t * 0.35)
      } else if (sh === 1) {
        // two lit spheres
        let ax = nx - 0.45, ay = ny + 0.12, ra2 = ax * ax + ay * ay, RA = 0.32
        let bx = nx + 0.5, by = ny - 0.16, rb2 = bx * bx + by * by, RB = 0.42
        if (ra2 < RA * RA) {
          let z = Math.sqrt(RA * RA - ra2), iv = 1.0 / RA
          let d = (ax * iv) * lx + (ay * iv) * ly + (z * iv) * lz
          if (d < 0.0) d = 0.0
          lum = 0.04 + 0.96 * Math.pow(d, 0.8)
        }
        if (rb2 < RB * RB) {
          let z = Math.sqrt(RB * RB - rb2), iv = 1.0 / RB
          let d = (bx * iv) * lx + (by * iv) * ly + (z * iv) * lz
          if (d < 0.0) d = 0.0
          let l2 = 0.04 + 0.96 * Math.pow(d, 0.8)
          if (l2 > lum) lum = l2
        }
      } else if (sh === 3) {
        // lit cone: brightness from the tilted slant, capped to a disc
        let r2 = nx * nx + ny * ny, R2 = 0.46
        if (r2 < R2 * R2) {
          let r = Math.sqrt(r2)
          let d = (nx / (r + 0.0001)) * lx + (ny / (r + 0.0001)) * ly + 0.55 * lz
          if (d < 0.0) d = 0.0
          lum = 0.08 + 0.9 * (1.0 - r / R2) * (0.3 + 0.7 * d)
        }
      } else {
        // lit sphere (default)
        let r2 = nx * nx + ny * ny
        if (r2 < R * R) {
          let z = Math.sqrt(R * R - r2), inv = 1.0 / R
          let d = (nx * inv) * lx + (ny * inv) * ly + (z * inv) * lz
          if (d < 0.0) d = 0.0
          lum = 0.04 + 0.96 * Math.pow(d, 0.8)
        }
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

export let frame = (t, mode, shape) => {
  source(t, shape)
  let md = mode | 0
  let n = W * H

  if (md === 0) {
    // Threshold at 50% — pure black/white, no spatial dither
    let i = 0
    while (i < n) { putBW(i, gray[i] >= 0.5 ? 1 : 0); i++ }
  } else if (md === 1) {
    // Random — threshold against a per-pixel hash (white-noise dither, the naive baseline)
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) { let idx = py * W + qx; putBW(idx, gray[idx] >= hash01(qx, py) ? 1 : 0); qx++ }
      py++
    }
  } else if (md === 2 || md === 3 || md === 4) {
    // Ordered — compare each pixel to a tiled threshold screen: Bayer 4×4, Bayer 8×8, or the
    // clustered-dot halftone. (One loop, three screens — the matrix + tile mask differ only.)
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let thr = md === 2 ? (bayer4[(py & 3) * 4 + (qx & 3)] + 0.5) / 16.0
          : md === 3 ? (bayer8[(py & 7) * 8 + (qx & 7)] + 0.5) / 64.0
          : (halftone[(py & 7) * 8 + (qx & 7)] + 0.5) / 64.0
        putBW(idx, gray[idx] >= thr ? 1 : 0)
        qx++
      }
      py++
    }
  } else if (md === 5) {
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
  } else if (md === 6) {
    // Jarvis–Judice–Ninke — a wider 12-neighbour diffusion (/48) → smoother gradients, less texture
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let e = (old - on) / 48.0
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + e * 7.0
        if (qx + 2 < W) gray[idx + 2] = gray[idx + 2] + e * 5.0
        if (py + 1 < H) {
          let r = idx + W
          if (qx - 2 >= 0) gray[r - 2] = gray[r - 2] + e * 3.0
          if (qx - 1 >= 0) gray[r - 1] = gray[r - 1] + e * 5.0
          gray[r] = gray[r] + e * 7.0
          if (qx + 1 < W) gray[r + 1] = gray[r + 1] + e * 5.0
          if (qx + 2 < W) gray[r + 2] = gray[r + 2] + e * 3.0
        }
        if (py + 2 < H) {
          let r = idx + 2 * W
          if (qx - 2 >= 0) gray[r - 2] = gray[r - 2] + e * 1.0
          if (qx - 1 >= 0) gray[r - 1] = gray[r - 1] + e * 3.0
          gray[r] = gray[r] + e * 5.0
          if (qx + 1 < W) gray[r + 1] = gray[r + 1] + e * 3.0
          if (qx + 2 < W) gray[r + 2] = gray[r + 2] + e * 1.0
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

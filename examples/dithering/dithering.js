// Dithering — eight ways to render a smooth grayscale image with only black & white pixels.
// Four shaded subjects — a pyramid, a profile bust, a cube, a torus — each lit by a circling
// light over a soft gradient backdrop, are reduced to 1-bit by `mode`:
//   0 threshold · 1 random · 2 ordered Bayer 4×4 · 3 ordered Bayer 8×8 · 4 clustered-dot halftone
//   5 Floyd–Steinberg · 6 Jarvis–Judice–Ninke · 7 Atkinson
// The threshold/random/ordered/halftone passes are per-pixel; the three error-diffusion passes
// are inherently SEQUENTIAL — each pixel pushes its quantization error onto pixels not yet visited
// — a tight scalar sweep that jz turns into clean wasm. resize(w,h) → Uint32Array; frame(t,mode,shape).
// Everything is deterministic (the "random" mode is a per-pixel hash), so JS and jz match exactly.

let W = 0, H = 0, px
let gray            // Float64Array — continuous-tone source AND the error-diffusion work buffer
let bayer4          // Int32Array(16) — 4×4 ordered-dither threshold matrix (values 0..15)
let bayer8          // Int32Array(64) — 8×8 dispersed-dot threshold matrix (values 0..63)
let halftone        // Int32Array(64) — 8×8 clustered-dot screen (ink grows as a dot from the centre)
let bustFrontKeys   // Float64Array — (y,r) profile keyframes: the bust's FRONT (face) curve
let bustBackKeys    // Float64Array — (y,r) profile keyframes: the bust's BACK (skull/neck) curve

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
  // Bust profile keyframes — (y,r) control points from crown to shoulders, smoothstep-interpolated
  // by profileR() below. FRONT carves forehead → brow/eye-socket dip → nose (the big protrusion)
  // → mouth recess → chin; BACK carries the rounded skull, a subtle ear bump, then neck/shoulders.
  // Both start at radius 0 at the crown so the head closes to a point instead of a flat cap.
  bustFrontKeys = new Float64Array([
    -0.85, 0.00,  -0.65, 0.42,  -0.35, 0.44,  -0.15, 0.32,   0.02, 0.62,
     0.14, 0.30,   0.28, 0.40,   0.40, 0.16,   0.55, 0.19,   0.68, 0.28,   0.95, 0.56
  ])
  bustBackKeys = new Float64Array([
    -0.85, 0.00,  -0.65, 0.42,  -0.40, 0.52,  -0.15, 0.48,   0.05, 0.50,
     0.20, 0.32,   0.34, 0.22,   0.48, 0.19,   0.58, 0.21,   0.68, 0.30,   0.95, 0.54
  ])
  return px
}

// Deterministic per-pixel hash → [0,1): an integer scramble (i32 wraps identically in JS and jz),
// so "random" dithering is reproducible and JS/jz stay bit-exact.
let hash01 = (x, y) => {
  let h = (x * 1103515245 + 12345) ^ (y * 12820163 + 9301)
  h = h & 0x7fffffff
  return (h % 4096) / 4096.0
}

// x^0.75 via two chained sqrt() calls instead of Math.pow(x, 0.8-ish): every exponent here is
// exactly 0.5, the one fractional power jz folds to f64.sqrt and so is bit-identical to V8 by
// construction — a general Math.pow(x,y) is NOT guaranteed bit-exact across engines, and even a
// 1-ULP gap can flip a threshold decision that then cascades through the sequential
// error-diffusion passes below. Same gamma "family" as a 0.8 exponent (visually indistinguishable
// after dithering), but provably exact.
let pow75 = (d) => { let s = Math.sqrt(d); return s * Math.sqrt(s) }

// Smooth falloff around 0 (1 at d=0 → 0 at |d|≥w) — a polynomial "spotlight" used to fake local
// shading (facial-feature shadows) that plain per-pixel Lambert can't reach, having no notion of
// self-occlusion (a brow ridge doesn't otherwise cast a shadow into the socket below it).
// Deliberately not a true Gaussian: no Math.exp keeps it bit-exact between JS and jz too (see
// pow75 above).
let bump = (d, w) => {
  let f = 1.0 - Math.abs(d) / w
  if (f < 0.0) f = 0.0
  return f * f * (3.0 - 2.0 * f)
}

// Smoothstep-interpolate a radius through ascending (y,r) keyframe pairs packed in `keys`
// (n = pair count), holding the end value flat past the first/last y. Builds the bust's
// front/back silhouette curves from a handful of hand-placed control points instead of a
// wall of branches.
let profileR = (keys, n, y) => {
  if (y <= keys[0]) return keys[1]
  let last = (n - 1) * 2
  if (y >= keys[last]) return keys[last + 1]
  let i = 0
  while (i < n - 1 && keys[(i + 1) * 2] < y) i++
  let y0 = keys[i * 2], r0 = keys[i * 2 + 1], y1 = keys[(i + 1) * 2], r1 = keys[(i + 1) * 2 + 1]
  let f = (y - y0) / (y1 - y0)
  f = f * f * (3.0 - 2.0 * f)
  return r0 + (r1 - r0) * f
}

// Continuous-tone source image to be dithered — one of four shaded subjects, chosen by `shape`,
// each a smooth full-tonal-range field so every dither algorithm has real gradients to bite into:
//   0 = pyramid (flat-shaded, two faces)   1 = bust (profile head + shoulders)
//   2 = cube (flat-shaded, three faces)    3 = torus
// All four share one rotating key light (lx,ly,lz, from `t`) and the same soft diagonal backdrop
// gradient — only the silhouette + shading rule inside it changes.
let source = (t, shape) => {
  let aspect = W / H
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
      if (sh === 0) {
        // Pyramid — a symmetric triangle silhouette split by a central vertical ridge into two
        // FLAT-shaded faces (a fixed normal per face, unlike every other shape's curvature) —
        // that hard flatness plus dead-straight edges reads as "geometric / man-made", not a
        // mountain. The two faces swap brighter/darker as the key light sweeps past the ridge.
        let apexY = -0.58, baseY = 0.60, baseHW = 0.56
        let h = (ny - apexY) / (baseY - apexY)
        let halfW = baseHW * h
        if (ny >= apexY && ny <= baseY && nx >= -halfW && nx <= halfW) {
          let onLeft = nx < 0.0
          let fx = onLeft ? -0.70 : 0.70, fy = 0.32, fz = 0.64
          let ifn = 1.0 / Math.sqrt(fx * fx + fy * fy + fz * fz)
          let d = (fx * ifn) * lx + (fy * ifn) * ly + (fz * ifn) * lz
          if (d < 0.0) d = 0.0
          let edge = halfW > 1e-4 ? Math.abs(nx) / halfW : 0.0
          lum = (0.08 + 0.88 * pow75(d)) * (1.0 - 0.12 * edge) * (1.0 - 0.08 * h)
        } else if (ny > baseY && ny < baseY + 0.16) {
          // soft contact shadow on the ground, just past the base
          let fall = 1.0 - (ny - baseY) / 0.16
          let s = nx / (baseHW * 1.25)
          let shd = fall * (1.0 - Math.min(1.0, s * s))
          if (shd > 0.0) lum = lum * (1.0 - 0.4 * shd)
        }
      } else if (sh === 1) {
        // Bust — a profile head + shoulders, facing right. FRONT traces forehead → brow/eye
        // socket dip → nose (the big protrusion — the single strongest "that's a face" cue in
        // silhouette) → mouth recess → chin; BACK carries the rounded skull, a subtle ear bump,
        // then neck/shoulders. Shaded like a "bent cylinder": each row is a circular
        // cross-section whose radius/centre follow the two profile curves, so the same
        // sqrt(R²-x²) trick as a sphere gives every row a smooth round highlight/shadow.
        let cx0 = -0.05
        let f = profileR(bustFrontKeys, 11, ny)
        let b = profileR(bustBackKeys, 11, ny)
        let R = (f + b) * 0.5
        let rowCx = cx0 + (f - b) * 0.5
        let lo = nx - rowCx
        if (lo > -R && lo < R) {
          let z = Math.sqrt(Math.max(0.0, R * R - lo * lo)), inv = 1.0 / R
          let d = (lo * inv) * lx + (z * inv) * lz
          if (d < 0.0) d = 0.0
          let shd = 0.07 + 0.90 * pow75(d)
          // fake self-shadowing plain Lambert can't produce: the brow overhangs the eye
          // socket, the septum shadows just under the nose — both read on the FRONT half only.
          if (lo > 0.0) {
            shd = shd * (1.0 - 0.32 * bump(ny + 0.15, 0.06))
            shd = shd * (1.0 - 0.22 * bump(ny - 0.14, 0.045))
          }
          lum = shd
        }
      } else if (sh === 2) {
        // Cube — isometric: three flat parallelogram faces (top / right / left) sharing the
        // near-bottom vertex N, exactly like a Rubik's-cube icon. Same flat-shaded-face idea as
        // the pyramid, one more tone. Three edges from N: eLeft=(-w,-hTop), eRight=(w,-hTop) (the
        // top rhombus's two upper corners) and eDown=(0,hSide) (the vertical edge shared by both
        // side faces). Each face test solves P−N = a·e1 + b·e2 (0≤a,b≤1) in closed form — no
        // matrix inverse needed, the edges are mirror-symmetric.
        let ccx = 0.0, ccy = 0.10, wSide = 0.50, hTop = 0.28, hSide = 0.55
        let dx = nx - ccx, dy = ny - ccy
        let at = (-dy / hTop - dx / wSide) * 0.5, bt = (-dy / hTop + dx / wSide) * 0.5   // top: a·eLeft+b·eRight
        let ar = dx / wSide, br = (dy + ar * hTop) / hSide                                // right: a·eRight+b·eDown
        let al = -dx / wSide, bl = (dy + al * hTop) / hSide                              // left: a·eLeft+b·eDown
        if (at >= 0.0 && at <= 1.0 && bt >= 0.0 && bt <= 1.0) {
          let fy = 1.0, fz = 0.18, ifn = 1.0 / Math.sqrt(fy * fy + fz * fz)
          let d = (fy * ifn) * ly + (fz * ifn) * lz
          if (d < 0.0) d = 0.0
          lum = 0.10 + 0.88 * pow75(d)
        } else if (dx >= 0.0 && ar >= 0.0 && ar <= 1.0 && br >= 0.0 && br <= 1.0) {
          let fx = 0.80, fy = 0.30, fz = 0.52, ifn = 1.0 / Math.sqrt(fx * fx + fy * fy + fz * fz)
          let d = (fx * ifn) * lx + (fy * ifn) * ly + (fz * ifn) * lz
          if (d < 0.0) d = 0.0
          lum = (0.10 + 0.86 * pow75(d)) * (1.0 - 0.08 * br)
        } else if (dx < 0.0 && al >= 0.0 && al <= 1.0 && bl >= 0.0 && bl <= 1.0) {
          let fx = -0.80, fy = 0.30, fz = 0.52, ifn = 1.0 / Math.sqrt(fx * fx + fy * fy + fz * fz)
          let d = (fx * ifn) * lx + (fy * ifn) * ly + (fz * ifn) * lz
          if (d < 0.0) d = 0.0
          lum = (0.10 + 0.86 * pow75(d)) * (1.0 - 0.08 * bl)
        }
      } else {
        // Torus (donut) — an annulus shaded as a tube: recast the radial position as a
        // cross-section angle (a sin/cos pair, already unit length by construction) so the
        // ring reads as a rounded 3D surface — bright crest, dark inner/outer rim — not a flat washer.
        let ccx = 0.0, ccy = 0.02, Router = 0.62, Rinner = 0.30
        let Rmid = (Router + Rinner) * 0.5, tubeR = (Router - Rinner) * 0.5
        let dx = nx - ccx, dy = ny - ccy, r = Math.sqrt(dx * dx + dy * dy)
        if (r > Rinner && r < Router) {
          let u = (r - Rmid) / tubeR
          let z = Math.sqrt(Math.max(0.0, 1.0 - u * u))
          let ir = 1.0 / (r + 1e-6)
          let d = (dx * ir * u) * lx + (dy * ir * u) * ly + z * lz
          if (d < 0.0) d = 0.0
          lum = 0.06 + 0.92 * pow75(d)
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

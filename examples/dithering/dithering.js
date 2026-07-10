// Dithering — eight ways to render a smooth grayscale image with only black & white pixels.
// The subject is one BAS-RELIEF plate seen from straight above, lit by an orbiting light: a
// three-sided pyramid standing on it, sculpted LIPS embossed as a medallion (the classic
// atelier cast, drawn from arithmetic alone), a cube standing flat whose swinging cast shadow
// tells its height, a torus and a full sphere each sunk to their equator — all reduced to
// 1-bit by `mode`:
//   0 threshold · 1 random · 2 ordered Bayer 4×4 · 3 ordered Bayer 8×8 · 4 clustered-dot halftone
//   5 Floyd–Steinberg · 6 Jarvis–Judice–Ninke · 7 Atkinson
// The threshold/random/ordered/halftone passes are per-pixel; the three error-diffusion passes
// are inherently SEQUENTIAL — each pixel pushes its quantization error onto pixels not yet visited
// — a tight scalar sweep that jz turns into clean wasm. resize(w,h) → Uint32Array; frame(t,mode,shape).
// Everything is deterministic (the "random" mode is a per-pixel hash), so JS and jz match exactly.

let W = 0, H = 0, px
let gray            // Float64Array — continuous-tone source AND the error-diffusion work buffer
let hf              // Float64Array — per-frame heightfield of the relief plate (pixel units)
let sb              // Float64Array — shadow ceiling: the height sunlight clears above each pixel
let bayer4          // Int32Array(16) — 4×4 ordered-dither threshold matrix (values 0..15)
let bayer8          // Int32Array(64) — 8×8 dispersed-dot threshold matrix (values 0..63)
let halftone        // Int32Array(64) — 8×8 clustered-dot screen (ink grows as a dot from the centre)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  gray = new Float64Array(w * h)
  hf = new Float64Array(w * h)
  sb = new Float64Array(w * h)
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

// x^0.75 via two chained sqrt() calls instead of Math.pow(x, 0.8-ish): every exponent here is
// exactly 0.5, the one fractional power jz folds to f64.sqrt and so is bit-identical to V8 by
// construction — a general Math.pow(x,y) is NOT guaranteed bit-exact across engines, and even a
// 1-ULP gap can flip a threshold decision that then cascades through the sequential
// error-diffusion passes below. Same gamma "family" as a 0.8 exponent (visually indistinguishable
// after dithering), but provably exact.
let pow75 = (d) => { let s = Math.sqrt(d); return s * Math.sqrt(s) }

// cos via exact range reduction + a fixed Taylor polynomial (u = x², Horner) — engine sin/cos
// differ from wasm's by an ULP, and the shadow sweep below would AMPLIFY a 1-ULP light tilt
// through its running max into visibly different dithers under error diffusion. floor, ÷, +, ×
// are all exactly-rounded in BOTH engines, so this cos is bit-identical everywhere by
// construction — and a light direction only needs ~1e-6 accuracy, which degree 14 gives on
// the reduced range. With it, the whole kernel is exact with NO tolerated-ULP exceptions.
let cosT = (x) => {
  let TAU = 6.283185307179586
  x = x - Math.floor(x / TAU) * TAU                     // → [0, 2π)
  if (x > 3.141592653589793) x = TAU - x                // cos(2π−x) = cos(x) → [0, π]
  let u = x * x
  return 1.0 + u * (-0.5 + u * (0.041666666666666664 + u * (-0.001388888888888889
    + u * (0.0000248015873015873 + u * (-2.755731922398589e-7 + u * (2.08767569878681e-9
    + u * -1.1470745597729725e-11))))))
}

// Continuous-tone source image to be dithered — a BAS-RELIEF plate seen from DIRECTLY ABOVE,
// lit by one ORBITING light (in-plane azimuth circles with t, elevation fixed). Every subject
// is a true HEIGHTFIELD z(x,y) standing on the plate, and ONE engine renders them all:
//   · surface normal from the height gradient (central differences) → n·light raking shade
//   · a real CAST SHADOW from an O(N) horizon sweep over the same heightfield — hard at the
//     contact, melting away toward its tip, swinging as the light orbits. Every subject
//     self-shadows too: the lips shade their own hollows, the torus bowl its far rim.
//   · curvature accents — convex breaks (ridges, rims, the lip line) draw themselves as fine
//     dark lines, and steep walls press a thin contact seam into the plate around each subject.
// Subjects: 0 = three-sided pyramid standing on the plate · 1 = sculpted lips embossed as a
// medallion · 2 = cube standing flat on the plate (only its square top face is visible from
// above — the LONG shadow, side ≈ its length, is what says "cube") · 3 = torus sunk to its
// tube's equator · 4 = full sphere sunk to its equator.
let source = (t, shape) => {
  let lpx = cosT(t * 0.6), lpy = cosT(t * 0.6 - 1.5707963267948966)   // orbiting light azimuth
  let LEL = 0.62                                          // light elevation as a slope (rise/run)
  let sh = shape | 0
  let cx = W * 0.5, cy = H * 0.5
  let PS = (W < H ? W : H) * 0.5                          // plate scale: half the short side, px

  // ---- pass 1: build the heightfield (pixel units, so gradients are dimensionless slopes) ----
  let zmax = 1.0                 // tallest point, px — normalizes the height lift in shading
  if (sh === 0) {
    // Three-sided pyramid: equilateral triangle base, apex over the centroid. Height at any
    // inside point is set by the nearest base edge — that IS the plane of the face above it,
    // so the three faces come out perfectly flat and their ridges perfectly straight.
    let Rt = 0.62 * PS, hA = 0.55 * PS, inr = 0.5 * Rt
    let pcy = cy + 0.04 * PS
    let axp = 0.0, ayp = -Rt
    let bxp = -0.8660254037844386 * Rt, byp = 0.5 * Rt
    let cxp = 0.8660254037844386 * Rt, cyp = 0.5 * Rt
    let eLen = 1.7320508075688772 * Rt                    // all three edges are √3·Rt long
    let hs = hA / inr                                     // face slope: apex height per inradius
    zmax = hA
    let py = 0
    while (py < H) {
      let dy = py - pcy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let e1 = (bxp - axp) * (dy - ayp) - (byp - ayp) * (dx - axp)
        let e2 = (cxp - bxp) * (dy - byp) - (cyp - byp) * (dx - bxp)
        let e3 = (axp - cxp) * (dy - cyp) - (ayp - cyp) * (dx - cxp)
        let eMax = e1
        if (e2 > eMax) eMax = e2
        if (e3 > eMax) eMax = e3
        let z = -eMax / eLen * hs
        hf[py * W + qx] = z > 0.0 ? z : 0.0
        qx++
      }
      py++
    }
  } else if (sh === 1) {
    // Sculpted lips — the classical atelier cast, built from arithmetic alone. The mouth line
    // smiles gently with a small tubercle dip at the centre; the upper lip is an elliptic
    // ridge whose outline carries the cupid's-bow notch; the fuller lower lip is an off-crest
    // elliptic cushion; both roll off through vertical-tangent (sqrt) borders, so the
    // vermilion edge catches raking light exactly like carved marble. A philtrum groove
    // above, a soft mentolabial hollow below, pressed dimples past the corners and a deep
    // crease along the contact line finish the fragment.
    let LS = 0.335 * (W < 1.55 * H ? W : 1.55 * H)        // lips half-span — fits any aspect
    let cyL = cy + 0.02 * LS
    zmax = 0.14 * LS
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let x = qx - cx, yy = py - cyL
        let z = 0.0
        let n = x / LS
        let n2 = 1.0 - n * n
        if (n2 > 0.0) {
          // mouth line: gently rising, curling back down at the very corners, with a small
          // central dip where the upper tubercle rests
          let tq = n / 0.16, tb = 1.0 - tq * tq; if (tb < 0.0) tb = 0.0
          let n4 = n * n * n * n
          let yL = LS * (-0.07 * n * n + 0.075 * n4 + 0.022 * tb * tb)
          let en = Math.sqrt(n2)
          if (yy < yL) {
            // upper lip: thickness ellipse with the cupid's-bow notch carved from its outline
            // (the two bow peaks emerge where the notch releases the ellipse, at |n|≈0.4)
            let cq = n / 0.42, cb = 1.0 - cq * cq; if (cb < 0.0) cb = 0.0
            let TU = LS * 0.34 * en * (1.0 - 0.42 * cb * cb)
            if (TU > 0.5) {
              let s = (yL - yy) / TU
              if (s < 1.0) {
                let wq = (s - 0.22) / 0.78         // crest just above the line — the lip rolls
                let ww = 1.0 - wq * wq             // over it and tucks INTO the contact crease
                if (ww > 0.0) {
                  let HU = LS * 0.115 * (0.68 + 0.32 * en)
                  z = HU * Math.sqrt(ww)
                }
              }
            }
          } else {
            // lower lip: fuller cushion, crest ~40% of the way down, sqrt roll-off both sides
            let nd = x / (0.86 * LS)
            let nd2 = 1.0 - nd * nd
            if (nd2 > 0.0) {
              let end = Math.sqrt(nd2)
              let TD = LS * 0.42 * end
              if (TD > 0.5) {
                let sD = (yy - yL) / TD
                if (sD < 1.0) {
                  let wq = (sD - 0.40) / 0.60
                  let ww = 1.0 - wq * wq
                  if (ww > 0.0) {
                    let HD = LS * 0.14 * (0.60 + 0.40 * end)
                    z = HD * Math.sqrt(ww)
                  }
                }
              }
            }
          }
          // contact-line crease: a deep V cut along the mouth line
          let cv = (yy - yL) / (0.018 * LS)
          let cg = 1.0 - cv * cv
          if (cg > 0.0) z = z * (1.0 - 0.55 * cg * cg)
        }
        // philtrum groove above the bow, mentolabial hollow below the lip — soft carved dips
        let pxv = x / (0.10 * LS), pyv = (yy + 0.345 * LS) / (0.18 * LS)
        let pw = 1.0 - pxv * pxv, ph = 1.0 - pyv * pyv
        if (pw > 0.0 && ph > 0.0) z = z - 0.022 * LS * pw * pw * ph * ph
        let mxv = x / (0.44 * LS), myv = (yy - 0.54 * LS) / (0.11 * LS)
        let mw = 1.0 - mxv * mxv, mh = 1.0 - myv * myv
        if (mw > 0.0 && mh > 0.0) z = z - 0.022 * LS * mw * mw * mh * mh
        // pressed dimples just past each corner of the mouth
        let eyl = (yy - 0.005 * LS) / (0.085 * LS)
        let exl = (x + 1.03 * LS) / (0.13 * LS)
        let rl = exl * exl + eyl * eyl
        if (rl < 1.0) { let q = 1.0 - rl; z = z - 0.022 * LS * q * q }
        let exr = (x - 1.03 * LS) / (0.13 * LS)
        let rr = exr * exr + eyl * eyl
        if (rr < 1.0) { let q = 1.0 - rr; z = z - 0.022 * LS * q * q }
        hf[py * W + qx] = z
        qx++
      }
      py++
    }
  } else if (sh === 2) {
    // Cube standing flat on the plate, seen from straight above: only the square top face is
    // visible — its four beveled edges catch the orbiting light (bright toward it, dark away),
    // and the LONG cast shadow (the block is as tall as it is wide) swings around it.
    let a = 0.40 * PS, hC = 0.80 * PS
    let bev = 0.055 * PS, bevH = 0.10 * PS
    zmax = hC
    let py = 0
    while (py < H) {
      let dy = py - cy; if (dy < 0.0) dy = -dy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx; if (dx < 0.0) dx = -dx
        let dm = dx > dy ? dx : dy
        let z = 0.0
        if (dm < a) {
          z = hC
          let dE = a - dm
          if (dE < bev) z = hC - (1.0 - dE / bev) * bevH
        }
        hf[py * W + qx] = z
        qx++
      }
      py++
    }
  } else if (sh === 3) {
    // Torus lying flat, sunk to its tube's equator: an annulus bulging out of the plate.
    let Router = 0.62 * PS, Rinner = 0.30 * PS
    let Rmid = (Router + Rinner) * 0.5, tubeR = (Router - Rinner) * 0.5
    zmax = tubeR
    let py = 0
    while (py < H) {
      let dy = py - cy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let r = Math.sqrt(dx * dx + dy * dy) - Rmid
        let s = tubeR * tubeR - r * r
        hf[py * W + qx] = s > 0.0 ? Math.sqrt(s) : 0.0
        qx++
      }
      py++
    }
  } else {
    // A full sphere sunk to its equator: a hemispheric dome flush in the plate.
    let R = 0.60 * PS
    zmax = R
    let py = 0
    while (py < H) {
      let dy = py - cy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let s = R * R - dx * dx - dy * dy
        hf[py * W + qx] = s > 0.0 ? Math.sqrt(s) : 0.0
        qx++
      }
      py++
    }
  }

  // ---- pass 1.5: shadow ceiling — the classic O(N) terrain-shadow horizon sweep. Walk the
  // grid AWAY from the light, one row (or column, whichever axis the azimuth leans on) at a
  // time: each pixel's ceiling is its own height, or the light-side neighbour's ceiling
  // dropped by the light's slope over one step — whichever is higher. sb−hf is then exactly
  // how far below the sunlight line each pixel sits: 0 in the open, large in deep shade.
  // The light-side neighbour lies at a fractional position, so read it with a 2-tap linear
  // interpolation from the already-swept row — pure add/mul/max, bit-exact in JS and jz.
  let adx = lpx < 0.0 ? -lpx : lpx, ady = lpy < 0.0 ? -lpy : lpy
  if (ady >= adx) {
    let offX = lpx / ady                   // x drift toward the light per row step
    let drop = LEL / ady                   // ceiling drop per row step (path length 1/ady)
    let rs = lpy >= 0.0 ? 1 : -1           // row step TOWARD the light
    let y = lpy >= 0.0 ? H - 1 : 0
    let yEnd = lpy >= 0.0 ? -1 : H
    while (y !== yEnd) {
      let ys = y + rs
      let row = y * W
      let x = 0
      if (ys < 0 || ys > H - 1) {
        while (x < W) { sb[row + x] = hf[row + x]; x++ }
      } else {
        let srow = ys * W
        while (x < W) {
          let xs = x + offX
          if (xs < 0.0) xs = 0.0
          if (xs > W - 1) xs = W - 1
          let xi = xs | 0
          let xi1 = xi + 1; if (xi1 > W - 1) xi1 = W - 1
          let xf = xs - xi
          let c = sb[srow + xi] * (1.0 - xf) + sb[srow + xi1] * xf - drop
          let z = hf[row + x]
          sb[row + x] = c > z ? c : z
          x++
        }
      }
      y = y - rs
    }
  } else {
    let offY = lpy / adx                   // y drift toward the light per column step
    let drop = LEL / adx
    let cs = lpx >= 0.0 ? 1 : -1           // column step TOWARD the light
    let x = lpx >= 0.0 ? W - 1 : 0
    let xEnd = lpx >= 0.0 ? -1 : W
    while (x !== xEnd) {
      let xsrc = x + cs
      let y = 0
      if (xsrc < 0 || xsrc > W - 1) {
        while (y < H) { sb[y * W + x] = hf[y * W + x]; y++ }
      } else {
        while (y < H) {
          let ysf = y + offY
          if (ysf < 0.0) ysf = 0.0
          if (ysf > H - 1) ysf = H - 1
          let yi = ysf | 0
          let yi1 = yi + 1; if (yi1 > H - 1) yi1 = H - 1
          let yf = ysf - yi
          let c = sb[yi * W + xsrc] * (1.0 - yf) + sb[yi1 * W + xsrc] * yf - drop
          let z = hf[y * W + x]
          sb[y * W + x] = c > z ? c : z
          y++
        }
      }
      x = x - cs
    }
  }

  // ---- pass 2: one relief engine for every subject — normals, raking light, cast shadow ----
  let invZ = 1.0 / zmax
  let invSoft = 1.0 / (0.045 * PS)         // penumbra scale: how much ceiling reads as full shade
  let seamZ = 1.0 / (0.05 * PS)            // contact seams live below this height
  let py = 0
  while (py < H) {
    let qx = 0
    while (qx < W) {
      let i = py * W + qx
      let z = hf[i]
      // central-difference gradient (clamped at the frame border)
      let gl = hf[qx > 0 ? i - 1 : i], gr = hf[qx < W - 1 ? i + 1 : i]
      let gu = hf[py > 0 ? i - W : i], gd = hf[py < H - 1 ? i + W : i]
      let gx = (gr - gl) * 0.5, gy = (gd - gu) * 0.5
      let inv = 1.0 / Math.sqrt(1.0 + gx * gx + gy * gy)
      let d = (LEL - gx * lpx - gy * lpy) * inv            // n·light with n = (−gx,−gy,1)/|·|
      if (d < 0.0) d = 0.0
      let zn = z * invZ
      if (zn < 0.0) zn = 0.0
      if (zn > 1.0) zn = 1.0
      // plate sheen leaning toward the light + height lift + raking shade
      let lum = 0.075 + 0.10 * (qx / W - 0.5) * lpx + 0.10 * (0.5 - py / H) * lpy
        + 0.04 * (qx / W + 1.0 - py / H)
        + 0.18 * zn + 0.62 * pow75(d) * (0.5 + 0.5 * zn)
      // curvature accent: convex breaks (ridges, rims, the lip line) draw as fine dark lines
      let lap = gl + gr + gu + gd - 4.0 * z
      if (lap < 0.0) {
        let cvv = -lap * 0.55; if (cvv > 1.0) cvv = 1.0
        lum = lum * (1.0 - 0.30 * cvv)
      }
      // contact seam: steep walls press a thin dark line into the plate around each subject
      let wA = 1.0 - z * seamZ
      if (wA > 0.0) {
        let ao = (gx * gx + gy * gy) * 1.4; if (ao > 1.0) ao = 1.0
        lum = lum * (1.0 - 0.30 * wA * ao)
      }
      // cast shadow: how far below the swept sunlight ceiling this pixel sits. The ceiling
      // decays at the light's slope, so shadows are hard at the contact and melt away at the
      // tip — and every subject self-shadows for free (the lips shade their own hollows, the
      // torus bowl catches its far rim's shade).
      let sraw = sb[i] - z - 0.8
      if (sraw > 0.0) {
        let s1 = sraw * invSoft
        if (s1 > 1.0) s1 = 1.0
        lum = lum * (1.0 - 0.52 * s1)
      }
      gray[i] = lum
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

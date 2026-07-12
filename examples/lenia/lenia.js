// Flow-Lenia — Lenia with MASS CONSERVATION (Plantec et al. 2022). Reproduces the emergent
// cell-like creatures of x.com/Waterflowing0/status/2075882228387610847: nothing is ever
// created or destroyed — the classic Lenia growth field only says where mass WANTS to be,
// and the mass flows there. Three channels (rendered magenta / cyan-blue / green) coupled by
// six smooth ring kernels (three self, three in a cycle 0→1→2→0):
//
//   U_c(x)  = Σ_k h_k · ( 2·exp(−(K_k*A_src − μ_k)²/2σ_k²) − 1 )      affinity field
//   F_c(x)  = (1−α)·∇U_c − α·∇S,  α = clip((S/θ)², 0, 1)             flow: climb affinity,
//                                                                     but crowded cells (S =
//                                                                     total mass) diffuse
//   A′_c    = reintegration of A_c along F_c·dt                       bilinear mass splat —
//                                                                     EXACTLY conservative
//
// Creatures emerge, wander, merge and split; total mass stays constant, so the population
// can never bloom to white or die to black. A whisper of diffusion each step keeps the
// splat from clumping at grid scale. frame(dt, mx, my, pull): pull > 0 herds mass toward
// (mx,my) — drag to shepherd the creatures. seed() re-soups; seedBrush(x,y,r) pours fresh
// mass. Each channel lives in its own buffer (a0/a1/a2 ping-ponged with b0/b1/b2), picked
// by reference before each sweep so every inner loop runs on plain arrays.
// resize(w,h) → Uint32Array (ARGB).

let W = 0, H = 0, px, n = 0
let a0, a1, a2        // channel mass fields (current)
let b0, b1, b2        // ping-pong targets
let U0, U1, U2        // per-channel affinity
let S                 // total mass per cell

const NK = 6
// kernels: src channel, dst channel, radius, growth centre μ, growth width σ, weight h
let ksrc = new Int32Array([0, 1, 2, 0, 1, 2])
let kdst = new Int32Array([0, 1, 2, 1, 2, 0])
let krad = new Int32Array([6, 4, 8, 5, 6, 7])
let kmu = new Float64Array([0.28, 0.22, 0.30, 0.18, 0.20, 0.24])
let ksg = new Float64Array([0.09, 0.08, 0.10, 0.07, 0.08, 0.09])
let kh = new Float64Array([1.0, 1.0, 1.0, 0.7, 0.7, 0.7])
let koff = new Int32Array(NK + 1)   // prefix offsets into the concatenated tap arrays
let kdx, kdy, kw                    // concatenated ring taps (all six kernels)

const THETA = 1.6     // crowding threshold: above ~θ total mass, cells diffuse not climb
const DIFF = 0.035    // per-step diffusion to each 4-neighbour (0.86 stays put)

// count taps in the ring 0<r<=R (two-pass: jz arrays are sized before filling)
let ringCount = (R) => {
  let count = 0
  let dy = -R
  while (dy <= R) {
    let dx = -R
    while (dx <= R) {
      let r = Math.sqrt(dx * dx + dy * dy)
      if (r > 0.0 && r <= R) count++
      dx++
    }
    dy++
  }
  return count
}

export let resize = (w, h) => {
  W = w; H = h; n = w * h
  a0 = new Float64Array(n); a1 = new Float64Array(n); a2 = new Float64Array(n)
  b0 = new Float64Array(n); b1 = new Float64Array(n); b2 = new Float64Array(n)
  U0 = new Float64Array(n); U1 = new Float64Array(n); U2 = new Float64Array(n)
  S = new Float64Array(n)
  px = new Uint32Array(n)
  // build the six smooth ring kernels, concatenated: weight(r) = exp(−(r/R−0.5)²/2·0.15²)
  let total = 0
  let k = 0
  while (k < NK) { koff[k] = total; total = total + ringCount(krad[k]); k++ }
  koff[NK] = total
  kdx = new Int32Array(total); kdy = new Int32Array(total); kw = new Float64Array(total)
  k = 0
  while (k < NK) {
    let R = krad[k]
    let idx = koff[k]
    let wsum = 0.0
    let dy = -R
    while (dy <= R) {
      let dx = -R
      while (dx <= R) {
        let r = Math.sqrt(dx * dx + dy * dy)
        if (r > 0.0 && r <= R) {
          let nr = r / R - 0.5
          let wv = Math.exp(-(nr * nr) / 0.045)   // 2·0.15²
          kdx[idx] = dx; kdy[idx] = dy; kw[idx] = wv
          wsum = wsum + wv
          idx++
        }
        dx++
      }
      dy++
    }
    let inv = 1.0 / wsum
    let i = koff[k]
    while (i < idx) { kw[i] = kw[i] * inv; i++ }
    k++
  }
  return px
}

// stamp a round blob of channel mix (m0,m1,m2) into the current fields, torus-wrapped
let blob = (bx, by, br, amp, m0, m1, m2) => {
  let y = (by - br) | 0, y1 = (by + br) | 0
  while (y <= y1) {
    let dy = y - by
    let yy = y; if (yy < 0) yy = yy + H; else if (yy >= H) yy = yy - H
    let x = (bx - br) | 0, x1 = (bx + br) | 0
    while (x <= x1) {
      let dx = x - bx
      let d2 = (dx * dx + dy * dy) / (br * br)
      if (d2 < 1.0) {
        let xx = x; if (xx < 0) xx = xx + W; else if (xx >= W) xx = xx - W
        let c = yy * W + xx
        let f = (1.0 - d2) * amp
        a0[c] = a0[c] + m0 * f
        a1[c] = a1[c] + m1 * f
        a2[c] = a2[c] + m2 * f
      }
      x++
    }
    y++
  }
}

// fresh soup: scattered round blobs, each a random mix of the three channels
export let seed = () => {
  let i = 0
  while (i < n) { a0[i] = 0.0; a1[i] = 0.0; a2[i] = 0.0; i++ }
  let b = 0
  while (b < 30) {
    blob(Math.random() * W, Math.random() * H, 4.0 + Math.random() * 9.0, 0.62,
      Math.random(), Math.random(), Math.random())
    b++
  }
}

// pour fresh mass under the brush — a random channel mix, so new creatures differ
export let seedBrush = (cx, cy, r) => {
  blob(cx, cy, r, 0.5, Math.random(), Math.random(), Math.random())
}

export let frame = (dt, mx, my, pull) => {
  let w = W, h = H
  // ── affinity: six ring convolutions, each feeding its growth into the target channel ──
  let i = 0
  while (i < n) { U0[i] = 0.0; U1[i] = 0.0; U2[i] = 0.0; i++ }
  let k = 0
  while (k < NK) {
    let src = ksrc[k] === 1 ? a1 : ksrc[k] === 2 ? a2 : a0
    let dst = kdst[k] === 1 ? U1 : kdst[k] === 2 ? U2 : U0
    let t0 = koff[k], t1 = koff[k + 1]
    let mu = kmu[k], inv2s2 = 1.0 / (2.0 * ksg[k] * ksg[k]), hk = kh[k]
    let y = 0
    while (y < h) {
      let x = 0
      while (x < w) {
        let conv = 0.0
        let t = t0
        while (t < t1) {
          let nx = x + kdx[t]
          let ny = y + kdy[t]
          if (nx < 0) nx = nx + w; else if (nx >= w) nx = nx - w
          if (ny < 0) ny = ny + h; else if (ny >= h) ny = ny - h
          conv = conv + kw[t] * src[ny * w + nx]
          t++
        }
        let d = conv - mu
        let ci = y * w + x
        dst[ci] = dst[ci] + hk * (2.0 * Math.exp(-d * d * inv2s2) - 1.0)
        x++
      }
      y++
    }
    k++
  }
  // ── total mass per cell (drives the crowding brake) ──
  i = 0
  while (i < n) { S[i] = a0[i] + a1[i] + a2[i]; i++ }
  // ── flow + reintegration: move each cell's mass along the flow, splat bilinearly ──
  let invTh = 1.0 / THETA
  let hr = 0.35 * (w < h ? w : h)
  let ihr2 = 1.0 / (hr * hr)
  let c = 0
  while (c < 3) {
    let aa = c === 1 ? a1 : c === 2 ? a2 : a0
    let bb = c === 1 ? b1 : c === 2 ? b2 : b0
    let uu = c === 1 ? U1 : c === 2 ? U2 : U0
    i = 0
    while (i < n) { bb[i] = 0.0; i++ }
    let y = 0
    while (y < h) {
      let x = 0
      while (x < w) {
        let ci = y * w + x
        let m = aa[ci]
        if (m > 1e-12) {
          let xp = x + 1; if (xp >= w) xp = 0
          let xm = x - 1; if (xm < 0) xm = w - 1
          let yp = y + 1; if (yp >= h) yp = 0
          let ym = y - 1; if (ym < 0) ym = h - 1
          let al = S[ci] * invTh; al = al * al; if (al > 1.0) al = 1.0
          let ua = 1.0 - al
          let fx = ua * (uu[y * w + xp] - uu[y * w + xm]) * 0.5
            - al * (S[y * w + xp] - S[y * w + xm]) * 0.5
          let fy = ua * (uu[yp * w + x] - uu[ym * w + x]) * 0.5
            - al * (S[yp * w + x] - S[ym * w + x]) * 0.5
          // the shepherd: drag pulls mass gently toward the pointer
          if (pull > 0.0) {
            let ddx = mx - x, ddy = my - y
            let d2 = ddx * ddx + ddy * ddy
            let g = pull * 0.35 * Math.exp(-d2 * ihr2)
            let idd = 1.0 / Math.sqrt(d2 + 25.0)
            fx = fx + g * ddx * idd
            fy = fy + g * ddy * idd
          }
          // clip to one cell per step — reintegration stays local and stable
          let sx = fx * dt, sy = fy * dt
          let mv = Math.sqrt(sx * sx + sy * sy)
          if (mv > 1.0) { sx = sx / mv; sy = sy / mv }
          let tx = x + sx, ty = y + sy
          let xi = tx | 0; if (tx < xi) xi = xi - 1     // floor for negatives
          let yi = ty | 0; if (ty < yi) yi = yi - 1
          let fxr = tx - xi, fyr = ty - yi
          if (xi < 0) xi = xi + w; else if (xi >= w) xi = xi - w
          if (yi < 0) yi = yi + h; else if (yi >= h) yi = yi - h
          let xi1 = xi + 1; if (xi1 >= w) xi1 = 0
          let yi1 = yi + 1; if (yi1 >= h) yi1 = 0
          bb[yi * w + xi] = bb[yi * w + xi] + m * (1.0 - fxr) * (1.0 - fyr)
          bb[yi * w + xi1] = bb[yi * w + xi1] + m * fxr * (1.0 - fyr)
          bb[yi1 * w + xi] = bb[yi1 * w + xi] + m * (1.0 - fxr) * fyr
          bb[yi1 * w + xi1] = bb[yi1 * w + xi1] + m * fxr * fyr
        }
        x++
      }
      y++
    }
    c++
  }
  let t0s = a0; a0 = b0; b0 = t0s
  let t1s = a1; a1 = b1; b1 = t1s
  let t2s = a2; a2 = b2; b2 = t2s
  // ── a whisper of diffusion — keeps the splat from clumping at grid scale ──
  c = 0
  while (c < 3) {
    let aa = c === 1 ? a1 : c === 2 ? a2 : a0
    let bb = c === 1 ? b1 : c === 2 ? b2 : b0
    let y = 0
    while (y < h) {
      let yp = y + 1; if (yp >= h) yp = 0
      let ym = y - 1; if (ym < 0) ym = h - 1
      let x = 0
      while (x < w) {
        let xp = x + 1; if (xp >= w) xp = 0
        let xm = x - 1; if (xm < 0) xm = w - 1
        bb[y * w + x] = aa[y * w + x] * (1.0 - 4.0 * DIFF)
          + (aa[y * w + xp] + aa[y * w + xm] + aa[yp * w + x] + aa[ym * w + x]) * DIFF
        x++
      }
      y++
    }
    c++
  }
  t0s = a0; a0 = b0; b0 = t0s
  t1s = a1; a1 = b1; b1 = t1s
  t2s = a2; a2 = b2; b2 = t2s
  // ── render: each channel its own hue (magenta / cyan-blue / green), sqrt exposure ──
  i = 0
  while (i < n) {
    let v0 = a0[i]; if (v0 > 2.5) v0 = 2.5
    let v1 = a1[i]; if (v1 > 2.5) v1 = 2.5
    let v2 = a2[i]; if (v2 > 2.5) v2 = 2.5
    v0 = Math.sqrt(v0 * 0.4); v1 = Math.sqrt(v1 * 0.4); v2 = Math.sqrt(v2 * 0.4)
    let r = v0 + 0.15 * v1 + 0.55 * v2
    let g = 0.1 * v0 + 0.5 * v1 + v2
    let b = v0 + v1 + 0.1 * v2
    if (r > 1.0) r = 1.0
    if (g > 1.0) g = 1.0
    if (b > 1.0) b = 1.0
    px[i] = (255 << 24) | (((b * 255.0) | 0) << 16) | (((g * 255.0) | 0) << 8) | ((r * 255.0) | 0)
    i++
  }
}

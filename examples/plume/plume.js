// Plume — a 200×200 lattice of points pushed through seven lines of trigonometry, the whole
// figure drawn twice at 180°. Reproduces the animated formula-art piece shared by
// @Rainmaker1973 (x.com/Rainmaker1973/status/2075485116856504794, rendered in Processing by
// 数理世界) — the tweet-sized generative genre pioneered by @yuruyurau. The formula, verbatim
// from the video overlay:
//   k = 5·cos(x/14)·cos(y/30)
//   e = y/8 − 13
//   d = (k²+e²)/59 + 4
//   q = 60 − 3·sin(atan2(k,e)·e) + k·(3 + A/d·sin(d²−2t))     (A = 4 in the original)
//   c = d/2 + e/99 − t/18
//   → point at (u,v) = (3q·sin c, 3(q+9d)·cos c)
// Each grid point lands somewhere on a feathered plume — the cap is the low-d core, the barbs
// are the sin(d²−2t) ripple sweeping outward as t runs. Points splat additively into an RGB
// accumulator (hue follows d, so the ribs band into rainbow rings) and tone-map through a
// soft-saturation exp curve. frame(t, amp, hue0): amp is the barb-ripple depth A, hue0 spins
// the palette. resize(w,h) → Uint32Array px.
let W = 0, H = 0, px
let acc               // Float64Array, W*H*3 — additive RGB exposure for this frame
let elut              // Int32Array(1024) — 255·(1−e^(−v/150)) soft-saturation tone curve

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  acc = new Float64Array(w * h * 3)
  elut = new Int32Array(1024)
  let i = 0
  while (i < 1024) {
    let g = (255.0 * (1.0 - Math.exp(-(i * 1.5) / 150.0))) | 0   // bucket i ↔ exposure v = 1.5·i
    if (g > 255) g = 255
    elut[i] = g
    i++
  }
  return px
}

// additive 5-tap splat (centre + orthogonal neighbours at 35%) — dots glow where they overlap
let splat = (x, y, r, g, b) => {
  let xi = (x + 0.5) | 0, yi = (y + 0.5) | 0
  if (xi < 1 || xi >= W - 1 || yi < 1 || yi >= H - 1) return
  let i = (yi * W + xi) * 3
  acc[i] = acc[i] + r; acc[i + 1] = acc[i + 1] + g; acc[i + 2] = acc[i + 2] + b
  let r3 = r * 0.35, g3 = g * 0.35, b3 = b * 0.35
  i = (yi * W + xi - 1) * 3
  acc[i] = acc[i] + r3; acc[i + 1] = acc[i + 1] + g3; acc[i + 2] = acc[i + 2] + b3
  i = (yi * W + xi + 1) * 3
  acc[i] = acc[i] + r3; acc[i + 1] = acc[i + 1] + g3; acc[i + 2] = acc[i + 2] + b3
  i = ((yi - 1) * W + xi) * 3
  acc[i] = acc[i] + r3; acc[i + 1] = acc[i + 1] + g3; acc[i + 2] = acc[i + 2] + b3
  i = ((yi + 1) * W + xi) * 3
  acc[i] = acc[i] + r3; acc[i + 1] = acc[i + 1] + g3; acc[i + 2] = acc[i + 2] + b3
}

export let frame = (t, amp, hue0) => {
  let n3 = W * H * 3, i = 0
  while (i < n3) { acc[i] = 0.0; i++ }

  // the figure's (u,v) bounding box is ~[−84,236]×[−426,−26] over a full cycle — recentre on
  // its middle (76,−226) and scale to the canvas; two copies at 180° make the yin-yang pair
  let s = H < W * 1.18 ? H / 560.0 : W * 1.18 / 560.0
  let c1x = W * 0.63, c1y = H * 0.46
  let c2x = W * 0.37, c2y = H * 0.54

  let y = 0
  while (y < 200) {
    let e = y / 8.0 - 13.0
    let cy30 = Math.cos(y / 30.0)
    let x = 0
    while (x < 200) {
      let k = 5.0 * Math.cos(x / 14.0) * cy30
      let d = (k * k + e * e) / 59.0 + 4.0
      let q = 60.0 - 3.0 * Math.sin(Math.atan2(k, e) * e) + k * (3.0 + amp / d * Math.sin(d * d - 2.0 * t))
      let c = d * 0.5 + e / 99.0 - t / 18.0
      let u = (3.0 * q * Math.sin(c) - 76.0) * s
      let v = (3.0 * (q + 9.0 * d) * Math.cos(c) + 226.0) * s

      // hue follows d — the ripple bands ring into a rainbow; inline HSV→RGB (S=.9, V=1)
      let hue = (d - 4.0) * 95.0 + 50.0 + t * 8.0 + hue0
      hue = hue - Math.floor(hue / 360.0) * 360.0
      let hs = hue / 60.0
      let hf = hs - Math.floor(hs * 0.5) * 2.0            // position within a 120° double-sector
      let xx = 1.0 - (hf < 1.0 ? 1.0 - hf : hf - 1.0)     // triangle wave 0→1→0
      let cr = 0.1, cg = 0.1, cb = 0.1                    // V·(1−S) floor
      let xc = 0.1 + 0.9 * xx
      if (hs < 1.0) { cr = 1.0; cg = xc }
      else if (hs < 2.0) { cr = xc; cg = 1.0 }
      else if (hs < 3.0) { cg = 1.0; cb = xc }
      else if (hs < 4.0) { cg = xc; cb = 1.0 }
      else if (hs < 5.0) { cr = xc; cb = 1.0 }
      else { cr = 1.0; cb = xc }

      splat(c1x + u, c1y + v, cr * 110.0, cg * 110.0, cb * 110.0)
      splat(c2x - u, c2y - v, cr * 110.0, cg * 110.0, cb * 110.0)
      x++
    }
    y++
  }

  // tone-map: soft saturation via the exp LUT, per channel
  let p = 0, n = W * H
  while (p < n) {
    let j = p * 3
    let qr = (acc[j] * 0.6666666666666666) | 0; if (qr > 1023) qr = 1023
    let qg = (acc[j + 1] * 0.6666666666666666) | 0; if (qg > 1023) qg = 1023
    let qb = (acc[j + 2] * 0.6666666666666666) | 0; if (qb > 1023) qb = 1023
    px[p] = (255 << 24) | (elut[qb] << 16) | (elut[qg] << 8) | elut[qr]
    p++
  }
}

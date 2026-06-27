// Ripple rings — a drop sends out ONE wavefront that bursts out fast, DECELERATES gradually to a stop,
// and fades, with a few small oscillations trailing the front (and nothing else — no spurious secondary
// wave). Drawn, not simulated: a real wavefront travels at a constant speed and refocuses an inward
// echo, neither of which is wanted here — a drawn ring slows down and stays clean. Rings accumulate into
// a field; where DIFFERENT circles overlap the field sums and GLARES — a white-hot glint plus a wide
// round bloom halo. Rings render at a consistent brightness regardless of age (Reinhard tone-map), dim
// grey, so the crossings stand out. Black field.
//
// A genuine per-pixel jz kernel (rasterise the ring annuli + separable blurs). resize(w,h)→Uint32Array.

let W = 0, H = 0, px
let acc, blm, btmp, btmp2   // ring field / bloom excess / blur scratch (×2 for a round double-blur)

let MAXD = 64               // max simultaneous rings (ring buffer of slots)
let cxs = new Float64Array(MAXD), cys = new Float64Array(MAXD)
let age = new Float64Array(MAXD), live = new Int32Array(MAXD)
let slot = 0
let RMAX = 0.0              // radius a ring eases to before stopping (set from canvas size)

const TGROW = 200.0    // frames to expand & DECELERATE to a stop — fast at first, slowing gradually (~3.3s)
const LIFE = 600.0     // frames until fully gone — the ring fades out & disappears by ~10s (not forever)
const FADE0 = 260.0    // holds full brightness until here (consistent), then ramps to 0 by LIFE
const RINGW = 1.2      // front/ripple half-thickness → thin
const LAMBDA = 11.0    // spacing of the small trailing oscillations behind the front
const W0 = 1.0, W1 = 0.28, W2 = 0.12, W3 = 0.05   // front + a short, decaying tail of small ripples
const GAIN = 2.0       // Reinhard input scale — rings read as a consistent dim grey
const BTHRESH = 1.5    // glare gate on field² (a lone front is 1.0; only where circles SUM does it clear)
const CROSSADD = 0.85  // crossing field² added straight into the display → a white-hot glint core
const BRAD = 6         // tight bloom radius → the glint
const BRAD2 = 32       // wide bloom radius → the big soft round glow halo
const BLOOMADD = 24.0
const BLOOMADD2 = 46.0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  acc = new Float32Array(w * h)
  blm = new Float32Array(w * h); btmp = new Float32Array(w * h); btmp2 = new Float32Array(w * h)
  let m = w < h ? w : h
  RMAX = m * 0.34
  return px
}

export let clear = () => { let i = 0; while (i < MAXD) { live[i] = 0; i++ } }

// spawn a ring at (x,y) — recycles the oldest slot when full
export let drop = (x, y) => {
  let s = slot
  cxs[s] = x; cys[s] = y; age[s] = 0.0; live[s] = 1
  slot = s + 1; if (slot >= MAXD) slot = 0
}

// Blur the bloom excess (blm) by radius R, run TWICE (≈ Gaussian → round halo), add weight×it to acc.
// Four separable passes: blm →1H→ btmp →1V→ btmp2 →2H→ btmp →2V→ acc. (buffers referenced directly.)
let blurAdd = (R, weight) => {
  let w = W, h = H, inv = 1.0 / (2.0 * R + 1.0)
  let y = 0
  while (y < h) {                         // 1H: blm → btmp
    let row = y * w, s = 0.0, x = 0
    while (x <= R) { s = s + blm[row + x]; x++ }
    x = 0
    while (x < w) {
      btmp[row + x] = s * inv
      if (x + R + 1 < w) s = s + blm[row + x + R + 1]
      if (x - R >= 0) s = s - blm[row + x - R]
      x++
    }
    y++
  }
  let x2 = 0
  while (x2 < w) {                        // 1V: btmp → btmp2
    let s = 0.0, yy = 0
    while (yy <= R) { s = s + btmp[yy * w + x2]; yy++ }
    yy = 0
    while (yy < h) {
      btmp2[yy * w + x2] = s * inv
      if (yy + R + 1 < h) s = s + btmp[(yy + R + 1) * w + x2]
      if (yy - R >= 0) s = s - btmp[(yy - R) * w + x2]
      yy++
    }
    x2++
  }
  y = 0
  while (y < h) {                         // 2H: btmp2 → btmp
    let row = y * w, s = 0.0, x = 0
    while (x <= R) { s = s + btmp2[row + x]; x++ }
    x = 0
    while (x < w) {
      btmp[row + x] = s * inv
      if (x + R + 1 < w) s = s + btmp2[row + x + R + 1]
      if (x - R >= 0) s = s - btmp2[row + x - R]
      x++
    }
    y++
  }
  x2 = 0
  while (x2 < w) {                        // 2V: btmp → accumulate into acc (the display field)
    let s = 0.0, yy = 0
    while (yy <= R) { s = s + btmp[yy * w + x2]; yy++ }
    yy = 0
    while (yy < h) {
      acc[yy * w + x2] = acc[yy * w + x2] + weight * (s * inv)
      if (yy + R + 1 < h) s = s + btmp[(yy + R + 1) * w + x2]
      if (yy - R >= 0) s = s - btmp[(yy - R) * w + x2]
      yy++
    }
    x2++
  }
}

export let frame = (t) => {
  let w = W, h = H, n = w * h
  let i = 0
  while (i < n) { acc[i] = 0.0; i++ }                  // clear the ring field

  // draw every live ring (additive): the front eases out (fast → gradually slowing to a stop), trailing
  // a few small ripples; brightness holds then fades.
  let k = 0
  while (k < MAXD) {
    if (live[k] != 0) {
      let a = age[k] + 1.0
      age[k] = a
      if (a >= LIFE) { live[k] = 0 }
      else {
        let p = a / TGROW; if (p > 1.0) p = 1.0
        let R = RMAX * (1.0 - (1.0 - p) * (1.0 - p))   // ease-out: fast, decelerating to a stop at TGROW
        let f = 1.0
        if (a > FADE0) f = 1.0 - (a - FADE0) / (LIFE - FADE0)
        if (R > 0.5 && f > 0.01) {
          let cx = cxs[k], cy = cys[k], rw = RINGW, inv = 1.0 / rw
          let rOut = R + rw, rIn = R - 3.0 * LAMBDA - rw; if (rIn < 0.0) rIn = 0.0
          let rOut2 = rOut * rOut, rIn2 = rIn * rIn
          let x0 = (cx - rOut - 1.0) | 0, x1 = (cx + rOut + 1.0) | 0
          let y0 = (cy - rOut - 1.0) | 0, y1 = (cy + rOut + 1.0) | 0
          if (x0 < 0) x0 = 0
          if (y0 < 0) y0 = 0
          if (x1 > w - 1) x1 = w - 1
          if (y1 > h - 1) y1 = h - 1
          let y = y0
          while (y <= y1) {
            let ddy = y - cy, row = y * w, x = x0
            while (x <= x1) {
              let ddx = x - cx, d2 = ddx * ddx + ddy * ddy
              if (d2 <= rOut2 && d2 >= rIn2) {
                let behind = R - Math.sqrt(d2)          // 0 at the front, grows inward
                let b = 0.0
                let e0 = behind * inv;                  if (e0 > -1.0 && e0 < 1.0) b = b + (1.0 - e0 * e0) * W0
                let e1 = (behind - LAMBDA) * inv;       if (e1 > -1.0 && e1 < 1.0) b = b + (1.0 - e1 * e1) * W1
                let e2 = (behind - 2.0 * LAMBDA) * inv; if (e2 > -1.0 && e2 < 1.0) b = b + (1.0 - e2 * e2) * W2
                let e3 = (behind - 3.0 * LAMBDA) * inv; if (e3 > -1.0 && e3 < 1.0) b = b + (1.0 - e3 * e3) * W3
                if (b > 0.0) acc[row + x] = acc[row + x] + b * f
              }
              x++
            }
            y++
          }
        }
      }
    }
    k++
  }

  // render: Reinhard-toned rings (consistent + rich) + a white-hot glint and bloom where circles SUM
  let i2 = 0
  while (i2 < n) {
    let c = acc[i2]
    let cg = c * GAIN
    let e = c * c - BTHRESH                              // a lone front is 1.0; overlaps exceed the gate
    let ex = e > 0.0 ? e : 0.0
    blm[i2] = ex                                        // → wide bloom halo (below)
    btmp2[i2] = cg / (cg + 1.0) + CROSSADD * ex          // ring profile + white-hot glint core at overlaps
    i2++
  }
  i2 = 0
  while (i2 < n) { acc[i2] = btmp2[i2]; i2++ }            // staged display into acc; blurAdd adds bloom on top
  blurAdd(BRAD, BLOOMADD)
  blurAdd(BRAD2, BLOOMADD2)

  // tone-map → white on black
  i2 = 0
  while (i2 < n) {
    let g = acc[i2]; if (g > 1.0) g = 1.0
    let v = (g * 255.0) | 0
    px[i2] = (255 << 24) | (v << 16) | (v << 8) | v
    i2++
  }
}

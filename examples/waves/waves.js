// Expanding ripple rings. Each drop spawns a thin white ring that bursts out fast, DECELERATES (its
// radius eases toward a maximum), and FADES to nothing — so rings settle and vanish instead of
// travelling forever. Rings are drawn ADDITIVELY into an intensity buffer, so where they overlap the
// values sum and the squared tone-map makes the intersections (and their immediate proximity) GLARE
// far brighter than a lone ring — no dark interference gaps. Black field, white rings.
//
// This is a motion-graphics effect, not the wave PDE — which is exactly why it can do the look the
// equation can't (a real wavefront travels at constant speed and never localises a clean bright knot).
// Still a genuine per-pixel jz kernel (draw the ring annuli + tone-map), so the JS⇄jz toggle stands.

let W = 0, H = 0, px
let acc            // Float32 intensity buffer (additive ring contributions)
let RMAX = 0.0     // max ring radius — set from the canvas size in resize()

let MAXD = 96      // max simultaneous rings (ring buffer of slots)
let cxs = new Float64Array(MAXD)   // centre x
let cys = new Float64Array(MAXD)   // centre y
let age = new Float64Array(MAXD)   // age in frames
let live = new Int32Array(MAXD)    // 1 = active
let slot = 0

const LIFE = 150.0    // frames until a ring has fully faded (then it's freed) — ~2.5s at 60Hz
const RINGW = 2.2     // ring half-thickness in px → thin
const GAIN = 4.6      // overall brightness
const SPEED0 = 0.042  // expansion-easing rate: fast burst, clearly decelerating over ~1.5s toward RMAX

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  acc = new Float32Array(w * h)
  let m = w < h ? w : h
  RMAX = m * 0.46
  return px
}

export let clear = () => { let i = 0; while (i < MAXD) { live[i] = 0; i++ } }

// spawn a ring at (x, y) — recycles the oldest slot when full
export let drop = (x, y) => {
  let s = slot
  cxs[s] = x; cys[s] = y; age[s] = 0.0; live[s] = 1
  slot = s + 1; if (slot >= MAXD) slot = 0
}

export let frame = (t) => {
  let w = W, h = H, n = w * h
  let i = 0
  while (i < n) { acc[i] = 0.0; i++ }                  // clear the intensity field

  // draw every live ring additively
  let k = 0
  while (k < MAXD) {
    if (live[k] != 0) {
      let a = age[k] + 1.0
      age[k] = a
      if (a >= LIFE) { live[k] = 0 }
      else {
        let cx = cxs[k], cy = cys[k]
        // decelerating radius: fast burst then easing toward RMAX (1 − e^{−age·SPEED0})
        let R = RMAX * (1.0 - Math.exp(-a * SPEED0))
        // brightness: fades to 0 over the lifetime, and dims as the ring grows (energy spreads round
        // a longer circumference) so big rings are faint — small/young ones bright.
        let f = 1.0 - a / LIFE
        f = f * f * (120.0 / (120.0 + R))
        if (R > 0.5 && f > 0.002) {
          let rw = RINGW, inv = 1.0 / rw
          let rOut = R + rw, rIn = R - rw; if (rIn < 0.0) rIn = 0.0
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
              if (d2 <= rOut2 && d2 >= rIn2) {        // only the thin annulus pays for a sqrt
                let e = (Math.sqrt(d2) - R) * inv     // −1..1 across the band
                let b = 1.0 - e * e                   // smooth ring profile, peak at the crest
                acc[row + x] = acc[row + x] + b * f
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

  // tone-map: white on black, intensity SQUARED so overlapping rings (intersections) glare
  let j = 0
  while (j < n) {
    let g = acc[j] * GAIN
    g = g * g
    if (g > 1.0) g = 1.0
    let v = (g * 255.0) | 0
    px[j] = (255 << 24) | (v << 16) | (v << 8) | v
    j++
  }
}

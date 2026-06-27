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
let blm, btmp      // bloom source / scratch (glow around the bright intersections)
let RMAX = 0.0     // max ring radius — set from the canvas size in resize()

let MAXD = 96      // max simultaneous rings (ring buffer of slots)
let cxs = new Float64Array(MAXD)   // centre x
let cys = new Float64Array(MAXD)   // centre y
let age = new Float64Array(MAXD)   // age in frames
let live = new Int32Array(MAXD)    // 1 = active
let slot = 0

const LIFE = 320.0    // frames until a ring has fully faded — ~5s at 60Hz (slow, gentle rings)
const LAMBDA = 14.0   // wavelength: spacing of the concentric crests in each packet → reads as a WAVE
const RINGW = 2.0     // crest half-thickness in px → thin
const GAIN = 1.3      // overall brightness — lone rings read as grey, leaving headroom so overlaps stand out
const SPEED0 = 0.0095 // expansion-easing rate — ~4.5× slower than before: a gentle burst that decelerates
const BTHRESH = 0.72  // only intensity above this (i.e. where rings overlap) feeds the bloom
const BRAD = 6        // bloom blur radius → glow spreads into the proximity of each intersection
const BLOOMADD = 2.6  // how hard the intersection glow is added back

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  acc = new Float32Array(w * h)
  blm = new Float32Array(w * h)
  btmp = new Float32Array(w * h)
  let m = w < h ? w : h
  RMAX = m * 0.42
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
        // brightness: linear fade to 0 over the lifetime, so the ring stays clearly visible the whole
        // time it expands (a faster decay would make the slow wave invisible for most of its travel).
        let f = 1.0 - a / LIFE
        if (R > 0.5 && f > 0.002) {
          let rw = RINGW, inv = 1.0 / rw
          // one dominant wavefront at d=R, followed by a soft small oscillation a wavelength behind (and a
          // barely-there second) → reads as a single spreading wave with a gentle trailing ripple.
          let rOut = R + rw, rIn = R - 2.0 * LAMBDA - rw; if (rIn < 0.0) rIn = 0.0
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
              if (d2 <= rOut2 && d2 >= rIn2) {        // only the thin packet band pays for a sqrt
                let behind = R - Math.sqrt(d2)        // 0 at the leading crest, grows inward
                let b = 0.0
                let e0 = behind * inv;                  if (e0 > -1.0 && e0 < 1.0) b = b + (1.0 - e0 * e0)
                let e1 = (behind - LAMBDA) * inv;       if (e1 > -1.0 && e1 < 1.0) b = b + (1.0 - e1 * e1) * 0.22
                let e2 = (behind - 2.0 * LAMBDA) * inv; if (e2 > -1.0 && e2 < 1.0) b = b + (1.0 - e2 * e2) * 0.06
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

  // bloom source: only the EXCESS where rings overlap (acc > BTHRESH) → lone rings don't glow, crossings do
  let p = 0
  while (p < n) { let e = acc[p] - BTHRESH; blm[p] = e > 0.0 ? e : 0.0; p++ }
  // separable box blur (running sum), blm →(horizontal)→ btmp →(vertical)→ blm: glow into the proximity
  let inv = 1.0 / (2.0 * BRAD + 1.0)
  let y = 0
  while (y < h) {
    let row = y * w, s = 0.0, x = 0
    while (x <= BRAD) { s = s + blm[row + x]; x++ }
    x = 0
    while (x < w) {
      btmp[row + x] = s * inv
      let xa = x - BRAD, xr = x + BRAD + 1
      if (xr < w) s = s + blm[row + xr]
      if (xa >= 0) s = s - blm[row + xa]
      x++
    }
    y++
  }
  let x2 = 0
  while (x2 < w) {
    let s = 0.0, yy = 0
    while (yy <= BRAD) { s = s + btmp[yy * w + x2]; yy++ }
    yy = 0
    while (yy < h) {
      blm[yy * w + x2] = s * inv
      let ya = yy - BRAD, yr = yy + BRAD + 1
      if (yr < h) s = s + btmp[(yr) * w + x2]
      if (ya >= 0) s = s - btmp[(ya) * w + x2]
      yy++
    }
    x2++
  }

  // tone-map: white on black, intensity SQUARED so overlaps already lift, then add the intersection glow
  let j = 0
  while (j < n) {
    let g = acc[j] * GAIN
    g = g * g + blm[j] * BLOOMADD
    if (g > 1.0) g = 1.0
    let v = (g * 255.0) | 0
    px[j] = (255 << 24) | (v << 16) | (v << 8) | v
    j++
  }
}

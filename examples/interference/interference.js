// Interference — Huygens' principle made visible. N coherent point sources laid along a line (a
// slit, or a fine grating) each radiate an outward cylindrical wave
//   sin(k·d_i − ωt) / √d_i
// — amplitude falling off with distance like a real 2D wave, not the flat-amplitude rings a
// textbook sketch draws. Every pixel sums all N contributions; in phase they build a bright fringe,
// out of phase they cancel — sum enough sources and the familiar N-slit grating structure (sharp
// principal maxima, faint secondary ones between) emerges from nothing more than addition.
//
// The host drives two independent axes: drag horizontal morphs the source COUNT (2 → 32 — a plain
// double-slit sharpening into a fine grating), vertical sets the SPAN the sources are spread across
// (the slit separation). Idle, both drift on their own.
//
// Per pixel: an inner loop sums the (at most 32) sources — the same "outer pixel loop wrapping a
// per-source reduction" shape as examples/metaballs/metaballs.js's blob sum, so jz's outer-strip
// vectorizer lifts it (two adjacent pixels/lane; sqrt/sin/div → f64x2, bit-exact). The sRGB tone-map
// is untouched (module/math.js's constant-exponent emitPow rewrites `a**(1/2.4)` to exp∘log at
// compile time, so no per-lane pow is needed there either).

let width = 320, height = 200
let mem

const MAXSRC = 32
let srcX = new Float64Array(MAXSRC), srcY = new Float64Array(MAXSRC)

export let resize = (w, h) => {
  width = w; height = h
  mem = new Int32Array(w * h)
  return mem
}

// n coherent sources evenly spaced along a horizontal line of the given span, centred in the
// canvas — n=2 is a plain double slit, n>2 a grating. tick drives the shared oscillation phase.
export let frame = (tick, n, span) => {
  let cnt = n | 0
  if (cnt < 1) cnt = 1
  if (cnt > MAXSRC) cnt = MAXSRC
  let cxs = width * 0.5, cys = height * 0.5
  if (cnt === 1) { srcX[0] = cxs; srcY[0] = cys }
  else {
    let step = span / (cnt - 1)
    let x0 = cxs - span * 0.5
    let i = 0
    while (i < cnt) { srcX[i] = x0 + i * step; srcY[i] = cys; i++ }
  }

  let w = width, h = height
  let res = 48.0 / Math.max(w, h)      // spatial frequency — fringes per pixel
  let omega = tick * 8.0
  let norm = 6.0 / Math.sqrt(cnt)      // keeps typical brightness roughly level as the count grows

  let row = 0, y = 0
  while (y < h) {
    // Sample each pixel's CENTER (y+0.5, x+0.5 below), not its corner — the correct discretization,
    // and it also keeps xf/yf genuinely fractional so jz types them f64 all the way into the source
    // loop (an integer-valued `x - srcX[b]` would let jz narrow the promotion back to i32 and hoist
    // it out of the loop as a preamble, which the outer-strip vectorizer's inner-loop match rejects).
    let yf = y + 0.5
    let x = 0
    while (x < w) {
      let xf = x + 0.5
      let sum = 0.0
      let b = 0
      while (b < cnt) {
        let dx = xf - srcX[b], dy = yf - srcY[b]
        let d = Math.sqrt(dx * dx + dy * dy + 4.0)   // +4: caps the amplitude right at a source
        sum = sum + Math.sin(d * res - omega) / Math.sqrt(d)
        b++
      }
      // sRGB transfer = perceptual lightness: an even gradient, dark fringes lifted, and — since
      // a≤1 — no overflow.
      let a = sum < 0.0 ? -sum : sum
      a = a * norm
      if (a > 1.0) a = 1.0
      let s = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1.0 / 2.4) - 0.055
      // Math.round (not `|0` truncate): jz's $math.sin2 polynomial agrees with V8's native Math.sin
      // only to ~1e-7 (sqrt is exact — it's WASM's native f64.sqrt on both sides — but sin has no
      // hardware instruction, so jz evaluates its own approximation). Summed over up to 32 sources
      // that's occasionally enough to land right on an integer boundary, where round() recovers the
      // same byte in both engines (the gap is far under 0.5) while truncate rounds one of them down
      // a full count.
      let vi = Math.round(s * 255.0) | 0
      if (vi > 255) vi = 255
      mem[row + x] = (0xff000000) | (vi << 16) | (vi << 8) | vi
      x++
    }
    row += w
    y++
  }
}

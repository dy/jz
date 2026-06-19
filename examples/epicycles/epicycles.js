// Fourier epicycles — any closed curve deconstructed into rotating circles.
// The heart curve is sampled at N=256 points, its DFT computed, and each frequency
// component becomes one spinning arm. Sorted by magnitude descending, the largest
// circles dominate the shape; tiny ones refine the cusps. The tip traces the heart.
//
// jz typing rules: f64 by default; i32 for bitwise. No mutable fractional module
// globals (they narrow to i32 in wasm). All persistent fractional state lives in
// typed arrays allocated at module level or in resize().
// resize(w,h) → Uint32Array; init() computes DFT; frame(t, phi) renders.

let W = 0, H = 0
let px        // Uint32Array — pixel buffer

let N = 256

// DFT outputs — f64 to avoid i32-narrowing
let C_re   = new Float64Array(N)   // real part of each Fourier coefficient
let C_im   = new Float64Array(N)   // imaginary part
let mags   = new Float64Array(N)   // magnitude |C[k]|
let freqs  = new Float64Array(N)   // mapped frequency k' in (-N/2, N/2]

// Sorted index list — Int32Array so loop counters stay i32-clean
let sortedIdx = new Int32Array(N)

// Heart-curve samples — preallocated at module scope, NOT inside init(). Allocating in
// init() would bump the heap *after* resize() handed the host its px view, and if that
// bump grows wasm memory the px ArrayBuffer detaches (length→0) → a blank canvas.
let hx = new Float64Array(N)
let hy = new Float64Array(N)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

export let init = () => {
  // Sample heart curve at N points (into the module-level hx/hy — no allocation here)
  let PI2 = 6.283185307179586   // 2*PI
  let n = 0
  while (n < N) {
    let tau = PI2 * n / N
    let s = Math.sin(tau)
    hx[n] = 16.0 * s * s * s
    // flip Y for screen coords (heart opens upward on math axes → downward on screen)
    hy[n] = -(13.0 * Math.cos(tau) - 5.0 * Math.cos(2.0 * tau) - 2.0 * Math.cos(3.0 * tau) - Math.cos(4.0 * tau))
    n++
  }

  // Compute DFT: treat heart as complex z_n = hx[n] + i*hy[n]
  // C[k] = (1/N) * sum_n( z_n * e^(-2*PI*i*k*n/N) )
  // C_re[k] = (1/N) * sum_n( hx[n]*cos(2*PI*k*n/N) + hy[n]*sin(2*PI*k*n/N) )
  // C_im[k] = (1/N) * sum_n( -hx[n]*sin(2*PI*k*n/N) + hy[n]*cos(2*PI*k*n/N) )
  let k = 0
  while (k < N) {
    let re = 0.0, im = 0.0
    let ni = 0
    while (ni < N) {
      let ang = PI2 * k * ni / N
      let ca = Math.cos(ang), sa = Math.sin(ang)
      re += hx[ni] * ca + hy[ni] * sa
      im += -hx[ni] * sa + hy[ni] * ca
      ni++
    }
    C_re[k] = re / N
    C_im[k] = im / N
    mags[k] = Math.sqrt(C_re[k] * C_re[k] + C_im[k] * C_im[k])
    // map frequency: k <= N/2 → k, else k - N  (shift to centered range)
    freqs[k] = k <= (N / 2) ? k : k - N
    k++
  }

  // Initialize sorted indices 0..N-1
  let si = 0
  while (si < N) { sortedIdx[si] = si; si++ }

  // Insertion sort by magnitude descending (256 elements, done once)
  let i = 1
  while (i < N) {
    let key = sortedIdx[i]
    let keyMag = mags[key]
    let j = i - 1
    while (j >= 0 && mags[sortedIdx[j]] < keyMag) {
      sortedIdx[j + 1] = sortedIdx[j]
      j--
    }
    sortedIdx[j + 1] = key
    i++
  }
}

// Additive, saturating pixel write
let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let r = (p & 0xff) + rr
  let g = ((p >> 8) & 0xff) + gg
  let b = ((p >> 16) & 0xff) + bb
  if (r > 255) r = 255
  if (g > 255) g = 255
  if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

let line = (x0, y0, x1, y1, rr, gg, bb) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let x = x0, y = y0, s = 0
  while (s <= steps) {
    addpix(x | 0, y | 0, rr, gg, bb)
    x += xi; y += yi; s++
  }
}

// Draw a circle via ~60 line segments
let circle = (cx, cy, r, rr, gg, bb) => {
  if (r < 1.0) return
  let SEGS = 60
  let inv = 6.283185307179586 / SEGS
  let px0 = cx + r, py0 = cy
  let si = 1
  while (si <= SEGS) {
    let ang = si * inv
    let px1 = cx + r * Math.cos(ang), py1 = cy + r * Math.sin(ang)
    line(px0, py0, px1, py1, rr, gg, bb)
    px0 = px1; py0 = py1; si++
  }
}

export let frame = (t, phi) => {
  // Clear to opaque black
  let total = W * H, ci = 0
  while (ci < total) { px[ci] = (255 << 24); ci++ }

  // Scale: heart spans ~x∈[-16,16], y∈[-17,17]. Fit 75% of half the smaller dimension.
  let halfMin = (W < H ? W : H) * 0.5
  let scale = halfMin * 0.75 / 17.0

  let cx = W * 0.5, cy = H * 0.5

  // Walk the epicycle chain to find current tip
  let ex = cx, ey = cy
  let ki = 0
  while (ki < N) {
    let k = sortedIdx[ki] | 0
    let freq = freqs[k]
    let mag = mags[k] * scale
    let phase = Math.atan2(C_im[k], C_re[k])
    let ang = freq * phi + phase

    let nx = ex + mag * Math.cos(ang)
    let ny = ey + mag * Math.sin(ang)

    // Draw faint circle for this arm
    circle(ex, ey, mag, 15, 15, 15)
    // Draw arm line
    line(ex, ey, nx, ny, 200, 200, 200)

    ex = nx; ey = ny
    ki++
  }

  // Draw the traced curve. The epicycle tip path IS the heart, and the heart is already
  // sampled in hx/hy (screen point j = cx + scale*hx[j], cy + scale*hy[j]). So draw the
  // heart polyline from the start up to the sample the pen has reached — phi/2π of the way
  // around — then bridge that leading edge to the live tip. Deterministic and bit-exact
  // (no Math.* in the trace → JS and jz draw an identical heart), and it always completes
  // a full loop regardless of frame rate (the old fixed tip buffer froze at ~27%).
  let PI2 = 6.283185307179586
  let frac = phi / PI2
  if (frac < 0.0) frac = 0.0
  if (frac > 1.0) frac = 1.0
  let prog = (frac * N) | 0
  if (prog > N - 1) prog = N - 1
  let hxs = cx + scale * hx[0], hys = cy + scale * hy[0]
  let j = 0
  while (j < prog) {
    let nxh = cx + scale * hx[j + 1], nyh = cy + scale * hy[j + 1]
    line(hxs, hys, nxh, nyh, 255, 255, 255)
    hxs = nxh; hys = nyh
    j++
  }
  // Bridge the leading trace sample to the live epicycle tip (it sits between samples).
  line(hxs, hys, ex, ey, 255, 255, 255)

  // Highlight tip
  addpix(ex | 0, ey | 0, 255, 255, 255)
}

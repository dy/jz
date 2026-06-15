// Wave ripples — the 2D wave equation u_tt = c²∇²u on a grid, le-frog in time over two
// height buffers (current, previous): next = 2·cur − prev + c²·laplacian, lightly damped.
// Click drops a pulse; circular ripples spread, reflect off the edges, and interfere.
// Two continuously-driven point sources oscillating in phase set up a real, *standing*
// interference pattern (hyperbolic fringes) — not just transient overlap of passing pulses.
// A pure 5-point stencil sweep — memory-bound, the kind of loop jz vectorizes well.
// resize(w,h) → Uint32Array; drop() for a pulse, source() for a driven oscillator.

let W = 0, H = 0, px
let a, b              // height now / previous
let C2 = 0.40         // wave speed² (clean propagation; keep < 0.5 for stability)
let DAMP = 0.995      // damping → pulses fade out, yet driven sources reach across to interfere

let MAXS = 6          // continuously-driven sources (oscillators)
let sOn = new Int32Array(MAXS)
let sx = new Float64Array(MAXS), sy = new Float64Array(MAXS)
let sFreq = new Float64Array(MAXS), sAmp = new Float64Array(MAXS)
let tt = 0.0

// place/replace a driven oscillator k at (x,y), angular freq f (rad/step), amplitude amp
export let source = (k, x, y, f, amp) => { sOn[k] = 1; sx[k] = x; sy[k] = y; sFreq[k] = f; sAmp[k] = amp }
export let clearSources = () => { let i = 0; while (i < MAXS) { sOn[i] = 0; i++ } }

export let resize = (w, h) => {
  W = w; H = h
  a = new Float64Array(w * h); b = new Float64Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0.0; b[i] = 0.0; i++ } }

// drop a smooth pulse (raises the surface) at (cx,cy)
export let drop = (cx, cy, r, amp) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 1) x0 = 1
  if (y0 < 1) y0 = 1
  if (x1 > W - 2) x1 = W - 2
  if (y1 > H - 2) y1 = H - 2
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx, d2 = dx * dx + dy * dy
      if (d2 <= r2) { let w = 1.0 - d2 / r2; a[row + x] += amp * w; b[row + x] += amp * w }
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let w = W, h = H, y = 1
  while (y < h - 1) {
    let rc = y * w, rn = rc - w, rs = rc + w, x = 1
    while (x < w - 1) {
      let c = rc + x
      let lap = a[rn + x] + a[rs + x] + a[c - 1] + a[c + 1] - 4.0 * a[c]
      b[c] = (2.0 * a[c] - b[c] + C2 * lap) * DAMP    // next height → into b
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp                          // swap: a is now current

  // drive the continuous sources: clamp their cells to a sinusoid each step (Dirichlet
  // forcing). Two in-phase sources → their circular wavefronts superpose into fixed fringes.
  tt += 1.0
  let k = 0
  while (k < MAXS) {
    if (sOn[k] == 1) {
      let ix = sx[k] | 0, iy = sy[k] | 0
      if (ix > 0 && ix < w - 1 && iy > 0 && iy < h - 1) a[iy * w + ix] = sAmp[k] * Math.sin(tt * sFreq[k])
    }
    k++
  }

  // render: mid-gray surface, ripples lighten/darken it
  let n = w * h, i = 0
  while (i < n) {
    let v = 0.5 + a[i] * 1.9
    if (v < 0.0) v = 0.0
    if (v > 1.0) v = 1.0
    let g = (v * 255.0) | 0
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

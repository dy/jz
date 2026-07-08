// 2D Ising model — classical statistical mechanics on a square lattice.
// Each site holds a spin s∈{+1,-1}. The Metropolis algorithm flips spins
// probabilistically: favorable flips (ΔE≤0) are always accepted; unfavorable
// flips (ΔE>0) are accepted with probability exp(-ΔE/T). The only possible
// positive ΔE values are 4 and 8 (from the ±1 neighbor sum), so exp(-4/T)
// and exp(-8/T) are precomputed once per frame call.
//
// At the critical temperature Tc≈2.269 the system undergoes a phase transition:
// below Tc, large ordered ferromagnetic domains form; above Tc, disorder wins.
// Sweeping T over time crosses this boundary visibly — islands of order melt and freeze.
//
// The transition is also made legible as DATA: the LAST of the 4 Metropolis sweeps per frame
// (sweepMeasure, a duplicate of sweep that also accumulates Σs/Σs·nb) yields M = |mean spin|
// (0=disordered..1=ordered) and E = energy per site (-2 ordered..0 disordered) for ~free —
// the 3 plain sweeps stay byte-for-byte the hot path, unslowed. Both are plotted as a
// scrolling strip-chart along the bottom edge, a live oscilloscope trace of the two order
// parameters collapsing at Tc.
//
// resize(w,h) → Uint32Array; frame(t, T) runs 4 Metropolis sweeps, renders, and returns M.
// Spin grid is Int32Array. msum/esum are exact sums of small integers (±1 spins, ±1·nb
// products) so plain module-level ints are safe — no i32-narrowing trap (that trap is about
// FRACTIONAL state; M/E themselves are locals, recomputed each call). The strip history is
// Float32Array, likewise exempt since typed-array elements keep their declared type
// regardless of inference (see fern.js).

let W = 0, H = 0, px
let spin   // Int32Array, values +1 or -1

// Strip-chart state: one column of history per pixel of width, scrolled left each frame.
let stripH = 0          // px height of the bottom strip (set in resize)
let histM, histE        // Float32Array[W] — M(t)/E(t) time series, in scroll order (oldest→newest)
let histTick            // Int32Array[W] — 1 where T crossed Tc that frame, else 0
let started = 0         // 0 until the first frame() call (so frame 1 never draws a spurious tick)
let prevAbove = 0        // which side of Tc T was on, last frame (0/1)

// Measurement accumulators — reset before the measuring sweep, read right after.
let msum = 0
let esum = 0

export let resize = (w, h) => {
  W = w; H = h
  spin = new Int32Array(w * h)
  px = new Uint32Array(w * h)

  stripH = (h * 0.12) | 0
  if (stripH < 16) stripH = 16
  if (stripH > 40) stripH = 40

  histM = new Float32Array(w)
  histE = new Float32Array(w)
  histTick = new Int32Array(w)
  let k = 0
  while (k < w) { histM[k] = 0.0; histE[k] = 0.0; histTick[k] = 0; k++ }
  started = 0

  init()
  return px
}

// Random ±1 initialization
export let init = () => {
  let n = W * H, i = 0
  while (i < n) {
    spin[i] = Math.random() < 0.5 ? 1 : -1
    i++
  }
}

// Sum of the 4 lattice neighbors (periodic wrap).
let neighborSum = (x, y, w, h) => {
  let up    = y === 0     ? (h - 1) * w + x : (y - 1) * w + x
  let down  = y === h - 1 ? x               : (y + 1) * w + x
  let left  = x === 0     ? y * w + w - 1   : y * w + x - 1
  let right = x === w - 1 ? y * w           : y * w + x + 1
  return spin[up] + spin[down] + spin[left] + spin[right]
}

// One full Metropolis sweep at temperature T.
let sweep = (T) => {
  let w = W, h = H
  let e4 = Math.exp(-4.0 / T)
  let e8 = Math.exp(-8.0 / T)
  let n = w * h, i = 0
  while (i < n) {
    let x = i % w
    let y = (i / w) | 0
    let s = spin[i]
    let nb = neighborSum(x, y, w, h)
    let dE = 2 * s * nb
    if (dE <= 0) {
      spin[i] = -s
    } else if (dE === 4) {
      if (Math.random() < e4) spin[i] = -s
    } else {
      // dE === 8
      if (Math.random() < e8) spin[i] = -s
    }
    i++
  }
}

// Same Metropolis sweep, but also accumulates Σs (msum) and Σs·nb (esum) over the settled
// spins/neighbor-sums already computed for the flip decision — a separate function (rather
// than a runtime flag inside `sweep`) so the 3 plain sweeps below compile to the exact same
// code as sweep() alone, with no shared branch/local tax. Used only for the LAST of the 4
// sweeps/frame, a coherent snapshot of the just-settled configuration.
let sweepMeasure = (T) => {
  let w = W, h = H
  let e4 = Math.exp(-4.0 / T)
  let e8 = Math.exp(-8.0 / T)
  let n = w * h, i = 0
  while (i < n) {
    let x = i % w
    let y = (i / w) | 0
    let s = spin[i]
    let nb = neighborSum(x, y, w, h)
    let dE = 2 * s * nb
    let ns = s
    if (dE <= 0) {
      ns = -s; spin[i] = ns
    } else if (dE === 4) {
      if (Math.random() < e4) { ns = -s; spin[i] = ns }
    } else {
      if (Math.random() < e8) { ns = -s; spin[i] = ns }
    }
    msum = msum + ns
    esum = esum + ns * nb
    i++
  }
}

export let frame = (t, T) => {
  // 4 sweeps per frame — coarsens fast enough to watch domains grow within a couple seconds.
  sweep(T)
  sweep(T)
  sweep(T)
  msum = 0; esum = 0
  sweepMeasure(T)

  let w = W, h = H, n = w * h, i = 0
  // M = |mean spin| ∈ [0,1]; E = energy per site ∈ [-2,0] (J=1: e = -(1/2N)Σ s_i·nb_i).
  let am = msum < 0 ? -msum : msum
  let M = am / n
  if (M < 0.0) M = 0.0
  if (M > 1.0) M = 1.0
  let E = -esum / (2.0 * n)
  let e01 = (E + 2.0) * 0.5     // remap E's [-2,0] onto the SAME 0..1 "orderedness" scale as M
  if (e01 < 0.0) e01 = 0.0
  if (e01 > 1.0) e01 = 1.0

  // Scroll the strip-chart history one column left; append the new sample at the right edge
  // (rightmost column = now). A tick marks the frame T crosses Tc≈2.269.
  let above = T > 2.269 ? 1 : 0
  let tick = started !== 0 && above !== prevAbove ? 1 : 0
  started = 1
  prevAbove = above
  let k = 0
  while (k < w - 1) {
    histM[k] = histM[k + 1]
    histE[k] = histE[k + 1]
    histTick[k] = histTick[k + 1]
    k++
  }
  histM[w - 1] = M
  histE[w - 1] = e01
  histTick[w - 1] = tick

  // Render: +1 spin → near-white gray, -1 spin → near-black gray
  i = 0
  while (i < n) {
    let s = spin[i]
    if (s > 0) {
      // spin up → 235 (R==G==B)
      px[i] = (255 << 24) | (235 << 16) | (235 << 8) | 235
    } else {
      // spin down → 20 (R==G==B)
      px[i] = (255 << 24) | (20 << 16) | (20 << 8) | 20
    }
    i++
  }

  // Strip-chart overlay: the bottom `stripH` rows become a scrolling M(t) (bright) / E(t) (dim)
  // sparkline, framed by a thin border line — you SEE both collapse together above Tc and
  // rise together below it, with a tick at every crossing.
  let top = h - stripH
  let dataH = stripH - 1
  let cx = 0
  while (cx < w) {
    px[top * w + cx] = (255 << 24) | (60 << 16) | (60 << 8) | 60   // frame line
    let mrow = (dataH - 1) - ((histM[cx] * (dataH - 1)) | 0)
    let erow = (dataH - 1) - ((histE[cx] * (dataH - 1)) | 0)
    let isTick = histTick[cx] !== 0
    let r = 0
    while (r < dataH) {
      let val
      if (r === mrow) val = (255 << 24) | (235 << 16) | (235 << 8) | 235       // M — bright
      else if (r === erow) val = (255 << 24) | (130 << 16) | (130 << 8) | 130  // E — dim
      else if (isTick) val = (255 << 24) | (90 << 16) | (90 << 8) | 90         // Tc-crossing gridline
      else val = 255 << 24                                                     // background
      px[(top + 1 + r) * w + cx] = val
      r++
    }
    cx++
  }

  return M
}

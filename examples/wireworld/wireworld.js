// Wireworld — a 4-state cellular automaton that models electronics. Cells are empty,
// conductor, electron head, or electron tail. Each step: head→tail, tail→conductor, and
// conductor→head iff exactly 1 or 2 of its 8 neighbours are heads (else stays conductor).
//   states: 0 empty · 1 head · 2 tail · 3 conductor
//
// The seed builds the classic demonstration: a bank of wires each gated by a DIODE — the
// canonical Wireworld one-way valve (a 3-cell cap + offset stub). Electrons fed from the left
// pass straight through; electrons fed from the right hit the gate and die. Below, conductor
// LOOPS act as clocks. A kernel-driven "gun" injects an electron at each wire end every PERIOD
// steps (in-world taps backfire and corrupt the grid, so the clock lives in frame() instead).
// resize(w,h) → Uint32Array; frame() steps; seed() rebuilds; paint()/drawRect() to edit.

let W = 0, H = 0, px
let a, b              // ping-pong state grids
let srcX, srcY        // electron-injection sources (wire ends)
let srcN = 0          // number of sources
let tick = 0          // step counter for the injection clock
let PERIOD = 15       // inject an electron at every source once per PERIOD steps

export let resize = (w, h) => {
  W = w; H = h
  a = new Int32Array(w * h); b = new Int32Array(w * h)
  srcX = new Int32Array(64); srcY = new Int32Array(64)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0; b[i] = 0; i++ } }

// Rectangular brush: the cell under the cursor plus r cells right & down — an
// (r+1)-wide filled square. r=0 paints one cell, r=1 a 2×2 block (a 2px line under
// a drag). A circular brush (dx²+dy² ≤ r²) silently painted NOTHING at r=0: with a
// sub-pixel centre, x|0 ≠ cx so dx² > 0 = r² and no cell qualified.
export let paint = (cx, cy, r, state) => {
  let x0 = cx | 0, y0 = cy | 0, x1 = x0 + r, y1 = y0 + r
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let y = y0
  while (y <= y1) {
    let row = y * W, x = x0
    while (x <= x1) { a[row + x] = state; x++ }
    y++
  }
}

// map a clockwise perimeter index s∈[0,per) of the rectangle to a cell and set its state
let setPerim = (ax, ay, bx, by, pw, ph, s, state) => {
  let x = ax, y = ay
  if (s < pw) { x = ax + s; y = ay }                       // top edge, L→R
  else if (s < pw + ph) { x = bx; y = ay + (s - pw) }      // right edge, T→B
  else if (s < pw + ph + pw) { x = bx - (s - pw - ph); y = by }  // bottom, R→L
  else { x = ax; y = by - (s - pw - ph - pw) }             // left edge, B→T
  a[y * W + x] = state
}

// a rectangular conductor loop (outline) carrying k electrons evenly spaced around it, all
// circulating clockwise. Small loops tick fast (clocks); large loops carry trains (buses).
let placeLoop = (x0, y0, x1, y1, k) => {
  let ax = (x0 < x1 ? x0 : x1) | 0, bx = (x0 < x1 ? x1 : x0) | 0
  let ay = (y0 < y1 ? y0 : y1) | 0, by = (y0 < y1 ? y1 : y0) | 0
  if (ax < 1) ax = 1
  if (ay < 1) ay = 1
  if (bx > W - 2) bx = W - 2
  if (by > H - 2) by = H - 2
  if (bx - ax < 4 || by - ay < 4) return
  let x = ax
  while (x <= bx) { a[ay * W + x] = 3; a[by * W + x] = 3; x++ }
  let y = ay
  while (y <= by) { a[y * W + ax] = 3; a[y * W + bx] = 3; y++ }
  let pw = bx - ax, ph = by - ay, per = 2 * (pw + ph)
  let j = 0
  while (j < k) {
    let s = (per * j / k) | 0
    setPerim(ax, ay, bx, by, pw, ph, s, 1)                 // head
    setPerim(ax, ay, bx, by, pw, ph, (s + per - 1) % per, 2)  // tail just behind it
    j++
  }
}

// drag-drawn rectangle (corners in grid coords) → a conductor loop with one electron
export let drawRect = (x0, y0, x1, y1) => placeLoop(x0, y0, x1, y1, 1)

let hwire = (x0, x1, y) => { let x = x0; while (x <= x1) { a[y * W + x] = 3; x++ } }

// A Wireworld DIODE on a horizontal wire at row y, gate centred on column cx: a 3-cell cap
// above the wire and a single stub below-left. Passes heads travelling → (left-to-right); a
// head arriving ← from the right meets the gate and is absorbed. (Verified by simulation.)
let diodeGate = (cx, y) => {
  a[(y - 1) * W + (cx - 1)] = 3; a[(y - 1) * W + cx] = 3; a[(y - 1) * W + (cx + 1)] = 3
  a[(y + 1) * W + (cx - 1)] = 3
}

let addSrc = (x, y) => { if (srcN < 64) { srcX[srcN] = x; srcY[srcN] = y; srcN = srcN + 1 } }

// The classic demo: a bank of diode-gated wires (alternately fed from the left → pass, or
// from the right → blocked) over a row of clock loops. Deterministic, so every reseed is clean.
export let seed = () => {
  clear()
  srcN = 0; tick = 0
  let mx = (W * 0.05) | 0; if (mx < 2) mx = 2
  let left = mx, right = W - 1 - mx, gateX = W >> 1
  let nW = 6
  let y = (H * 0.10) | 0
  let dy = ((H * 0.52) / nW) | 0; if (dy < 3) dy = 3
  let i = 0
  while (i < nW) {
    hwire(left, right, y)
    diodeGate(gateX, y)
    if ((i & 1) === 0) addSrc(left, y)       // fed from the left → passes the diode →
    else addSrc(right, y)                     // fed from the right → blocked at the gate
    y = y + dy
    i++
  }
  // clock loops along the bottom — oscillators of graded size
  let ly = (H * 0.70) | 0, lh = (H * 0.24) | 0
  let lx = left, j = 0
  while (lx < right - 18 && j < 8) {
    let lw = 14 + ((lx * 7 + j * 11) % 26)
    if (lx + lw > right) break
    placeLoop(lx, ly, lx + lw, ly + lh, 1 + (j % 2))
    lx = lx + lw + 9
    j = j + 1
  }
}

export let frame = (t) => {
  let w = W, h = H, y = 0
  while (y < h) {
    let yn = y > 0 ? y - 1 : h - 1, ys = y < h - 1 ? y + 1 : 0
    let rc = y * w, rn = yn * w, rs = ys * w, x = 0
    while (x < w) {
      let c = rc + x, s = a[c]
      let nx = s
      if (s === 1) nx = 2
      else if (s === 2) nx = 3
      else if (s === 3) {
        let xw = x > 0 ? x - 1 : w - 1, xe = x < w - 1 ? x + 1 : 0
        let cnt = 0
        if (a[rn + xw] === 1) cnt++
        if (a[rn + x] === 1) cnt++
        if (a[rn + xe] === 1) cnt++
        if (a[rc + xw] === 1) cnt++
        if (a[rc + xe] === 1) cnt++
        if (a[rs + xw] === 1) cnt++
        if (a[rs + x] === 1) cnt++
        if (a[rs + xe] === 1) cnt++
        if (cnt === 1 || cnt === 2) nx = 1
      }
      b[c] = nx
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp

  // kernel-driven gun: inject an electron at each source (a wire end) every PERIOD steps
  tick = tick + 1
  if (tick >= PERIOD) {
    tick = 0
    let k = 0
    while (k < srcN) {
      let idx = srcY[k] * W + srcX[k]
      if (a[idx] === 3) a[idx] = 1
      k = k + 1
    }
  }

  // render — grayscale: empty black, conductor dark, tail mid, head white
  let n = w * h, i = 0
  while (i < n) {
    let s = a[i], g = 16
    if (s === 3) g = 70
    else if (s === 2) g = 150
    else if (s === 1) g = 255
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

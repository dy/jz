// Wireworld — a 4-state cellular automaton that models electronics. Cells are empty,
// conductor, electron head, or electron tail. Each step: head→tail, tail→conductor, and
// conductor→head iff exactly 1 or 2 of its 8 neighbours are heads (else stays conductor).
// Electrons race along the wires forever. Branchy integer neighbour-counting over the
// grid — a different shape of work for jz than the float kernels.
//   states: 0 empty · 1 head · 2 tail · 3 conductor
// resize(w,h) → Uint32Array; frame() steps; paint() to draw wire / inject electrons.

let W = 0, H = 0, px
let a, b              // ping-pong state grids

export let resize = (w, h) => {
  W = w; H = h
  a = new Int32Array(w * h); b = new Int32Array(w * h)
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

// a rectangular wire loop (outline) with one electron (head+tail) circulating it
let rectLoop = (x0, y0, x1, y1) => {
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
  a[ay * W + (ax + 2)] = 1; a[ay * W + (ax + 1)] = 2    // electron heading along the top
}
let loop = (cx, cy, rw, rh) => rectLoop(cx - rw, cy - rh, cx + rw, cy + rh)

// drag-drawn rectangle (corners in grid coords) → a conductor loop with an electron
export let drawRect = (x0, y0, x1, y1) => rectLoop(x0, y0, x1, y1)

export let seed = () => {
  clear()
  let k = 0
  while (k < 5) {
    let rw = 8 + (Math.random() * 26 | 0), rh = 6 + (Math.random() * 20 | 0)
    loop((rw + 2 + Math.random() * (W - 2 * rw - 4)) | 0, (rh + 2 + Math.random() * (H - 2 * rh - 4)) | 0, rw, rh)
    k++
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

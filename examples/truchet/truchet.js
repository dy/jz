// Truchet tiles — each square cell of the grid holds one of two tile orientations:
// two quarter-circle arcs joining midpoints of adjacent edges. Orientation 0 places arcs
// centered at top-left and bottom-right corners; orientation 1 at top-right and bottom-left.
// Randomly assigned, they spontaneously form flowing loops and mazes. Color flows by time.
// init()/seed() randomize; frame(t, tileSize) draws. Click re-seeds.

let W = 0, H = 0, px

let TILE = 22     // default tile size in pixels
let MAXCELLS = 4096

// Per-cell orientation: 0 or 1
let cells = new Uint8Array(MAXCELLS)
let gW = 0, gH = 0   // grid dimensions (integer, but stored as i32 via |0)

// Float64Array for float state that must stay f64 in jz
let st = new Float64Array(4) // [tileF, ...] tileF = runtime tile size as float

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  gW = (w / TILE) | 0
  gH = (h / TILE) | 0
  seed()
  return px
}

export let seed = () => {
  let total = gW * gH
  if (total > MAXCELLS) total = MAXCELLS
  let i = 0
  while (i < total) {
    cells[i] = Math.random() < 0.5 ? 0 : 1
    i++
  }
}

export let init = () => {
  seed()
}

let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let r = (p & 0xff) + rr; if (r > 255) r = 255
  let g = ((p >> 8) & 0xff) + gg; if (g > 255) g = 255
  let b = ((p >> 16) & 0xff) + bb; if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

// Draw a quarter-circle arc centered at (acx, acy) with radius arcR,
// from angle a0 to a1 (both in radians, a0 < a1). step in radians.
let drawArc = (acx, acy, arcR, a0, a1, rr, gg, bb) => {
  let step = 0.04
  let a = a0
  let prevX = acx + arcR * Math.cos(a)
  let prevY = acy + arcR * Math.sin(a)
  a += step
  while (a <= a1 + 0.001) {
    let curX = acx + arcR * Math.cos(a)
    let curY = acy + arcR * Math.sin(a)
    // Draw segment prevX,prevY → curX,curY
    let dx = curX - prevX, dy = curY - prevY
    let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
    let steps = (adx > ady ? adx : ady) | 0
    if (steps < 1) steps = 1
    let xi = dx / steps, yi = dy / steps
    let x = prevX, y = prevY, s = 0
    while (s <= steps) {
      addpix(x | 0, y | 0, rr, gg, bb)
      x += xi; y += yi; s++
    }
    prevX = curX; prevY = curY
    a += step
  }
}

let PI = 3.141592653589793
let HALF_PI = 1.5707963267948966

export let frame = (t, tileSize) => {
  let ts = tileSize | 0
  if (ts < 8) ts = TILE

  // Clear to deep dark blue-black
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24) | (2 << 16) | (0 << 8) | 5; i++ }

  let arcR = ts * 0.5

  let gy = 0
  while (gy < gH) {
    let gx = 0
    while (gx < gW) {
      let idx = gy * gW + gx
      let ori = idx < MAXCELLS ? cells[idx] : 0

      // Cell origin in screen pixels
      let ox = gx * ts, oy = gy * ts

      // Smooth hue field flows with t
      let hue = ((gx + gy) * 0.08 + t * 0.2)
      // wrap hue to [0,6)
      hue = hue - Math.floor(hue / 6.0) * 6.0
      let rr = Math.abs(hue - 3.0) - 1.0
      let gg = 2.0 - Math.abs(hue - 2.0)
      let bb = 2.0 - Math.abs(hue - 4.0)
      if (rr < 0.0) rr = 0.0; if (rr > 1.0) rr = 1.0
      if (gg < 0.0) gg = 0.0; if (gg > 1.0) gg = 1.0
      if (bb < 0.0) bb = 0.0; if (bb > 1.0) bb = 1.0
      let INT = 180.0
      let ir = (rr * INT) | 0, ig = (gg * INT) | 0, ib = (bb * INT) | 0

      if (ori == 0) {
        // Arc 1: centered at top-left corner (ox, oy), quarter circle from right to down
        // connecting midpoint of top edge to midpoint of left edge
        drawArc(ox, oy, arcR, 0.0, HALF_PI, ir, ig, ib)
        // Arc 2: centered at bottom-right corner (ox+ts, oy+ts), left half to up
        drawArc(ox + ts, oy + ts, arcR, PI, PI + HALF_PI, ir, ig, ib)
      } else {
        // Arc 1: centered at top-right corner (ox+ts, oy), quarter from left to down
        drawArc(ox + ts, oy, arcR, HALF_PI, PI, ir, ig, ib)
        // Arc 2: centered at bottom-left corner (ox, oy+ts), right to up
        drawArc(ox, oy + ts, arcR, PI + HALF_PI, 2.0 * PI, ir, ig, ib)
      }

      gx++
    }
    gy++
  }
}

// Falling sand — a cellular automaton over an integer element grid. Each frame scans
// bottom-up and applies simple per-cell rules: sand falls down or diagonally and sinks
// through water; water falls, then spreads sideways; walls hold. It's branchy integer
// work with random tie-breaking — no floats in the hot loop — a different stress on jz
// than the float-heavy demos. resize(w,h) → Uint32Array; paint to add material.
//
// element ids: 0 empty · 1 sand · 2 water · 3 wall

let W = 0, H = 0, px
let cell        // Int32Array element grid
let parity = 0  // flips scan direction each frame to avoid drift bias

// colors (0xAABBGGRR): empty near-black, wall gray; sand/water tinted in the render loop
let C_EMPTY = (255 << 24) | (14 << 16) | (14 << 8) | 14
let C_WALL  = (255 << 24) | (96 << 16) | (98 << 8) | 104

export let resize = (w, h) => {
  W = w; H = h
  cell = new Int32Array(w * h)
  px = new Uint32Array(w * h)
  return px
}

export let clear = () => { let n = W * H, i = 0; while (i < n) { cell[i] = 0; i++ } }

// Paint a disc of element `el` (sand/water scattered so it looks granular).
export let paint = (cx, cy, r, el) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) {
        // walls/erase fill solid; sand & water are sparse so they pour like grains
        if (el === 3 || el === 0 || Math.random() < 0.55) cell[row + x] = el
      }
      x++
    }
    y++
  }
}

let swap = (a, b) => {
  let t = cell[a]; cell[a] = cell[b]; cell[b] = t
}

export let frame = (t) => {
  let w = W, h = H
  // bottom-up so a grain falls at most one row per frame
  let y = h - 2
  while (y >= 0) {
    let leftToRight = ((y + parity) & 1) === 0
    let x = leftToRight ? 0 : w - 1
    let xend = leftToRight ? w : -1
    let dxs = leftToRight ? 1 : -1
    while (x !== xend) {
      let c = y * w + x
      let e = cell[c]
      if (e === 1) {
        // sand: down, then a random diagonal; sinks through water
        let d = c + w
        let below = cell[d]
        if (below === 0 || below === 2) { swap(c, d) }
        else {
          let goLeft = Math.random() < 0.5
          let dl = x > 0 ? d - 1 : -1
          let dr = x < w - 1 ? d + 1 : -1
          let a = goLeft ? dl : dr
          let b = goLeft ? dr : dl
          if (a >= 0 && (cell[a] === 0 || cell[a] === 2)) swap(c, a)
          else if (b >= 0 && (cell[b] === 0 || cell[b] === 2)) swap(c, b)
        }
      } else if (e === 2) {
        // water: falls, diagonal-falls, else flows far horizontally toward open space so it
        // levels quickly and behaves like a low-viscosity fluid (not a pile).
        let d = c + w
        if (cell[d] === 0) { swap(c, d) }
        else {
          let goLeft = Math.random() < 0.5
          let dl = x > 0 ? d - 1 : -1, dr = x < w - 1 ? d + 1 : -1
          let a = goLeft ? dl : dr, b = goLeft ? dr : dl
          if (a >= 0 && cell[a] === 0) swap(c, a)
          else if (b >= 0 && cell[b] === 0) swap(c, b)
          else {
            // glide to the farthest empty cell in a direction (fast spread → fluid)
            let DISP = 14, dir = goLeft ? -1 : 1, tx = x, k = 0
            while (k < DISP) { let nx = tx + dir; if (nx < 0 || nx >= w || cell[y * w + nx] !== 0) break; tx = nx; k++ }
            if (tx === x) { dir = -dir; k = 0; while (k < DISP) { let nx = tx + dir; if (nx < 0 || nx >= w || cell[y * w + nx] !== 0) break; tx = nx; k++ } }
            if (tx !== x) swap(c, y * w + tx)
          }
        }
      }
      x += dxs
    }
    y--
  }
  parity = parity ^ 1

  // render: tint sand/water with a little per-cell variation for grain
  let n = w * h, i = 0
  while (i < n) {
    let e = cell[i]
    let col = C_EMPTY
    if (e === 1) {                              // sand — warm tan with grain
      let v = (i * 2654435761) & 31
      let r = 205 + (v - 16), g = 170 + (v - 16) / 2 | 0, b = 95
      col = (255 << 24) | (b << 16) | (g << 8) | r
    } else if (e === 2) {                       // water — blue with shimmer
      let v = (i * 40503) & 15
      col = (255 << 24) | ((205 + v) << 16) | ((120 + v) << 8) | 45
    } else if (e === 3) col = C_WALL
    px[i] = col
    i++
  }
}

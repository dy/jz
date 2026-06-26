// Pascal's triangle mod p — colour C(n,k) by whether p divides it and the Sierpiński fractal
// falls out. Mod 2 is the classic Sierpiński triangle; every prime p births its own lattice of
// (p choose 2) sub-triangles (Lucas' theorem), and composite moduli remix it. Drawn black & white:
// a cell is lit when C(n,k) mod p ≠ 0, black (a void) when p divides it. The figure BUILDS UP row
// by row from the apex — the host ramps how many rows are revealed, so you watch the fractal grow.
// Rows are built incrementally, row[k] = (prev[k-1] + prev[k]) mod p; the revealed triangle is
// recomputed every frame — honest O(rows²) integer work that separates the JS baseline from jz.
//
// resize(w,h) → Uint32Array; frame(t, p, frac) draws the first `frac`·ROWS rows of the mod-p triangle.

let W = 0, H = 0, px
let row0, row1                 // Int32Array ping-pong buffers for the current/next Pascal row
let ROWS = 0, CELL = 0, topY = 0

let INK = (255 << 24) | (236 << 16) | (236 << 8) | 236   // lit cell (near-white)
let EDGE = (255 << 24) | (255 << 16) | (255 << 8) | 255   // the growing bottom edge — pure white

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  // size the cells so the triangle's base ≈ the shorter screen side, centred & full-height
  let span = w < h ? w : h
  ROWS = (span / 3) | 0                  // ~3px cells → a tall, detailed triangle (lots of rows)
  if (ROWS > 720) ROWS = 720
  CELL = (span / ROWS) | 0
  if (CELL < 2) CELL = 2
  topY = ((h - ROWS * CELL) >> 1)        // vertical centre
  if (topY < 0) topY = 0
  row0 = new Int32Array(ROWS + 2)
  row1 = new Int32Array(ROWS + 2)
  return px
}

export let frame = (t, p, frac) => {
  let P = p | 0
  if (P < 2) P = 2
  if (P > 63) P = 63
  let maxRow = (frac * ROWS) | 0          // build-up: only the first maxRow rows are revealed
  if (maxRow < 1) maxRow = 1
  if (maxRow > ROWS) maxRow = ROWS

  // clear to black
  let total = W * H, i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let cx = W >> 1, half = CELL >> 1

  // row 0 = [1, 0, 0, …]
  row0[0] = 1
  let j = 1
  while (j <= ROWS) { row0[j] = 0; j++ }

  let n = 0
  while (n < maxRow) {
    let y = topY + n * CELL
    if (y >= H) break
    let col = (n === maxRow - 1) ? EDGE : INK     // pure-white drawing front, near-white body
    let k = 0
    while (k <= n) {
      if (row0[k] != 0) {                          // C(n,k) mod p ≠ 0 → lit
        let x0 = cx + ((2 * k - n) * CELL >> 1) - half
        let py = y, ymax = y + CELL
        while (py < ymax && py < H) {
          let xx = x0, xmax = x0 + CELL
          while (xx < xmax && xx < W) {
            if (xx >= 0) px[py * W + xx] = col
            xx++
          }
          py++
        }
      }
      k++
    }
    // next row mod P
    row1[0] = 1
    let kk = 1
    while (kk <= n + 1) { row1[kk] = (row0[kk - 1] + row0[kk]) % P; kk++ }
    row1[n + 1] = 1
    let m = 0
    while (m <= n + 2) { row0[m] = row1[m]; m++ }
    n++
  }
}

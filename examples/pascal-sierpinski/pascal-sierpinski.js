// Pascal's triangle mod p — coloring C(n,k) mod p by residue produces fractal self-similarity.
// Mod 2 gives the classic Sierpinski triangle; mod 3,5,7 each birth their own sub-triangle
// lattices. The demo cycles through primes p∈{2,3,5,7} so you watch one fractal morph into
// another. Each row is computed incrementally as row[k]=(prev[k-1]+prev[k]) mod p.
//
// resize(w,h) → Uint32Array; frame(t) renders. p = primes[floor(t/3.5) % 4]

let W = 0, H = 0, px
let row0, row1              // Int32Array ping-pong buffers for Pascal rows
let ROWS = 0
let cellW = 0, cellH = 0

// Color palette per residue value 1..p-1 (mod 2: just 1 color, mod 7: 6 colors)
// We precompute nothing — just pick by (p, val)
let palR = new Int32Array(8)
let palG = new Int32Array(8)
let palB = new Int32Array(8)

// module scope, NOT inside frame() — allocating it per frame would grow the heap forever
// and eventually detach the host's px view (blank canvas after a few minutes)
let primes4 = new Int32Array([2, 3, 5, 7])

let fillPalette = (p) => {
  // index 1..(p-1) → distinct gray levels spread across ~60..255
  let i = 1
  while (i < p) {
    let gv = (60 + (i / p) * 195.0) | 0
    palR[i] = gv
    palG[i] = gv
    palB[i] = gv
    i++
  }
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  cellW = 4; cellH = 4
  ROWS = (h / cellH) | 0
  if (ROWS > 512) ROWS = 512
  row0 = new Int32Array(ROWS + 2)
  row1 = new Int32Array(ROWS + 2)
  return px
}

export let frame = (t) => {
  // pick modulus
  let pi = (t / 3.5) | 0
  let p = primes4[pi & 3]

  fillPalette(p)

  // clear to black
  let total = W * H
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let cx = W >> 1

  // init row 0 = [1, 0, 0, ...]
  row0[0] = 1
  let j = 1
  while (j <= ROWS) { row0[j] = 0; j++ }

  let n = 0
  while (n < ROWS) {
    let y = n * cellH
    if (y >= H) break

    // draw row n: cell k at x = cx + (2k - n)*cellW/2, width cellW, height cellH
    let k = 0
    while (k <= n) {
      let val = row0[k]
      if (val != 0) {
        // compute pixel position
        let xCenter = cx + ((2 * k - n) * cellW >> 1)
        let x0 = xCenter - (cellW >> 1)
        let r = palR[val], g = palG[val], b = palB[val]
        let color = (255 << 24) | (b << 16) | (g << 8) | r
        // fill cellW x cellH rectangle
        let py = y
        while (py < y + cellH && py < H) {
          let px2 = x0
          while (px2 < x0 + cellW && px2 < W) {
            if (px2 >= 0) px[py * W + px2] = color
            px2++
          }
          py++
        }
      }
      k++
    }

    // compute next row mod p
    row1[0] = 1
    let kk = 1
    while (kk <= n + 1) {
      row1[kk] = (row0[kk - 1] + row0[kk]) % p
      kk++
    }
    row1[n + 1] = 1

    // copy row1 into row0 for next iteration (reference swap not available in jz)
    let m = 0
    while (m <= n + 2) { row0[m] = row1[m]; m++ }

    n++
  }
}

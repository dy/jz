let W = 0, H = 0
let px    // Uint32Array output
let row   // Uint8Array current generation (W cells)
let nxt   // Uint8Array next generation buffer

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  row = new Uint8Array(w)
  nxt = new Uint8Array(w)
  seed()
  return px
}

export let init = () => { seed() }

export let seed = () => {
  let i = 0
  while (i < W) { row[i] = 0; i++ }
  row[W >> 1] = 1
  let j = 0, n = W * H
  while (j < n) { px[j] = (255 << 24); j++ }
  drawRow(0)
}

let drawRow = (y) => {
  let base = y * W, x = 0
  while (x < W) {
    px[base + x] = row[x] ? (255<<24)|(255<<16)|(255<<8)|255 : (255<<24)
    x++
  }
}

export let frame = (t, rule) => {
  let r = rule | 0
  // scroll pixel buffer up one row
  let y = 0
  while (y < H - 1) {
    let dst = y * W, src = (y + 1) * W, x = 0
    while (x < W) { px[dst + x] = px[src + x]; x++ }
    y++
  }
  // compute next generation
  let x = 0
  while (x < W) {
    let l = x === 0 ? row[W - 1] : row[x - 1]
    let c = row[x]
    let ri = x === W - 1 ? row[0] : row[x + 1]
    let idx = l * 4 + c * 2 + ri
    nxt[x] = (r >> idx) & 1
    x++
  }
  // copy nxt to row
  let i = 0
  while (i < W) { row[i] = nxt[i]; i++ }
  // draw new bottom row
  drawRow(H - 1)
}

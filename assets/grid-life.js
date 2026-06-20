// grid-life.js — the hero's live demo, two layers on the blueprint grid:
//   • AMBIENT: a very slow Conway's Game of Life lighting the grid's cells; births/deaths crossfade over
//     a generation, so it reads as a calm shimmer rather than a blink.
//   • CLICK: a four-way burst of white pulses fired from the nearest junction (kept from the original
//     live grid) — and it also drops a little colony of life where you clicked.
// One source, compiled in the page two ways (plain JS via import, and jz → wasm); the JS/JZ toggle drives
// either and the fps readout times the frame. Everything is deterministic (integer-hash seed + pure GoL
// rule + hashed spark + time-derived generation), so the JS and wasm boards stay bit-identical.
// Interface matches grid-current: resize → pixel buffer · configure · frame · spawn · param.

let W = 0, H = 0, px
let gx = 0, cell = 8, cols = 0, rows = 0   // cell = the 8px MINOR grid square
let pumaj = 160, pumid = 80                // pulse-burst units (80/40 grid × scale) — kept full-scale, independent of the tiny Life cells
let prev, cur, nxt          // Uint8Array boards (0/1): crossfade prev→cur, nxt is the next-gen scratch
let gen = -1
let STEP = 0.72             // seconds per generation — "very slow"
let INS = 1                 // cell fill inset (px) so the minor grid line peeks between lit cells

// click bursts (white pulses): a small ring — junction + cursor bias + start time
let BMAX = 12
let bJX = new Float32Array(BMAX), bJY = new Float32Array(BMAX)
let bOX = new Float32Array(BMAX), bOY = new Float32Array(BMAX)
let bT = new Float32Array(BMAX)
let bNext = 0
let T0 = -1.0

let F = new Float64Array(16)

// Stateless integer hash → [0,1). i32 mul/xor/shift wrap identically in JS and wasm.
let rnd = (n) => {
  let x = Math.imul(n | 0, 1664525) | 0
  x = Math.imul(x ^ (x >>> 15), 2246822519) | 0
  x = Math.imul(x ^ (x >>> 13), 3266489917) | 0
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296.0
}

let seed = () => {
  let n = cols * rows, i = 0
  while (i < n) { let a = rnd(i * 2 + 1) < 0.32 ? 1 : 0; cur[i] = a; prev[i] = a; i = i + 1 }
  gen = 0
}

export let resize = (w, h) => {
  W = w; H = h
  // Allocate the Life boards FIRST (worst case = the 4px cell floor), then the pixel buffer LAST. In wasm
  // any allocation grows linear memory and DETACHES earlier views — so px must be the final allocation, or
  // the host's blit (`set(px)`) throws on a detached buffer. configure() below allocates nothing.
  let maxC = Math.floor(W / 4) + 2, maxR = Math.floor(H / 4) + 2, maxN = maxC * maxR
  prev = new Uint8Array(maxN); cur = new Uint8Array(maxN); nxt = new Uint8Array(maxN)
  px = new Uint32Array(w * h)
  T0 = -1.0
  let i = 0; while (i < BMAX) { bT[i] = -1.0; i = i + 1 }
  return px
}

// gridX + scale come from the hero: the canvas shares the blueprint grid's origin, so cells = the 8px
// minor grid (× the render scale) and align with the lines. Boards are pre-sized in resize → no alloc here.
export let configure = (gridX, scale) => {
  gx = gridX | 0
  cell = Math.round(8.0 * scale); if (cell < 4) cell = 4     // the 8px minor grid (× render scale); floor matches the board pre-size
  pumid = Math.round(40.0 * scale); pumaj = Math.round(80.0 * scale)   // pulse junctions snap to 40, comets sized to 80
  cols = Math.floor((W - gx) / cell) + 2
  rows = Math.floor(H / cell) + 2
  seed()
}

export let param = (i, v) => { let k = (i | 0) + 4; if (k >= 4 && k <= 15) F[k] = v }

// ── ambient: Game of Life ──────────────────────────────────────────────────
let step = () => {
  let r = 0
  while (r < rows) {
    let up = r - 1; if (up < 0) up = rows - 1
    let dn = r + 1; if (dn >= rows) dn = 0
    let c = 0
    while (c < cols) {
      let lf = c - 1; if (lf < 0) lf = cols - 1
      let rg = c + 1; if (rg >= cols) rg = 0
      let cnt = cur[up * cols + lf] + cur[up * cols + c] + cur[up * cols + rg]
            + cur[r * cols + lf]                       + cur[r * cols + rg]
            + cur[dn * cols + lf] + cur[dn * cols + c] + cur[dn * cols + rg]
      let p = r * cols + c
      let nv = cur[p] === 1 ? (cnt === 2 || cnt === 3 ? 1 : 0) : (cnt === 3 ? 1 : 0)
      if (rnd((gen * 374761393 + p * 2 + 1) | 0) < 0.006) nv = 1   // rare deterministic spark — never fully dies
      nxt[p] = nv
      c = c + 1
    }
    r = r + 1
  }
  let t0 = prev; prev = cur; cur = nxt; nxt = t0
}

let fillCell = (c, r, aa) => {
  let x0 = gx + c * cell + INS, x1 = gx + (c + 1) * cell - INS
  let y0 = r * cell + INS, y1 = (r + 1) * cell - INS
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W) x1 = W
  if (y1 > H) y1 = H
  let col = (aa << 24) | 0x00ffffff               // white, alpha aa (ABGR: a<<24 | b,g,r = 255)
  let y = y0
  while (y < y1) {
    let row = y * W, x = x0
    while (x < x1) { px[row + x] = col; x = x + 1 }
    y = y + 1
  }
}

let ease = (p) => p * p * (3.0 - 2.0 * p)         // smoothstep

// ── click: white pulse comets ──────────────────────────────────────────────
// additive white glow → near-pure-white at high alpha (so the click flash reads on either theme).
let put = (x, y, a) => {
  let ix = x | 0, iy = y | 0
  if (ix < 0 || ix >= W || iy < 0 || iy >= H || a < 1.0) return
  let p = iy * W + ix
  let old = (px[p] >>> 24) & 255
  let na = old + (a | 0); if (na > 255) na = 255
  let v = 200 + ((na * 55) >> 8); if (v > 255) v = 255
  px[p] = (na << 24) | (v << 16) | (v << 8) | v
}

let drawPulse = (tAxis, lineCoord, head, dir, tail, alpha) => {
  let k = 0
  while (k <= tail) {
    let a = alpha * (1.0 - k / tail)
    if (a < 1.0) return
    let pos = head - dir * k
    if (tAxis === 0) put(pos, lineCoord, a)
    else put(lineCoord, pos, a)
    k = k + 1
  }
}

export let frame = (t) => {
  if (W === 0 || cols === 0) return
  if (T0 < 0.0) T0 = t
  let tt = t - T0; if (tt < 0.0) tt = 0.0

  // advance Game of Life to the current generation (bounded per frame; gen keeps catching up over the
  // next frames if a backgrounded tab jumped t — no skip, so JS and wasm stay in step).
  let target = Math.floor(t / STEP)
  let did = 0
  while (gen < target && did < 256) { step(); gen = gen + 1; did = did + 1 }
  let phase = gen >= target ? (t / STEP - target) : 1.0
  let e = ease(phase)

  let nn = W * H, i = 0
  while (i < nn) { px[i] = 0; i = i + 1 }

  // ambient cells (crossfaded)
  let r = 0
  while (r < rows) {
    let c = 0
    while (c < cols) {
      let p = r * cols + c
      let a0 = prev[p], a1 = cur[p]
      let f = a0 + (a1 - a0) * e
      if (f > 0.004) { let aa = (f * 255.0) | 0; if (aa > 255) aa = 255; fillCell(c, r, aa) }
      c = c + 1
    }
    r = r + 1
  }

  // click bursts: four white pulses out from each live junction, biased by the cursor offset
  let ckV = pumaj * 2.1, ckTail = pumaj * 1.35, base = 380.0, reach = (W > H ? W : H) + ckTail
  let bi = 0
  while (bi < BMAX) {
    let bt = bT[bi]
    if (bt === -2.0) { bT[bi] = tt; bt = tt }
    if (bt >= 0.0) {
      let trav = ckV * (tt - bt)
      if (trav > reach) bT[bi] = -1.0
      else {
        let jx = bJX[bi], jy = bJY[bi], ox = bOX[bi], oy = bOY[bi]
        let tl = trav < ckTail ? trav : ckTail; if (tl < 1.0) tl = 1.0
        drawPulse(0, jy, jx + trav, 1.0, tl, base * (0.5 - 0.45 * ox))
        drawPulse(0, jy, jx - trav, -1.0, tl, base * (0.5 + 0.45 * ox))
        drawPulse(1, jx, jy + trav, 1.0, tl, base * (0.5 - 0.45 * oy))
        drawPulse(1, jx, jy - trav, -1.0, tl, base * (0.5 + 0.45 * oy))
      }
    }
    bi = bi + 1
  }
}

// click → a white pulse burst from the nearest junction + a small live colony seeded around it
export let spawn = (nx, ny) => {
  if (cols === 0) return
  let cx = nx * W, cy = ny * H
  let jx = gx + Math.round((cx - gx) / pumid) * pumid   // pulse burst fires from the nearest 40px junction
  let jy = Math.round(cy / pumid) * pumid
  let half = pumid * 0.5
  let ox = (cx - jx) / half; if (ox < -1.0) ox = -1.0; if (ox > 1.0) ox = 1.0
  let oy = (cy - jy) / half; if (oy < -1.0) oy = -1.0; if (oy > 1.0) oy = 1.0
  let i = bNext; bNext = bNext + 1; if (bNext >= BMAX) bNext = 0
  bJX[i] = Math.round(jx); bJY[i] = Math.round(jy); bOX[i] = ox; bOY[i] = oy; bT[i] = -2.0
  let cc = Math.floor((cx - gx) / cell), cr = Math.floor(cy / cell)
  let dr = -2
  while (dr <= 2) {
    let dc = -2
    while (dc <= 2) {
      let rr = cr + dr, c2 = cc + dc
      if (rr >= 0 && rr < rows && c2 >= 0 && c2 < cols) {
        if (rnd((rr * 92837 + c2 * 689 + 5) | 0) < 0.6) { let p = rr * cols + c2; cur[p] = 1; prev[p] = 1 }
      }
      dc = dc + 1
    }
    dr = dr + 1
  }
}

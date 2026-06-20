// grid-life.js — the light theme's live demo: a slow Conway's Game of Life on the 8px minor-grid cells.
//   • A calm field — a few canonical shapes (glider, blinker, toad, beacon, LWSS) at random starts; the
//     field refreshes to a fresh few every so often so it never piles up.
//   • ~3 generations/second; each live cell is a filled black square (~80% opaque), crossfading in/out.
//   • Click = a pen: lights the cells under the cursor (drag to draw) + a white pulse burst.
// One source, compiled in the page two ways (plain JS, and jz → wasm via dist/jz.js). Deterministic
// (integer-hash seed + pure GoL) so the JS and wasm boards match for an honest A/B.
// Interface matches grid-current: resize → pixel buffer · configure · frame · spawn · param (+ pen).

let W = 0, H = 0, px
let gx = 0, cellF = 8.0, cols = 0, rows = 0   // cellF = the 8px minor cell in device px (= 8 × scale), kept FLOAT so each cell edge snaps to the real grid line — rounding `cell` to an int drifts off the lines across the band
let pumaj = 160, pumid = 80                          // pulse-burst units (80/40 grid × scale), full-scale
let prev, cur, nxt                                   // Uint8Array boards (0/1): crossfade prev→cur, nxt = scratch
let gen = 0
let STEP = 0.34                            // ~3 generations/second
let INJECT = 18                            // refresh a fresh few shapes every N generations (≈6s) — never piles up
let NPAT = 5

// click bursts (white pulses)
let BMAX = 12
let bJX = new Float32Array(BMAX), bJY = new Float32Array(BMAX)
let bOX = new Float32Array(BMAX), bOY = new Float32Array(BMAX)
let bT = new Float32Array(BMAX)
let bNext = 0
let T0 = -1.0

let F = new Float64Array(16)

let rnd = (n) => {
  let x = Math.imul(n | 0, 1664525) | 0
  x = Math.imul(x ^ (x >>> 15), 2246822519) | 0
  x = Math.imul(x ^ (x >>> 13), 3266489917) | 0
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296.0
}

export let resize = (w, h) => {
  W = w; H = h
  // boards FIRST, pixel buffer LAST — in wasm any later allocation grows memory and detaches the px view
  // the host blits from. configure() allocates nothing. Pre-size to the 4px cell floor (worst case).
  let maxC = Math.floor(W / 4) + 2, maxR = Math.floor(H / 4) + 2, maxN = maxC * maxR
  prev = new Uint8Array(maxN); cur = new Uint8Array(maxN); nxt = new Uint8Array(maxN)
  px = new Uint32Array(w * h)
  T0 = -1.0
  let i = 0; while (i < BMAX) { bT[i] = -1.0; i = i + 1 }
  return px
}

let setc = (r0, c0, rot, dr, dc) => {
  let rr = dr, cc = dc
  if (rot === 1) { rr = dc; cc = 0 - dr }
  else if (rot === 2) { rr = 0 - dr; cc = 0 - dc }
  else if (rot === 3) { rr = 0 - dc; cc = dr }
  let r = r0 + rr, c = c0 + cc
  if (r >= 0 && r < rows && c >= 0 && c < cols) cur[r * cols + c] = 1
}

let place = (pi, r0, c0, rot) => {
  if (pi === 0) {                                                                   // glider
    setc(r0, c0, rot, 0, 1); setc(r0, c0, rot, 1, 2); setc(r0, c0, rot, 2, 0); setc(r0, c0, rot, 2, 1); setc(r0, c0, rot, 2, 2)
  } else if (pi === 1) {                                                            // blinker
    setc(r0, c0, rot, 0, 0); setc(r0, c0, rot, 0, 1); setc(r0, c0, rot, 0, 2)
  } else if (pi === 2) {                                                            // toad
    setc(r0, c0, rot, 0, 1); setc(r0, c0, rot, 0, 2); setc(r0, c0, rot, 0, 3); setc(r0, c0, rot, 1, 0); setc(r0, c0, rot, 1, 1); setc(r0, c0, rot, 1, 2)
  } else if (pi === 3) {                                                            // beacon
    setc(r0, c0, rot, 0, 0); setc(r0, c0, rot, 0, 1); setc(r0, c0, rot, 1, 0); setc(r0, c0, rot, 1, 1); setc(r0, c0, rot, 2, 2); setc(r0, c0, rot, 2, 3); setc(r0, c0, rot, 3, 2); setc(r0, c0, rot, 3, 3)
  } else {                                                                          // LWSS
    setc(r0, c0, rot, 0, 0); setc(r0, c0, rot, 0, 3); setc(r0, c0, rot, 1, 4); setc(r0, c0, rot, 2, 0); setc(r0, c0, rot, 2, 4); setc(r0, c0, rot, 3, 1); setc(r0, c0, rot, 3, 2); setc(r0, c0, rot, 3, 3); setc(r0, c0, rot, 3, 4)
  }
}

let drop = (s) => {
  let pi = Math.floor(rnd(s * 4 + 1) * NPAT)
  let rr = rows - 9; if (rr < 1) rr = 1
  let cc = cols - 9; if (cc < 1) cc = 1
  let r0 = 3 + Math.floor(rnd(s * 4 + 2) * rr)   // off the edges so shapes evolve instead of clipping + dying
  let c0 = 3 + Math.floor(rnd(s * 4 + 3) * cc)
  let rot = Math.floor(rnd(s * 4 + 4) * 4)
  place(pi, r0, c0, rot)
}

// a fresh field of a few shapes (clears cur first; prev is left holding the previous board so it crossfades out)
let plant = (s) => {
  let n = cols * rows, i = 0
  while (i < n) { cur[i] = 0; i = i + 1 }
  drop(s + 11); drop(s + 27); drop(s + 53); drop(s + 91); drop(s + 131); drop(s + 173); drop(s + 211)
}

let seed = () => {
  let n = cols * rows, i = 0
  while (i < n) { prev[i] = 0; nxt[i] = 0; i = i + 1 }
  plant(7)
  gen = 0
}

export let configure = (gridX, scale) => {
  gx = gridX | 0
  cellF = 8.0 * scale; if (cellF < 4.0) cellF = 4.0
  pumid = Math.round(40.0 * scale); pumaj = Math.round(80.0 * scale)
  cols = Math.floor((W - gx) / cellF) + 2
  rows = Math.floor(H / cellF) + 2
  seed()
}

export let param = (i, v) => { let k = (i | 0) + 4; if (k >= 4 && k <= 15) F[k] = v }

// one generation: bounded (non-wrapping) 8-neighbour Conway, so movers leave at the edges.
let step = () => {
  let r = 0
  while (r < rows) {
    let c = 0
    while (c < cols) {
      let cnt = 0
      let dr = -1
      while (dr <= 1) {
        let rr = r + dr
        if (rr >= 0 && rr < rows) {
          let dc = -1
          while (dc <= 1) {
            if (dr !== 0 || dc !== 0) { let cc = c + dc; if (cc >= 0 && cc < cols) cnt = cnt + cur[rr * cols + cc] }
            dc = dc + 1
          }
        }
        dr = dr + 1
      }
      let p = r * cols + c
      nxt[p] = cur[p] === 1 ? (cnt === 2 || cnt === 3 ? 1 : 0) : (cnt === 3 ? 1 : 0)
      c = c + 1
    }
    r = r + 1
  }
  let t0 = prev; prev = cur; cur = nxt; nxt = t0   // rotate: old cur → prev (fade FROM), new gen → cur
  gen = gen + 1
  if (gen % INJECT === 0) plant(gen)               // refresh: clear cur + a fresh few (prev still fades out)
}

let ease = (p) => p * p * (3.0 - 2.0 * p)          // smoothstep

let fillCell = (c, r, aa) => {
  // edges snap to the real grid lines (round(c·cellF)) so cells never drift off them; 1px inset lets the line peek
  let x0 = gx + Math.round(c * cellF) + 1, x1 = gx + Math.round((c + 1) * cellF) - 1
  let y0 = Math.round(r * cellF) + 1, y1 = Math.round((r + 1) * cellF) - 1
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W) x1 = W
  if (y1 > H) y1 = H
  let col = (aa << 24) | 0x00000000                // black, alpha aa (peaks ~80% opaque — a touch transparent)
  let y = y0
  while (y < y1) {
    let row = y * W, x = x0
    while (x < x1) { px[row + x] = col; x = x + 1 }
    y = y + 1
  }
}

// ── click pulses (kept from the original) ──
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

  let target = Math.floor(t / STEP)
  let did = 0
  while (gen < target && did < 256) { step(); did = did + 1 }
  let phase = gen >= target ? (t / STEP - target) : 1.0
  let e = ease(phase)

  let nn = W * H, i = 0
  while (i < nn) { px[i] = 0; i = i + 1 }

  // crossfaded dots
  let r = 0
  while (r < rows) {
    let c = 0
    while (c < cols) {
      let p = r * cols + c
      let a0 = prev[p], a1 = cur[p]
      if (a0 !== 0 || a1 !== 0) {
        let f = a0 + (a1 - a0) * e
        if (f > 0.02) { let aa = (f * 204.0) | 0; if (aa > 204) aa = 204; fillCell(c, r, aa) }   // peak ~80% opacity
      }
      c = c + 1
    }
    r = r + 1
  }

  // click bursts on top
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

// pen: light the single cell under the cursor (drag to draw a 1-cell line)
export let pen = (nx, ny) => {
  if (cols === 0) return
  let c = Math.floor((nx * W - gx) / cellF), r = Math.floor(ny * H / cellF)
  if (r >= 0 && r < rows && c >= 0 && c < cols) { cur[r * cols + c] = 1; prev[r * cols + c] = 1 }
}

// click → draw (pen) + a white pulse burst from the nearest junction
export let spawn = (nx, ny) => {
  if (cols === 0) return
  pen(nx, ny)
  let cx = nx * W, cy = ny * H
  let jx = gx + Math.round((cx - gx) / pumid) * pumid
  let jy = Math.round(cy / pumid) * pumid
  let half = pumid * 0.5
  let ox = (cx - jx) / half; if (ox < -1.0) ox = -1.0; if (ox > 1.0) ox = 1.0
  let oy = (cy - jy) / half; if (oy < -1.0) oy = -1.0; if (oy > 1.0) oy = 1.0
  let i = bNext; bNext = bNext + 1; if (bNext >= BMAX) bNext = 0
  bJX[i] = Math.round(jx); bJY[i] = Math.round(jy); bOX[i] = ox; bOY[i] = oy; bT[i] = -2.0
}

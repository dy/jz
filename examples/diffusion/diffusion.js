// Reaction-diffusion (Gray-Scott model). Two chemical fields U and V are
// ping-ponged: each sub-step reads from the "read" half and writes to the
// "write" half, then toggles. The Laplacian is the simple 4-neighbour
// cross (N+S+E+W-4·C) with toroidal wrap. No transcendentals, no
// per-cell divides — pure multiply-add arithmetic.
//
// The kernel avoids reference-aliasing globals (which prevents jz from
// statically knowing which typed-array is being accessed). Instead, it
// keeps four permanently-named arrays (uA/uB/vA/vB) and toggles which
// "ping" is current via a flip bit, manually selecting A or B.
//
// Parameters: Du=0.16, Dv=0.08, F=0.054, k=0.062  (fingerprint / coral)
// frame() runs STEPS sub-steps per call for visible evolution at 60 fps.

let W = 0, H = 0
let uA, vA, uB, vB  // ping-pong double-buffered fields
let px               // Uint32 pixel output
let flip = 0         // 0: read A write B  |  1: read B write A
let STEPS = 8
let Du = 0.16, Dv = 0.08, F = 0.054, k = 0.062

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  uA = new Float64Array(n); vA = new Float64Array(n)
  uB = new Float64Array(n); vB = new Float64Array(n)
  px = new Uint32Array(n)
  clear()
  return px
}

// Reset both ping-pong halves to the rest state (U=1, V=0). The host plants seeds.
export let clear = () => {
  let n = W * H, i = 0
  while (i < n) {
    uA[i] = 1.0; vA[i] = 0.0
    uB[i] = 1.0; vB[i] = 0.0
    i++
  }
  flip = 0
}

// Plant a reacting patch (V=1, U=0.5) in the pixel rectangle [x0,x1]×[y0,y1], into BOTH
// halves so it shows whichever is the current read buffer — works as an initial seed and as
// a live drop into an already-evolving field (drag a selection rectangle).
export let seedRect = (x0, y0, x1, y1) => {
  let ax = x0 < x1 ? x0 : x1, bx = x0 < x1 ? x1 : x0
  let ay = y0 < y1 ? y0 : y1, by = y0 < y1 ? y1 : y0
  if (ax < 0) ax = 0
  if (ay < 0) ay = 0
  if (bx > W - 1) bx = W - 1
  if (by > H - 1) by = H - 1
  let y = ay
  while (y <= by) {
    let row = y * W, x = ax
    while (x <= bx) {
      uA[row + x] = 0.5; vA[row + x] = 1.0
      uB[row + x] = 0.5; vB[row + x] = 1.0
      x++
    }
    y++
  }
}

// Circular brush for free-hand painting. Writes into both ping-pong halves so the patch
// appears regardless of which buffer is currently being read.
export let seedBrush = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0
  let y0 = cy - r | 0, y1 = cy + r | 0
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
        uA[row + x] = 0.5; vA[row + x] = 1.0
        uB[row + x] = 0.5; vB[row + x] = 1.0
      }
      x++
    }
    y++
  }
}

// Erase a circular patch (back to rest state U=1, V=0) into both buffers.
export let eraseBrush = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0
  let y0 = cy - r | 0, y1 = cy + r | 0
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
        uA[row + x] = 1.0; vA[row + x] = 0.0
        uB[row + x] = 1.0; vB[row + x] = 0.0
      }
      x++
    }
    y++
  }
}

// Live parameter tweak: pointer position can drive the feed (F) and kill (k) rates.
export let setParams = (feed, kill) => {
  F = feed
  k = kill
}

// One Gray-Scott sub-step reading from (rU,rV) and writing to (wU,wV).
let stepAtoB = () => {
  let w = W, h = H
  let du = Du, dv = Dv, f = F, fk = F + k
  let y = 0
  while (y < h) {
    let yN = y === 0 ? h - 1 : y - 1
    let yS = y === h - 1 ? 0 : y + 1
    let rowC = y * w, rowN = yN * w, rowS = yS * w
    let x = 0
    while (x < w) {
      let xW = x === 0 ? w - 1 : x - 1
      let xE = x === w - 1 ? 0 : x + 1
      let c = rowC + x
      let uC = uA[c], vC = vA[c]
      let lapU = uA[rowN + x] + uA[rowS + x] + uA[rowC + xW] + uA[rowC + xE] - 4.0 * uC
      let lapV = vA[rowN + x] + vA[rowS + x] + vA[rowC + xW] + vA[rowC + xE] - 4.0 * vC
      let uvv = uC * vC * vC
      uB[c] = uC + du * lapU - uvv + f * (1.0 - uC)
      vB[c] = vC + dv * lapV + uvv - fk * vC
      x++
    }
    y++
  }
}

let stepBtoA = () => {
  let w = W, h = H
  let du = Du, dv = Dv, f = F, fk = F + k
  let y = 0
  while (y < h) {
    let yN = y === 0 ? h - 1 : y - 1
    let yS = y === h - 1 ? 0 : y + 1
    let rowC = y * w, rowN = yN * w, rowS = yS * w
    let x = 0
    while (x < w) {
      let xW = x === 0 ? w - 1 : x - 1
      let xE = x === w - 1 ? 0 : x + 1
      let c = rowC + x
      let uC = uB[c], vC = vB[c]
      let lapU = uB[rowN + x] + uB[rowS + x] + uB[rowC + xW] + uB[rowC + xE] - 4.0 * uC
      let lapV = vB[rowN + x] + vB[rowS + x] + vB[rowC + xW] + vB[rowC + xE] - 4.0 * vC
      let uvv = uC * vC * vC
      uA[c] = uC + du * lapU - uvv + f * (1.0 - uC)
      vA[c] = vC + dv * lapV + uvv - fk * vC
      x++
    }
    y++
  }
}

export let frame = () => {
  let n = W * H, steps = STEPS, s = 0

  while (s < steps) {
    if (flip === 0) { stepAtoB(); flip = 1 } else { stepBtoA(); flip = 0 }
    s++
  }

  // render the current read buffer's V → grayscale. The V field peaks near ~0.4, so a raw
  // v*255 reads as a dim mid-gray — lift it (gain ≈ 2.6) so the coral is crisp white on black.
  let i = 0
  while (i < n) {
    let v = flip === 0 ? vA[i] : vB[i]
    let b = v * 2.6
    if (b < 0.0) b = 0.0
    if (b > 1.0) b = 1.0
    let g = (b * 255.0) | 0
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

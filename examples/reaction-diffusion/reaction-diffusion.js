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
// Parameters: Du=0.16, Dv=0.08, F=0.06, k=0.062  (fingerprint / coral)
// frame() runs STEPS sub-steps per call for visible evolution at 60 fps.

let W = 0, H = 0
let uA, vA, uB, vB  // ping-pong double-buffered fields
let px               // Uint32 pixel output
let flip = 0         // 0: read A write B  |  1: read B write A
let STEPS = 8
let Du = 0.16, Dv = 0.08, F = 0.06, k = 0.062

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  uA = new Float64Array(n); vA = new Float64Array(n)
  uB = new Float64Array(n); vB = new Float64Array(n)
  px = new Uint32Array(n)
  flip = 0
  seed()
  return px
}

export let seed = () => {
  let n = W * H, i = 0
  while (i < n) {
    uA[i] = 1.0; vA[i] = 0.0
    uB[i] = 1.0; vB[i] = 0.0
    i++
  }
  flip = 0
  // plant two square patches of V=1, U=0.5 near centre
  let cx = W >> 1, cy = H >> 1
  let r = (W < H ? W : H) >> 4
  let py = -r
  while (py <= r) {
    let row = ((cy + py + H) % H) * W
    let px0 = -r
    while (px0 <= r) {
      let col = (cx + px0 + W) % W
      uA[row + col] = 0.5; vA[row + col] = 1.0
      px0++
    }
    py++
  }
  let ox = W >> 2, oy = H >> 2
  py = -r
  while (py <= r) {
    let row = ((cy + oy + py + H) % H) * W
    let px0 = -r
    while (px0 <= r) {
      let col = (cx + ox + px0 + W) % W
      uA[row + col] = 0.5; vA[row + col] = 1.0
      px0++
    }
    py++
  }
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

  // render the current read buffer's V → palette (blue→cyan→white)
  // shift-based colour mapping, no per-pixel divides
  let i = 0
  while (i < n) {
    let v = flip === 0 ? vA[i] : vB[i]
    v = v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v
    let t = (v * 255.0) | 0
    let t2 = t + t             // 0..510
    let r = t2 > 255 ? t2 - 255 : 0
    let g = t2 < 255 ? t2 : 255
    let b = 128 + ((t * 127) >> 8)
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}

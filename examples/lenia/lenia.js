// Lenia — continuous cellular automaton. A smooth ring kernel convolution drives
// exponential growth/decay per cell, producing "digital life" structures.
// Kernel offsets (dx,dy,weight) are precomputed in resize(); each frame does
// one pass: conv = Σ weight_k · cell[wrap(x+dx_k)], growth = 2·exp(-((conv-μ)²·INV2S2))-1,
// next = clamp(cur + dt·growth, 0, 1). No per-pixel divides; exp per cell = ILP win for jz.

let W = 0, H = 0, px
let cellA, cellB                  // ping-pong Float64 buffers
let kdx, kdy, kw                  // kernel offset & weight arrays (Int32 dx,dy; Float64 w)
let klen = 0                      // number of kernel entries
let INV2S2 = 0.0                  // 1/(2σ²), σ=0.017

export let resize = (w, h) => {
  W = w; H = h
  cellA = new Float64Array(w * h)
  cellB = new Float64Array(w * h)
  px = new Uint32Array(w * h)

  // Precompute smooth ring kernel: weight(r) = exp(-((r/R-0.5)^2)/(2*0.15^2)) for r in (0,R]
  // R=12, sigma_r=0.15. Collect all (dx,dy) where 0<dist<=R, compute & normalize weights.
  let R = 9
  let sigma_r = 0.15
  let inv2sr2 = 1.0 / (2.0 * sigma_r * sigma_r)
  let sigma = 0.017
  INV2S2 = 1.0 / (2.0 * sigma * sigma)

  // Two-pass: first count, then fill (jz needs static-size arrays)
  let count = 0
  let dy2 = -R
  while (dy2 <= R) {
    let dx2 = -R
    while (dx2 <= R) {
      let r = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      if (r > 0.0 && r <= R) { count++ }
      dx2++
    }
    dy2++
  }

  kdx = new Int32Array(count)
  kdy = new Int32Array(count)
  kw = new Float64Array(count)
  klen = count

  let idx = 0
  let wsum = 0.0
  let dy3 = -R
  while (dy3 <= R) {
    let dx3 = -R
    while (dx3 <= R) {
      let r = Math.sqrt(dx3 * dx3 + dy3 * dy3)
      if (r > 0.0 && r <= R) {
        let nr = r / R - 0.5          // normalized, centered at 0.5
        let wval = Math.exp(-(nr * nr) * inv2sr2)
        kdx[idx] = dx3
        kdy[idx] = dy3
        kw[idx] = wval
        wsum += wval
        idx++
      }
      dx3++
    }
    dy3++
  }

  // Normalize weights so they sum to 1
  let invWsum = 1.0 / wsum
  let ki = 0
  while (ki < klen) { kw[ki] = kw[ki] * invWsum; ki++ }

  return px
}

export let seed = () => {
  // Primordial soup: low-amplitude noise over a broad central region, biased near the
  // growth peak μ≈0.15 so cells start inside the growth window and sustain (a full-range
  // [0,1] seed sits mostly above μ+σ and just decays to nothing). buf reset to read cellA.
  buf = 0
  let i = 0, n = W * H
  while (i < n) { cellA[i] = 0.0; cellB[i] = 0.0; i++ }
  let pw = (W * 0.7) | 0
  let ph = (H * 0.7) | 0
  let x0 = ((W - pw) >> 1)
  let y0 = ((H - ph) >> 1)
  let cy = y0
  while (cy < y0 + ph) {
    let cx = x0
    while (cx < x0 + pw) {
      cellA[cy * W + cx] = Math.random() * 0.5
      cx++
    }
    cy++
  }
}

let buf = 0   // 0 → read cellA write cellB, 1 → read cellB write cellA

// Paint a patch of living "soup" — low-amplitude noise biased into the growth window
// (μ≈0.15) so the brush spawns self-sustaining Lenia structures instead of a blob that
// just decays. Written to both ping-pong buffers so it survives the swap.
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
        let v = 0.1 + Math.random() * 0.45
        cellA[row + x] = v
        cellB[row + x] = v
      }
      x++
    }
    y++
  }
}

export let frame = (dt) => {
  let src = buf === 0 ? cellA : cellB
  let dst = buf === 0 ? cellB : cellA
  buf = 1 - buf

  let mu = 0.15
  let inv2s2 = INV2S2
  let ww = W, hh = H
  let kl = klen

  let py = 0
  while (py < hh) {
    let qx = 0
    while (qx < ww) {
      let cidx = py * ww + qx
      let conv = 0.0
      let ki = 0
      while (ki < kl) {
        // toroidal wrap with explicit modulo (no % — use conditional arithmetic)
        let nx = qx + kdx[ki]
        let ny = py + kdy[ki]
        // wrap nx into [0, W)
        if (nx < 0) { nx = nx + ww }
        else if (nx >= ww) { nx = nx - ww }
        // wrap ny into [0, H)
        if (ny < 0) { ny = ny + hh }
        else if (ny >= hh) { ny = ny - hh }
        conv = conv + kw[ki] * src[ny * ww + nx]
        ki++
      }
      let diff = conv - mu
      // growth = 2·exp(-((conv-μ)²·INV2S2)) - 1
      let growth = 2.0 * Math.exp(-(diff * diff) * inv2s2) - 1.0
      let next = src[cidx] + dt * growth
      // clamp to [0,1] divide-free
      if (next < 0.0) { next = 0.0 }
      else if (next > 1.0) { next = 1.0 }
      dst[cidx] = next
      qx++
    }
    py++
  }

  // Render: grayscale — cell value v in [0,1] maps linearly to intensity [0,255]
  py = 0
  while (py < hh) {
    let qx = 0
    while (qx < ww) {
      let v = dst[py * ww + qx]
      let vi = (v * 255.0) | 0
      px[py * ww + qx] = (255 << 24) | (vi << 16) | (vi << 8) | vi
      qx++
    }
    py++
  }
}

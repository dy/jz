// Lenia — continuous cellular automaton, now TWO interacting species. Each species (A, B) is
// its own smooth-ring-kernel Lenia (own radius/μ/σ); growth ALSO senses the OTHER species'
// field through the SAME kernel geometry — no extra offset arrays, one extra accumulator per
// pass. Predator/prey-flavored: A (prey) is suppressed where B is dense, B (predator) is
// boosted where A is dense — this keeps both populations alive long-term (tuned empirically:
// too much predation collapses both channels, too little reads as two independent films).
// B is stepped on a slower timescale than A (see dtBscale in frame()) so it visibly hunts —
// spreading into and eroding A's coral for thousands of frames — rather than snapping
// instantly to a shared equilibrium.
//
//   convAA = Σ wA_k·A[wrap(x+dxA_k)]     convAB = Σ wA_k·B[wrap(x+dxA_k)]   (A's kernel, both fields)
//   convBB = Σ wB_k·B[wrap(x+dxB_k)]     convBA = Σ wB_k·A[wrap(x+dxB_k)]   (B's kernel, both fields)
//   growthA = 2·exp(-((convAA-μA)²·INV2S2A))-1 - βAB·convAB    (B's local mass suppresses A)
//   growthB = 2·exp(-((convBB-μB)²·INV2S2B))-1 + βBA·convBA    (A's local mass feeds B)
//   next = clamp(cur + dt·growth, 0, 1)
//
// Each kernel's taps are walked ONCE per species (self-conv and cross-conv accumulate
// together over the same (dx,dy) offsets), so a frame costs ~2 convolution passes/pixel, not
// 4. No per-pixel divides; exp per cell = ILP win for jz.

let W = 0, H = 0, px
let a0, a1                        // species A (prey) ping-pong Float64 buffers
let b0, b1                        // species B (predator) ping-pong Float64 buffers
let buf = 0                       // 0 → read *0 write *1, 1 → read *1 write *0 (both species march together)

let kdxA, kdyA, kwA                // species A kernel offsets/weights (Int32 dx,dy; Float64 w)
let klenA = 0
let kdxB, kdyB, kwB                // species B kernel offsets/weights — own radius/shape
let klenB = 0

let INV2S2A = 0.0, INV2S2B = 0.0   // 1/(2σ²) per species growth window

// count how many (dx,dy) taps fall in the ring 0<r<=R (two-pass: count then fill, since jz
// needs static-size arrays)
let ringCount = (R) => {
  let count = 0
  let dy = -R
  while (dy <= R) {
    let dx = -R
    while (dx <= R) {
      let r = Math.sqrt(dx * dx + dy * dy)
      if (r > 0.0 && r <= R) count++
      dx++
    }
    dy++
  }
  return count
}

// Fill dxArr/dyArr/wArr (pre-sized via ringCount(R)) with the smooth ring kernel:
// weight(r) = exp(-((r/R-0.5)²)/(2·sigmaR²)). Returns the UNNORMALIZED weight sum so the
// caller can normalize in a second short pass (kw[i] *= 1/wsum).
let fillRing = (dxArr, dyArr, wArr, R, sigmaR) => {
  let inv2sr2 = 1.0 / (2.0 * sigmaR * sigmaR)
  let idx = 0
  let wsum = 0.0
  let dy = -R
  while (dy <= R) {
    let dx = -R
    while (dx <= R) {
      let r = Math.sqrt(dx * dx + dy * dy)
      if (r > 0.0 && r <= R) {
        let nr = r / R - 0.5          // normalized, centered at 0.5
        let wval = Math.exp(-(nr * nr) * inv2sr2)
        dxArr[idx] = dx
        dyArr[idx] = dy
        wArr[idx] = wval
        wsum += wval
        idx++
      }
      dx++
    }
    dy++
  }
  return wsum
}

export let resize = (w, h) => {
  W = w; H = h
  a0 = new Float64Array(w * h); a1 = new Float64Array(w * h)
  b0 = new Float64Array(w * h); b1 = new Float64Array(w * h)
  px = new Uint32Array(w * h)

  // Species A (prey): wide ring, R=9 — the original single-species Lenia regime, unchanged.
  let RA = 9, sigmaRA = 0.15
  let sigmaA = 0.030        // wider growth window → fluid, perpetually-moving creatures
  INV2S2A = 1.0 / (2.0 * sigmaA * sigmaA)
  let countA = ringCount(RA)
  kdxA = new Int32Array(countA); kdyA = new Int32Array(countA); kwA = new Float64Array(countA)
  klenA = countA
  let wsumA = fillRing(kdxA, kdyA, kwA, RA, sigmaRA)
  let invA = 1.0 / wsumA
  let ia = 0
  while (ia < klenA) { kwA[ia] = kwA[ia] * invA; ia++ }

  // Species B (predator): tighter ring, own radius — a visually + behaviourally distinct,
  // faster-reacting creature that depends on A to persist (see BETA_BA in frame()).
  let RB = 6, sigmaRB = 0.15
  let sigmaB = 0.028
  INV2S2B = 1.0 / (2.0 * sigmaB * sigmaB)
  let countB = ringCount(RB)
  kdxB = new Int32Array(countB); kdyB = new Int32Array(countB); kwB = new Float64Array(countB)
  klenB = countB
  let wsumB = fillRing(kdxB, kdyB, kwB, RB, sigmaRB)
  let invB = 1.0 / wsumB
  let ib = 0
  while (ib < klenB) { kwB[ib] = kwB[ib] * invB; ib++ }

  return px
}

// Scatter `nb` soup blobs (radius br0..br0+brSpan, amplitude amp0..amp0+ampSpan) into `dst`.
let scatterSpecies = (dst, nbBase, nbSpan, br0, brSpan, amp0, ampSpan) => {
  let nb = nbBase + (Math.random() * nbSpan | 0)
  let b = 0
  while (b < nb) {
    let bx = Math.random() * W, by = Math.random() * H
    let br = br0 + Math.random() * brSpan
    let amp = amp0 + Math.random() * ampSpan
    let r2 = br * br
    let x0 = (bx - br) | 0, x1 = (bx + br) | 0, y0 = (by - br) | 0, y1 = (by + br) | 0
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 > W - 1) x1 = W - 1
    if (y1 > H - 1) y1 = H - 1
    let y = y0
    while (y <= y1) {
      let dy = y - by, row = y * W, x = x0
      while (x <= x1) {
        let dx = x - bx, d2 = dx * dx + dy * dy
        if (d2 < r2) {
          let f = 1.0 - d2 / r2
          let v = dst[row + x] + amp * f * (0.6 + Math.random() * 0.4)
          if (v > 1.0) v = 1.0
          dst[row + x] = v
        }
        x++
      }
      y++
    }
    b++
  }
}

// Scatter fresh soup of BOTH species into otherwise-empty space. Only the current "read" half
// (buf reset to 0 → a0/b0) needs seeding — frame() computes the other half fresh on its first
// pass. Species get independent blob counts/sizes so the two populations read distinctly.
export let seed = () => {
  buf = 0
  let i = 0, n = W * H
  while (i < n) { a0[i] = 0.0; a1[i] = 0.0; b0[i] = 0.0; b1[i] = 0.0; i++ }
  scatterSpecies(a0, 9, 10.0, 13.0, 16.0, 0.35, 0.5)
  scatterSpecies(b0, 7, 8.0, 10.0, 14.0, 0.30, 0.45)
}

// Paint low-amplitude noise biased into the growth window so the brush spawns self-sustaining
// structures instead of a blob that just decays. Written to BOTH ping-pong slots (d0,d1) so
// the stamp survives the next buf swap regardless of which half is currently "read".
let paintBrush = (d0, d1, cx, cy, r) => {
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
        d0[row + x] = v
        d1[row + x] = v
      }
      x++
    }
    y++
  }
}

// Brush paints species A (prey) — the original interaction, unchanged signature.
export let seedBrush = (cx, cy, r) => { paintBrush(a0, a1, cx, cy, r) }
// Right-drag / modifier paints species B (predator) — same stamp, other channel.
export let seedBrushB = (cx, cy, r) => { paintBrush(b0, b1, cx, cy, r) }

export let frame = (dt) => {
  let srcA = buf === 0 ? a0 : a1
  let dstA = buf === 0 ? a1 : a0
  let srcB = buf === 0 ? b0 : b1
  let dstB = buf === 0 ? b1 : b0
  buf = 1 - buf

  // Growth-window centres + cross-coupling strengths. Tuned for long-term coexistence: B
  // needs a steady diet of A to avoid decaying away; A tolerates modest local predation
  // without going globally extinct (it keeps regrowing where B has moved on).
  let muA = 0.22, muB = 0.18
  let betaAB = 0.30     // B's local mass subtracts from A's growth (predation pressure)
  let betaBA = 0.60     // A's local mass adds to B's growth (B's food source)
  // Predators respond to prey on a SLOWER timescale than prey respond to predators (real
  // populations lag their food source) — this is what turns the coupling into an extended
  // chase/settle rather than an instant snap to a shared equilibrium: B's field is stepped at
  // a fraction of A's rate, so B keeps visibly hunting/retreating for thousands of frames.
  let dtBscale = 0.05
  let inv2s2A = INV2S2A, inv2s2B = INV2S2B
  let ww = W, hh = H
  let klA = klenA, klB = klenB

  let py = 0
  while (py < hh) {
    let qx = 0
    while (qx < ww) {
      let cidx = py * ww + qx

      // species A's kernel walk: self-conv (over A) and cross-conv (over B) together
      let convAA = 0.0, convAB = 0.0
      let ki = 0
      while (ki < klA) {
        let nx = qx + kdxA[ki]
        let ny = py + kdyA[ki]
        if (nx < 0) { nx = nx + ww } else if (nx >= ww) { nx = nx - ww }
        if (ny < 0) { ny = ny + hh } else if (ny >= hh) { ny = ny - hh }
        let nidx = ny * ww + nx
        let wgt = kwA[ki]
        convAA = convAA + wgt * srcA[nidx]
        convAB = convAB + wgt * srcB[nidx]
        ki++
      }

      // species B's kernel walk: self-conv (over B) and cross-conv (over A) together
      let convBB = 0.0, convBA = 0.0
      let kj = 0
      while (kj < klB) {
        let nx = qx + kdxB[kj]
        let ny = py + kdyB[kj]
        if (nx < 0) { nx = nx + ww } else if (nx >= ww) { nx = nx - ww }
        if (ny < 0) { ny = ny + hh } else if (ny >= hh) { ny = ny - hh }
        let nidx = ny * ww + nx
        let wgt = kwB[kj]
        convBB = convBB + wgt * srcB[nidx]
        convBA = convBA + wgt * srcA[nidx]
        kj++
      }

      let diffA = convAA - muA
      let growthA = 2.0 * Math.exp(-(diffA * diffA) * inv2s2A) - 1.0 - betaAB * convAB
      let nextA = srcA[cidx] + dt * growthA
      if (nextA < 0.0) { nextA = 0.0 }
      else if (nextA > 1.0) { nextA = 1.0 }
      dstA[cidx] = nextA

      let diffB = convBB - muB
      let growthB = 2.0 * Math.exp(-(diffB * diffB) * inv2s2B) - 1.0 + betaBA * convBA
      let nextB = srcB[cidx] + dt * dtBscale * growthB
      if (nextB < 0.0) { nextB = 0.0 }
      else if (nextB > 1.0) { nextB = 1.0 }
      dstB[cidx] = nextB

      qx++
    }
    py++
  }

  // Render: monochrome — species A is bright white, species B a distinct mid-gray, so the prey
  // and predator fields (and their meeting zones) read apart without any colour.
  py = 0
  while (py < hh) {
    let qx = 0
    while (qx < ww) {
      let idx = py * ww + qx
      let va = dstA[idx], vb = dstB[idx]
      let v = va * 255.0 + vb * 150.0
      if (v > 255.0) v = 255.0
      let vi = v | 0
      px[idx] = (255 << 24) | (vi << 16) | (vi << 8) | vi
      qx++
    }
    py++
  }
}

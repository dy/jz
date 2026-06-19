// Schrödinger equation — Visscher leapfrog, double-slit potential.
// ψ = R + iI evolved as staggered real/imaginary fields.
// Render: brightness = |ψ|², hue = phase angle.
//
// Visscher scheme (stable), forward-time Schrödinger ∂ψ/∂t = i(½∇²ψ − Vψ):
//   R_{n+1} = R_n + dt*(-0.5*L(I_n) + V*I_n)
//   I_{n+1} = I_n + dt*( 0.5*L(R_{n+1}) - V*R_{n+1})  ← uses updated R
// (sign of the bracket = +Ĥ on R, −Ĥ on I; the opposite sign runs time backwards,
//  which sends a +kx packet the WRONG way — leftward, away from the slits.)

let W = 0, H = 0
let R   // Float64Array — real part of ψ
let I   // Float64Array — imaginary part of ψ
let V   // Float32Array — barrier potential
let px  // Uint32Array  — pixel output

const DT = 0.05
const SUBSTEPS = 10
const BORDER = 6

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  R = new Float64Array(n)
  I = new Float64Array(n)
  V = new Float32Array(n)
  px = new Uint32Array(n)
  buildV()
  init()
  return px
}

let buildV = () => {
  let w = W, h = H
  // Vertical barrier at x = floor(w*0.55), width 2, height V0=4.0
  let bx = (w * 0.55) | 0
  // Two slit openings (V=0 inside slits)
  let s1y0 = (h * 0.33) | 0, s1y1 = (h * 0.44) | 0
  let s2y0 = (h * 0.56) | 0, s2y1 = (h * 0.67) | 0
  // Zero everything first
  let n = w * h, i = 0
  while (i < n) { V[i] = 0.0; i++ }
  // Set barrier
  let y = 0
  while (y < h) {
    let inSlit = (y >= s1y0 && y <= s1y1) || (y >= s2y0 && y <= s2y1)
    if (!inSlit) {
      V[y * w + bx] = 4.0
      if (bx + 1 < w) V[y * w + bx + 1] = 4.0
    }
    y++
  }
}

export let init = () => {
  let w = W, h = H, n = w * h
  let x0 = (w * 0.2) | 0
  let y0 = (h * 0.5) | 0
  let sig = w / 12.0
  let sig2 = sig * sig * 2.0
  let kx = 0.55
  let i = 0
  while (i < n) {
    let x = i % w
    let y = (i / w) | 0
    let dx = x - x0, dy = y - y0
    let env = Math.exp(-(dx * dx + dy * dy) / sig2)
    R[i] = env * Math.cos(kx * x)
    I[i] = env * Math.sin(kx * x)
    i++
  }
}

// Visscher step: update R using current I, then update I using new R
let stepR = () => {
  let w = W, h = H, dt = DT
  let y = 1
  while (y < h - 1) {
    let x = 1
    while (x < w - 1) {
      let idx = y * w + x
      let lapI = I[idx - w] + I[idx + w] + I[idx - 1] + I[idx + 1] - 4.0 * I[idx]
      R[idx] = R[idx] + dt * (-0.5 * lapI + V[idx] * I[idx])
      x++
    }
    y++
  }
}

let stepI = () => {
  let w = W, h = H, dt = DT
  let y = 1
  while (y < h - 1) {
    let x = 1
    while (x < w - 1) {
      let idx = y * w + x
      let lapR = R[idx - w] + R[idx + w] + R[idx - 1] + R[idx + 1] - 4.0 * R[idx]
      I[idx] = I[idx] + dt * (0.5 * lapR - V[idx] * R[idx])
      x++
    }
    y++
  }
}

// Absorbing boundary: zero out border pixels
let zeroR = () => {
  let w = W, h = H, b = BORDER
  // top rows
  let y = 0
  while (y < b) {
    let x = 0
    while (x < w) { R[y * w + x] = 0.0; x++ }
    y++
  }
  // bottom rows
  y = h - b
  while (y < h) {
    let x = 0
    while (x < w) { R[y * w + x] = 0.0; x++ }
    y++
  }
  // left/right columns in middle rows
  y = b
  while (y < h - b) {
    let x = 0
    while (x < b) { R[y * w + x] = 0.0; x++ }
    x = w - b
    while (x < w) { R[y * w + x] = 0.0; x++ }
    y++
  }
}

let zeroI = () => {
  let w = W, h = H, b = BORDER
  // top rows
  let y = 0
  while (y < b) {
    let x = 0
    while (x < w) { I[y * w + x] = 0.0; x++ }
    y++
  }
  // bottom rows
  y = h - b
  while (y < h) {
    let x = 0
    while (x < w) { I[y * w + x] = 0.0; x++ }
    y++
  }
  // left/right columns in middle rows
  y = b
  while (y < h - b) {
    let x = 0
    while (x < b) { I[y * w + x] = 0.0; x++ }
    x = w - b
    while (x < w) { I[y * w + x] = 0.0; x++ }
    y++
  }
}

export let frame = (t) => {
  let s = 0
  while (s < SUBSTEPS) {
    stepR()
    zeroR()
    stepI()
    zeroI()
    s++
  }

  let n = W * H, scale = 12.0
  let i = 0
  while (i < n) {
    if (V[i] > 0.5) {
      // barrier: dim gray
      px[i] = (255 << 24) | (40 << 16) | (40 << 8) | 40
    } else {
      let ri = R[i], ii = I[i]
      let prob = (ri * ri + ii * ii) * scale
      if (prob > 1.0) prob = 1.0
      // gray = |ψ|² probability density (drop phase hue)
      let g = (prob * 255.0) | 0
      px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    }
    i++
  }
}

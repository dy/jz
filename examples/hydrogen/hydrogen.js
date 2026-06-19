// Hydrogen orbitals — the electron probability cloud of the hydrogen atom. Each eigenstate
// ψₙₗₘ(r,θ,φ) = Rₙₗ(r)·Yₗₘ(θ,φ); we render |ψ|² in the x–z plane (φ=0) as a glowing grayscale cloud
// (white where the electron is most likely) — the dark nodal surfaces between the bright lobes are
// what make a p a dumbbell and a d a cloverleaf. `sel` (a fractional orbital index) cross-dissolves
// through a curated tour — 1s → 2s → 2p → 3s → 3p → 3d → 4f — so it morphs continuously.
//
// The real orbitals are hard-coded analytic forms (a₀=1, un-normalized — resize() finds each one's
// peak |ψ|² so brightness auto-scales). Per pixel: two orbital evaluations (the dissolve pair), each
// a handful of multiplies + one exp — a dense transcendental kernel, jz's wheelhouse.
let W = 0, H = 0, px
let NORB = 9
let nOf = new Int32Array([1, 2, 2, 2, 3, 3, 3, 3, 4])   // principal quantum number per orbital
let norm                                                 // Float64Array(NORB) — peak |ψ|² per orbital

// world half-extent (Bohr radii) that frames orbital i — grows like n² (the cloud's size)
let scaleOf = (i) => { let n = nOf[i]; return 3.5 * (n * n) + 5.0 }

// signed wavefunction amplitude ψ at (r, cosθ=ct, sinθ=st) for orbital index i
let psi = (i, r, ct, st) => {
  if (i === 0) return Math.exp(-r)                                              // 1s
  if (i === 1) return (2.0 - r) * Math.exp(-r * 0.5)                            // 2s
  if (i === 2) return r * Math.exp(-r * 0.5) * st                              // 2pₓ
  if (i === 3) return r * Math.exp(-r * 0.5) * ct                              // 2p_z
  if (i === 4) return (27.0 - 18.0 * r + 2.0 * r * r) * Math.exp(-r / 3.0)      // 3s
  if (i === 5) return (6.0 - r) * r * Math.exp(-r / 3.0) * ct                   // 3p_z
  if (i === 6) return r * r * Math.exp(-r / 3.0) * (3.0 * ct * ct - 1.0)        // 3d_z²
  if (i === 7) return r * r * Math.exp(-r / 3.0) * st * ct                      // 3d_xz
  return r * r * r * Math.exp(-r * 0.25) * (5.0 * ct * ct * ct - 3.0 * ct)      // 4f_z³
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  // Per-orbital normalization: scan a coarse grid over each orbital's own frame, record peak |ψ|².
  norm = new Float64Array(NORB)
  let oi = 0
  while (oi < NORB) {
    let s = scaleOf(oi), mx = 1e-30
    let gy = 0
    while (gy < 72) {
      let z = (gy / 71.0 - 0.5) * 2.0 * s
      let gx = 0
      while (gx < 72) {
        let x = (gx / 71.0 - 0.5) * 2.0 * s
        let r = Math.sqrt(x * x + z * z)
        let ct = r > 1e-9 ? z / r : 1.0
        let st = r > 1e-9 ? x / r : 0.0
        let p = psi(oi, r, ct, st)
        let b = p * p
        if (b > mx) mx = b
        gx++
      }
      gy++
    }
    norm[oi] = mx
    oi++
  }
  return px
}

export let frame = (t, sel) => {
  let i0 = sel | 0
  if (i0 < 0) i0 = 0
  if (i0 > NORB - 1) i0 = NORB - 1
  let i1 = i0 + 1
  if (i1 > NORB - 1) i1 = NORB - 1
  let frac = sel - i0
  let s0 = scaleOf(i0), s1 = scaleOf(i1)
  let in0 = 1.0 / norm[i0], in1 = 1.0 / norm[i1]
  let aspect = W / H

  let py = 0
  while (py < H) {
    let fy = 0.5 - py / H                          // +z points up
    let qx = 0
    while (qx < W) {
      let fx = (qx / W - 0.5) * aspect

      // orbital i0 at its scale
      let x0 = fx * 2.0 * s0, z0 = fy * 2.0 * s0
      let r0 = Math.sqrt(x0 * x0 + z0 * z0)
      let ct0 = r0 > 1e-9 ? z0 / r0 : 1.0, st0 = r0 > 1e-9 ? x0 / r0 : 0.0
      let p0 = psi(i0, r0, ct0, st0)
      let b0 = p0 * p0 * in0

      // orbital i1 at its scale
      let x1 = fx * 2.0 * s1, z1 = fy * 2.0 * s1
      let r1 = Math.sqrt(x1 * x1 + z1 * z1)
      let ct1 = r1 > 1e-9 ? z1 / r1 : 1.0, st1 = r1 > 1e-9 ? x1 / r1 : 0.0
      let p1 = psi(i1, r1, ct1, st1)
      let b1 = p1 * p1 * in1

      let b = b0 * (1.0 - frac) + b1 * frac

      let v = b > 1.0 ? 1.0 : b
      v = Math.pow(v, 0.45)                         // lift the faint outer cloud
      let g = (v * 255.0) | 0                        // grayscale density — white cloud on black
      if (g > 255) g = 255

      px[py * W + qx] = (255 << 24) | (g << 16) | (g << 8) | g
      qx++
    }
    py++
  }
}

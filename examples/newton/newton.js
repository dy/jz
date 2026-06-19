// Newton fractal — Newton–Raphson root-finding turned into a picture. Every pixel is a
// start point z₀ for the iteration  z ← z − a·p(z)/p′(z)  on p(z) = z³ − 1, whose three
// roots are the cube roots of unity. Color = which root the orbit falls into (the basin
// of attraction); brightness = how fast it got there. The basins meet on a fractal
// boundary — between any two colors lurks a speck of the third, forever.
//
// Unlike Mandelbrot/Julia (escape time), this is CONVERGENCE: the boundary is where
// Newton's method can't decide. `a` is the relaxation factor, passed as f64 args so it
// stays fractional (a module global would be i32-narrowed in jz). a=1 is plain Newton;
// driving a off 1 over-/under-relaxes it and the basins swirl. The per-pixel complex
// loop — a fistful of multiplies and one divide — is exactly what jz compiles to tight wasm.
// resize(w,h) → Uint32Array; frame(t, are, aim, vcx, vcy, vscale) renders the view centred at
// (vcx,vcy) with half-height vscale — the host drives those from scroll-zoom / drag-pan.

let W = 0, H = 0, px, invW = 0, invH = 0, aspect = 1
let MAXIT = 40
let EPS = 0.000001                       // |z−root|² convergence threshold

// cube roots of unity: 1, and −½ ± i·√3/2
let R3 = 0.8660254037844386              // √3 / 2

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH
  px = new Uint32Array(w * h)
  return px
}

export let frame = (t, are, aim, vcx, vcy, vscale) => {
  let scale = vscale
  let j = 0, py = 0
  while (py < H) {
    let y0 = (py * invH - 0.5) * 2.0 * scale + vcy
    let qx = 0
    while (qx < W) {
      let zx = (qx * invW - 0.5) * 2.0 * scale * aspect + vcx
      let zy = y0
      let it = 0
      let root = 0
      while (it < MAXIT) {
        // z² and z³ by hand (complex)
        let zx2 = zx * zx - zy * zy
        let zy2 = 2.0 * zx * zy
        let zx3 = zx2 * zx - zy2 * zy
        let zy3 = zx2 * zy + zy2 * zx
        // p = z³ − 1 ; p′ = 3z²
        let pr = zx3 - 1.0, pi = zy3
        let dr = 3.0 * zx2, di = 3.0 * zy2
        // q = p / p′  (complex divide)
        let den = dr * dr + di * di
        if (den < 1e-18) { it = MAXIT; break }
        let qr = (pr * dr + pi * di) / den
        let qi = (pi * dr - pr * di) / den
        // relaxed Newton step: z ← z − a·q
        let sx = are * qr - aim * qi
        let sy = are * qi + aim * qr
        zx = zx - sx
        zy = zy - sy
        // converged to a root?
        let d0x = zx - 1.0
        if (d0x * d0x + zy * zy < EPS) { root = 1; break }
        let d1x = zx + 0.5, d1y = zy - R3
        if (d1x * d1x + d1y * d1y < EPS) { root = 2; break }
        let d2x = zx + 0.5, d2y = zy + R3
        if (d2x * d2x + d2y * d2y < EPS) { root = 3; break }
        it++
      }
      // shade by speed of convergence (fewer iters → brighter); gray level by basin
      let s = 1.0 - it / MAXIT
      s = s * s                            // gamma — deepen the boundary filigree
      let lo = 0.18 + 0.82 * s
      let gg = 0
      if (root == 1) { gg = (95.0 * lo) | 0 }
      else if (root == 2) { gg = (165.0 * lo) | 0 }
      else if (root == 3) { gg = (235.0 * lo) | 0 }
      px[j] = (255 << 24) | (gg << 16) | (gg << 8) | gg
      j++; qx++
    }
    py++
  }
}

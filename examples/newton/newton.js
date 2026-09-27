// Newton fractal — Newton–Raphson root-finding turned into a picture. Every pixel is a
// start point z₀ for the iteration  z ← z − a·p(z)/p′(z)  on p(z) = z³ − 1, whose three
// roots are the cube roots of unity. Tone = which root the orbit falls into (the basin
// of attraction); brightness = how fast it got there, as a smooth count continuous across whole
// steps: plain Newton converges quadratically, ν = n − log₂(log d² / log ε); relaxed by a it
// converges linearly, each step shrinking d² by k = |1 − a|², ν = n − log(d²/ε) / log k — falling off
// exponentially, so the quick heart of each basin glows and the slow fractal boundary sinks into
// shadow. Between any two basins lurks a speck of the third, forever.
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
  let k = (1.0 - are) * (1.0 - are) + aim * aim      // the linear contraction of d² per relaxed step
  let lin = k > 0.0001 ? 1.0 : 0.0
  let ilk = lin > 0.5 ? 1.0 / Math.log(k) : 0.0
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
      // smooth convergence count: how far the last step undershot ε, in quadratic-convergence steps
      let tone = root == 1 ? 0.36 : root == 2 ? 0.66 : root == 3 ? 1.0 : 0.0
      let rx = root == 1 ? 1.0 : -0.5, ry = root == 2 ? R3 : root == 3 ? -R3 : 0.0
      let d2 = (zx - rx) * (zx - rx) + (zy - ry) * (zy - ry) + 1e-300
      let le = Math.log(d2) + 13.815510557964274       // log(d²/ε); log ε = −13.8155
      let nu = lin > 0.5 ? it - le * ilk : it - Math.log(Math.log(d2) / -13.815510557964274) * 1.4426950408889634
      let b = Math.exp(-nu * 0.16)
      let gg = (Math.min(1.0, tone * b * 1.35) * 255.0) | 0
      px[j] = (255 << 24) | (gg << 16) | (gg << 8) | gg
      j++; qx++
    }
    py++
  }
}

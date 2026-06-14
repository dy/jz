// Julia set — escape-time fractal z ← z² + c, evaluated per pixel. Unlike Mandelbrot
// (where c is the pixel), here c is a single constant for the whole image, so as c moves
// the fractal morphs continuously. c is passed as f64 args (a setter global would be
// narrowed to i32 in jz, freezing the shape). Smooth-iteration grayscale. The tight
// per-pixel complex iteration is exactly the kind of float loop jz turns into clean wasm.
// resize(w,h) → Uint32Array; frame(t, cre, cim) renders.

let W = 0, H = 0, px, invW = 0, invH = 0, aspect = 1
let MAXIT = 160

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH
  px = new Uint32Array(w * h)
  return px
}

export let frame = (t, cre, cim) => {
  let scale = 1.5
  let j = 0, py = 0
  while (py < H) {
    let y0 = (py * invH - 0.5) * 2.0 * scale
    let qx = 0
    while (qx < W) {
      let x0 = (qx * invW - 0.5) * 2.0 * scale * aspect
      let zx = x0, zy = y0
      let it = 0
      let zx2 = zx * zx, zy2 = zy * zy
      while (it < MAXIT && zx2 + zy2 < 16.0) {
        zy = 2.0 * zx * zy + cim
        zx = zx2 - zy2 + cre
        zx2 = zx * zx; zy2 = zy * zy
        it++
      }
      let g = 0
      if (it < MAXIT) {
        // smooth iteration count → grayscale band
        let mu = it + 1.0 - Math.log(Math.log(zx2 + zy2) * 0.5) * 1.442695
        let s = mu / MAXIT
        if (s < 0.0) s = 0.0
        if (s > 1.0) s = 1.0
        // emphasize the filaments with a sqrt curve
        g = (Math.sqrt(s) * 255.0) | 0
      }
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g
      j++; qx++
    }
    py++
  }
}

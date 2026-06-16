// Burning Ship fractal — escape-time fractal with a distinctive ship silhouette.
// The twist on Mandelbrot: both Re and Im components are absolute-valued before
// squaring, which breaks the symmetry and creates the ship shape at the bottom.
//
// Iteration: z_{n+1} = (|Re z| + i|Im z|)² + c
// Written out: xt = x²−y²+cx;  y = 2·|x·y|+cy;  x = xt
//
// Smooth coloring via fractional iteration (log-log trick) avoids banding.
// Color: warm ember/fire palette — black→deep-red→orange→yellow→white.
// frame(t, cx, cy, halfH) — cx/cy/halfH passed as f64 args (avoids i32 narrowing).

let W = 0, H = 0, px, invW = 0, invH = 0, aspect = 1
let MAXIT = 200

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH
  px = new Uint32Array(w * h)
  return px
}

export let frame = (t, cx, cy, halfH) => {
  let j = 0, py = 0
  while (py < H) {
    let ry = (py * invH - 0.5) * 2.0 * halfH + cy
    let qx = 0
    while (qx < W) {
      let rx = (qx * invW - 0.5) * 2.0 * halfH * aspect + cx
      // burning ship iteration
      let x = 0.0, y = 0.0, it = 0
      while (it < MAXIT) {
        let xt = x * x - y * y + rx
        y = 2.0 * Math.abs(x * y) + ry
        x = xt
        if (x * x + y * y > 256.0) break
        it++
      }
      // smooth coloring + fire palette
      let r = 0, g = 0, b = 0
      if (it < MAXIT) {
        let sqd = x * x + y * y
        let frac = Math.log2(0.5 * Math.log(sqd))
        let smi = it + 1.0 - frac
        let v = smi / MAXIT
        if (v < 0.0) v = 0.0
        if (v > 1.0) v = 1.0
        // fire palette: black → red → orange → yellow → white
        r = (255.0 * Math.min(1.0, v * 4.0)) | 0
        g = (255.0 * Math.min(1.0, Math.max(0.0, v * 4.0 - 1.5))) | 0
        b = (255.0 * Math.min(1.0, Math.max(0.0, v * 4.0 - 3.0))) | 0
      }
      px[j] = (255 << 24) | (b << 16) | (g << 8) | r
      j++; qx++
    }
    py++
  }
}

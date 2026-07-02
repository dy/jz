// Burning Ship fractal — escape-time fractal with a distinctive ship silhouette.
// The twist on Mandelbrot: both Re and Im components are absolute-valued before
// squaring, which breaks the symmetry and creates the ship shape at the bottom.
//
// Iteration: z_{n+1} = (|Re z| + i|Im z|)² + c
// Written out: xt = x²−y²+cx;  y = 2·|x·y|+cy;  x = xt
//
// Smooth coloring via fractional iteration (log-log trick) avoids banding;
// rendered grayscale (√-eased), matching the gallery's ink-on-black language.
// frame(t, cx, cy, halfH, rot) — cx/cy/halfH/rot passed as f64 args (avoids i32 narrowing).
//
// `rot` gives the ship LIFE without a free parameter to morph (unlike Julia's c): each squaring
// w² is rotated by a tiny animated angle before adding c, so masts and reflection sway and the
// rigging breaks and re-forms continuously. At rot=0 it's the exact classic Burning Ship.

let W = 0, H = 0, px, invW = 0, invH = 0, aspect = 1
let MAXIT = 200

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH
  px = new Uint32Array(w * h)
  return px
}

export let frame = (t, cx, cy, halfH, rot) => {
  let ca = Math.cos(rot), sa = Math.sin(rot)   // twist applied to w² each iteration (once per frame)
  let j = 0, py = 0
  while (py < H) {
    let ry = (py * invH - 0.5) * 2.0 * halfH + cy
    let qx = 0
    while (qx < W) {
      let rx = (qx * invW - 0.5) * 2.0 * halfH * aspect + cx
      // burning ship iteration: w = |x|+i|y|, then z = rot·w² + c
      let x = 0.0, y = 0.0, it = 0
      while (it < MAXIT) {
        let wr = x * x - y * y            // Re(w²)
        let wi = 2.0 * Math.abs(x * y)    // Im(w²) = 2|x||y|
        x = wr * ca - wi * sa + rx        // rotate w² by `rot`, then + c
        y = wr * sa + wi * ca + ry
        if (x * x + y * y > 256.0) break
        it++
      }
      // smooth coloring → grayscale
      let gv = 0
      if (it < MAXIT) {
        let sqd = x * x + y * y
        let frac = Math.log2(0.5 * Math.log(sqd))
        let smi = it + 1.0 - frac
        let v = smi / MAXIT
        if (v < 0.0) v = 0.0
        if (v > 1.0) v = 1.0
        gv = (Math.sqrt(v) * 255.0) | 0
      }
      px[j] = (255 << 24) | (gv << 16) | (gv << 8) | gv
      j++; qx++
    }
    py++
  }
}

// Domain coloring — every pixel is a complex number z = x+iy; the function f(z) is evaluated
// and drawn as an enhanced phase portrait (Wegert, Visual Complex Functions, 2012): bands of
// log₂|f| (one per doubling) crossed with twelve sectors of arg f tile the plane in a conformal
// checkerboard — near-squares, because f is analytic — that shrink into every zero and pole. Each
// tile is shaded by a sawtooth of |f| (the landscape rising toward the poles). The analytic
// derivative gives |f′/f|, the gradient of log f, so every tile edge is anti-aliased at one pixel
// and tiles smaller than a pixel melt to grey right at the singularities.
// f(z) = (z²−1)·(z−c) / (z²+c2) where c,c2 are small complex constants that orbit slowly.
// frame(t, cx, cy, pan_x, pan_y) renders; cx/cy orbit the constant c so zeros/poles drift.

let W = 0, H = 0, px

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// scale = half-height of the viewport in world units (2.5 = the default whole-plane view); shrink
// it to zoom in. panX/panY recentre. All f64 args so they stay fractional through jz.
export let frame = (t, cx, cy, panX, panY, scale) => {
  // c2 is a fixed complex constant for the denominator pole pair
  let c2r = 1.0, c2i = 0.0

  let invW = 1.0 / W, invH = 1.0 / H
  let aspect = W * invH
  let pw = 2.0 * scale * invH           // one pixel, in world units

  let j = 0, py = 0
  while (py < H) {
    let zy = (py * invH - 0.5) * 2.0 * scale + panY
    let qx = 0
    while (qx < W) {
      let zx = (qx * invW - 0.5) * 2.0 * scale * aspect + panX

      // Evaluate f(z) = (z²−1)·(z−c) / (z²+c2)
      // Step 1: z² = (zx²−zy², 2·zx·zy)
      let zx2 = zx * zx - zy * zy
      let zy2 = 2.0 * zx * zy

      // Step 2: (z²−1) = (zx2−1, zy2)
      let n1r = zx2 - 1.0, n1i = zy2

      // Step 3: (z − c) = (zx−cx, zy−cy)
      let n2r = zx - cx, n2i = zy - cy

      // Step 4: numerator = (z²−1)·(z−c), complex multiply
      let numr = n1r * n2r - n1i * n2i
      let numi = n1r * n2i + n1i * n2r

      // Step 5: denominator = (z²+c2) = (zx2+c2r, zy2+c2i). +ε keeps the divide finite AT a pole
      // (denom→0), so the map is UNCONDITIONAL — it vectorizes through the f64x2 hypot/atan2 mirrors,
      // where the old `if (denom>ε){…}` guard forced scalar (a lane local reassigned in the masked
      // arm reads a stale shadow → all-black). Bonus: the pole now flares white (|f|→∞ ⇒ v→1)
      // instead of the guard leaving a black dot at the singularity.
      let dr = zx2 + c2r, di = zy2 + c2i
      let denom = dr * dr + di * di + 1e-300

      let fx = (numr * dr + numi * di) / denom
      let fy = (numi * dr - numr * di) / denom

      let mag = Math.hypot(fx, fy)
      let arg = Math.atan2(fy, fx)

      // f′ = (N′D − ND′)/D², N′ = 2z(z − c) + z² − 1, D′ = 2z  →  |f′/f| = |N′/N − D′/D|
      let npr = 2.0 * (zx * n2r - zy * n2i) + n1r, npi = 2.0 * (zx * n2i + zy * n2r) + n1i
      let nn = numr * numr + numi * numi + 1e-300
      let ar = (npr * numr + npi * numi) / nn, ai = (npi * numr - npr * numi) / nn
      let br = (2.0 * zx * dr + 2.0 * zy * di) / denom, bi = (2.0 * zy * dr - 2.0 * zx * di) / denom
      let lg = Math.hypot(ar - br, ai - bi)                     // |d log f / dz|, per world unit

      // the checkerboard: log₂|f| bands × 12 arg sectors; their gradients in bands per pixel
      let a1 = Math.log(mag + 1e-300) * 1.4426950408889634
      let a2 = arg * 1.909859317102744                           // 12 / 2π
      let fl1 = Math.floor(a1), fl2 = Math.floor(a2)
      let f1 = a1 - fl1, f2 = a2 - fl2
      let g1 = lg * 1.4426950408889634 * pw, g2 = lg * 1.909859317102744 * pw
      let par = fl1 + fl2 - 2.0 * Math.floor((fl1 + fl2) * 0.5)  // 0 or 1
      let tone = par < 0.5 ? 0.3 + 0.58 * f1 : 0.03 + 0.14 * f1
      // anti-alias every tile edge: distance to the nearest band boundary, in pixels
      let e1 = Math.min(f1, 1.0 - f1) / (g1 + 1e-12), e2 = Math.min(f2, 1.0 - f2) / (g2 + 1e-12)
      let cov = Math.min(1.0, Math.min(e1, e2) * 2.0)
      // tiles under ~2px melt to the mean grey at the zeros and poles
      let melt = Math.min(1.0, Math.max(0.0, (1.0 / (Math.max(g1, g2) + 1e-12) - 2.0) * 0.33))
      let gv = 0.36 + (tone - 0.36) * cov * melt
      let g = (gv * 255.0) | 0
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g
      j++; qx++
    }
    py++
  }
}

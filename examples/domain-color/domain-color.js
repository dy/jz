// Domain coloring — every pixel is a complex number z = x+iy; the function f(z) is evaluated
// and rendered as a grayscale analytic landscape: brightness from |f| (zeros sink black,
// poles flare white), phase lobes from arg f shading light/dark petals around each feature.
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

      // Grayscale analytic landscape: zeros=black, poles=white, phase contours visible
      let mag = Math.hypot(fx, fy)
      let arg = Math.atan2(fy, fx)

      // v: 0 at zeros (mag=0) → 1 at poles (mag→∞)
      let v = mag / (mag + 1.0)

      // Phase contour shading: light/dark lobes around each zero/pole
      let shade = 0.55 + 0.45 * Math.abs(Math.sin(2.0 * arg))

      let gv = v * shade
      if (gv < 0.0) gv = 0.0
      if (gv > 1.0) gv = 1.0
      let g = (gv * 255.0) | 0
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g
      j++; qx++
    }
    py++
  }
}

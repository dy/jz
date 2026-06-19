// Domain coloring — every pixel is a complex number z = x+iy; the function f(z) is evaluated
// and the result is colored by argument (hue) and magnitude (brightness+contour rings).
// f(z) = (z²−1)·(z−c) / (z²+c2) where c,c2 are small complex constants that orbit slowly.
// Zeros of the numerator make black spots; poles of the denominator blow up to white.
// Contour rings of |f| grid the field like a topographic map.
// frame(t, cx, cy, pan_x, pan_y) renders; cx/cy orbit the constant c so zeros/poles drift.

let W = 0, H = 0, px

// Store pan offset as Float64Array so fractional state survives jz narrowing
let st = new Float64Array(4)  // [panX, panY, unused, unused]

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

// HSV→RGB; h,s,v in [0,1], outputs r,g,b packed as three 0..255 ints in a Uint8Array
let hsv_buf = new Uint8Array(3)
let hsv2rgb = (h, s, v) => {
  let h6 = h * 6.0
  let i = h6 | 0
  let f = h6 - i
  let p = v * (1.0 - s)
  let q = v * (1.0 - s * f)
  let u = v * (1.0 - s * (1.0 - f))
  let r = 0.0, g = 0.0, b = 0.0
  if (i == 0) { r = v; g = u; b = p }
  else if (i == 1) { r = q; g = v; b = p }
  else if (i == 2) { r = p; g = v; b = u }
  else if (i == 3) { r = p; g = q; b = v }
  else if (i == 4) { r = u; g = p; b = v }
  else { r = v; g = p; b = q }
  hsv_buf[0] = (r * 255.0) | 0
  hsv_buf[1] = (g * 255.0) | 0
  hsv_buf[2] = (b * 255.0) | 0
}

let TWO_PI = 6.283185307179586

export let frame = (t, cx, cy, panX, panY) => {
  // c2 is a fixed complex constant for the denominator pole pair
  let c2r = 1.0, c2i = 0.0

  let scale = 2.5
  let invW = 1.0 / W, invH = 1.0 / H
  let aspect = W * invH

  let j = 0, py = 0
  while (py < H) {
    let zy = (0.5 - py * invH) * 2.0 * scale + panY
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

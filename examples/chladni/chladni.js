// Chladni plate — the nodal figure of a driven plate. A plate excited at an eigenmode stays still
// along its NODAL LINES; here they're the zero set of
//   F(x,y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),
// the COMBINATION of an x-axis standing wave (n half-waves ACROSS the plate) and a y-axis one (m
// half-waves DOWN). The host maps horizontal cursor travel to n and vertical to m, so dragging
// morphs the two standing waves and the nodal figure re-shapes with them.
//
// Rendered straight from the analytic field, no simulation: each pixel maps a DISTANCE-to-nodal-line
// estimate through a narrow Gaussian — bright (→1) right on the line, smoothly and monotonically → 0
// a couple of line-widths away. One continuous formula, no threshold, no particles, so the figure is
// exactly as smooth as F itself: crisp thin curves on black, never a scatter of dots.
//
// Distance, not raw |F|: near a GENERIC point of the nodal set |F| already grows ∝ distance (·|∇F|),
// so thresholding |F| alone would work — except F(y,x)=−F(x,y) here (swap antisymmetry), which forces
// the plate's centre point to lie on the nodal set for EVERY (n,m), and when n,m are BOTH odd forces
// the entire centre ROW+COLUMN onto it too — a much higher-order (degenerate) zero, where |∇F| itself
// also → 0. Thresholding bare |F| there reads a wide patch around the centre as "still on the line"
// (a blown-out blob/cross), not the crisp curve everywhere else. Dividing out the LOCAL gradient —
// F/|∇F|, one step of Newton's method toward the zero set — turns that back into a genuine per-pixel
// distance regardless of how degenerate the nearby zero is, so one uniform formula stays a constant
// line width everywhere, with no special-casing of particular (n,m).
//
// The distance is scaled to come out in SCREEN PIXELS directly (S = the short screen side in px
// converts the plate's [0,1]-normalized distance), so the rendered line width stays the same
// constant few pixels at any canvas resolution, with no per-resolution tuning.
//
// jz typing: n, m and every per-pixel local here are plain fractional f64 — there is no persistent
// state at all (the whole frame is a pure function of (n,m) and the geometry resize() computed), so
// there's nothing to seed, init, or randomize — resize()/frame() below are the whole kernel.
//
// Perf: the per-pixel loop is a straight-line body (row-hoisted cos/sin, per-pixel cos/sin, one
// store) — jz's per-pixel-color vectorizer (tryPerPixelColor) lifts it to f64x2 lanes: Math.cos/sin →
// the bit-exact $math.cos2/sin2 mirrors, Math.exp → the true-2-wide $math.exp_v poly, only the final
// round+pack running scalar per lane.
let W = 0, H = 0, px, SC = 0, cx = 0, cy = 0   // uniform plate scale + viewport centre
let SHARP = 1.1                                // ridge sharpness ≈ inverse target half-width, px
let EPS = 1e-5                                 // |∇F|² floor — guards the divide at a degenerate zero

export let resize = (w, h) => {
  // Map pixels to plate space with ONE uniform scale (no stretch): the unit plate [0,1]² fills the
  // shorter screen side and the longer side extends the periodic figure — so the canvas can be
  // full-screen at any aspect and the nodal lines stay perfectly square.
  W = w; H = h; SC = 1.0 / (w < h ? w : h); cx = w * 0.5; cy = h * 0.5
  px = new Uint32Array(w * h)
  return px
}

// n = half-waves across (x), m = half-waves down (y); the host drives them from cursor x/y.
export let frame = (n, m) => {
  let PI = Math.PI
  let nP = n * PI, mP = m * PI
  let S = W < H ? W : H                  // short screen side, px — converts plate-unit distance → px
  let K = SHARP * S

  let j = 0, py = 0
  while (py < H) {
    let y = (py - cy) * SC + 0.5
    // y-only terms — hoist once per row (both the field's and its y-partial's)
    let cny = Math.cos(nP * y), cmy = Math.cos(mP * y)
    let sny = Math.sin(nP * y), smy = Math.sin(mP * y)
    let qx = 0
    while (qx < W) {
      let x = (qx - cx) * SC + 0.5
      let cnx = Math.cos(nP * x), cmx = Math.cos(mP * x)
      let snx = Math.sin(nP * x), smx = Math.sin(mP * x)
      let f = cnx * cmy - cmx * cny
      let fx = mP * smx * cny - nP * snx * cmy   // ∂F/∂x
      let fy = nP * cmx * sny - mP * cnx * smy   // ∂F/∂y

      let fk = f * K
      let g2 = fx * fx + fy * fy + EPS           // |∇F|², floored (never an exact-zero divide)
      let dn = (fk * fk) / g2                    // squared pixel-distance to the nodal line
      // Gaussian ridge: 1 exactly ON the nodal line (dn=0), smooth and monotonic → 0 off it. No
      // clamp needed even far from any line (dn huge): $math.exp2's own range guard already maps
      // any exponent past -1075 to a clean 0.0 in both engines, same as V8's native Math.exp.
      let bright = Math.exp(-dn)
      // Math.round (not `|0` truncate): near the plate's own symmetry axes, n or m odd puts a whole
      // ROW/COLUMN exactly on a coincidental zero of cos(), where jz's polynomial $math.cos2 and
      // V8's native Math.cos agree only to ~1e-7 (not the ~1e-16 two independent correctly-rounded
      // implementations usually share). round() absorbs that hair either way, where a truncate
      // wouldn't.
      let g = Math.round(bright * 255.0) | 0
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g     // white nodal curves on black
      j++; qx++
    }
    py++
  }
}

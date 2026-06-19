// Chladni plate — the nodal figures of a vibrating square plate. A plate driven at an eigenmode is
// still along its NODAL LINES (where sand settles); here they're the zero set of
//   F(x,y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),
// drawn as crisp white curves on black ("black is space, white is sound"). n is the number of
// half-waves ACROSS the plate, m the number DOWN — so the figure is literally the COMBINATION of an
// x-axis standing wave and a y-axis one. The host maps horizontal cursor travel to n and vertical
// to m, so you dial the two axes independently and watch their interference lock into a figure.
// Per pixel: two cos (the y-terms hoist per row) and a divide-free ridge — jz's throughput sweet
// spot. Same source = the V8 baseline (imported) and the compiled wasm.
let W = 0, H = 0, px, SC = 0, cx = 0, cy = 0   // uniform plate scale + viewport centre
let SHARP = 14.0                               // nodal-line sharpness (≈ inverse half-width)

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
  let K = SHARP

  let j = 0, py = 0
  while (py < H) {
    let y = (py - cy) * SC + 0.5
    let cyn = Math.cos(nP * y)     // y-only terms — hoist once per row
    let cym = Math.cos(mP * y)
    let qx = 0
    while (qx < W) {
      let x = (qx - cx) * SC + 0.5
      let f = Math.cos(nP * x) * cym - Math.cos(mP * x) * cyn
      // Divide-free ridge: a sharp white core on the nodal line (f≈0) plus a wider, softer glow →
      // the thick-white-on-black look. No per-pixel divides.
      let fk = f * K
      let q = 1.0 - fk * fk
      let core = q > 0.0 ? (q * q * 255.0) | 0 : 0
      let fkg = f * (K * 0.25)
      let qg = 1.0 - fkg * fkg
      let glow = qg > 0.0 ? (qg * 180.0) | 0 : 0
      let g = core + ((glow * 90) >> 8)
      if (g > 255) g = 255
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g     // white on black
      j++; qx++
    }
    py++
  }
}

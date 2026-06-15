// Chladni plate — the Camerata Lausanne generator (after Demian Conrad). A musical
// frequency selects a square-plate eigenmode (n,m); the nodal lines — where the plate
// is still and sand settles — are the zero set of
//   F(x,y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),
// drawn as crisp white curves on black ("black is space, white is sound"). Modes are
// ordered by eigenfrequency √(n²+m²), so a rising frequency sweeps from the bold X+arcs
// of (2,1) up to dense lattices. Per pixel: two cos (the y-terms hoist per row) and a
// divide-free ridge for the line — jz's throughput sweet spot. Same source = the V8
// baseline (imported) and the compiled wasm.
let W = 0, H = 0, px, SC = 0, cx = 0, cy = 0   // uniform plate scale + viewport centre
let nArr, mArr, NMODES = 0      // (n,m) mode pairs, ascending eigenfrequency √(n²+m²)
let SHARP = 15.0                // nodal-line sharpness, pointer-controlled

export let resize = (w, h) => {
  // Map pixels to plate space with ONE uniform scale (no stretch): the unit plate [0,1]²
  // fills the shorter screen side and the longer side extends the periodic figure — so the
  // canvas can be full-screen at any aspect and the nodal lines stay perfectly square.
  W = w; H = h; SC = 1.0 / (w < h ? w : h); cx = w * 0.5; cy = h * 0.5
  px = new Uint32Array(w * h)
  // Enumerate distinct pairs 1 ≤ n < m ≤ 12 and insertion-sort by n²+m² (∝ eigenfreq),
  // so frequency sweeps simple→complex figures. Integer modes ride Int32Arrays (a scalar
  // f64 global fed these would be i32-narrowed anyway — here they ARE integers).
  let K = 12, cap = (K * (K - 1)) >> 1
  nArr = new Int32Array(cap); mArr = new Int32Array(cap)
  let keys = new Int32Array(cap)
  let cnt = 0
  let n = 1
  while (n <= K) {
    let m = n + 1
    while (m <= K) {
      let key = n * n + m * m
      let i = cnt
      while (i > 0 && keys[i - 1] > key) { keys[i] = keys[i - 1]; nArr[i] = nArr[i - 1]; mArr[i] = mArr[i - 1]; i = i - 1 }
      keys[i] = key; nArr[i] = n; mArr[i] = m; cnt = cnt + 1
      m = m + 1
    }
    n = n + 1
  }
  NMODES = cnt
  return px
}

// `freq` (Hz-ish, ~40..20000) selects the mode: higher frequency → higher eigenmode →
// richer nodal figure. (Adjustable/audio-driven later; here the demo sweeps it.)
export let setSharpness = (k) => { SHARP = k }

export let frame = (freq) => {
  let PI = Math.PI
  let t01 = (freq - 40.0) / 19960.0
  if (t01 < 0.0) t01 = 0.0
  if (t01 > 1.0) t01 = 1.0
  let idx = (t01 * (NMODES - 1) + 0.5) | 0
  let n = nArr[idx], m = mArr[idx]
  let nP = n * PI, mP = m * PI
  let K = SHARP                   // nodal-line sharpness (≈ inverse half-width in f-units)

  let j = 0, py = 0
  while (py < H) {
    let y = (py - cy) * SC + 0.5
    let cyn = Math.cos(nP * y)     // y-only terms — hoist once per row
    let cym = Math.cos(mP * y)
    let qx = 0
    while (qx < W) {
      let x = (qx - cx) * SC + 0.5
      let f = Math.cos(nP * x) * cym - Math.cos(mP * x) * cyn
      // Divide-free ridge: a sharp white core on the nodal line (f≈0) plus a wider,
      // softer glow → the Camerata thick-white-on-black look. No per-pixel divides.
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

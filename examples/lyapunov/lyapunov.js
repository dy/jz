// Markus–Lyapunov fractal ("Zircon Zity"). Every pixel (a,b) runs the logistic map
// x_{n+1} = r·x·(1−x) where r alternates between a and b per a forcing sequence.
// The Lyapunov exponent λ = (1/N)·Σ log|r·(1−2x)| measures chaos: λ<0 means order
// (stable cycle, warm gold palette), λ≥0 means chaos (near-black with cool tint).
// The boundary between them is the fractal. ox,oy pan offsets are frame args (f64)
// so they never get narrowed to i32. resize→Uint32Array; frame(t,ox,oy) renders.

let W = 0, H = 0, px, invW = 0, invH = 0
let SEQLEN = 5
// Forcing sequence AABAB: 0=A, 1=B
// Stored in Int32Array to avoid float narrowing issues
let seq

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h
  px = new Uint32Array(w * h)
  seq = new Int32Array(5)
  seq[0] = 0; seq[1] = 0; seq[2] = 1; seq[3] = 0; seq[4] = 1  // AABAB
  return px
}

export let frame = (t, ox, oy) => {
  let j = 0, py = 0
  while (py < H) {
    // b maps y: screen y ∈ [2.5+oy, 4.0+oy]
    let b = 2.5 + oy + (py * invH) * 1.5
    let qx = 0
    while (qx < W) {
      // a maps x: screen x ∈ [2.5+ox, 4.0+ox]
      let a = 2.5 + ox + (qx * invW) * 1.5

      // logistic map — si continues across warmup into accumulation
      let x = 0.5
      let si = 0, wi = 0
      // warmup 80 iters (no accumulation, let x settle)
      while (wi < 80) {
        let r = (seq[si] < 1) ? a : b
        x = r * x * (1.0 - x)
        si = si + 1
        if (si >= SEQLEN) si = 0
        wi++
      }
      // accumulate 160 iters for Lyapunov exponent
      let L = 0.0
      let ai = 0
      while (ai < 160) {
        let r = (seq[si] < 1) ? a : b
        x = r * x * (1.0 - x)
        let deriv = Math.abs(r * (1.0 - 2.0 * x))
        if (deriv > 0.0) L = L + Math.log(deriv)
        si = si + 1
        if (si >= SEQLEN) si = 0
        ai++
      }
      let lam = L / 160.0

      let rv = 0, gv = 0, bv = 0
      if (lam < 0.0) {
        // order: bright gold/green palette
        let tv = Math.min(1.0, -lam / 1.5)
        rv = (200.0 + 55.0 * Math.sqrt(tv)) | 0   // warm yellow-white
        gv = (160.0 * tv * tv + 80.0 * Math.sqrt(tv)) | 0  // gold-green midtones
        bv = (30.0 * tv * tv) | 0                 // minimal blue, warm
      } else {
        // chaos: near-black with faint cool tint
        let v = Math.min(1.0, lam / 2.0)
        rv = 0
        gv = (20.0 * Math.max(0.0, 1.0 - v)) | 0
        bv = (40.0 * Math.max(0.0, 1.0 - v)) | 0
      }
      px[j] = (255 << 24) | (bv << 16) | (gv << 8) | rv
      j++; qx++
    }
    py++
  }
}

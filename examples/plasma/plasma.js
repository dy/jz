// Plasma — FBM domain-warp genart. Per pixel: three layers of sine-based fBm
// (octaves 1..5, freq doubling, amp halving) domain-warped into each other.
// q = fbm(x,y,t), r = fbm(x+q, y+q, t*0.6), v = fbm(x+r, y, t*0.3).
// v ∈ [-1,1] is mapped to a teal↔magenta palette via integer channel ramps —
// no per-pixel divides, pure trig + multiply → jz's fast sin/cos pipeline wins.
let W = 0, H = 0, px, invW = 0, invH = 0
let pal                                  // 4 RGB colour-ramp stops (12 ints) the value sweeps through

// Watercolor "ink": a ring buffer of soft blooms the finger deposits while dragging.
// Each frame they fade; per pixel they lift the field value, so the drag leaves a
// glowing, spreading trail that settles like wet paint. Guarded by `smearOn` so an
// idle plasma pays nothing.
let PK = 24
let pkx = new Float64Array(PK), pky = new Float64Array(PK), pka = new Float64Array(PK)
let pkHead = 0, smearOn = 0

// exponential luminance curve, precomputed (256 entries) so the hot loop does a lookup,
// not a per-pixel exp: deep darks, glowing highlights.
let expLut

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h
  px = new Uint32Array(w * h)
  expLut = new Int32Array(256)
  let G = 2.4, den = 1.0 / (Math.exp(G) - 1.0), i = 0
  while (i < 256) { expLut[i] = ((Math.exp(G * i / 255.0) - 1.0) * den * 255.0) | 0; i++ }
  pal = new Int32Array(12)
  // default: grayscale black → white until setPalette overrides
  pal[0] = 0;   pal[1] = 0;   pal[2] = 0
  pal[3] = 85;  pal[4] = 85;  pal[5] = 85
  pal[6] = 170; pal[7] = 170; pal[8] = 170
  pal[9] = 255; pal[10] = 255; pal[11] = 255
  return px
}

// Swap the colour ramp live: 4 RGB stops (12 ints) the value sweeps through, low→high.
// A black→…→white colormap (magma / inferno / single-hue …) the host builds. Channels are
// integers, so the Int32Array store is exact (no i32-narrowing loss — they ARE integers).
export let setPalette = (a, b, c, d, e, f, g, h, i, j, k, l) => {
  pal[0] = a;  pal[1] = b;  pal[2] = c
  pal[3] = d;  pal[4] = e;  pal[5] = f
  pal[6] = g;  pal[7] = h;  pal[8] = i
  pal[9] = j;  pal[10] = k; pal[11] = l
}

// Drop a watercolor bloom at normalized (x,y) — called along the drag path.
export let poke = (x, y) => {
  pkx[pkHead] = x; pky[pkHead] = y; pka[pkHead] = 1.0
  pkHead = pkHead + 1
  if (pkHead >= PK) pkHead = 0
}

// sine-based fbm: 5 octaves, freq doubling (2,4,8,16,32), amp halving (0.5,0.25,...)
// ph is the phase-time argument; py-only terms are hoisted by the caller.
// Returns a value roughly in [-1, 1].
let fbm = (px_, py_, ph, a1y, a2y, a3y, a4y, a5y) => {
  let s1 = Math.sin(2.0  * px_ + ph)
  let s2 = Math.sin(4.0  * px_ + ph)
  let s3 = Math.sin(8.0  * px_ + ph)
  let s4 = Math.sin(16.0 * px_ + ph)
  let s5 = Math.sin(32.0 * px_ + ph)
  return 0.5    * s1 * a1y
       + 0.25   * s2 * a2y
       + 0.125  * s3 * a3y
       + 0.0625 * s4 * a4y
       + 0.03125* s5 * a5y
}

export let frame = (t) => {
  // fade the ink blooms; note whether any are still alive (skip the per-pixel ink loop if not)
  let any = 0, k = 0
  while (k < PK) { pka[k] = pka[k] * 0.955; if (pka[k] > 0.02) any = 1; k++ }
  smearOn = any

  let j = 0, py = 0
  let t6 = t * 0.6, t3 = t * 0.3, t7 = t * 0.7
  while (py < H) {
    let y = py * invH
    // hoist all y-only fbm terms (independent of x) once per row
    // layer q: ph = t
    let q_a1y = Math.sin(2.0  * y + t)
    let q_a2y = Math.sin(4.0  * y + t)
    let q_a3y = Math.sin(8.0  * y + t)
    let q_a4y = Math.sin(16.0 * y + t)
    let q_a5y = Math.sin(32.0 * y + t)
    // layer r: ph = t6, y axis uses y+q — but q varies per pixel, so only the
    // pure-y part (without q) can be hoisted. We split: r_ay = sin(freq*(y)) and
    // absorb the q-shift inside the x loop via sin(a+b) = sinacosb+cosasinb to
    // avoid computing two full fbm calls. For simplicity keep it straightforward —
    // the compiler still vectorises across pixels in x.
    let r_a1y = Math.sin(2.0  * y + t6)
    let r_a2y = Math.sin(4.0  * y + t6)
    let r_a3y = Math.sin(8.0  * y + t6)
    let r_a4y = Math.sin(16.0 * y + t6)
    let r_a5y = Math.sin(32.0 * y + t6)
    // layer v: ph = t3, y unchanged (no y-warp in v)
    let v_a1y = Math.sin(2.0  * y + t3)
    let v_a2y = Math.sin(4.0  * y + t3)
    let v_a3y = Math.sin(8.0  * y + t3)
    let v_a4y = Math.sin(16.0 * y + t3)
    let v_a5y = Math.sin(32.0 * y + t3)

    let qx = 0
    while (qx < W) {
      let x = qx * invW

      // q = fbm(x, y, t)
      let q = fbm(x, y, t, q_a1y, q_a2y, q_a3y, q_a4y, q_a5y)

      // r = fbm(x+q, y+q, t*0.6)  — y+q shifts the y argument; inline with shifted y hoists
      let xq = x + q, yq = y + q
      let r_b1y = Math.sin(2.0  * yq + t6)
      let r_b2y = Math.sin(4.0  * yq + t6)
      let r_b3y = Math.sin(8.0  * yq + t6)
      let r_b4y = Math.sin(16.0 * yq + t6)
      let r_b5y = Math.sin(32.0 * yq + t6)
      let r = fbm(xq, yq, t6, r_b1y, r_b2y, r_b3y, r_b4y, r_b5y)

      // v = fbm(x+r, y, t*0.3)
      let v = fbm(x + r, y, t3, v_a1y, v_a2y, v_a3y, v_a4y, v_a5y)

      // map v ∈ [-1,1] → u ∈ [0,1]
      let u = v * 0.5 + 0.5

      // watercolor ink: lift u where the finger dragged (cheap radial falloff, skipped when idle)
      if (smearOn) {
        let ink = 0.0, kk = 0
        while (kk < PK) {
          let a = pka[kk]
          if (a > 0.02) {
            let ddx = x - pkx[kk], ddy = y - pky[kk]
            ink += a * 0.0009 / (0.0009 + ddx * ddx + ddy * ddy)
          }
          kk++
        }
        if (ink > 0.7) ink = 0.7        // cap so an overlapping trail blooms, never blows out
        u += ink
      }
      // exponential luminance via lookup (clamped index) → punchy darks, glowing highlights
      let idx = (u * 255.0) | 0
      if (idx < 0) idx = 0
      if (idx > 255) idx = 255
      let c = expLut[idx]

      // map c ∈ [0,255] through the 4-stop ramp (3 segments) → RGB
      let p = c * (3.0 / 255.0)               // 0..3
      let seg = p | 0; if (seg > 2) seg = 2
      let fr = p - seg
      let i0 = seg * 3, i1 = i0 + 3
      let cr = (pal[i0]     + (pal[i1]     - pal[i0])     * fr) | 0
      let cg = (pal[i0 + 1] + (pal[i1 + 1] - pal[i0 + 1]) * fr) | 0
      let cb = (pal[i0 + 2] + (pal[i1 + 2] - pal[i0 + 2]) * fr) | 0
      px[j] = (0xff000000) | (cb << 16) | (cg << 8) | cr     // canvas is little-endian RGBA
      j++; qx++
    }
    py++
  }
}

// Plasma — FBM domain-warp genart. Per pixel: three layers of sine-based fBm
// (octaves 1..5, freq doubling, amp halving) domain-warped into each other.
// q = fbm(x,y,t), r = fbm(x+q, y+q, t*0.6), v = fbm(x+r, y, t*0.3).
// v ∈ [-1,1] is mapped to a teal↔magenta palette via integer channel ramps —
// no per-pixel divides, pure trig + multiply → jz's fast sin/cos pipeline wins.
let W = 0, H = 0, px, invW = 0, invH = 0

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h
  px = new Uint32Array(w * h); return px
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

      // map v ∈ [-1, 1] → 0..255 — no divide, just multiply + clamp
      // norm ∈ [0, 255]
      let norm = (v * 127.5 + 127.5) | 0
      if (norm < 0) norm = 0
      if (norm > 255) norm = 255

      // teal(0)↔white(128)↔magenta(255) palette, shift-based (no divides):
      //   r: low=0, mid=255, high=255  → ramp up then stay
      //   g: low=200, mid=255, high=80 → bright mid
      //   b: low=200, mid=255, high=200 → stays teal/blue
      // Implemented as two linear segments joined at norm==128:
      let r_, g_, b_
      if (norm < 128) {
        let h_ = norm          // 0..127
        // teal→white: r 0→255, g 200→255, b 200→255
        r_ = (h_ * 2) | 0                        // 0..254
        g_ = 200 + ((h_ * 55) >> 7) | 0          // 200..255  (55/128 ≈ 0.43)
        b_ = 200 + ((h_ * 55) >> 7) | 0
      } else {
        let h_ = norm - 128    // 0..127
        // white→magenta: r stays ~255, g 255→40, b 255→200
        r_ = 255
        g_ = 255 - ((h_ * 215) >> 7) | 0         // 255..40
        b_ = 255 - ((h_ * 55) >> 7) | 0          // 255..200
      }
      if (r_ > 255) r_ = 255
      if (g_ < 0) g_ = 0
      if (b_ < 0) b_ = 0

      px[j] = (255 << 24) | (b_ << 16) | (g_ << 8) | r_
      j++; qx++
    }
    py++
  }
}

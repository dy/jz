// Cymatics — a Chladni standing-wave plate, the way sand dances on a vibrating
// *disc*: concentric radial waves crossed with angular modes, lighting up the
// nodal lines where the surface is still. In polar (r,θ) from the centre:
//   u(r,θ) = Σ sin(kᵢ·π·r ± t)·cos(mᵢ·θ ± t),  brightness peaks where u≈0.
// kᵢ set the ring frequencies, mᵢ the number of spokes — the demo drives both
// (and amplitude) from a live floatbeat's spectrum, so the plate blooms with the
// music. Each pixel is independent and trig-heavy (sqrt + atan2 + a handful of
// sin/cos, no per-pixel divides) — jz's throughput sweet spot. Same source = V8
// baseline (imported) and compiled wasm.
let W = 0, H = 0, px, invW = 0, invH = 0

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h
  px = new Uint32Array(w * h); return px
}

export let frame = (m1, m2, m3, m4, amp, t) => {
  let PI = Math.PI
  let j = 0, py = 0
  while (py < H) {
    let dy = py * invH - 0.5             // [-0.5, 0.5] — fills the canvas (anamorphic on wide screens)
    let qx = 0
    while (qx < W) {
      let dx = qx * invW - 0.5
      let rd = Math.sqrt(dx * dx + dy * dy) * 2.6   // 0 at centre, ~1 mid-edge
      let th = Math.atan2(dy, dx)
      // concentric rings (radial) modulated by angular spokes (Bessel-ish disc modes)
      let u = Math.sin(m1 * PI * rd - t) * Math.cos(m2 * th)
            + Math.sin(m3 * PI * rd + t) * Math.cos(m4 * th)
            + 0.5 * Math.sin((m1 + m3) * PI * rd) * Math.cos((m2 + m4) * th + t)
      u = u * amp
      // divide-free ridge: a smooth bump peaking on the nodal lines (u≈0). A divide
      // here stalls the per-pixel chain and kills cross-pixel ILP, so keep it to muls.
      let q = 1.0 - u * u * 18.0
      let g = q > 0.0 ? (q * q * 255.0) | 0 : 0
      let r = (g * g) >> 8                            // ≈ g²/255 (warm core), shift not divide
      let bl = (g * 230) >> 8                         // ≈ g·0.9 (teal)
      px[j] = (255 << 24) | (bl << 16) | (g << 8) | r
      j++; qx++
    }
    py++
  }
}

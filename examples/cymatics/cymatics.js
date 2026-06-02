// Cymatics — a Chladni standing-wave plate. Per pixel, sum a few audio-driven sine
// modes and light up the nodal lines, where the sum crosses zero and the "sand"
// settles:  u(x,y) = Σ sin(nπx±φ)·sin(mπy∓φ) ,  brightness = 1/(1+(u·k)²).
// Each pixel is independent and trig-heavy (the y-modes hoist per row, and there are
// no per-pixel divides) — the same throughput shape as interference, which jz runs
// ~1.9× faster than V8. Same source = V8 baseline (imported) and compiled wasm. The
// demo drives the mode numbers m1..m4 and amplitude from a live floatbeat's spectrum,
// so the plate dances to the music.
let W = 0, H = 0, px, invW = 0, invH = 0

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h
  px = new Uint32Array(w * h); return px
}

export let frame = (m1, m2, m3, m4, amp, t) => {
  let PI = Math.PI
  let j = 0, py = 0
  while (py < H) {
    let y = py * invH
    // y-only modes: independent of x, evaluate once per row
    let a1 = Math.sin(m2 * PI * y)
    let a2 = Math.sin(m4 * PI * y - t)
    let a3 = Math.sin((m2 + m4) * PI * y)
    let qx = 0
    while (qx < W) {
      let x = qx * invW
      let u = Math.sin(m1 * PI * x + t) * a1
            + Math.sin(m3 * PI * x) * a2
            + 0.5 * Math.sin((m1 + m3) * PI * x) * a3
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

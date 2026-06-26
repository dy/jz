// Bifurcation diagram — logistic map x_{n+1} = r·x·(1−x) orbit diagram.
// Each pixel column is a growth rate r ∈ [r0,r1]. For each r: warm up 400
// steps, then plot 600 steps and accumulate density[row*W+col]++.
//
// COLOR: density log-tonemapped to an amber gradient — the canonical look of
// bifurcation poster art. Black background → dim red-ember at sparse orbits →
// rich amber at medium density → bright gold-white at dense period attractors.
// Period-1 fixed points glow brightest; chaos fills with dim warm ember wash.
//
// RICHNESS LEVERS:
//   • 400 warmup + 600 plot → fine structure, faint Feigenbaum windows visible
//   • Amber colormap: scientifically faithful, aesthetically canonical
//   • panZoom in host: scroll to zoom into any fork, see self-similar cascade
//   • Idle LFO in host: auto-tours landmark regimes (period-3 window, etc.)
//   • dpr:2 in host for crisp retina rendering
//
// Float64Array for fractional state — scalar f64 globals are i32-narrowed in jz.

let W = 0, H = 0, dens, px
let st = new Float64Array(2) // [r0, r1] — fallback bounds

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)
  px   = new Uint32Array(w * h)
  st[0] = 2.5; st[1] = 4.0
  return px
}

// frame(t, r0, r1, x0, x1)
//   r0..r1 = horizontal growth-rate window; x0..x1 = vertical orbit-value window.
//   Both shrink on pan/zoom to dive into the self-similar Feigenbaum cascade.
export let frame = (t, r0, r1, x0, x1) => {
  let invXspan = 1.0 / (x1 - x0)
  let n = W * H, i = 0
  while (i < n) { dens[i] = 0; i++ }

  let WARMUP = 400, PLOT = 600

  let col = 0
  while (col < W) {
    let r = r0 + (col / W) * (r1 - r0)
    let x = 0.5
    // warmup: let transients die
    let k = 0
    while (k < WARMUP) { x = r * x * (1.0 - x); k++ }
    // plot: accumulate orbit density
    k = 0
    while (k < PLOT) {
      x = r * x * (1.0 - x)
      let row = ((x1 - x) * invXspan * H) | 0
      if (row >= 0 && row < H) {
        let idx = row * W + col
        dens[idx] = dens[idx] + 1
      }
      k++
    }
    col++
  }

  // Log-tonemap density → amber gradient.
  // dn = log(d+1)/log(PLOT+1) ∈ [0,1]
  // Three-stop gradient: black → dim red-ember → rich amber → bright gold-white.
  // Dense period-1 attractors glow peak gold; chaos fills with a warm ember wash.
  let logMax = Math.log(PLOT + 1.0)
  i = 0
  while (i < n) {
    let d = dens[i]
    if (d === 0) {
      px[i] = (255 << 24)  // pure black
    } else {
      let dn = Math.log(d + 1.0) / logMax  // 0..1
      let r = 0, g = 0, b = 0
      if (dn < 0.35) {
        // black → deep amber-red ember
        let tt = dn / 0.35
        r = (tt * 200.0) | 0
        g = (tt * 65.0)  | 0
        b = 0
      } else if (dn < 0.72) {
        // amber-red → rich amber-gold
        let tt = (dn - 0.35) / 0.37
        r = (200.0 + tt * 55.0)  | 0
        g = (65.0  + tt * 130.0) | 0
        b = (tt * 18.0)          | 0
      } else {
        // amber-gold → bright gold-white
        let tt = (dn - 0.72) / 0.28
        r = 255
        g = (195.0 + tt * 60.0)  | 0
        b = (18.0  + tt * 210.0) | 0
      }
      px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    }
    i++
  }
}

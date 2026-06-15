// Swappable visualizers — each is a self-contained renderer fed by ONE shared
// AnalyserNode, so adding a new one (Chladni, Lissajous, …) never touches the host.
//
//   create(canvas) → {
//     id, name,
//     resize(W, H, dpr),          // device-pixel canvas size changed
//     frame(g, env)               // draw one frame; g = 2d context
//   }
//
// env = { time: Float32Array, freq: Uint8Array, sr, W, H, dpr, accent, playing }
//   time — getFloatTimeDomainData (−1..1)
//   freq — getByteFrequencyData   (0..255, sr/2 across the bins)
//
// The host owns the analyser, the transport and the engine swap; a visualizer only
// ever reads `env` and paints. Keep them pure of audio/DOM concerns.

const BG = '#08080c'
const clear = (g, W, H) => { g.fillStyle = BG; g.fillRect(0, 0, W, H) }

// Perceptual frequency weighting — the ear hears pitch logarithmically, so every
// spectral renderer maps bin index → a log position. `binToX(i, n)` ∈ [0,1].
const FMIN = 30, fLog = (hz) => Math.log2(Math.max(hz, FMIN))
const logAxis = (n, sr) => {                       // precompute log positions of the n bins
  const nyq = sr / 2, lo = fLog(FMIN), hi = fLog(nyq), span = hi - lo
  const pos = new Float32Array(n)
  for (let i = 0; i < n; i++) pos[i] = (fLog(i / n * nyq) - lo) / span
  return pos
}

// ── inferno-ish intensity ramp for the spectrogram (luminance rises monotonically,
//    so the field still reads as a value; one warm hue journey, no rainbow noise) ──
const RAMP = (() => {
  const stops = [8, 8, 14, 40, 18, 70, 130, 40, 70, 224, 110, 40, 250, 200, 90, 255, 255, 225]
  const n = stops.length / 3, lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (n - 1), a = Math.floor(x), b = Math.min(n - 1, a + 1), f = x - a
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[a * 3 + c] + (stops[b * 3 + c] - stops[a * 3 + c]) * f
  }
  return lut
})()

// ── Waveform — a clean oscilloscope. Min/max envelope per column keeps fast
//    transients visible at any width; a hairline baseline, nothing else. ──
const waveform = () => ({
  id: 'wave', name: 'Waveform',
  resize() {},
  frame(g, { time, W, H, dpr, accent, playing }) {
    clear(g, W, H)
    const mid = H / 2, amp = H * 0.42, n = time.length, step = n / W
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = dpr
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke()
    g.strokeStyle = playing ? accent : 'rgba(255,255,255,.5)'
    g.lineWidth = Math.max(1.25, dpr * 1.1); g.lineJoin = 'round'
    g.beginPath()
    for (let x = 0; x < W; x++) {
      let lo = 1, hi = -1
      const s0 = x * step | 0, s1 = Math.min(n, (x + 1) * step + 1 | 0)
      for (let i = s0; i < s1; i++) { const v = time[i]; if (v < lo) lo = v; if (v > hi) hi = v }
      g.moveTo(x + .5, mid - hi * amp); g.lineTo(x + .5, mid - lo * amp + .5)
    }
    g.stroke()
  },
})

// ── Spectrum — log-frequency bars with falling peak-hold caps. The caps make
//    rhythm legible: each transient leaves a ghost that drifts down. ──
const spectrum = () => {
  let peaks = null, axis = null, sr0 = 0
  return {
    id: 'spectrum', name: 'Spectrum',
    resize() {},
    frame(g, { freq, sr, W, H, dpr, accent, playing }) {
      clear(g, W, H)
      const n = freq.length
      if (axis === null || sr0 !== sr) { axis = logAxis(n, sr); sr0 = sr }
      const pad = H * 0.06, floor = H - pad, ceil = pad
      if (!peaks) peaks = new Float32Array(W)
      // accumulate each bin into its log-x column (max), so low bins don't crowd the left
      const col = new Float32Array(W)
      for (let i = 1; i < n; i++) {
        const x = axis[i] * (W - 1) | 0, v = freq[i] / 255
        if (v > col[x]) col[x] = v
      }
      // fill gaps left by sparse low-bin mapping
      let lastv = 0
      for (let x = 0; x < W; x++) { if (col[x] > 0) lastv = col[x]; else col[x] = lastv * 0.96 }
      g.fillStyle = playing ? accent : 'rgba(255,255,255,.42)'
      const bw = Math.max(1, dpr)
      for (let x = 0; x < W; x += 2) {
        const v = col[x], h = v * (floor - ceil)
        g.fillRect(x, floor - h, bw, h)
        peaks[x] = Math.max(peaks[x] * 0.94 - 0.5, h)
      }
      g.fillStyle = 'rgba(255,255,255,.85)'
      for (let x = 0; x < W; x += 2) g.fillRect(x, floor - peaks[x] - dpr, bw, dpr)
    },
  }
}

// ── Spectrogram — time scrolls left, frequency on a log axis, intensity through a
//    warm ramp. Its own offscreen history canvas survives across frames; on resize
//    we rebuild it. The hero renderer: the song's structure becomes visible. ──
const spectrogram = () => {
  let buf = null, bctx = null, bw = 0, bh = 0, axis = null, sr0 = 0, col = null, img = null
  const build = (W, H) => {
    buf = document.createElement('canvas'); buf.width = bw = W; buf.height = bh = H
    bctx = buf.getContext('2d'); bctx.fillStyle = BG; bctx.fillRect(0, 0, W, H)
    col = bctx.createImageData(1, H); img = col.data
  }
  return {
    id: 'gram', name: 'Spectrogram',
    resize(W, H) { build(W, H) },
    frame(g, { freq, sr, W, H }) {
      if (!buf || bw !== W || bh !== H) build(W, H)
      const n = freq.length
      if (axis === null || sr0 !== sr) { axis = logAxis(n, sr); sr0 = sr }
      // shift history one column left, render the new column at the right edge
      bctx.drawImage(buf, -1, 0)
      // paint column: for each pixel row (y → freq via inverse log axis) pick the bin
      for (let y = 0; y < H; y++) {
        const t = 1 - y / H                                   // 0 bottom … 1 top
        // binary-search-free: bins are monotone in axis, scan is fine at H≈few hundred
        let v = 0, lo = 0, hi = n - 1
        while (lo < hi) { const m = (lo + hi) >> 1; if (axis[m] < t) lo = m + 1; else hi = m }
        v = freq[lo] | 0
        const p = v * 3
        img[y * 4] = RAMP[p]; img[y * 4 + 1] = RAMP[p + 1]; img[y * 4 + 2] = RAMP[p + 2]; img[y * 4 + 3] = 255
      }
      bctx.putImageData(col, W - 1, 0)
      g.drawImage(buf, 0, 0)
    },
  }
}

// ── Lissajous — phase portrait: sample(i) vs sample(i+lag). A pure sine draws an
//    ellipse, harmonics fold it into knots. Quiet, hypnotic, almost no ink. ──
const lissajous = () => ({
  id: 'phase', name: 'Phase',
  resize() {},
  frame(g, { time, W, H, dpr, accent, playing }) {
    clear(g, W, H)
    const n = time.length, lag = 32, cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.44
    g.strokeStyle = playing ? accent : 'rgba(255,255,255,.5)'
    g.lineWidth = Math.max(1, dpr); g.lineJoin = 'round'; g.globalAlpha = 0.85
    g.beginPath()
    for (let i = 0; i < n - lag; i++) {
      const x = cx + time[i] * r, y = cy - time[i + lag] * r
      if (i) g.lineTo(x, y); else g.moveTo(x, y)
    }
    g.stroke(); g.globalAlpha = 1
  },
})

export const makeVisualizers = () => [waveform(), spectrum(), spectrogram(), lissajous()]

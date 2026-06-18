// Swappable visualizers — each is a self-contained renderer fed by ONE shared
// AnalyserNode, so adding a new one (Chladni, Lissajous, …) never touches the host.
//
//   create() → {
//     id, name,
//     opts?: [{ key, values:[...], cur }],   // live sub-controls (e.g. log/mel)
//     set?(key, value),                        // apply an opt change
//     resize(W, H, dpr),                       // device-pixel canvas size changed
//     frame(g, env)                            // draw one frame; g = 2d context
//   }
//
// env = { time: Float32Array, freq: Uint8Array, sr, W, H, dpr, accent, playing }
//   time — getFloatTimeDomainData (−1..1)
//   freq — getByteFrequencyData   (0..255, sr/2 across the bins)

const BG = '#08080c'
const clear = (g, W, H) => { g.fillStyle = BG; g.fillRect(0, 0, W, H) }

// ── frequency scales — two ways to lay 30 Hz..16 kHz onto a fraction 0..1, live-swappable.
//    log = equal octaves (constant-Q, pitch-faithful); mel = perceptual (packs bass). ──
const F_LO = 30, F_HI = 16000
const hzToMel = (f) => 1127 * Math.log(1 + f / 700)
const melToHz = (m) => 700 * (Math.exp(m / 1127) - 1)
const scaleHz = (mode, p, hi) =>           // fraction p∈[0,1] → Hz, between F_LO and hi
  mode === 'mel' ? melToHz(hzToMel(F_LO) + p * (hzToMel(hi) - hzToMel(F_LO)))
                 : F_LO * Math.exp(p * Math.log(hi / F_LO))

// log positions of n analyser bins (for the spectrum bars)
const logAxis = (n, sr) => {
  const nyq = sr / 2, lo = Math.log2(F_LO), hi = Math.log2(nyq), span = hi - lo, pos = new Float32Array(n)
  for (let i = 0; i < n; i++) pos[i] = (Math.log2(Math.max(i / n * nyq, F_LO)) - lo) / span
  return pos
}

// inferno-ish intensity ramp for the spectrogram (luminance rises monotonically)
const RAMP = (() => {
  const stops = [8, 8, 14, 40, 18, 70, 130, 40, 70, 224, 110, 40, 250, 200, 90, 255, 255, 225]
  const n = stops.length / 3, lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (n - 1), a = Math.floor(x), b = Math.min(n - 1, a + 1), f = x - a
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[a * 3 + c] + (stops[b * 3 + c] - stops[a * 3 + c]) * f
  }
  return lut
})()

// ── scroll buffer — an offscreen canvas that shifts one pixel left per frame and
//    paints a fresh 1-px column at the right edge. Shared by both time-scrolling
//    renderers (spectrogram, waveform) so they behave identically. ──
const scroller = () => {
  let buf = null, bctx = null, bw = 0, bh = 0, col = null, img = null
  return {
    ensure(W, H) {
      if (buf && bw === W && bh === H) return
      buf = document.createElement('canvas'); buf.width = bw = W; buf.height = bh = H
      bctx = buf.getContext('2d'); bctx.fillStyle = BG; bctx.fillRect(0, 0, W, H)
      col = bctx.createImageData(1, H); img = col.data
    },
    clear() { if (bctx) { bctx.fillStyle = BG; bctx.fillRect(0, 0, bw, bh) } },
    column(W, H, fill) { bctx.drawImage(buf, -1, 0); fill(img, H); bctx.putImageData(col, W - 1, 0) },
    blit(g) { g.drawImage(buf, 0, 0) },
  }
}

// ── Waveform — the signal over time. Per column we take the mean μ and stdev σ of the
//    recent samples and paint a vertical Gaussian centred at μ with half-width σ — a warm
//    ribbon whose THICKNESS is amplitude, scrolling like the spectrogram. ──
const waveform = () => {
  const sc = scroller()
  let mean = 0, std = 0.1
  return {
    id: 'wave', name: 'Waveform',
    resize(W, H) { sc.ensure(W, H) },
    frame(g, { time, W, H, playing }) {
      sc.ensure(W, H)
      if (!playing) { sc.blit(g); return }
      let sum = 0, sum2 = 0, n = time.length
      for (let i = 0; i < n; i++) { const s = time[i]; sum += s; sum2 += s * s }
      const m = sum / n, sd = Math.sqrt(Math.max(sum2 / n - m * m, 1e-9))
      mean += (m - mean) * 0.05; std += (sd - std) * 0.12          // EMA: steady midline, responsive width
      const amp = H * 0.46, mid = H * 0.5, muY = mid - mean * amp, sigY = Math.max(0.8, std * amp)
      sc.column(W, H, (img) => {
        for (let y = 0; y < H; y++) {
          const d = (y - muY) / sigY, gg = Math.abs(d) > 4 ? 0 : Math.exp(-0.5 * d * d), L = gg * 255 | 0
          img[y * 4] = L; img[y * 4 + 1] = L * 0.94 | 0; img[y * 4 + 2] = L * 0.74 | 0; img[y * 4 + 3] = 255
        }
      })
      sc.blit(g)
    },
  }
}

// ── Spectrogram — time scrolls left, frequency on a log OR mel axis, intensity through a
//    warm ramp. The hero renderer: the song's structure becomes visible. ──
const spectrogram = () => {
  const sc = scroller()
  let mode = 'log', table = null, tH = 0, sr0 = 0
  const build = (H, sr, n) => {
    const hi = Math.min(F_HI, sr / 2), fft = n * 2
    table = new Int32Array(H)
    for (let y = 0; y < H; y++) {
      const hz = scaleHz(mode, 1 - y / (H - 1), hi)            // top = high
      table[y] = Math.min(n - 1, Math.max(1, Math.round(hz * fft / sr)))
    }
    tH = H; sr0 = sr
  }
  return {
    id: 'gram', name: 'Spectrogram',
    opts: [{ key: 'scale', values: ['log', 'mel'], cur: 'log' }],
    set(k, v) { if (k === 'scale' && v !== mode) { mode = v; table = null; sc.clear() } },
    resize(W, H) { sc.ensure(W, H); table = null },
    frame(g, { freq, sr, W, H, playing }) {
      sc.ensure(W, H)
      if (!playing) { sc.blit(g); return }
      if (!table || tH !== H || sr0 !== sr) build(H, sr, freq.length)
      sc.column(W, H, (img) => {
        for (let y = 0; y < H; y++) {
          const p = freq[table[y]] * 3
          img[y * 4] = RAMP[p]; img[y * 4 + 1] = RAMP[p + 1]; img[y * 4 + 2] = RAMP[p + 2]; img[y * 4 + 3] = 255
        }
      })
      sc.blit(g)
    },
  }
}

// ── Spectrum — momentary log-frequency bars with falling peak-hold caps. ──
const spectrum = () => {
  let peaks = null, axis = null, sr0 = 0, pw = 0
  return {
    id: 'spectrum', name: 'Spectrum',
    resize() {},
    frame(g, { freq, sr, W, H, dpr, accent, playing }) {
      clear(g, W, H)
      const n = freq.length
      if (axis === null || sr0 !== sr) { axis = logAxis(n, sr); sr0 = sr }
      if (!peaks || pw !== W) { peaks = new Float32Array(W); pw = W }
      const pad = H * 0.06, floor = H - pad, ceil = pad
      const col = new Float32Array(W)
      for (let i = 1; i < n; i++) { const x = axis[i] * (W - 1) | 0, v = freq[i] / 255; if (v > col[x]) col[x] = v }
      let lastv = 0
      for (let x = 0; x < W; x++) { if (col[x] > 0) lastv = col[x]; else col[x] = lastv * 0.96 }
      g.fillStyle = playing ? accent : 'rgba(255,255,255,.42)'
      const bw = Math.max(1, dpr)
      for (let x = 0; x < W; x += 2) { const h = col[x] * (floor - ceil); g.fillRect(x, floor - h, bw, h); peaks[x] = Math.max(peaks[x] * 0.94 - 0.5, h) }
      g.fillStyle = 'rgba(255,255,255,.85)'
      for (let x = 0; x < W; x += 2) g.fillRect(x, floor - peaks[x] - dpr, bw, dpr)
    },
  }
}

// ── Scope — momentary oscilloscope line (the classic dollchan view). ──
const scope = () => ({
  id: 'scope', name: 'Scope',
  resize() {},
  frame(g, { time, W, H, dpr, accent, playing }) {
    clear(g, W, H)
    const mid = H / 2, amp = H * 0.42, n = time.length, step = n / W
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = dpr
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke()
    g.strokeStyle = playing ? accent : 'rgba(255,255,255,.5)'
    g.lineWidth = Math.max(1.25, dpr * 1.1); g.lineJoin = 'round'; g.beginPath()
    for (let x = 0; x < W; x++) {
      let lo = 1, hi = -1
      const s0 = x * step | 0, s1 = Math.min(n, (x + 1) * step + 1 | 0)
      for (let i = s0; i < s1; i++) { const v = time[i]; if (v < lo) lo = v; if (v > hi) hi = v }
      g.moveTo(x + .5, mid - hi * amp); g.lineTo(x + .5, mid - lo * amp + .5)
    }
    g.stroke()
  },
})

// ── Phase — Lissajous portrait: sample(i) vs sample(i+lag). ──
const lissajous = () => ({
  id: 'phase', name: 'Phase',
  resize() {},
  frame(g, { time, W, H, dpr, accent, playing }) {
    clear(g, W, H)
    const n = time.length, lag = 32, cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.44
    g.strokeStyle = playing ? accent : 'rgba(255,255,255,.5)'
    g.lineWidth = Math.max(1, dpr); g.lineJoin = 'round'; g.globalAlpha = 0.85; g.beginPath()
    for (let i = 0; i < n - lag; i++) { const x = cx + time[i] * r, y = cy - time[i + lag] * r; if (i) g.lineTo(x, y); else g.moveTo(x, y) }
    g.stroke(); g.globalAlpha = 1
  },
})

export const makeVisualizers = () => [spectrogram(), waveform(), spectrum(), scope(), lissajous()]

// Shared demo harness: one kernel source runs two ways, side by side.
//
//   valid jz === valid JS — so the same .js file is the JS engine (ESM import)
//   and the jz engine (compiled .wasm). Both expose identical exports that
//   return real typed arrays: JS returns its own buffer, jz returns a view over
//   wasm memory. The render loop never knows which one it's driving.
//
// loadEngine(kind, urls) → exports        pick an engine by name
// hud({ kind, onSwitch, note })           FPS + ms readout + JS/jz toggle

import { instantiate } from '../../interop.js'
import { EXAMPLES, byName } from '../examples.js'

// Gallery order + nicer labels come from the shared descriptor (examples/examples.js).
// Re-exported so existing importers keep working.
export { EXAMPLES }
const titleOf = (n) => byName[n]?.title || n.replace(/-/g, ' ')

// Embed mode (?embed) — strip ALL chrome (masthead, edge chevrons, palette, hint),
// leaving just the demo canvas + the FPS/toggle HUD. The landing-page hero hosts an
// example this way in an <iframe>; the parent owns prev/next + the "open" label.
// `?embed` strips chrome. `?embed=N` additionally tells us the host upscales the iframe by
// N× (the landing renders the example at a fraction of native pixels, then CSS-scales it up
// to stay fast full-screen). We counter-scale the HUD by 1/N so it renders at its true size
// instead of being blown up with the canvas.
const embedParam = new URLSearchParams(location.search).get('embed')
const EMBED = embedParam !== null
if (EMBED) {
  const inv = 1 / (parseFloat(embedParam) || 1)
  document.documentElement.classList.add('jz-embed')
  const s = document.createElement('style')
  s.textContent = 'html.jz-embed, html.jz-embed body { border: 0 !important; overflow: hidden !important; }'
    + ` html.jz-embed .jz-hud { top: 12px; left: 12px; right: auto; bottom: auto; align-items: flex-start; transform: scale(${inv}); transform-origin: top left; }`
    + ' html.jz-embed #hint, html.jz-embed .hint { display: none !important; }'   // example-local hint divs
  document.head.appendChild(s)
}

// Inject the shared masthead for every example page. The LOOK comes from the shared
// site.css (.masthead) — one source of truth across all pages; here we add only the
// markup, the `.fixed` overlay (example pages are full-screen canvases), and the link.
const SITE_CSS = new URL('../../site.css', import.meta.url).href
const addMasthead = (name) => {
  if (document.querySelector('.masthead')) return
  if (!document.querySelector('link[data-jz-site]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = SITE_CSS; link.dataset.jzSite = ''
    document.head.appendChild(link)
  }
  const header = document.createElement('header')
  header.className = 'masthead fixed'
  // critical inline so the band never flashes unstyled before site.css resolves
  header.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:200;background:#0a0a0a'
  header.innerHTML = `
    <div class="wordmark">
      <a class="mark" href="../../" aria-label="jz — home">JZ</a><a class="sub" href="../">examples</a><span class="sep" aria-hidden="true">›</span><span class="page">${name}</span>
    </div>
    <nav>
      <a href="../../repl/">repl</a>
      <a href="../../floatbeat/">floatbeat</a>
      <a href="../../bench/">bench</a>
      <a class="gh" href="https://github.com/dy/jz" target="_blank" rel="noopener" aria-label="jz on GitHub">
        <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
    </nav>`
  document.body.insertBefore(header, document.body.firstChild)
}

// Big left/right chevrons for switching examples without leaving the demo area.
const addEdgeNav = (name) => {
  if (document.querySelector('.jz-edge')) return
  const at = EXAMPLES.indexOf(name)
  if (at < 0) return
  const prev = at > 0 ? EXAMPLES[at - 1] : EXAMPLES[EXAMPLES.length - 1]
  const next = at < EXAMPLES.length - 1 ? EXAMPLES[at + 1] : EXAMPLES[0]
  const label = titleOf
  const chev = (d) => `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
  const wrap = document.createElement('div')
  wrap.className = 'jz-edge'
  wrap.innerHTML = `
    <a class="jz-edge-prev" href="../${prev}/" aria-label="previous example: ${prev}">
      <span class="chip">${chev('M15 5l-7 7 7 7')}</span><span class="label">${label(prev)}</span>
    </a>
    <a class="jz-edge-next" href="../${next}/" aria-label="next example: ${next}">
      <span class="chip">${chev('M9 5l7 7-7 7')}</span><span class="label">${label(next)}</span>
    </a>
    <style>
      /* No chrome — big white chevrons + label, with a soft dark outline (drop-shadow /
         text-shadow) so they stay legible on dark, light AND mid-gray frames alike. */
      .jz-edge a {
        position: fixed; top: 50%; transform: translateY(-50%); z-index: 150;
        display: flex; align-items: center; text-decoration: none; user-select: none;
        -webkit-tap-highlight-color: transparent; color: #fff;
        font-family: Futura, 'Futura PT', 'Avant Garde', Jost, 'Helvetica Neue', sans-serif;
      }
      .jz-edge-prev { left: 10px; }
      .jz-edge-next { right: 10px; flex-direction: row-reverse; }
      .jz-edge .chip {
        flex: none; display: flex; align-items: center; justify-content: center;
        filter: drop-shadow(0 0 1px rgba(0,0,0,.9)) drop-shadow(0 1px 3px rgba(0,0,0,.6));
        transition: transform .2s;
      }
      .jz-edge .label {
        max-width: 0; overflow: hidden; white-space: nowrap; box-sizing: border-box;
        font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .14em;
        opacity: 0; text-shadow: 0 0 2px rgba(0,0,0,.9), 0 1px 2px rgba(0,0,0,.7);
        transition: max-width .34s cubic-bezier(.22,.6,.36,1), opacity .26s, padding .34s;
      }
      .jz-edge a:hover .chip { transform: scale(1.15); }
      .jz-edge a:hover .label { max-width: 220px; opacity: 1; }
      .jz-edge-prev:hover .label { padding-left: 8px; }
      .jz-edge-next:hover .label { padding-right: 8px; }
      @media (hover: none) { .jz-edge .label { display: none; } }
    </style>`
  document.body.appendChild(wrap)
}

// Track normalized pointer state for canvas-driven examples.
// Position updates on every move so a drag never jumps, but examples should gate
// actual effects on `down` — interactivity is click/drag only, never hover.
// Returns a live object `{ x, y, down, btn }`.
export const trackPointer = (el, onChange) => {
  const state = { x: 0.5, y: 0.5, down: false, btn: 0 }
  const update = (e) => {
    const r = el.getBoundingClientRect()
    state.x = (e.clientX - r.left) / r.width
    state.y = (e.clientY - r.top) / r.height
    state.btn = e.button || 0
    if (onChange) onChange(state)
  }
  el.addEventListener('pointerdown', (e) => {
    state.down = true
    try { el.setPointerCapture(e.pointerId) } catch {}
    update(e)
  })
  el.addEventListener('pointermove', update)
  el.addEventListener('pointerup', (e) => {
    state.down = false
    try { el.releasePointerCapture(e.pointerId) } catch {}
    update(e)
  })
  el.addEventListener('pointerleave', (e) => { state.down = false; update(e) })
  el.addEventListener('pointercancel', (e) => { state.down = false; update(e) })
  return state
}

// URLs are page-relative; resolve against the document so dynamic import() (which
// would otherwise resolve relative to this module) and fetch() agree.
export const loadEngine = async (kind, { js, wasm }) => {
  const url = (u) => new URL(u, document.baseURI).href
  return kind === 'js'
    ? await import(url(js))
    : instantiate(new Uint8Array(await (await fetch(url(wasm))).arrayBuffer())).exports
}

// ── palette: any grayscale example can be colorized by mapping luminance through a
// colormap. Default is grayscale (the B&W look); the palette icon picks a random map. ──
const hsl = (h, s, l) => {
  h = (((h % 360) + 360) % 360) / 360
  const a = s * Math.min(l, 1 - l)
  const f = n => { const k = (n + h * 12) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
  return [f(0), f(8), f(4)]
}
// Each colormap is a perceptual path black → … → white (luminance rises monotonically so
// the field still reads as a value), with a meaningful hue journey between.
const CMAPS = [
  [0, 0, 0, 60, 16, 110, 245, 135, 75, 255, 255, 235],   // magma
  [0, 0, 4, 50, 12, 95, 235, 120, 30, 255, 255, 170],    // inferno
  [0, 0, 12, 30, 110, 170, 120, 210, 210, 255, 255, 255],// ice
  [0, 0, 0, 150, 25, 10, 250, 180, 40, 255, 255, 255],   // fire
  [4, 2, 24, 95, 40, 135, 225, 120, 95, 255, 255, 255],  // dusk
  [0, 8, 8, 20, 120, 90, 150, 205, 80, 255, 255, 235],   // moss
]
const randomPalette = () => {
  if (Math.random() < 0.5) return CMAPS[Math.floor(Math.random() * CMAPS.length)]
  const h = Math.random() * 360, off = (40 + Math.random() * 120) * (Math.random() < 0.5 ? -1 : 1)
  return [0, 0, 0, ...hsl(h, 0.9, 0.34), ...hsl(h + off, 0.85, 0.66), 255, 255, 255]
}
// 256-entry LUT (luminance → 0xAABBGGRR) interpolated across the colormap stops
const buildLUT = (stops) => {
  const n = stops.length / 3, t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (n - 1), a = Math.floor(x), b = Math.min(n - 1, a + 1), f = x - a
    const r = stops[a * 3] + (stops[b * 3] - stops[a * 3]) * f
    const g = stops[a * 3 + 1] + (stops[b * 3 + 1] - stops[a * 3 + 1]) * f
    const bl = stops[a * 3 + 2] + (stops[b * 3 + 2] - stops[a * 3 + 2]) * f
    t[i] = (255 << 24) | ((bl | 0) << 16) | ((g | 0) << 8) | (r | 0)
  }
  return t
}

// FPS sparkline + ms/frame readout and engine toggle. Call frame(workMs?) once per rendered
// frame with the measured kernel compute time. FPS alone lies under a vsync cap (both engines
// peg at the refresh rate), so the HUD also shows kernel ms — the real engine gap
// regardless of vsync. The sparkline tracks FPS over time so a stall visibly dips the line.
// Clicking swaps engine and fires onSwitch(kind).
// `code` (optional): the kernel source — a URL to fetch (e.g. './attractors.js') or
// literal text (anything containing a newline). Adds a `</>` toggle that overlays it.
// `nav` (optional): this example's name (from EXAMPLES) — adds ‹ prev / next › arrows.
// `hint` (optional): a bottom-center caption describing the interaction; fades on first use.
export const hud = ({ kind = 'jz', onSwitch, src = '', code = '', nav = '', meter = true, hint = '', palette = true, onPalette }) => {
  if (nav && !EMBED) { addMasthead(nav); addEdgeNav(nav) }
  if (hint && !EMBED && !document.querySelector('.jz-hint')) {
    const hel = document.createElement('div')
    hel.className = 'jz-hint'
    hel.textContent = hint
    hel.innerHTML += `<style>
      /* white text + soft dark outline → legible on dark, light AND mid-gray backgrounds */
      .jz-hint { position: fixed; left: 0; right: 0; bottom: 18px; z-index: 90; text-align: center;
        pointer-events: none; transition: opacity .6s; opacity: .95;
        font: 500 13px 'Helvetica Neue', Helvetica, Arial, sans-serif; letter-spacing: .02em;
        color: #fff; text-shadow: 0 0 3px rgba(0,0,0,.9), 0 0 1px rgba(0,0,0,.9), 0 1px 2px rgba(0,0,0,.7); }
    </style>`
    document.body.appendChild(hel)
  }
  const el = document.createElement('div')
  el.innerHTML = `
    <style>
      /* floating chart + readout + skeuomorphic switch — no box, bottom-right over the demo */
      .jz-hud { position: fixed; bottom: 14px; right: 16px; z-index: 100;
        font: 600 13px/1.1 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #fff; user-select: none;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
        text-shadow: 0 1px 3px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.6); }
      .jz-hud .spark { display: block; width: 150px; height: 34px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.85)); }
      .jz-hud .readout { display: flex; align-items: baseline; gap: 9px; font-size: 12px; color: rgba(255,255,255,.72); }
      .jz-hud .readout .metric { display: inline-flex; align-items: baseline; gap: .34em; }
      .jz-hud .readout b { font-weight: 700; font-size: 19px; line-height: 1; color: #fff; letter-spacing: -.02em; }
      /* skeuomorphic JS↔JZ slider: dark inset track (JS) → light track + knob right (JZ) */
      .jz-sw { display: flex; align-items: center; gap: 9px; }
      .jz-sw .lbl { font-size: 11px; letter-spacing: .13em; text-transform: uppercase; color: rgba(255,255,255,.48);
        cursor: pointer; transition: color .15s; display: inline-flex; align-items: center; gap: 4px; }
      .jz-sw .lbl.on { color: #fff; }
      .jz-sw .lbl .bolt { width: 10px; height: 10px; }
      .jz-toggle { position: relative; width: 46px; height: 26px; flex: none; border: 0; padding: 0; cursor: pointer;
        border-radius: 13px; -webkit-appearance: none; appearance: none; transition: background .25s, box-shadow .25s;
        background: linear-gradient(180deg, #242424, #0d0d0d);
        box-shadow: inset 0 2px 4px rgba(0,0,0,.75), inset 0 -1px 0 rgba(255,255,255,.06), 0 1px 0 rgba(255,255,255,.07); }
      .jz-toggle.jz { background: linear-gradient(180deg, #fdfdfd, #d2d2d2);
        box-shadow: inset 0 2px 4px rgba(0,0,0,.28), 0 1px 0 rgba(255,255,255,.14); }
      .jz-toggle .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
        background: radial-gradient(120% 120% at 50% 26%, #5c5c5c, #1a1a1a 72%);
        box-shadow: 0 2px 4px rgba(0,0,0,.65), inset 0 1px 1px rgba(255,255,255,.3), inset 0 -2px 3px rgba(0,0,0,.55);
        transition: transform .28s cubic-bezier(.34,.72,.28,1.3); }
      .jz-toggle.jz .knob { transform: translateX(20px); }
      @media (prefers-reduced-motion: reduce) { .jz-toggle .knob { transition: none; } }
    </style>
    <div class="jz-hud">
      ${meter ? `<canvas class="spark" id="jz-spark"></canvas>
      <div class="readout"><span class="metric"><b id="jz-fps">··</b> fps</span><span class="metric" id="jz-ms" hidden><b id="jz-ms-v">·</b> ms</span></div>` : ''}
      <div class="jz-sw">
        <span class="lbl js" id="jz-lbl-js">JS</span>
        <button class="jz-toggle" id="jz-toggle" role="switch" aria-label="JS / JZ engine"><span class="knob"></span></button>
        <span class="lbl jz" id="jz-lbl-jz"><svg class="bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>JZ</span>
      </div>
    </div>`
  document.body.appendChild(el)

  // The HUD is an overlay — swallow pointer/click so they don't fall through to a
  // window-level canvas handler (e.g. clicking the FPS area must not re-seed/shuffle).
  for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'])
    el.addEventListener(ev, (e) => e.stopPropagation())

  const fpsEl = el.querySelector('#jz-fps')
  const msRow = el.querySelector('#jz-ms'), msEl = el.querySelector('#jz-ms-v')
  const sparkEl = el.querySelector('#jz-spark')
  const sctx = sparkEl && sparkEl.getContext('2d')
  let sw = 0, sh = 0
  const sizeSpark = () => {
    const r = sparkEl.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    sw = Math.max(1, Math.round(r.width)); sh = Math.max(1, Math.round(r.height))
    sparkEl.width = sw * dpr; sparkEl.height = sh * dpr
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  // FPS area chart: filled gradient under the line shows headroom; a stall visibly dips it.
  const drawSpark = () => {
    if (!sctx) return
    if (!sw) sizeSpark()
    const n = hist.length, w = sw, h = sh
    const xs = (i) => i / (n - 1) * w
    const ys = (v) => h - (v / 100) * (h - 2) - 1
    sctx.clearRect(0, 0, w, h)
    sctx.beginPath(); sctx.moveTo(0, h)
    for (let i = 0; i < n; i++) sctx.lineTo(xs(i), ys(hist[i]))
    sctx.lineTo(w, h); sctx.closePath()
    const grad = sctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(255,255,255,.42)')
    grad.addColorStop(1, 'rgba(255,255,255,.04)')
    sctx.fillStyle = grad; sctx.fill()
    sctx.beginPath()
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(hist[i]); if (i) sctx.lineTo(x, y); else sctx.moveTo(x, y) }
    sctx.strokeStyle = 'rgba(255,255,255,.95)'; sctx.lineWidth = 1.25; sctx.stroke()
  }
  const toggle = el.querySelector('#jz-toggle')
  const lblJs = el.querySelector('#jz-lbl-js'), lblJz = el.querySelector('#jz-lbl-jz')
  const paint = () => {
    toggle.classList.toggle('jz', kind === 'jz')
    toggle.setAttribute('aria-checked', kind === 'jz')
    lblJs.classList.toggle('on', kind === 'js')
    lblJz.classList.toggle('on', kind === 'jz')
  }
  paint()
  const setKind = (k) => { if (k === kind) return; kind = k; paint(); ms = 0; onSwitch?.(kind) }
  toggle.onclick = () => setKind(kind === 'js' ? 'jz' : 'js')
  lblJs.onclick = () => setKind('js')
  lblJz.onclick = () => setKind('jz')

  // Palette icon: a bare square color-wheel, bottom-right. Click randomizes a colormap
  // (rotating the wheel); `paint(src,dst)` then maps grayscale luminance through it. Until
  // first click the LUT is null, so paint() is a plain copy and the example stays B&W.
  let lut = null
  if (palette && !EMBED) {
    const pal = document.createElement('button')
    pal.id = 'jz-pal'; pal.title = 'randomize palette'; pal.setAttribute('aria-label', 'randomize palette')
    pal.innerHTML = `<span class="sw"></span><style>
      #jz-pal { position: fixed; left: 18px; bottom: 18px; z-index: 100; width: 30px; height: 30px;
        padding: 0; margin: 0; border: 0; background: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
      #jz-pal .sw { display: block; width: 100%; height: 100%;
        background: conic-gradient(from 0deg, #ff5151, #ffc400, #36e07a, #36a8ff, #a36bff, #ff5151);
        box-shadow: 0 0 0 1.5px rgba(255,255,255,.35) inset; transition: transform .4s cubic-bezier(.2,.75,.2,1); }
      #jz-pal:hover .sw { transform: rotate(120deg); }
      #jz-pal.on .sw { transform: rotate(360deg); }</style>`
    document.body.appendChild(pal)
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart']) pal.addEventListener(ev, (e) => e.stopPropagation())
    pal.onclick = () => { lut = buildLUT(randomPalette()); pal.classList.toggle('on'); onPalette?.() }
  }
  // Blit src (engine pixels) → dst (ImageData buffer), colorizing if a palette is active.
  // Indexes the LUT by luminance, so it works on colored kernels too (false-color remap),
  // not just grayscale ones. Default (lut null) is a plain copy → original colors intact.
  const blit = (src, dst) => {
    if (!lut) { dst.set(src); return }
    const t = lut, n = src.length
    for (let i = 0; i < n; i++) {
      const p = src[i]
      dst[i] = t[((p & 0xff) * 77 + (p >> 8 & 0xff) * 150 + (p >> 16 & 0xff) * 29) >> 8]
    }
  }

  // EMA-smoothed over a ~0.4s window. The sparkline plots FPS on an absolute scale
  // (full height = `ref`, which rises to the display's refresh rate), so the line sits
  // at the true level and swapping to a slower engine visibly steps it down.
  const SPARK = 48   // FPS history length for the sparkline
  let last = performance.now(), fps = 0, ms = 0, ref = 120
  const hist = new Array(SPARK).fill(0)
  return {
    get kind() { return kind },
    paint: blit,
    frame(workMs) {
      if (!meter) return
      const now = performance.now(), dt = now - last; last = now
      // Cap a sub-4ms frame (scheduler catch-up, not a 250Hz display) so a startup/GC
      // spike can't poison the EMA or latch `ref` to a blip.
      const inst = dt > 0 ? Math.min(1000 / dt, 240) : fps
      fps += (inst - fps) * 0.1
      fpsEl.textContent = fps >= 1 ? fps.toFixed(0) : '··'
      if (fps > ref) ref = fps
      hist.push(Math.min(100, fps / ref * 100)); hist.shift()
      drawSpark()
      if (workMs != null) {
        ms = ms ? ms * 0.9 + workMs * 0.1 : workMs
        msEl.textContent = ms.toFixed(ms < 10 ? 2 : 1)
        msRow.hidden = false
      }
    },
  }
}

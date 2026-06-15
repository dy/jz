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

// Gallery order — drives the edge chevrons (wraps around). Visual examples only;
// audio is handled separately in the floatbeat playground.
export const EXAMPLES = [
  'game-of-life', 'wireworld', 'maze', 'sand', 'lenia', 'slime', 'dla',
  'diffusion', 'watercolor', 'marble', 'interference', 'waves', 'erosion', 'plasma', 'chladni',
  'mandelbrot', 'julia', 'attractors', 'voronoi', 'raymarcher',
  'metaballs', 'nbody', 'swarm', 'cloth', 'cradle', 'sph', 'lbm', 'raytrace',
]

// Jost (libre Futura) — bundled so weights render predictably (macOS "Futura" has no
// true regular and renders heavy at every weight). Used Jost-first in the masthead.
const JOST_URL = new URL('./jost.woff2', import.meta.url).href

// Inject the shared top navigation bar for every example page.
// Matches examples/index.html: dark band, geometric wordmark, nav links.
const addMasthead = (name) => {
  if (document.querySelector('.jz-masthead')) return
  const header = document.createElement('header')
  header.className = 'jz-masthead'
  header.innerHTML = `
    <a class="wordmark" href="../" aria-label="back to all examples">
      <span class="mark">JZ</span><span class="sub">examples</span><span class="sep" aria-hidden="true">›</span><span class="page">${name}</span>
    </a>
    <nav>
      <a href="../../repl/">repl</a>
      <a href="../../bench/">bench</a>
      <a class="gh" href="https://github.com/dy/jz" target="_blank" rel="noopener" aria-label="jz on GitHub">
        <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
    </nav>
    <style>
      @font-face { font-family: Jost; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${JOST_URL}") format('woff2'); }
      .jz-masthead {
        position: fixed; top: 0; left: 0; right: 0; z-index: 200;
        background: #0a0a0a; color: #fff;
        display: flex; align-items: center; gap: 16px;
        min-height: 44px;
        padding: 0 16px;
        font-family: Jost, 'Helvetica Neue', Arial, sans-serif;
      }
      .jz-masthead .wordmark { font-size: 19px; font-weight: 400; letter-spacing: -.02em; line-height: 1; text-decoration: none; color: #fff; }
      .jz-masthead .wordmark .mark { font-weight: 700; color: #fff; }
      .jz-masthead .wordmark .sub { font-weight: 400; color: #8a8a8a; margin-left: .45em; transition: color .18s; }
      .jz-masthead .wordmark .sep { font-weight: 400; color: #5a5a5a; margin: 0 .42em; }
      .jz-masthead .wordmark .page { font-weight: 400; color: #fff; }
      .jz-masthead .wordmark:hover .sub { color: #fff; }
      .jz-masthead nav { margin-left: auto; display: flex; align-items: center; gap: 20px; }
      .jz-masthead nav a { color: #fff; opacity: .7; text-decoration: none; font-size: 12px; text-transform: uppercase; letter-spacing: .14em; transition: opacity .18s; }
      .jz-masthead nav a:hover { opacity: 1; }
      .jz-masthead .gh { display: flex; }
      @media (max-width: 520px) {
        .jz-masthead { gap: 10px; padding: 0 12px; }
        .jz-masthead .wordmark { font-size: 15px; }
        .jz-masthead nav { gap: 12px; }
        .jz-masthead nav a { font-size: 11px; }
      }
    </style>`
  document.body.insertBefore(header, document.body.firstChild)
}

// Big left/right chevrons for switching examples without leaving the demo area.
const addEdgeNav = (name) => {
  if (document.querySelector('.jz-edge')) return
  const at = EXAMPLES.indexOf(name)
  if (at < 0) return
  const prev = at > 0 ? EXAMPLES[at - 1] : EXAMPLES[EXAMPLES.length - 1]
  const next = at < EXAMPLES.length - 1 ? EXAMPLES[at + 1] : EXAMPLES[0]
  const label = (n) => n.replace(/-/g, ' ')
  const chev = (d) => `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
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
      .jz-edge a {
        position: fixed; top: 50%; transform: translateY(-50%); z-index: 150;
        display: flex; align-items: center; text-decoration: none; user-select: none;
        -webkit-tap-highlight-color: transparent;
        font-family: Futura, 'Futura PT', 'Avant Garde', Jost, 'Helvetica Neue', sans-serif;
      }
      .jz-edge-prev { left: 14px; }
      .jz-edge-next { right: 14px; flex-direction: row-reverse; }
      .jz-edge .chip {
        flex: none; width: 44px; height: 44px;
        display: flex; align-items: center; justify-content: center;
        color: rgba(255,255,255,.7); background: rgba(12,12,14,.42);
        border: 1px solid rgba(255,255,255,.15);
        backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
        box-shadow: 0 2px 12px rgba(0,0,0,.28);
        transition: color .2s, background .2s, border-color .2s, transform .2s;
      }
      .jz-edge .label {
        max-width: 0; overflow: hidden; white-space: nowrap; box-sizing: border-box;
        font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .14em;
        color: rgba(255,255,255,.92); opacity: 0;
        transition: max-width .34s cubic-bezier(.22,.6,.36,1), opacity .26s, padding .34s;
      }
      .jz-edge a:hover .chip {
        color: #0a0a0a; background: rgba(255,255,255,.94);
        border-color: transparent; transform: scale(1.05);
      }
      .jz-edge a:hover .label { max-width: 220px; opacity: 1; }
      .jz-edge-prev:hover .label { padding-left: 12px; }
      .jz-edge-next:hover .label { padding-right: 12px; }
      @media (max-width: 520px) {
        .jz-edge-prev { left: 8px; } .jz-edge-next { right: 8px; }
        .jz-edge .chip { width: 40px; height: 40px; }
      }
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

const SPARK = 48   // FPS history length for the sparkline

// FPS sparkline + ms/frame readout and engine toggle. Call frame(workMs?) once per rendered
// frame with the measured kernel compute time. FPS alone lies under a vsync cap (both engines
// peg at the refresh rate), so the HUD also shows kernel ms — the real engine gap
// regardless of vsync. The sparkline tracks FPS over time so a stall visibly dips the line.
// Clicking swaps engine and fires onSwitch(kind).
// `code` (optional): the kernel source — a URL to fetch (e.g. './attractors.js') or
// literal text (anything containing a newline). Adds a `</>` toggle that overlays it.
// `nav` (optional): this example's name (from EXAMPLES) — adds ‹ prev / next › arrows.
// `hint` (optional): a bottom-center caption describing the interaction; fades on first use.
export const hud = ({ kind = 'jz', onSwitch, src = '', code = '', nav = '', meter = true, hint = '' }) => {
  if (nav) { addMasthead(nav); addEdgeNav(nav) }
  if (hint && !document.querySelector('.jz-hint')) {
    const hel = document.createElement('div')
    hel.className = 'jz-hint'
    hel.textContent = hint
    hel.innerHTML += `<style>
      .jz-hint { position: fixed; left: 0; right: 0; bottom: 18px; z-index: 90; text-align: center;
        pointer-events: none; transition: opacity .6s; opacity: .9;
        font: 500 13px 'Helvetica Neue', Helvetica, Arial, sans-serif; letter-spacing: .02em;
        color: #888; mix-blend-mode: difference; }
    </style>`
    document.body.appendChild(hel)
  }
  const el = document.createElement('div')
  el.innerHTML = `
    <style>
      .jz-hud { position: fixed; bottom: 12px; left: 12px; z-index: 100;
        font: 600 13px/1.1 'Helvetica Neue', Helvetica, Arial, sans-serif;
        color: #eee; background: rgba(10,10,10,.92);
        border: 1px solid rgba(255,255,255,.12); padding: 9px 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,.3); user-select: none; width: 168px; }
      .jz-hud .spark { display: block; width: 100%; height: 34px; margin: 0 0 5px; }
      .jz-hud .readout { display: flex; justify-content: space-between; align-items: baseline;
        font-size: 12px; color: #888; }
      .jz-hud .readout .metric { display: inline-flex; align-items: baseline; gap: .35em; }
      .jz-hud .readout b { font-weight: 700; font-size: 13px; color: #fff; }
      .jz-hud .seg { display: flex; margin-top: 9px;
        border: 1px solid rgba(255,255,255,.18); overflow: hidden; }
      .jz-hud .seg button { flex: 1; border: 0; background: transparent;
        font: inherit; padding: 5px 12px; cursor: pointer; color: #888; }
      .jz-hud .seg button.on { background: #eee; color: #111; }
      .jz-hud .cv { position: absolute; top: 8px; right: 10px; color: #888; opacity: .8; display: inline-flex; cursor: pointer; }
      .jz-hud .cv:hover, .jz-hud .cv.on { opacity: 1; color: #fff; }
      .jz-code { position: fixed; left: 12px; top: 56px; bottom: 12px; z-index: 99; display: none;
        max-width: min(560px, 46vw); background: rgba(7,7,12,.93); border: 1px solid #ffffff1f;
        box-shadow: 0 8px 28px #0007; }
      .jz-code.show { display: block; }
      .jz-code-pre { margin: 0; padding: 12px 14px; height: 100%; box-sizing: border-box; overflow: auto;
        color: #ddd; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent; }
      .jz-code-pre::-webkit-scrollbar { width: 9px; height: 9px; }
      .jz-code-pre::-webkit-scrollbar-track { background: transparent; }
      .jz-code-pre::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16);
        border: 2px solid transparent; background-clip: padding-box; }
      .jz-code-pre::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.3); background-clip: padding-box; }
      .jz-code-x { position: absolute; top: 6px; right: 7px; z-index: 1; width: 22px; height: 22px;
        border: 0; background: transparent; color: #aaa; font: 18px/22px ui-monospace, Menlo, monospace;
        cursor: pointer; padding: 0; }
      .jz-code-x:hover { color: #fff; background: rgba(255,255,255,.12); }
    </style>
    <div class="jz-hud">
      ${code ? `<span class="cv" id="jz-cv" title="view source" aria-label="view source"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="2" y="5" width="14" height="2" rx="1"/><rect x="6" y="10" width="14" height="2" rx="1"/><rect x="2" y="15" width="9" height="2" rx="1"/></svg></span>` : ''}
      ${meter ? `<canvas class="spark" id="jz-spark"></canvas>
      <div class="readout"><span class="metric"><b id="jz-fps">··</b> fps</span><span class="metric" id="jz-ms" hidden><b id="jz-ms-v">·</b> ms/frame</span></div>` : ''}
      <div class="seg">
        <button data-k="js">JS</button>
        <button data-k="jz">JZ</button>
      </div>
    </div>
    ${code ? `<div class="jz-code" id="jz-code"><button class="jz-code-x" id="jz-code-x" title="close source" aria-label="close source">×</button><pre class="jz-code-pre" id="jz-code-pre"></pre></div>` : ''}`
  document.body.appendChild(el)

  // The HUD is an overlay — swallow pointer/click so they don't fall through to a
  // window-level canvas handler (e.g. clicking the FPS area must not re-seed/shuffle).
  for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'])
    el.addEventListener(ev, (e) => e.stopPropagation())

  const fpsEl = el.querySelector('#jz-fps')
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
  // FPS area chart: a filled gradient under the line shows the headroom (line near the
  // top = the engine is keeping up; a dip = a stall eating into the available power).
  const drawSpark = () => {
    if (!sw) sizeSpark()
    const n = hist.length, w = sw, h = sh
    const xs = (i) => i / (n - 1) * w
    const ys = (v) => h - (v / 100) * (h - 2) - 1
    sctx.clearRect(0, 0, w, h)
    sctx.beginPath(); sctx.moveTo(0, h)
    for (let i = 0; i < n; i++) sctx.lineTo(xs(i), ys(hist[i]))
    sctx.lineTo(w, h); sctx.closePath()
    const grad = sctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(255,255,255,.40)')
    grad.addColorStop(1, 'rgba(255,255,255,.03)')
    sctx.fillStyle = grad; sctx.fill()
    sctx.beginPath()
    for (let i = 0; i < n; i++) { const x = xs(i), y = ys(hist[i]); if (i) sctx.lineTo(x, y); else sctx.moveTo(x, y) }
    sctx.strokeStyle = 'rgba(255,255,255,.92)'; sctx.lineWidth = 1.25; sctx.stroke()
  }
  const msRow = el.querySelector('#jz-ms'), msEl = el.querySelector('#jz-ms-v')
  const btns = [...el.querySelectorAll('button')]
  const paint = () => btns.forEach(b => b.classList.toggle('on', b.dataset.k === kind))
  paint()
  btns.forEach(b => b.onclick = () => {
    if (b.dataset.k === kind) return
    kind = b.dataset.k; paint(); ms = 0; onSwitch?.(kind)
  })

  // Source overlay: lazy-load `code` (a URL to fetch, or literal text) on first open.
  const cvBtn = el.querySelector('#jz-cv'), codeBox = el.querySelector('#jz-code')
  const codePre = el.querySelector('#jz-code-pre'), codeX = el.querySelector('#jz-code-x')
  if (cvBtn) {
    let loaded = false
    const close = () => { codeBox.classList.remove('show'); cvBtn.classList.remove('on') }
    cvBtn.onclick = async () => {
      const showing = codeBox.classList.toggle('show')
      cvBtn.classList.toggle('on', showing)
      if (showing && !loaded) {
        loaded = true
        codePre.textContent = code.includes('\n') ? code
          : await fetch(new URL(code, document.baseURI).href).then(r => r.text()).catch(() => '// source unavailable')
      }
    }
    codeX.onclick = close
  }

  // EMA-smoothed over a ~0.4s window. The sparkline plots FPS on an absolute scale
  // (full height = `ref`, which rises to the display's refresh rate), so the line sits
  // at the true level and swapping to a slower engine visibly steps it down.
  let last = performance.now(), fps = 0, ms = 0, ref = 120
  const hist = new Array(SPARK).fill(0)
  return {
    get kind() { return kind },
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

// Shared demo harness: one kernel source runs two ways, side by side.
//
//   valid jz === valid JS — so the same .js file is the JS engine (ESM import)
//   and the jz engine (compiled .wasm). Both expose identical exports that
//   return real typed arrays: JS returns its own buffer, jz returns a view over
//   wasm memory. The render loop never knows which one it's driving.
//
// loadEngine(kind, urls) → exports        pick an engine by name
// hud({ kind, onSwitch, note })           FPS sparkline + ms + JS/jz toggle

import { instantiate } from '../../interop.js'

// Gallery order — drives the prev/next nav (wraps around). Grouped Life · Fields ·
// Geometry · Audio, three to a row for a 3×4 README grid.
export const EXAMPLES = [
  'game-of-life', 'lenia', 'reaction-diffusion',
  'interference', 'plasma', 'chladni',
  'mandelbrot', 'attractors', 'raymarcher',
  'rfft', 'zzfx', 'jukebox',
]

// URLs are page-relative; resolve against the document so dynamic import() (which
// would otherwise resolve relative to this module) and fetch() agree.
export const loadEngine = async (kind, { js, wasm }) => {
  const url = (u) => new URL(u, document.baseURI).href
  return kind === 'js'
    ? await import(url(js))
    : instantiate(new Uint8Array(await (await fetch(url(wasm))).arrayBuffer())).exports
}

// linefont: a value 0..100 is the glyph at 0x100+value; ligatures join adjacent
// glyphs into one continuous line chart. So a string of recent samples *is* the
// sparkline. (github.com/dy/linefont — the font ships next to this module.)
const SPARK = 40
const lineChars = (vals) => vals.map(v =>
  String.fromCharCode(0x100 + Math.max(0, Math.min(100, Math.round(v))))).join('')
const FONT_URL = new URL('./linefont.woff2', import.meta.url).href

// FPS sparkline + engine toggle. Call frame(workMs?) once per rendered frame with
// the measured kernel compute time. FPS alone lies under a vsync cap (both engines
// peg at the refresh rate), so the HUD also shows kernel ms — the real engine gap
// regardless of vsync. The sparkline tracks FPS over time on a decaying-peak scale,
// so a stall visibly dips the line. Clicking swaps engine and fires onSwitch(kind).
// `code` (optional): the kernel source — a URL to fetch (e.g. './attractors.js') or
// literal text (anything containing a newline). Adds a `</>` toggle that overlays it.
// `nav` (optional): this example's name (from EXAMPLES) — adds ‹ prev / next › arrows.
export const hud = ({ kind = 'jz', onSwitch, src = '', code = '', nav = '', meter = true }) => {
  const el = document.createElement('div')
  el.innerHTML = `
    <style>
      @font-face { font-family: linefont; font-display: block; src: url("${FONT_URL}") format('woff2'); }
      .jz-hud { position: fixed; top: 12px; right: 12px; z-index: 100;
        font: 600 13px/1.1 'Helvetica Neue', Helvetica, Arial, sans-serif;
        color: #111; background: rgba(255,255,255,.92);
        border: 1px solid #0002; padding: 10px 12px;
        box-shadow: 0 4px 16px #0002; user-select: none; width: 168px; }
      .jz-hud .fps { font-size: 22px; letter-spacing: -.5px; }
      .jz-hud .fps small { font-size: 11px; opacity: .5; font-weight: 500; }
      .jz-hud .spark { display: block; height: 34px; margin: 4px 0 2px;
        font-family: linefont; font-variation-settings: 'wght' 260, 'wdth' 100;
        font-size: 34px; line-height: 34px; color: #111; overflow: hidden;
        white-space: nowrap; word-break: break-all; }
      .jz-hud .ms { margin-top: 2px; font-size: 12px; }
      .jz-hud .ms b { font-weight: 700; }
      .jz-hud .ms small { opacity: .5; font-weight: 500; }
      .jz-hud .seg { display: flex; margin-top: 8px;
        border: 1px solid #0002; overflow: hidden; }
      .jz-hud .seg button { flex: 1; border: 0; background: transparent;
        font: inherit; padding: 5px 12px; cursor: pointer; color: #888; }
      .jz-hud .seg button.on { background: #111; color: #fff; }
      .jz-hud .gh { position: absolute; top: 9px; right: 11px; color: #111; opacity: .35; display: inline-flex; }
      .jz-hud .gh:hover { opacity: 1; }
      .jz-hud .cv { position: absolute; top: 9px; right: 33px; color: #111; opacity: .35; display: inline-flex; cursor: pointer; }
      .jz-hud .cv:hover, .jz-hud .cv.on { opacity: 1; color: #111; }
      .jz-code { position: fixed; left: 12px; top: 12px; bottom: 12px; z-index: 99; display: none;
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
      .jz-hud .nav { display: flex; align-items: center; justify-content: space-between; margin: -1px 0 7px; padding-right: 42px; }
      .jz-hud .nav b { font-weight: 700; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .jz-hud .nav button { border: 0; background: transparent; font: inherit; font-size: 18px; line-height: 1;
        color: #888; cursor: pointer; padding: 0 2px; }
      .jz-hud .nav button:hover { color: #111; }
    </style>
    <div class="jz-hud">
      ${nav ? `<div class="nav"><button id="jz-prev" title="previous example">‹</button><b>${nav}</b><button id="jz-next" title="next example">›</button></div>` : ''}
      ${src ? `<a class="gh" href="${src}" target="_blank" rel="noopener" title="source" aria-label="source"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>` : ''}
      ${code ? `<span class="cv" id="jz-cv" title="view source" aria-label="view source"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="2" y="5" width="14" height="2" rx="1"/><rect x="6" y="10" width="14" height="2" rx="1"/><rect x="2" y="15" width="9" height="2" rx="1"/></svg></span>` : ''}
      ${meter ? `<div class="fps"><span id="jz-fps">··</span> <small>FPS</small></div>
      <div class="spark" id="jz-spark"></div>
      <div class="ms" id="jz-ms" hidden><b><span id="jz-ms-v">·</span></b> <small>ms / frame compute</small></div>` : ''}
      <div class="seg">
        <button data-k="js">js</button>
        <button data-k="jz">jz</button>
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
  const msRow = el.querySelector('#jz-ms'), msEl = el.querySelector('#jz-ms-v')
  const btns = [...el.querySelectorAll('button')]
  const paint = () => btns.forEach(b => b.classList.toggle('on', b.dataset.k === kind))
  paint()
  btns.forEach(b => b.onclick = () => {
    if (b.dataset.k === kind) return
    kind = b.dataset.k; paint(); ms = 0; onSwitch?.(kind)
  })

  // Prev/next gallery nav — wraps around EXAMPLES, jumps to the sibling example dir.
  if (nav) {
    const at = EXAMPLES.indexOf(nav)
    const go = (d) => { if (at >= 0) location.href = '../' + EXAMPLES[(at + d + EXAMPLES.length) % EXAMPLES.length] + '/' }
    el.querySelector('#jz-prev').onclick = () => go(-1)
    el.querySelector('#jz-next').onclick = () => go(1)
  }

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
  // (full height = `ref`, which rises to the display's refresh rate), so the line
  // sits at the true level: a smooth 120 reads near the top, a 30 reads a quarter
  // up, and swapping to a slower engine visibly steps the line down.
  let last = performance.now(), fps = 0, ms = 0, ref = 120
  const hist = new Array(SPARK).fill(0)
  return {
    get kind() { return kind },
    frame(workMs) {
      if (!meter) return                         // meter hidden (e.g. spectrogram demo) — toggle only
      const now = performance.now(), dt = now - last; last = now
      // A sub-4ms frame is the scheduler catching up, not a 250Hz display — cap it
      // so a startup/GC spike can't poison the EMA. Warming fps up from 0 means it
      // approaches the true rate from below, so `ref` latches the refresh, not a blip.
      const inst = dt > 0 ? Math.min(1000 / dt, 240) : fps
      fps += (inst - fps) * 0.1
      fpsEl.textContent = fps >= 1 ? fps.toFixed(0) : '··'
      if (fps > ref) ref = fps
      hist.push(Math.min(100, fps / ref * 100)); hist.shift()
      sparkEl.textContent = lineChars(hist)
      if (workMs != null) {
        ms = ms ? ms * 0.9 + workMs * 0.1 : workMs
        msEl.textContent = ms.toFixed(ms < 10 ? 2 : 1)
        msRow.hidden = false
      }
    },
  }
}

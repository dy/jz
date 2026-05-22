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
export const hud = ({ kind = 'jz', onSwitch, note = '' }) => {
  const el = document.createElement('div')
  el.innerHTML = `
    <style>
      @font-face { font-family: linefont; font-display: block; src: url("${FONT_URL}") format('woff2'); }
      .jz-hud { position: fixed; top: 12px; right: 12px; z-index: 100;
        font: 600 13px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #111; background: rgba(255,255,255,.92);
        border: 1px solid #0002; border-radius: 10px; padding: 10px 12px;
        box-shadow: 0 4px 16px #0002; user-select: none; width: 168px; }
      .jz-hud .fps { font-size: 22px; letter-spacing: -.5px; }
      .jz-hud .fps small { font-size: 11px; opacity: .5; font-weight: 500; }
      .jz-hud .spark { display: block; height: 34px; margin: 4px 0 2px;
        font-family: linefont; font-variation-settings: 'wght' 260, 'wdth' 100;
        font-size: 34px; line-height: 34px; color: #50ad7b; overflow: hidden;
        white-space: nowrap; word-break: break-all; }
      .jz-hud .ms { margin-top: 2px; font-size: 12px; }
      .jz-hud .ms b { font-weight: 700; }
      .jz-hud .ms small { opacity: .5; font-weight: 500; }
      .jz-hud .seg { display: flex; margin-top: 8px;
        border: 1px solid #0002; border-radius: 7px; overflow: hidden; }
      .jz-hud .seg button { flex: 1; border: 0; background: transparent;
        font: inherit; padding: 5px 12px; cursor: pointer; color: #888; }
      .jz-hud .seg button.on { background: #111; color: #fff; }
      .jz-hud .note { margin-top: 6px; font-weight: 500; opacity: .5; font-size: 11px; }
    </style>
    <div class="jz-hud">
      <div class="fps"><span id="jz-fps">··</span> <small>FPS</small></div>
      <div class="spark" id="jz-spark"></div>
      <div class="ms" id="jz-ms" hidden><b><span id="jz-ms-v">·</span></b> <small>ms / frame compute</small></div>
      <div class="seg">
        <button data-k="js">JS</button>
        <button data-k="jz">jz</button>
      </div>
      ${note ? `<div class="note">${note}</div>` : ''}
    </div>`
  document.body.appendChild(el)

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

  // EMA-smoothed over a ~0.4s window. The sparkline plots FPS on an absolute scale
  // (full height = `ref`, which rises to the display's refresh rate), so the line
  // sits at the true level: a smooth 120 reads near the top, a 30 reads a quarter
  // up, and swapping to a slower engine visibly steps the line down.
  let last = performance.now(), fps = 0, ms = 0, ref = 120
  const hist = new Array(SPARK).fill(0)
  return {
    get kind() { return kind },
    frame(workMs) {
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

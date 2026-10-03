// Every gallery page, driven as the site drives it: the page's own `runDemo`
// config (`size`, `load`, `frame`) runs against the example's module as JS and
// as the jz build the site ships (examples/build.mjs: `optimize: 'speed'`).
// The canvas box is a fixed 1280×720 CSS viewport at devicePixelRatio 1, sized
// by runDemo's own rule, so each kernel works at the resolution a desktop
// visitor gets. Pointer input stays idle; the idle drivers a page runs on its
// own (tours, auto-perturbs) run as they do on the site.
//
//   node examples/bench-pages.mjs [name…] [--opt='{"pass":false}']
//
// Exits non-zero unless jz is strictly faster than JS on every page: the
// site's toggle promises a gain, not a replacement. `--opt` overrides passes of
// the site's tier, to weigh one on the same machine.
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { OPT } from './build.mjs'
import { examples } from './examples.js'

const dir = fileURLToPath(new URL('.', import.meta.url))
const BOX = { w: 1280, h: 720 }

// A DOM that answers everything: event wiring, styles and overlays are inert.
const inert = new Proxy(function () {}, {
  get: (_, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : inert,
  apply: () => inert, construct: () => inert, set: () => true,
})
const canvas = new Proxy({ clientWidth: BOX.w, clientHeight: BOX.h, width: 0, height: 0 }, {
  get: (o, k) => k in o ? o[k] : k === 'getContext' ? () => ctx2d : inert,
  set: (o, k, v) => { o[k] = v; return true },
})
const ctx2d = new Proxy({}, { get: (_, k) => k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : inert })
Object.assign(globalThis, {
  document: new Proxy({}, { get: (_, k) => k === 'querySelector' ? () => canvas : k === 'baseURI' ? 'file:///' : inert }),
  window: { devicePixelRatio: 1 }, devicePixelRatio: 1, innerWidth: BOX.w, innerHeight: BOX.h,
  location: { search: '' }, addEventListener: () => {}, requestAnimationFrame: () => 0,
  MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} },
})

// runDemo's sizing (examples/lib/jzdemo.js `sizeTo`) at the fixed box.
const sizeOf = (size = {}) => {
  let scale = size.scale
  if (size.cap != null) scale = size.cap / Math.max(BOX.w, BOX.h)
  else if (scale == null) {
    scale = Math.min(size.dpr ?? 1, 1)
    const budget = size.budget === undefined ? 600000 : size.budget
    if (budget && BOX.w * BOX.h * scale * scale > budget) scale *= Math.sqrt(budget / (BOX.w * BOX.h * scale * scale))
  }
  const even = v => size.odd ? (Math.round(v * scale) | 1) : (Math.round(v * scale) >> 1 << 1)
  return [even(BOX.w), even(BOX.h)]
}

// The page's runDemo config: its inline module script, with the shared library
// replaced by a recorder.
let loads = 0
const pageConfig = async (name) => {
  const html = readFileSync(join(dir, name, 'index.html'), 'utf8')
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]
  if (!script || !/runDemo\(/.test(script)) return null
  let config = null
  const demo = { cv: canvas, engine: null, W: 0, H: 0, t: 0 }
  globalThis.__jzbench = {
    runDemo: (c) => { config = c; return demo },
    trackPointer: () => ({ down: false, x: 0, y: 0, inside: false }),
    panZoom: () => inert, hud: () => inert, loadEngine: () => inert,
  }
  const body = script
    .replace(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/lib\/jzdemo\.js["']/, 'const {$1} = globalThis.__jzbench')
    .replace(/from\s*["'](\.{1,2}\/[^"']+)["']/g, (_, p) => `from ${JSON.stringify(pathToFileURL(join(dir, name, p)).href)}`)
  // (a fresh module per load: the loader caches a repeated URL)
  await import('data:text/javascript,' + encodeURIComponent(`${body}\n//${++loads}`))
  return config && { config, demo }
}

const args = process.argv.slice(2)
const over = args.find(a => a.startsWith('--opt='))
const optimize = over ? { level: OPT.optimize, ...JSON.parse(over.slice(6)) } : OPT.optimize

// The jz build the site ships for this page.
const jzEngine = (name, wasm) => {
  const file = join(dir, name, `${wasm || name}.js`)
  const { code, modules } = resolveModuleGraph(file)
  return instantiate(compile(code, { ...OPT, optimize, modules })).exports
}

const timeFrames = (engine, { config, demo }, [W, H]) => {
  demo.engine = engine; demo.W = W; demo.H = H
  engine.resize?.(W, H)
  config.load?.(engine, demo)
  engine.setTheme?.(0, 0, 0, 235, 235, 235)
  let t = 0
  const step = () => { t += 1 / 60; demo.t = t; config.frame(engine, t, demo) }
  // warm: compile tiers and let the simulation leave its first-frame transient
  const w0 = performance.now()
  for (let i = 0; i < 400 && performance.now() - w0 < 1500; i++) step()
  // median of 7 batches, each ~150 ms
  const one = Math.max(0.01, (performance.now() - w0) / 400)
  const per = Math.max(2, Math.min(2000, Math.round(150 / one)))
  const samples = []
  for (let r = 0; r < 7; r++) {
    const a = performance.now()
    for (let i = 0; i < per; i++) step()
    samples.push((performance.now() - a) / per)
  }
  return samples.sort((a, b) => a - b)[3]
}

const only = args.filter(a => !a.startsWith('--'))
const rows = []
console.log('page                 size        JS ms/frame  jz ms/frame  speedup')
console.log('─'.repeat(70))
for (const { name } of examples) {
  if (only.length && !only.includes(name)) continue
  if (!existsSync(join(dir, name, 'index.html'))) continue
  let page
  try { page = await pageConfig(name) } catch (e) { console.log(`${name.padEnd(20)} skipped: page script (${e.message.slice(0, 60)})`); continue }
  if (!page) { console.log(`${name.padEnd(20)} skipped: custom loop`); continue }
  const size = sizeOf(page.config.size)
  try {
    // a page whose build prepares sources (vendored modules) runs it first, as the site's build does
    if (existsSync(join(dir, name, 'build.mjs'))) execFileSync(process.execPath, [join(dir, name, 'build.mjs')], { cwd: join(dir, name), stdio: 'ignore' })
    const js = await import(pathToFileURL(join(dir, name, `${name}.js`)).href)
    const jsT = timeFrames({ ...js }, await pageConfig(name), size)
    const jzT = timeFrames(jzEngine(name, page.config.wasm), await pageConfig(name), size)
    const sp = jsT / jzT
    rows.push({ name, sp })
    console.log(`${(sp > 1 ? '  ' : '✗ ') + name.padEnd(18)} ${(size[0] + '×' + size[1]).padEnd(11)} ${jsT.toFixed(3).padStart(11)} ${jzT.toFixed(3).padStart(12)}    ${sp.toFixed(2)}×`)
  } catch (e) {
    rows.push({ name, sp: 0 })
    console.log(`✗ ${name.padEnd(18)} error: ${e.message.slice(0, 80)}`)
  }
}
const slow = rows.filter(r => !(r.sp > 1))
const gm = Math.exp(rows.reduce((s, r) => s + Math.log(Math.max(r.sp, 1e-3)), 0) / rows.length)
console.log('─'.repeat(70))
console.log(`geomean ${gm.toFixed(2)}× · jz faster on ${rows.length - slow.length}/${rows.length}`)
if (slow.length) { console.error(`✗ not faster than JS: ${slow.map(r => `${r.name} ${r.sp.toFixed(2)}×`).join(', ')}`); process.exit(1) }
console.log('✓ every page runs faster as jz than as JS')

// Shared website behavior and the deployed gallery's build contract.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = (...args) => spawnSync(process.execPath, [join(root, 'scripts/build-site.mjs'), ...args], { encoding: 'utf8' })

// Exercise the shipped pointer controller with a deterministic frame clock. SVG rendering
// is browser-checked; these ports record its paint attributes without a DOM dependency.
async function glint({ count = 1, reduced = false, fine = true, failure = 'http', paper = false, textNodes = [], scroll = 0 } = {}) {
  const events = new Map(), frames = new Map(), requests = [], clicks = [], mounted = [], selection = { isCollapsed: true }
  const listen = (name, fn) => events.set(name, fn)
  const node = () => ({ attrs: {}, children: [], style: { setProperty(k, v) { this[k] = v } },
    setAttribute(k, v) { this.attrs[k] = String(v) }, append(el) { this.children.push(el) },
    remove() { this.removed = true }, parts: {}, querySelector(name) { return this.parts[name] ??= node() },
    querySelectorAll(name) { return this.parts[name] ??= [node(), node()] } })
  const els = Array.from({ length: count }, () => ({
    rect: { left: 20, top: 40, width: 160, height: 160, bottom: 200 }, children: [],
    append(el) { this.children.push(el) }, getBoundingClientRect() { return this.rect },
    querySelector() { throw new Error('A failed enhancement must preserve the original image') },
  }))
  const motion = { matches: reduced, addEventListener: (_, fn) => listen('motion', fn) }
  const mouse = { matches: fine, addEventListener: (_, fn) => listen('mouse', fn) }
  const classes = new Set()
  const doc = { dataset: { theme: 'dark' }, classList: { contains: name => classes.has(name) }, clientWidth: 1000, clientHeight: 800, addEventListener: listen }
  const gradient = node(), path = node(), defs = node()
  const ruler = { ...node(), querySelector: name => ({ path, defs }[name] || gradient) }
  const sides = { left: '20px', width: '161px' }
  const rules = [{ left: 0, right: 1000, top: 320, width: 1000 }], tables = [], controls = []
  let id = 0, measurements = 0, clickLoads = 0
  const src = readFileSync(join(root, 'assets/glint.js'), 'utf8')
    .replace('import.meta.url', JSON.stringify('https://jz.test/assets/glint.js'))
    .replace("import('./grid-click.js')", 'loadClicks()')
  const { light } = await runInNewContext(`(async () => {${src}\nreturn { light }})()`, {
    document: { querySelector: () => paper ? doc : null, addEventListener: listen, getSelection: () => selection,
      querySelectorAll: selector => selector === '.logo, footer .wordmark' ? els : selector.startsWith('.report') ? controls :
        selector.startsWith('.ruled') ? [...rules.map(rect => ({ getBoundingClientRect: () => rect })), ...(selector.includes('table') ? tables : [])] :
        selector.includes('table') ? tables : selector.startsWith('h1') ? textNodes.filter(el => el.matches(selector)) : [],
      createElement: node, createElementNS: (_, tag) => tag === 'svg' ? ruler : node(), documentElement: doc,
      body: { append(el) { mounted.push(el) }, getBoundingClientRect: () => ({ left: 0 }) } },
    matchMedia: query => query.includes('reduced-motion') ? motion : mouse,
    addEventListener: listen, innerWidth: 1000, innerHeight: 800, scrollY: scroll, URL,
    loadClicks: async () => { clickLoads++; return { spark: (x, y) => clicks.push([x, y]) } },
    getComputedStyle: () => { measurements++; return sides },
    ResizeObserver: class { constructor(fn) { listen('layout', fn) } observe() {} },
    MutationObserver: class { constructor(fn) { this.fn = fn } observe(target) { listen(target === doc ? 'theme' : 'mutate', this.fn) } },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    fetch: async url => {
      requests.push(String(url))
      if (failure === 'network') throw new Error('offline')
      return { ok: failure !== 'http', text: async () => '<broken' }
    },
    DOMParser: class { parseFromString() { return { documentElement: { localName: 'parsererror' } } } },
  })
  const drain = () => {
    let n = 0
    while (frames.size && n < 100) {
      const batch = [...frames.values()]; frames.clear()
      for (const fn of batch) fn()
      n++
    }
    is(frames.size, 0, 'frame queue drains instead of spinning at rest')
    return n
  }
  return { els, frames, requests, motion, mouse, light, node, drain, doc, classes, ruler, gradient, path, sides, rules, tables, controls, defs,
    clicks, mounted, selection, clickLoads: () => clickLoads,
    measurements: () => measurements,
    emit: (name, event) => events.get(name)?.(event),
    move: (x, y, pointerType = 'mouse') => events.get('pointermove')({ clientX: x, clientY: y, pointerType }),
    paint: () => els[0]?.children[0].style.background,
  }
}

test('site: logo pointer frames coalesce, settle, reset and resume after resize', async () => {
  const g = await glint()
  g.drain()
  const rest = g.paint()
  const angle = paint => Number(paint.match(/from ([\d.e+-]+)deg/)[1])
  g.move(20, 40); g.move(180, 200)
  is(g.frames.size, 1, 'rapid moves share one pending frame')
  g.drain()
  ok(Math.abs(angle(g.paint()) - 135) < .2, 'the highlight faces the final pointer, southeast of the mark')
  g.move(180, 200); is(g.drain(), 1, 'repeating the settled position needs no continuation')
  ok(Math.abs(angle(g.paint()) - 135) < .2, 'the repeated position preserves the highlight direction')
  g.emit('pointerleave'); g.drain()
  const reset = g.paint()
  g.move(180, 200); g.drain()
  g.emit('blur'); g.drain()
  ok(Math.abs(angle(reset) - angle(rest)) < .2, 'exit restores the resting direction')
  ok(Math.abs(angle(g.paint()) - angle(rest)) < .2, 'window blur also restores it')
  g.els[0].rect.width = 0
  g.move(100, 120); is(g.drain(), 1, 'a hidden logo schedules no continuation')
  g.els[0].rect.width = 160
  g.els[0].rect.top = 900
  g.els[0].rect.bottom = 1060
  g.emit('resize'); is(g.drain(), 1, 'an offscreen logo schedules no continuation')
  g.els[0].rect.top = 40
  g.els[0].rect.bottom = 200
  g.emit('scroll'); g.drain()
  ok(!/NaN|Infinity/.test(g.paint()), 'the exact center stays finite after reveal')
})

test('site: logo respects touch and live reduced-motion changes', async () => {
  const g = await glint({ reduced: true })
  g.drain()
  const rest = g.paint()
  g.move(180, 200)
  is(g.frames.size, 0, 'reduced motion ignores pointer moves')
  is(g.paint(), rest, 'static lighting is unchanged')
  g.motion.matches = false; g.emit('motion'); g.drain()
  g.move(180, 200); g.drain()
  ok(g.paint() !== rest, 'turning motion on enables tracking')
  g.motion.matches = true; g.emit('motion')
  is(g.drain(), 1, 'turning motion off resets without interpolation')
  is(g.paint(), rest, 'reduced motion restores the exact resting paint')
  g.motion.matches = false
  g.move(180, 200, 'touch')
  is(g.frames.size, 0, 'touch events on a hybrid device do not animate')
  g.mouse.matches = false; g.emit('mouse'); g.drain()
  g.move(180, 200)
  is(g.frames.size, 0, 'a device without a fine pointer stays still')
})

test('site: failed silver enhancements preserve the original logo and its square lighting', async () => {
  const empty = await glint({ count: 0 })
  is(empty.requests.length, 0, 'no logo means no asset request')
  is(empty.frames.size, 0, 'no logo means no frame work')
  for (const failure of ['http', 'network', 'parse']) {
    const g = await glint({ failure }); g.drain()
    is(g.requests, ['https://jz.test/jz.svg'], 'the canonical asset resolves relative to the module')
    ok(g.paint().startsWith('conic-gradient('), `${failure}: the fallback image keeps its square reflection`)
  }
})

test('site: ruler reflection follows the pointer and remeasures only after layout changes', async () => {
  const g = await glint({ count: 0, paper: true })
  g.drain()
  is(g.requests.length, 0, 'rulers need no logo asset')
  is(g.mounted, [g.ruler], 'only rulers get a light layer; the grid stays static')
  is(g.path.attrs.d, 'M20.5,0V800M180.5,0V800M0,320.5H1000', 'reflection occupies the existing one-pixel dividers')
  const measured = g.measurements()
  g.move(180, 200); g.drain()
  ok(Math.abs(+g.gradient.attrs.cx - 180) + Math.abs(+g.gradient.attrs.cy - 200) < .1, 'light follows viewport pointer coordinates')
  is(g.measurements(), measured, 'pointer-only frames reuse ruler geometry')
  g.doc.dataset.theme = 'light'; g.emit('theme'); g.drain()
  g.move(800, 600); g.drain()
  ok(Math.abs(+g.gradient.attrs.cx - 800) + Math.abs(+g.gradient.attrs.cy - 600) < .1, 'light theme follows the pointer with the same field')
  const lightMeasured = g.measurements()
  g.move(800, 600)
  is(g.drain(), 1, 'repeating a settled light-mode position needs only one frame')
  is(g.measurements(), lightMeasured, 'light-mode pointer frames also reuse divider geometry')
  g.emit('pointerleave'); g.drain()
  ok(Math.abs(+g.gradient.attrs.cx - 500) + Math.abs(+g.gradient.attrs.cy + 160) < .1, 'leaving light mode’s field restores the overhead reflection')
  g.move(800, 600); g.drain()
  const before = { ...g.gradient.attrs }
  g.classes.add('jz-saver')
  g.doc.dataset.theme = 'dark'; g.emit('theme'); g.drain()
  g.move(600, 400); g.drain()
  is(g.gradient.attrs, before, 'fullscreen demos do not animate hidden reflections')
  g.classes.delete('jz-saver')
  g.classes.add('jz-embed'); g.emit('theme'); g.drain()
  is(g.gradient.attrs, before, 'embedded views do not animate hidden reflections')
  g.classes.delete('jz-embed')
  g.doc.dataset.theme = 'dark'; g.emit('theme'); g.drain()
  ok(Math.abs(+g.gradient.attrs.cx - 600) + Math.abs(+g.gradient.attrs.cy - 400) < .1, 'dark resumes at the current pointer')
  g.rules[0].top = 400
  g.emit('layout'); g.drain()
  ok(g.path.attrs.d.endsWith('M0,400.5H1000'), 'expanded content moves the reflection with its divider')
  g.rules[0].top = -1
  g.doc.clientWidth = 640
  g.emit('scroll'); g.drain()
  is(g.path.attrs.d, 'M20.5,0V800M180.5,0V800', 'offscreen dividers are omitted')
  is(g.ruler.attrs.viewBox, '0 0 640 800', 'SVG coordinates match the viewport after resize')
  for (const [top, visible] of [[0, true], [799, true], [800, false]]) {
    g.rules[0].top = top; g.emit('scroll'); g.drain()
    is(g.path.attrs.d.includes(`M0,${top + .5}H1000`), visible, `divider at viewport y=${top}`)
  }
  g.sides.left = 'auto'; g.rules[0].width = 0
  g.emit('resize'); g.drain()
  is(g.path.attrs.d, '', 'missing or hidden dividers produce no invalid path')
  g.doc.dataset.theme = 'light'; g.emit('theme')
  g.motion.matches = true; g.emit('motion'); g.drain()
  is(g.gradient.attrs, { cx: '500', cy: '-160' }, 'reduced motion returns to a static overhead light')
  g.move(10, 10)
  is(g.frames.size, 0, 'reduced motion does not schedule ruler animation')
  is(g.mounted, [g.ruler], 'pointer movement and theme changes never mount a grid light')
})

test('site: buttons use the logo bevel and tables remain matte', async () => {
  const g = await glint({ paper: true })
  const rect = { left: 20, top: 40, right: 180, bottom: 200, width: 160, height: 160 }
  const button = { disabled: false, classList: { add() {} }, children: [],
    append(el) { this.children.push(el) }, getBoundingClientRect: () => rect }
  g.controls.push(button)
  g.tables.push({ getBoundingClientRect: () => ({ left: 80, right: 800, bottom: 600, width: 720 }) })
  g.drain(); g.move(180, 200); g.drain()
  is(button.children[0].style.background, g.paint(), 'same position gives button and logo the exact same bevel')
  ok(!g.path.attrs.d.includes('600.5'), 'tables contribute no reflected path')
  ok(!g.path.attrs.d.includes('Z'), 'button bevel is its own masked ring, not a ruler rectangle')
  button.disabled = true; g.emit('mutate'); g.drain()
  is(button.children[0].style.visibility, 'hidden', 'disabled controls have no bright reflection')
  button.disabled = false; rect.width = 0; g.emit('toggle'); g.drain()
  is(button.children[0].style.visibility, 'hidden', 'collapsed controls have no reflection')
  rect.width = 160; rect.top = 800; rect.bottom = 960; g.emit('scroll'); g.drain()
  is(button.children[0].style.visibility, 'hidden', 'offscreen controls are omitted')
  rect.top = -20; rect.bottom = 140; g.emit('scroll'); g.drain()
  is(button.children[0].style.visibility, '', 'partially visible controls regain their bevel')
  g.doc.dataset.theme = 'light'; g.emit('theme'); g.drain()
  ok(button.children[0].style.background.includes('rgb(0 0 0 /'), 'light mode uses the same bevel in black')
})

test('site: thin title outlines track the light while stats, FAQ and JZ keep their fill', async () => {
  const text = (kind, width = 100, height = 16) => {
    const classes = new Set(), rect = { left: 20, top: 40, width, height, bottom: 40 + height }
    const fill = { textContent: 'Examples', getBoundingClientRect: () => rect }
    const outline = { textContent: 'Examples', isConnected: true, style: {} }
    return { textContent: 'Examples', rect, fill, outline,
      matches: selector => selector.split(', ').includes(kind),
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      querySelector: selector => selector === '.title-fill' ? fill : outline,
      style: { setProperty(name, value) { this[name] = value } }, getBoundingClientRect: () => rect }
  }
  const title = text('h1.title'), stat = text('.metrics b'), faq = text('h2'), logo = text('.logo-letters'), textNodes = [title, stat, faq, logo]
  const g = await glint({ paper: true, count: 0, textNodes }); g.drain()
  const lit = () => title.classList.contains('title-lit')
  const at = (x, y) => Math.abs(parseFloat(title.style['--light-x']) - x) + Math.abs(parseFloat(title.style['--light-y']) - y) < .15
  ok(!lit(), 'resting title retains its native fill')
  g.move(20, 40); g.drain()
  ok(lit(), 'nearby pointer reveals the outline')
  g.move(70, 48); g.drain()
  ok(at(50, 8), 'reflection uses local CSS pixels')
  const measured = g.measurements()
  g.move(70, 48); is(g.drain(), 1, 'repeated pointer position settles in one frame')
  is(g.measurements(), measured, 'pointer movement reuses measured geometry')
  title.rect.left = 40; title.rect.top = 20; g.emit('scroll'); g.drain()
  ok(at(30, 28), 'scroll remeasures the paint box')
  for (const el of [stat, faq, logo]) {
    ok(!el.classList.contains('title-lit'), 'stats, FAQ and JZ stay solid')
    is(Object.keys(el.style), ['setProperty'], 'unrelated glyphs receive no paint updates')
  }
  const filter = g.defs.children[0]
  is(filter.attrs.primitiveUnits, 'objectBoundingBox', 'inner-edge dimensions work across browser coordinate systems')
  const [rx, ry] = filter.parts.feGaussianBlur.attrs.stdDeviation.split(' ').map(Number)
  ok(Math.abs(rx * 100 - .6) + Math.abs(ry * 16 - .6) < 1e-12, 'the inner edge uses a subpixel soft mask instead of integer erosion')
  for (const value of ['2.36×', '2.36×', '1.04×']) {
    stat.textContent = value; g.emit('mutate'); g.drain()
    ok(!stat.classList.contains('title-lit'), 'rotating stats remain solid')
    is(g.defs.children.length, 1, 'stat changes create no glyph masks')
  }
  g.emit('pointerleave'); g.drain(); ok(!lit(), 'leaving restores the title fill')
  g.move(70, 48); g.drain(); g.move(900, 600); g.drain()
  ok(!lit(), 'moving elsewhere clears the cutout')
  g.move(70, 48); g.drain(); g.motion.matches = true; g.emit('motion'); g.drain()
  ok(!lit(), 'live reduced motion restores the fill')
  g.move(70, 48); is(g.frames.size, 0, 'reduced motion does not animate')
  g.motion.matches = false; g.emit('motion'); g.move(70, 48); g.drain()
  title.rect.width = 0; title.rect.height = 0; g.emit('resize'); g.drain()
  ok(!lit(), 'collapsed titles shed their cutout')
  is(filter.parts.feGaussianBlur.attrs.stdDeviation, '0.6 0.6', 'zero-size paint boxes retain finite mask dimensions')
  title.rect.width = 100; title.rect.height = 16; title.rect.top = 900; title.rect.bottom = 916
  g.emit('scroll'); g.drain(); ok(!lit(), 'offscreen titles stay unmasked')
})

test('site: selection outlines merge inline fragments, follow scroll, clear, and leave editors native', () => {
  const events = new Map(), frames = [], classes = new Set(), parts = []
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top })
  const nodes = [
    { nodeType: 3, textContent: 'First link', rects: [rect(20, 30, 90, 50)] },
    { nodeType: 3, textContent: ' next line', rects: [rect(90, 30, 140, 50), rect(20, 54, 100, 74)] },
    { nodeType: 3, textContent: 'outside viewport', rects: [rect(20, 900, 140, 920)] },
  ]
  const range = { commonAncestorContainer: { nodeType: 1 }, startContainer: nodes[0], startOffset: 2,
    endContainer: nodes[2], endOffset: 4, intersectsNode: () => true }
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range }
  const path = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  const svg = { namespaceURI: 'svg', setAttribute() {}, append() {} }
  const doc = { documentElement: { classList: { toggle(k, on) { if (on) classes.add(k); else classes.delete(k) } } },
    body: { append() {} }, activeElement: { closest: () => null }, getSelection: () => selection,
    createElementNS: (_, tag) => tag === 'svg' ? svg : path,
    createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] } },
    createRange: () => {
      let node
      const part = { selectNodeContents(n) { node = n }, setStart(n, offset) { this.start = [n, offset] },
        setEnd(n, offset) { this.end = [n, offset] }, getClientRects: () => node.rects }
      parts.push(part); return part
    },
    addEventListener: (name, fn) => events.set(name, fn),
  }
  runInNewContext(readFileSync(join(root, 'assets/selection.js'), 'utf8'), {
    document: doc, NodeFilter: { SHOW_TEXT: 4 }, innerHeight: 800,
    addEventListener: (name, fn) => events.set(name, fn), requestAnimationFrame: fn => { frames.push(fn); return 1 },
  })
  const flush = () => { while (frames.length) frames.shift()() }
  is(path.attrs.d, 'M20,30H140V50H20ZM20,54H100V74H20Z', 'wrapped selection has one rectangle per visible line, with adjacent link fragments joined')
  is(parts[0].start, [nodes[0], 2], 'first text slice uses the native start offset')
  is(parts[2].end, [nodes[2], 4], 'last text slice uses the native end offset')
  is([range.startOffset, range.endOffset], [2, 4], 'native selection is untouched for copying')
  ok(classes.has('outline-selection'), 'transparent selection is enabled only with visible outlines')
  nodes[0].rects = [rect(20, 10, 90, 30)]; nodes[1].rects = [rect(90, 10, 140, 30)]
  events.get('scroll')(); events.get('scroll')(); is(frames.length, 1, 'scroll updates coalesce')
  flush(); is(path.attrs.d, 'M20,10H140V30H20Z', 'outlines track the new viewport geometry')
  selection.isCollapsed = true; events.get('selectionchange')(); flush()
  is(path.attrs.d, '', 'clearing the native selection removes outlines')
  ok(!classes.has('outline-selection'), 'clearing restores native highlighting')
  selection.isCollapsed = false; doc.activeElement.closest = () => ({ tagName: 'TEXTAREA' })
  events.get('selectionchange')(); flush(); is(path.attrs.d, '', 'editors retain their native selection')
  doc.activeElement.closest = () => null; doc.getSelection = () => null
  events.get('selectionchange')(); flush(); is(path.attrs.d, '', 'missing selection leaves no overlay')
})

test('site: sparkles require a completed background click', async () => {
  const g = await glint({ count: 0, paper: true, scroll: 800 })
  const click = { button: 0, clientX: 101, clientY: 203, target: { closest: () => null } }
  g.emit('pointerdown', click); await Promise.resolve()
  is(g.clickLoads(), 0, 'beginning a press or touch scroll does not even load the click layer')
  for (const tag of ['a', 'button', 'iframe', 'input', 'summary', 'select', 'textarea', '.grid-info'])
    g.emit('click', { ...click, target: { closest: selector => selector.split(', ').includes(tag) ? {} : null } })
  g.emit('click', { ...click, button: 2 }); await Promise.resolve()
  g.selection.isCollapsed = false; g.emit('click', click); await Promise.resolve()
  g.selection.isCollapsed = true
  is(g.clickLoads(), 0, 'controls and secondary clicks never load the click layer')
  g.emit('click', click); await Promise.resolve()
  g.emit('click', click); await Promise.resolve()
  g.emit('click', { ...click, clientX: 280, clientY: 320 }); await Promise.resolve()
  is(g.clicks, [[101, 1003], [101, 1003], [280, 1120]], 'completed clicks preserve repeated and changed document positions')
  g.doc.dataset.theme = 'light'; g.emit('click', click); await Promise.resolve()
  is(g.clickLoads(), 3, 'light mode does not request sparkles')
  const plain = await glint({ count: 0 }); plain.emit('click', click); await Promise.resolve()
  is(plain.clickLoads(), 0, 'pages without the grid do not request sparkles')
})

function clickGrid({ canvas = true, width = 800, height = 600, left = 0, top = 0, dpr = 1 } = {}) {
  const events = new Map(), frames = new Map(), mounted = [], segments = []
  let clock = 1000, id = 0, start
  const transforms = [], rect = { width, height, left, top }
  const doc = { dataset: { theme: 'dark' }, classList: { contains: () => false } }
  const context = {
    setTransform(...v) { transforms.push(v) }, clearRect() { segments.length = 0 }, beginPath() {}, stroke() {},
    moveTo(x, y) { start = [x, y] }, lineTo(x, y) { segments.push([...start, x, y]) },
    createLinearGradient() { return { addColorStop() {} } },
  }
  const env = { document: { documentElement: doc, hidden: false,
    addEventListener: (name, fn) => events.set(name, fn), body: { append: el => mounted.push(el) },
    createElement: () => ({ getContext: () => canvas ? context : null, setAttribute() {}, getBoundingClientRect: () => rect }) },
    addEventListener: (name, fn) => events.set(name, fn), innerWidth: 800, innerHeight: 600, devicePixelRatio: dpr, scrollY: 0,
    performance: { now: () => clock }, getComputedStyle: () => ({ backgroundPositionX: '20px' }),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { events.set('theme', fn) } observe() {} },
  }
  const source = readFileSync(join(root, 'assets/grid-click.js'), 'utf8').replace('export const spark', 'const spark')
  const spark = runInNewContext(`(() => {${source}\nreturn spark})()`, env)
  return { env, doc, frames, mounted, segments, transforms, rect, spark, emit: name => events.get(name)?.(),
    tick: delta => { clock += delta; const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(clock)) },
  }
}

test('site: click bursts are lazy, grid-aligned, bounded and attached to the document', () => {
  const g = clickGrid()
  is(g.mounted.length, 0, 'no canvas before a click')
  is(g.frames.size, 0, 'no automatic click-layer loop')
  g.spark(NaN, 0); g.spark(0, Infinity)
  is(g.frames.size, 0, 'invalid coordinates do not start work')
  g.env.scrollY = 800; g.spark(101, 1003); g.tick(100)
  is(g.mounted.length, 1, 'a click below the header creates one viewport layer')
  is(g.segments[0], [100.5, 200.5, 117.3, 200.5], 'right ray leaves the nearest document grid junction')
  g.env.scrollY = 813; g.tick(0)
  is(g.segments[0], [100.5, 187.5, 117.3, 187.5], 'scroll moves the same burst with its document crossing')
  for (let i = 0; i < 20; i++) g.spark(101, 1003)
  is(g.frames.size, 1, 'repeated clicks share one frame loop')
  g.tick(100)
  is(g.segments.length, 16 * 4, 'at most sixteen four-arm bursts remain live')
  g.tick(10_000)
  is(g.segments.length, 0, 'expired bursts clear the layer')
  is(g.frames.size, 0, 'the loop stops after the final burst')
})

test('site: click canvas preserves grid coordinates at the right edge with scrollbars and fractional scaling', () => {
  for (const dpr of [1, 1.25, 2]) {
    const g = clickGrid({ width: 785, height: 599.5, left: 3, top: 2, dpr })
    g.spark(780, 200); g.tick(0)
    const [sx, , , sy] = g.transforms[0]
    is([g.mounted[0].width, g.mounted[0].height], [Math.round(785 * dpr), Math.round(599.5 * dpr)], 'backing store uses the displayed canvas, excluding the scrollbar')
    const [x, y] = g.segments[0].slice(2)
    ok(Math.abs(x * sx * 785 / g.mounted[0].width + 3 - 780.5) < 1e-10, `DPR ${dpr}: right ray aligns at the same CSS grid crossing`)
    ok(Math.abs(y * sy * 599.5 / g.mounted[0].height + 2 - 200.5) < 1e-10, `DPR ${dpr}: vertical coordinates survive backing-store rounding`)
  }
  const hidden = clickGrid({ width: 0 }); hidden.spark(10, 20)
  is(hidden.frames.size, 0, 'zero-size canvas does not animate')
})

test('site: click bursts clear on light mode or a hidden tab, then resume only on a new click', () => {
  const g = clickGrid()
  g.spark(100, 200); g.tick(100)
  g.doc.dataset.theme = 'light'; g.emit('theme')
  is(g.frames.size, 0, 'light mode stops the loop')
  is(g.segments.length, 0, 'light mode clears existing rays')
  g.spark(100, 200)
  is(g.frames.size, 0, 'light mode cannot create black sparkles')
  g.doc.dataset.theme = 'dark'; g.emit('theme')
  is(g.frames.size, 0, 'returning to dark does not restart old bursts')
  g.spark(100, 200); g.tick(100)
  is(g.segments.length, 4, 'a fresh click draws fresh rays')
  g.env.document.hidden = true; g.emit('visibilitychange')
  is(g.frames.size, 0, 'hidden tabs stop the loop')
  is(g.segments.length, 0, 'hidden tabs clear rays')
  g.env.document.hidden = false; g.spark(100, 200); g.tick(100); g.emit('resize')
  is(g.frames.size, 0, 'resize retires bursts rather than moving them off the new grid')
  is(g.segments.length, 0, 'resize clears the old crossing positions')
  const missing = clickGrid({ canvas: false }); missing.spark(100, 200)
  is(missing.frames.size, 0, 'unavailable canvas creates no loop')
  is(missing.mounted.length, 0, 'unavailable canvas leaves no empty overlay')
})

// Run the page's grid controller, mocking only browser/engine boundaries. The numeric
// simulation's JS/WASM parity is covered by grid-current.js; these tests pin its lifecycle.
function gridDemo({ failure, gate = Promise.resolve(), hidden = false, width = 160, height = 240, dpr = 1, viewport = 1280, wordRight = 300 } = {}) {
  const events = new Map(), frames = new Map(), sizes = [], draws = []
  const listen = (name, fn) => events.set(name, [...events.get(name) || [], fn])
  const emit = (name, event) => events.get(name)?.forEach(fn => fn(event))
  const rect = { width, height, left: 0, top: 0 }
  const engine = mode => ({
    resize(w, h) { sizes.push([mode, w, h]); this.px = new Uint32Array(w * h); return failure === 'boxed' && mode === 'wasm' ? NaN : this.px },
    configure() {}, frame() {
      if (failure === 'frame' && mode === 'wasm') throw new Error('trap')
      this.px.fill(mode === 'wasm' ? 11 : 22)
    },
  })
  const wasm = engine('wasm'), js = engine('js'), summary = { focus() { this.focused = true },
    getBoundingClientRect: () => ({ left: parseFloat(info.style.left), right: parseFloat(info.style.left) + 24 }) }, description = {}
  const picker = { disabled: true, value: 'wasm', setAttribute(k, v) { this[k] = String(v) }, addEventListener: listen }, stats = { textContent: 'Loading…' }
  const pop = { style: {}, get offsetWidth() { return Math.min(240, ctx.root.clientWidth - 32) } }
  const info = { open: true, style: { setProperty(k, v) { this[k] = v } }, querySelector: s => s === 'summary' ? summary : s === '.grid-pop' ? pop : description, contains: () => false, addEventListener: listen }
  const canvas = { style: {}, getBoundingClientRect: () => rect, getContext: () => failure === 'canvas' ? null : {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: img => draws.push(new Uint32Array(img.data.buffer)[0]),
  } }
  const nodes = { 'grid-current': canvas, 'grid-info': info, 'grid-engine': picker, 'grid-stats': stats,
    'hero-wasm': { getBoundingClientRect: () => ({ right: wordRight, top: 40, height: 40 }) } }
  let id = 0
  const ctx = {
    $: key => nodes[key], root: { dataset: { theme: 'dark' }, clientWidth: viewport },
    document: { hidden, addEventListener: listen, querySelector: () => ({ getBoundingClientRect: () => ({ bottom: rect.height - ctx.scrollY }) }) }, addEventListener: listen,
    performance: { now: () => 1 }, devicePixelRatio: dpr, scrollY: 0,
    getComputedStyle: () => ({ backgroundPositionX: '160px' }),
    Uint32Array, ArrayBuffer, Blob, URL: { createObjectURL: () => 'blob:grid', revokeObjectURL() {} },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { events.set('timer', [fn]); return 1 }, clearTimeout() {},
    MutationObserver: class { constructor(fn) { listen('theme', fn) } observe() {} },
    IntersectionObserver: class { constructor(fn) { listen('visible', fn) } observe() {} },
    ResizeObserver: class { constructor(fn) { listen('layout', fn) } observe() {} },
    fetch: async () => {
      await gate
      if (failure === 'network') throw new Error('offline')
      return { ok: failure !== 'source', text: async () => '' }
    },
    loadJS: async () => js,
    loadWasm: async () => { if (failure === 'wasm') throw new Error('unavailable'); return { compile() {}, instantiate: () => ({ exports: wasm }) } },
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const source = html.slice(html.indexOf("const cv = $('grid-current')"), html.indexOf('// ── dev tuning panel'))
    .replace('await import(u)', 'await loadJS()').replace("await import('./dist/jz.js')", 'await loadWasm()')
  const api = runInNewContext(`(() => {${source}\nreturn { boot, sync }})()`, ctx)
  return { ...api, ctx, picker, stats, info, pop, summary, description, canvas, rect, sizes, draws, frames, emit,
    tick: (now = 1000) => { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(now)) },
    select: mode => { if (picker.value !== mode) emit('click') },
  }
}

test('site: grid engines reuse buffers through WASM → WASM → JS → WASM and stop when hidden', async () => {
  const g = gridDemo()
  await g.boot(); g.tick()
  is(g.draws, [11], 'first frame displays the selected WASM output')
  g.select('wasm'); g.tick(); g.select('js'); g.tick(); g.select('wasm'); g.tick()
  is(g.draws, [11, 11, 22, 11], 'switching displays the selected engine, including a repeated selection')
  is(g.sizes, [['wasm', 160, 240], ['js', 160, 240]], 'switching reuses each engine’s pixel buffer')
  is(g.description.textContent, 'This header animation runs WebAssembly compiled by JZ.', 'description names the actual engine')
  g.ctx.document.hidden = true; await g.sync()
  is(g.frames.size, 0, 'hidden tabs stop requesting frames')
  g.ctx.document.hidden = false; await g.sync()
  is(g.frames.size, 1, 'visible tab resumes exactly one loop')
  g.ctx.root.dataset.theme = 'light'; g.emit('theme')
  is(g.frames.size, 0, 'light mode cancels the loop')
  g.ctx.root.dataset.theme = 'dark'; await g.sync(); g.tick(2000)
  is(g.draws.at(-1), 11, 'dark resumes with the chosen engine')
  g.emit('visible', [{ isIntersecting: false }])
  is(g.frames.size, 0, 'scrolling below the header stops automatic sparkles')
  g.emit('visible', [{ isIntersecting: true }]); await g.sync(); g.tick()
  is(g.draws.at(-1), 11, 'returning to the header resumes the chosen engine')
  is(g.canvas.style.height, '240px', 'automatic canvas ends at the header boundary')
  is([g.info.style.left, g.info.style.top, g.info.style['--info-drop']], ['302px', '36px', '52px'], 'superscript info follows WASM; its popover clears the word')
})

test('site: grid info opens right when it fits and stays within narrow viewports', async () => {
  for (const [viewport, wordRight, left, top] of [
    [1280, 300, 334, '0px'], [590, 300, 334, '0px'],
    [589, 300, 86, 'var(--info-drop)'], [200, 175, 16, 'var(--info-drop)'],
    [260, 10, 16, 'var(--info-drop)'],
  ]) {
    const g = gridDemo({ viewport, wordRight }); await g.boot()
    const x = parseFloat(g.info.style.left) + parseFloat(g.pop.style.left)
    is([x, g.pop.style.top], [left, top], `${viewport}px viewport / ${wordRight}px anchor: placement`)
    ok(x >= 16 && x + g.pop.offsetWidth <= viewport - 16, 'panel stays within both viewport edges')
  }
  const g = gridDemo(); await g.boot()
  g.ctx.root.clientWidth = 589; g.emit('resize'); g.emit('timer')
  is(g.pop.style.top, 'var(--info-drop)', 'open panel moves below after resize')
  g.emit('keydown', { key: 'Escape' })
  is([g.info.open, g.summary.focused], [false, true], 'Escape closes and restores focus')
  g.ctx.root.clientWidth = 900; g.info.open = true; g.emit('toggle')
  is([g.pop.style.left, g.pop.style.top], ['32px', '0px'], 'reopening recomputes available space')
  g.emit('pointerdown', { target: {} })
  is(g.info.open, false, 'outside click closes the panel')
})

test('site: JS/JZ switch reports its engine and separates frame stats with a comma', async () => {
  const g = gridDemo(); await g.boot()
  is([g.picker.disabled, g.picker['aria-checked']], [false, 'true'], 'ready switch starts on JZ')
  g.tick(1000); g.tick(1600)
  is(g.stats.textContent, '0.00 ms/frame, 3 fps', 'readout uses a comma between values')
  g.emit('click'); g.tick()
  is([g.picker.value, g.picker['aria-checked'], g.draws.at(-1)], ['js', 'false', 22], 'click selects JS in the UI and renderer')
  g.emit('click'); g.tick()
  is([g.picker.value, g.picker['aria-checked'], g.draws.at(-1)], ['wasm', 'true', 11], 'next click restores JZ')
})

test('site: grid backing store stays on an integer grid at low and high display scales', async () => {
  for (const [dpr, scale] of [[.25, 1], [.49, 1], [.5, 1], [1.49, 1], [1.5, 2], [3, 2]]) {
    const g = gridDemo({ dpr }); await g.boot(); g.tick()
    is(g.sizes, [['wasm', 160 * scale, 240 * scale]], `DPR ${dpr}: positive integer backing scale`)
    is(g.draws, [11], `DPR ${dpr}: computed pixels reach the canvas`)
  }
})

test('site: grid boot races, missing source, missing canvas and unsupported WASM have honest states', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = gridDemo({ gate })
  slow.ctx.root.dataset.theme = 'light'; slow.emit('theme'); release(); await slow.boot()
  is(slow.frames.size, 0, 'loading after a switch to light cannot start a hidden loop')
  slow.ctx.root.dataset.theme = 'dark'; await slow.sync()
  is(slow.frames.size, 1, 'the loaded engine starts when dark returns')
  for (const failure of ['wasm', 'boxed', 'source', 'network', 'canvas']) {
    const g = gridDemo({ failure }); await g.boot(); g.tick()
    if (failure === 'wasm' || failure === 'boxed') {
      is(g.picker.value, 'js', `${failure}: JS selected`)
      is(g.draws, [22], `${failure}: the JS buffer reaches the canvas`)
      is([g.picker.disabled, g.picker['aria-checked']], [true, 'false'], `${failure}: switch stays on JS when WASM is unavailable`)
      is(g.description.textContent, 'This header animation runs the same JavaScript source.', `${failure}: no false WASM claim`)
    } else {
      is(g.stats.textContent, 'Grid unavailable', `${failure}: failure is visible`)
      is(g.picker.disabled, true, `${failure}: unavailable engines cannot be selected`)
      is(g.frames.size, 0, `${failure}: no empty animation loop`)
    }
  }
  const empty = gridDemo({ width: 0, height: 0 }); await empty.boot(); empty.tick()
  is(empty.sizes, [], 'zero-sized canvas allocates no buffer')
  empty.rect.width = 160; empty.rect.height = 240; empty.emit('resize'); empty.emit('timer'); await empty.sync(); empty.tick()
  is(empty.draws, [11], 'a zero-sized canvas resumes once laid out')
  const trapped = gridDemo({ failure: 'frame' }); await trapped.boot(); trapped.tick()
  is(trapped.stats.textContent, 'Grid unavailable', 'a frame trap is visible')
  is(trapped.frames.size, 0, 'a frame trap stops instead of retrying every frame')
  trapped.select('js'); await trapped.sync(); trapped.tick()
  is(trapped.draws, [22], 'switching to JS recovers from a trapped WASM frame')
})

test('site: dark is the default; explicit light and dark preferences survive navigation', () => {
  const files = ['index.html', 'guide/index.html', 'examples/index.html', 'bench/index.html', '404.html', 'repl/index.html']
  const scripts = files.map(file => [file, readFileSync(join(root, file), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]])
  scripts.push(['theme module', readFileSync(join(root, 'assets/theme.js'), 'utf8')])
  scripts.push(['demo theme', readFileSync(join(root, 'examples/lib/jzdemo.js'), 'utf8').match(/;\(\(\) => \{[\s\S]*?\n\}\)\(\)/)[0]])
  for (const [name, script] of scripts) for (const saved of [null, '', 'dark', 'light', 'invalid', 'blocked']) {
    const dataset = {}, writes = []
    runInNewContext(script, {
      document: { documentElement: { dataset }, querySelectorAll: () => [] }, addEventListener() {},
      localStorage: {
        getItem() { if (saved === 'blocked') throw new Error('storage blocked'); return saved },
        setItem(...args) { writes.push(args) },
      },
    })
    is(dataset.theme, saved === 'light' ? 'light' : 'dark', `${name}: saved ${saved}`)
    is(writes.length, 0, 'initialization does not persist an implicit preference')
  }
  const dataset = {}, writes = [], handlers = []
  runInNewContext(scripts.find(([name]) => name === 'theme module')[1], {
    document: { documentElement: { dataset }, querySelectorAll: () => [{ addEventListener: (_, fn) => handlers.push(fn) }] },
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) },
  })
  handlers[0](); is(dataset.theme, 'light', 'first toggle selects light')
  handlers[0](); is(dataset.theme, 'dark', 'second toggle restores dark')
  is(writes, [['theme', 'light'], ['theme', 'dark']], 'only explicit toggles persist')
})

test('site: theme toggles remain usable when storage reads and writes fail', () => {
  const dataset = {}, handlers = []
  let reads = 0, writes = 0
  const script = readFileSync(join(root, 'assets/theme.js'), 'utf8')
  const context = {
    document: { documentElement: { dataset }, querySelectorAll: () => [{ addEventListener: (_, fn) => handlers.push(fn) }] },
    localStorage: {
      getItem() { reads++; throw new Error('read blocked') },
      setItem() { writes++; throw new Error('write blocked') },
    },
  }
  runInNewContext(script, context)
  is(dataset.theme, 'dark', 'blocked storage defaults dark')
  handlers[0](); is(dataset.theme, 'light', 'write failure still changes the displayed theme')
  handlers[0](); is(dataset.theme, 'dark', 'a second toggle still works')
  is(writes, 2, 'each explicit toggle attempts to persist its choice')
  dataset.theme = 'light'
  runInNewContext(script, { ...context })
  is(dataset.theme, 'light', 'module preserves the head snippet’s selected theme')
  is(reads, 1, 'an initialized theme needs no further storage read')
})

test('site: guide is canonical and the sitemap uses its current URL', () => {
  const guide = readFileSync(join(root, 'guide/index.html'), 'utf8')
  ok(guide.includes('<title>Guide | JZ</title>'), 'short page title')
  ok(guide.includes('rel="canonical" href="https://jz.js.org/guide/"'), 'canonical URL')
  const sitemap = spawnSync(process.execPath, [join(root, 'scripts/sitemap.mjs'), root], { encoding: 'utf8' })
  is(sitemap.status, 0, sitemap.stderr)
  ok(sitemap.stdout.includes('<loc>https://jz.js.org/guide/</loc>'), 'guide indexed')
  ok(!sitemap.stdout.includes('/get-started/'), 'old route excluded')
})

test('site: primary menus keep the same destinations and the self-compile badge names a real workflow', () => {
  for (const file of ['index.html', 'guide/index.html', 'examples/index.html', 'bench/index.html', 'floatbeat/index.html', 'examples/lib/jzdemo.js']) {
    const html = readFileSync(join(root, file), 'utf8')
    const nav = html.match(/<nav class="[^"]*site-nav"[^>]*>([\s\S]*?)<\/nav>/)[1]
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    is(links.map(([, href, label]) => [href.replace(/^(\.\.\/)+/, ''), label]),
      [['guide/', 'guide'], ['examples/', 'examples'], ['bench/', 'bench'], ['repl/', 'repl']], file)
  }
  const home = readFileSync(join(root, 'index.html'), 'utf8')
  ok(!home.includes('selfhost.yml'), 'no stale self-host workflow URL')
  ok(home.includes('workflows/self-compile.yml/badge.svg'), 'badge uses self-compile workflow')
  ok(readFileSync(join(root, '.github/workflows/self-compile.yml'), 'utf8').includes('name: self-compile'), 'linked workflow exists')
})

test('site: Pages redeploys only successful main-push benchmark snapshots', () => {
  const pages = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8')
  const trigger = pages.match(/  workflow_run:\n([\s\S]*?)(?=\n\S)/)[1]
  ok(trigger.includes('workflows: [bench]') && trigger.includes('types: [completed]'), 'benchmark completion triggers deployment')
  ok(trigger.includes('branches: [main]'), 'completion trigger is restricted to main')
  const condition = pages.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)[1].trim()
  const run = { conclusion: 'success', event: 'push', head_repository: { full_name: 'dy/jz' } }
  const allowed = (event_name, workflow_run) => runInNewContext(condition, {
    github: { event_name, repository: 'dy/jz', event: { workflow_run } },
  })
  is(allowed('push'), true, 'ordinary site pushes still deploy')
  is(allowed('workflow_dispatch'), true, 'manual site deployment still works')
  is(allowed('workflow_run', run), true, 'successful main push deploys')
  for (const conclusion of ['failure', 'cancelled', 'skipped'])
    is(allowed('workflow_run', { ...run, conclusion }), false, conclusion + ' cannot deploy')
  is(allowed('workflow_run', { ...run, event: 'pull_request' }), false, 'PR completion cannot deploy')
  is(allowed('workflow_run', { ...run, head_repository: { full_name: 'fork/jz' } }), false, 'fork completion cannot deploy')
  ok(pages.includes("ref: ${{ github.event_name == 'workflow_run' && 'main' || github.sha }}"), 'checkout includes the later snapshot commit')
  ok(pages.includes('node test/headline.js'), 'deployment gates dataset loading and Perry rendering')
})

test('site: benchmark publication requires Perry evidence and a successful push', () => {
  const workflow = readFileSync(join(root, '.github/workflows/bench.yml'), 'utf8')
  const step = workflow.slice(workflow.indexOf('      - name: publish bench snapshot'))
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
  ok(script.includes(',perry,'), 'published run includes Perry')
  ok(script.includes('--json=bench/results-ci.json'), 'runner writes directly to its own dataset')
  ok(script.includes('cp bench/results.json bench/results-ci.json'), 'refresh uses current reference checksums')
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-publish-'))
  try {
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'bench')); mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(join(dir, 'bench/results.json'), '{"reference":"unchanged"}')
    copyFileSync(join(root, 'assets/headline.js'), join(dir, 'assets/headline.js'))
    writeFileSync(join(dir, 'bench/bench.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync('bench/results-ci.json', process.env.SNAPSHOT)
`)
    // Execute the real publication shell with a local git fixture, never a remote.
    writeFileSync(join(dir, 'bin/git'), `#!/bin/sh
echo "$*" >> "$GIT_LOG"
case "$1" in
  push) test "$PUSH_OK" = 1 ;;
  merge-base) test "$HISTORY_OK" = 1 ;;
  diff) if test "$2" = --cached; then exit 1; fi; test "$INPUTS_SAME" = 1 ;;
esac
`, { mode: 0o755 })
    const good = { cases: { alpha: { targets: { perry: { medianUs: 1, parity: 'ok' } } } } }
    const run = (snapshot = good, extra = {}) => {
      const log = join(dir, 'git.log')
      writeFileSync(log, '')
      const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8',
        env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
          GIT_LOG: log, GITHUB_SHA: 'source', INPUTS_SAME: '1', HISTORY_OK: '1', PUSH_OK: '1', SNAPSHOT: JSON.stringify(snapshot), ...extra },
      })
      return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
    }
    const success = run()
    is(success.status, 0, success.stderr)
    is(success.calls.filter(c => c === 'push').length, 1, 'one successful push finishes publication')
    is(success.calls.filter(c => c.startsWith('add ')), ['add bench/results-ci.json'], 'only CI evidence is staged')
    is(readFileSync(join(dir, 'bench/results.json'), 'utf8'), '{"reference":"unchanged"}', 'reference evidence is preserved')
    for (const perry of [undefined, { status: 'fail' }, { medianUs: 1, parity: 'DIFF' }, { medianUs: 0, parity: 'ok' }]) {
      const rejected = run({ cases: { alpha: { targets: { perry } } } })
      is(rejected.status, 1, 'missing, failed, wrong, or zero-time Perry evidence blocks publication')
      is(rejected.calls, [], 'invalid snapshot never reaches git')
    }
    const exhausted = run(good, { PUSH_OK: '0' })
    is(exhausted.status, 1, 'exhausted retries fail CI')
    is(exhausted.calls.filter(c => c === 'push').length, 3, 'three publication attempts')
    for (const extra of [{ INPUTS_SAME: '0' }, { HISTORY_OK: '0' }]) {
      const stale = run(good, extra)
      is(stale.status, 0, 'changed inputs or history yield to the newer run')
      is(stale.calls.includes('push'), false, 'stale evidence is never pushed')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('site: gallery stays current and renders into the deployment directory', () => {
  const checked = build('--check')
  is(checked.status, 0, checked.stderr)
  const html = readFileSync(join(root, 'examples/index.html'), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'jz-gallery-'))
  try {
    mkdirSync(join(dir, 'examples'))
    const file = join(dir, 'examples/index.html')
    const stale = html.replace(/<!-- gallery:start -->[\s\S]*?<!-- gallery:end -->/, '<!-- gallery:start --><!-- gallery:end -->')
    writeFileSync(file, stale)
    is(build(dir, '--check').status, 1, 'stale deployment is detected')
    is(readFileSync(file, 'utf8'), stale, 'check mode does not write')
    is(build(dir).status, 0, 'deployment generation succeeds')
    is(readFileSync(file, 'utf8'), html, 'deployment includes the complete static gallery')
    is(build(dir, '--check').status, 0, 'generation is idempotent')

    const start = '<!-- gallery:start -->', end = '<!-- gallery:end -->'
    for (const invalid of ['', start, end, end + start, start + start + end, start + end + end, start + end + start + end]) {
      writeFileSync(file, invalid)
      const result = build(dir)
      is(result.status, 1, 'reject malformed markers: ' + JSON.stringify(invalid))
      ok(result.stderr.includes('Expected one gallery block'), 'actionable marker error')
      is(readFileSync(file, 'utf8'), invalid, 'malformed template is never overwritten')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('site: catalog empty → A → A → B escapes text and replaces only the gallery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-gallery-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'examples'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    copyFileSync(join(root, 'scripts/build-site.mjs'), join(dir, 'scripts/build-site.mjs'))
    const file = join(dir, 'examples/index.html')
    const catalog = rows => writeFileSync(join(dir, 'examples/examples.js'), `export const examples = ${JSON.stringify(rows)}`)
    const run = () => spawnSync(process.execPath, [join(dir, 'scripts/build-site.mjs')], { encoding: 'utf8' })
    const read = () => readFileSync(file, 'utf8')
    writeFileSync(file, '<header>keep</header><!-- gallery:start -->stale<!-- gallery:end --><footer>keep</footer>')
    catalog([])
    is(run().status, 0, 'empty catalog builds')
    is(read(), '<header>keep</header><!-- gallery:start -->\n\n<!-- gallery:end --><footer>keep</footer>', 'zero cards; surrounding markup preserved')

    catalog([{ name: 'a', title: 'A "quoted" & <tag>', blurb: "it's <safe> & costs $&" }])
    is(run().status, 0, 'single-entry catalog builds')
    const a = read()
    ok(a.includes('alt="A &quot;quoted&quot; &amp; &lt;tag&gt;"'), 'attribute text escaped')
    ok(a.includes('it&#39;s &lt;safe&gt; &amp; costs $&amp;'), 'body text escaped; replacement metacharacters literal')
    is(run().status, 0, 'same catalog builds again')
    is(read(), a, 'A → A is byte-identical')

    catalog([{ name: 'b', title: 'B', blurb: 'new caption' }])
    is(run().status, 0, 'changed catalog builds')
    const b = read()
    is((b.match(/class="cell"/g) || []).length, 1, 'A → B replaces, rather than appends')
    ok(b.includes('href="./b/"') && b.includes('new caption') && !b.includes('href="./a/"'), 'only the new entry remains')
    ok(b.startsWith('<header>keep</header>') && b.endsWith('<footer>keep</footer>'), 'A → B preserves surrounding markup')

    catalog([null])
    is(run().status, 1, 'invalid entry fails the build')
    is(read(), b, 'invalid catalog leaves the last valid page untouched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

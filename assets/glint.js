// One cursor light for the grid, rulers, bevels and reflective ink.
const root = document.documentElement, radius = 320
const edge = el => {
  const ring = document.createElement('span')
  ring.className = 'edge-refl'
  ring.setAttribute('aria-hidden', 'true')
  el.append(ring)
  return { el, ring }
}
const logos = [...document.querySelectorAll('.logo, footer .wordmark')].map(edge)
const boxes = new Map(), surfaces = new Map()
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const mouse = matchMedia('(hover: hover) and (pointer: fine)')
const field = { x: innerWidth / 2, y: -160 }
let pointer = null, raf = 0, dirty = true, ink = []
let titleId = 0
const aperture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="a" x2="1" y2=".6"><stop offset=".2" stop-color="white" stop-opacity="0"/><stop offset=".44" stop-color="white"/><stop offset=".56" stop-color="white"/><stop offset=".8" stop-color="white" stop-opacity="0"/></linearGradient></defs><rect width="640" height="640" fill="url(#a)"/></svg>')}`

let ruler
if (document.querySelector('html.paper')) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  el.setAttribute('class', 'ruler-refl')
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = `<defs><radialGradient id="ruler-light" gradientUnits="userSpaceOnUse" r="${radius}">
    <stop stop-color="currentColor" stop-opacity=".65"/><stop offset=".3" stop-color="currentColor" stop-opacity=".22"/>
    <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
  </radialGradient></defs><path fill="none" stroke="url(#ruler-light)" stroke-width="1"/>`
  document.body.append(el)
  const grid = document.createElement('div')
  grid.className = 'grid-light'
  grid.setAttribute('aria-hidden', 'true')
  document.body.append(grid)
  ruler = { el, grid, gradient: el.querySelector('radialGradient'), path: el.querySelector('path'),
    defs: el.querySelector('defs') }
}

// One inner edge, shaded by the same light as the square rings. No displaced copy of the glyph.
const surface = (el, xray, defs = ruler.defs) => {
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter')
  const id = `ink-${titleId++}`
  filter.setAttribute('id', id)
  filter.setAttribute('primitiveUnits', 'objectBoundingBox')
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  filter.innerHTML = `<feMorphology in="SourceAlpha" operator="erode" result="inside"/>
    <feComposite in="SourceAlpha" in2="inside" operator="out" result="outline"/>
    <feOffset in="SourceAlpha" result="litOffset"/>
    <feComposite in="SourceAlpha" in2="litOffset" operator="out" result="litEdge"/>
    <feOffset in="SourceAlpha" result="backOffset"/>
    <feComposite in="SourceAlpha" in2="backOffset" operator="out" result="backEdge"/>
    <feFlood flood-color="white" flood-opacity="${xray ? '.12' : '.7'}"/>
    <feComposite in2="outline" operator="in" result="base"/>
    <feFlood flood-color="white" flood-opacity=".85"/>
    <feComposite in2="litEdge" operator="in" result="highlight"/>
    <feFlood flood-color="white" flood-opacity=".3"/>
    <feComposite in2="backEdge" operator="in" result="back"/>
    <feMerge result="shade"><feMergeNode in="base"/><feMergeNode in="highlight"/><feMergeNode in="back"/></feMerge>
    <feComposite in="SourceGraphic" in2="shade" operator="in" result="edge"/>
    <feComposite in="SourceGraphic" in2="inside" operator="in" result="solid"/>
    ${xray ? `<feImage href="${aperture}" x="-1000" y="-1000" result="mask"/>
    <feComposite in="solid" in2="mask" operator="out" result="face"/>` : ''}
    <feMerge><feMergeNode in="${xray ? 'face' : 'solid'}"/><feMergeNode in="edge"/></feMerge>`
  defs.append(filter)
  el.classList.add('reflect-surface')
  return { filter, id, mask: xray ? filter.querySelector('feImage') : null,
    inset: filter.querySelector('feMorphology'), offsets: [...filter.querySelectorAll('feOffset')] }
}
const glare = el => {
  if (el.classList.contains('glare-link') || el.matches('.logo, .wordmark, .gh, .report, .install')) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = []
  while (walker.nextNode()) if (walker.currentNode.textContent.trim() && !walker.currentNode.parentElement.closest('svg'))
    nodes.push(walker.currentNode)
  for (const node of nodes) {
    const span = document.createElement('span')
    span.className = 'glare-ink'
    node.replaceWith(span); span.append(node)
    el.classList.add('glare-link')
  }
}
const layout = () => {
  if (ruler) {
    for (const [el, item] of surfaces) if (!el.isConnected) { item.filter.remove(); surfaces.delete(el) }
    const { clientWidth: width, clientHeight: height } = root
    const sides = getComputedStyle(document.body, '::before')
    const left = document.body.getBoundingClientRect().left + parseFloat(sides.left)
    const right = left + parseFloat(sides.width) - 1
    const lines = []
    if (Number.isFinite(left) && Number.isFinite(right))
      for (const x of [left, right]) lines.push(`M${x + .5},0V${height}`)
    for (const el of document.querySelectorAll('.ruled, footer, .faq details + details, .jz-bar')) {
      const r = el.getBoundingClientRect()
      if (r.width && r.top >= 0 && r.top < height) lines.push(`M${r.left},${r.top + .5}H${r.right}`)
    }
    ruler.el.setAttribute('viewBox', `0 0 ${width} ${height}`)
    ruler.path.setAttribute('d', lines.join(''))
    const controls = new Set(document.querySelectorAll('.report, .install, #runAll, .chips button'))
    for (const [el] of boxes) if (!controls.has(el)) boxes.delete(el)
    for (const el of controls) {
      if (!boxes.has(el)) { el.classList.add('reflect-box'); boxes.set(el, edge(el)) }
      boxes.get(el).rect = el.getBoundingClientRect()
    }
    for (const el of document.querySelectorAll('a')) glare(el)
    ink = [...document.querySelectorAll('h1.title, .logo-letters, .metrics b, .metrics .lab, footer .legal > :not(a)')]
      .filter(el => el.textContent.trim() || el.matches('.logo-letters')).map(el => {
      const rect = el.getBoundingClientRect()
      if (el.matches('h1.title, .logo-letters, .metrics b')) {
        if (!surfaces.has(el)) surfaces.set(el, surface(el, el.matches('h1.title, .logo-letters')))
        const { filter, mask, inset } = surfaces.get(el)
        const width = rect.width || 1, height = rect.height || 1
        const x = 2000 / width, y = 2000 / height
        filter.setAttribute('x', `${-x}%`); filter.setAttribute('y', `${-y}%`)
        filter.setAttribute('width', `${100 + 2 * x}%`); filter.setAttribute('height', `${100 + 2 * y}%`)
        if (mask) { mask.setAttribute('width', 640 / width); mask.setAttribute('height', 640 / height) }
        inset.setAttribute('radius', `${1 / width} ${1 / height}`)
      } else el.classList.add('reflect-text')
      return { el, rect }
    })
  }
  dirty = false
}

// Both a button and a logo use this same one-pixel directional bevel.
const light = (item, x, y) => {
  const { ring } = item
  const angle = Math.atan2(x, -y) * 180 / Math.PI
  const rgb = root.dataset.theme === 'light' ? '0 0 0' : '255 255 255'
  ring.style.background = `conic-gradient(from ${angle}deg, rgb(${rgb} / .72), rgb(${rgb} / .08) 65deg, rgb(${rgb} / .03) 110deg, rgb(${rgb} / .31) 180deg, rgb(${rgb} / .03) 250deg, rgb(${rgb} / .08) 295deg, rgb(${rgb} / .72))`
}
const illumination = rect => {
  const dx = field.x - rect.left - rect.width / 2, dy = field.y - rect.top - rect.height / 2
  const distance = Math.hypot(dx, dy), length = distance || 1
  return { x: dx / length, y: dy / length, power: Math.max(0, 1 - distance / radius) ** 2 }
}
const frame = () => {
  raf = 0
  if (root.classList.contains('jz-saver') || root.classList.contains('jz-embed')) return
  if (dirty) layout()
  const target = pointer && mouse.matches && !motion.matches ? pointer : { x: innerWidth / 2, y: -160 }
  field.x = motion.matches ? target.x : field.x + (target.x - field.x) * .2
  field.y = motion.matches ? target.y : field.y + (target.y - field.y) * .2
  let painted = !!ruler
  if (ruler) {
    ruler.gradient.setAttribute('cx', field.x); ruler.gradient.setAttribute('cy', field.y)
    ruler.grid.style.transform = `translate(${field.x}px, ${field.y}px)`
  }
  for (const item of [...logos, ...boxes.values()]) {
    const rect = item.rect || item.el.getBoundingClientRect()
    const visible = rect.width && rect.height && rect.bottom >= 0 && rect.top < innerHeight && !item.el.disabled
    item.ring.style.visibility = visible ? '' : 'hidden'
    if (!visible) continue
    painted = true
    const { x, y, power } = illumination(rect)
    item.ring.style.opacity = .3 + .7 * power
    light(item, x, y)
  }
  for (const { el, rect } of ink) {
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top >= innerHeight) continue
    const { x, y, power } = illumination(rect)
    const item = surfaces.get(el)
    if (item) {
      const dx = field.x - rect.left, dy = field.y - rect.top
      const distance = Math.hypot(Math.max(-dx, 0, dx - rect.width), Math.max(-dy, 0, dy - rect.height))
      const nearby = pointer && mouse.matches && !motion.matches && distance < 320
      // Empty image primitives can invalidate Safari's entire filter. Distant ink needs no mask.
      el.style.setProperty('--ink-filter', !item.mask || nearby ? `url(#${item.id})` : '')
      if (item.mask) {
        item.mask.setAttribute('x', (dx - 320) / rect.width)
        item.mask.setAttribute('y', (dy - 320) / rect.height)
      }
      item.offsets.forEach((offset, i) => {
        const side = i ? -1 : 1
        offset.setAttribute('dx', -x * side / rect.width)
        offset.setAttribute('dy', -y * side / rect.height)
      })
    } else el.style.setProperty('--light-power', power.toFixed(3))
  }
  if (painted && Math.abs(target.x - field.x) + Math.abs(target.y - field.y) > .1) schedule()
}
const schedule = () => { if (!raf && (logos.length || ruler)) raf = requestAnimationFrame(frame) }
const invalidate = () => { dirty = true; schedule() }
const reset = () => { pointer = null; invalidate() }
addEventListener('pointermove', e => {
  if (!mouse.matches || motion.matches || e.pointerType === 'touch') return
  pointer = { x: e.clientX, y: e.clientY }; schedule()
}, { passive: true })
addEventListener('click', e => {
  if (!ruler || root.dataset.theme !== 'dark' || e.button !== 0 || e.target.closest('a, button, iframe, input, summary, select, textarea, .grid-info')) return
  if (document.getSelection()?.isCollapsed === false) return
  const x = e.clientX, y = e.clientY + scrollY
  import('./grid-click.js').then(({ spark }) => spark(x, y)).catch(() => {})
}, { passive: true })
document.addEventListener('selectionchange', () => { import('./selection.js').catch(() => {}) }, { once: true })
root.addEventListener('pointerleave', reset)
addEventListener('blur', reset)
addEventListener('scroll', invalidate, { passive: true })
addEventListener('resize', invalidate, { passive: true })
document.addEventListener('toggle', invalidate, true)
document.addEventListener('transitionend', invalidate)
motion.addEventListener('change', reset)
mouse.addEventListener('change', reset)
if (ruler) {
  new ResizeObserver(invalidate).observe(document.body)
  new MutationObserver(invalidate).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  new MutationObserver(invalidate).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'],
  })
}
schedule()

if (logos.length) {
  try {
    const response = await fetch(new URL('../jz.svg', import.meta.url))
    if (!response.ok) throw new Error('Logo unavailable')
    const source = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement
    if (source.localName !== 'svg') throw new Error('Invalid logo')
    for (const [i, logo] of logos.entries()) {
      const img = logo.el.querySelector('img')
      if (!img) continue
      const svg = document.importNode(source, true), ns = svg.namespaceURI
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', img.alt || 'JZ')
      svg.setAttribute('focusable', 'false')
      const defs = document.createElementNS(ns, 'defs')
      const face = `logo-face-${i}`
      defs.innerHTML = `<linearGradient id="${face}" x1="0" y1="0" x2=".65" y2="1">
        <stop stop-color="#fff"/><stop offset=".5" stop-color="#e7eaee"/>
        <stop offset="1" stop-color="#cbd2dc"/>
      </linearGradient>`
      const letters = document.createElementNS(ns, 'g')
      letters.setAttribute('class', 'logo-letters')
      for (const path of svg.querySelectorAll('path')) {
        const paint = path.getAttribute('fill') === 'white' ? 'fill' : path.getAttribute('stroke') === 'white' ? 'stroke' : null
        if (!paint) continue
        path.setAttribute(paint, `url(#${face})`)
        letters.append(path)
      }
      svg.prepend(defs)
      svg.append(letters)
      surfaces.set(letters, surface(letters, true, defs))
      img.replaceWith(svg)
    }
    invalidate()
  } catch { /* Keep the original image when the enhancement cannot load. */ }
}

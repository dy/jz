import { metal, logoMetal } from './title-metal.js'

// One cursor light for rulers, outlines and reflective ink.
const root = document.documentElement, radius = 320
const edge = el => {
  const ring = document.createElement('span')
  ring.className = 'edge-refl'
  ring.setAttribute('aria-hidden', 'true')
  el.append(ring)
  return { el, ring }
}
const logos = [...document.querySelectorAll('.logo, footer .wordmark')].map(edge)
const boxes = new Map()
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const mouse = matchMedia('(hover: hover) and (pointer: fine)')
const field = { x: innerWidth / 2, y: -160 }
let pointer = null, raf = 0, dirty = true, ink = []

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
  ruler = { el, gradient: el.querySelector('radialGradient'), path: el.querySelector('path') }
}

// Keep real text selectable; its inert twin carries the radial silver reflection.
const title = el => {
  let fill = el.querySelector('.title-fill')
  if (!fill) {
    fill = document.createElement('span')
    fill.className = 'title-fill'
    fill.append(...el.childNodes)
    el.append(fill)
  }
  if (!el.querySelector('.title-outline')) {
    const outline = fill.cloneNode(true)
    outline.className = 'title-outline metal-face'
    outline.setAttribute('aria-hidden', 'true')
    outline.setAttribute('inert', '')
    for (const node of outline.querySelectorAll('[id]')) node.removeAttribute('id')
    el.append(outline)
    el.classList.add('reflect-title')
    metal(el)
  }
}
const glare = el => {
  if (el.classList.contains('glare-link') || el.matches('.logo, .wordmark, .report, .install')) return
  if (el.matches('.gh')) {
    const icon = el.querySelector('svg')?.cloneNode(true)
    if (!icon) return
    icon.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    el.style.setProperty('--icon-mask', `url("data:image/svg+xml,${encodeURIComponent(icon.outerHTML)}")`)
    el.classList.add('glare-link', 'glare-icon')
    return
  }
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
    ink = [...document.querySelectorAll('h1.title, footer .legal > :not(a)')]
      .filter(el => el.textContent.trim()).map(el => {
        const heading = el.matches('h1.title')
        if (heading) title(el)
        if (!heading) el.classList.add('reflect-text')
        const rect = el.getBoundingClientRect()
        let bounds = rect
        if (heading) {
          const range = document.createRange()
          range.selectNodeContents(el.querySelector('.title-fill'))
          bounds = range.getBoundingClientRect()
        }
        return { el, heading, rect, bounds }
      })
  }
  dirty = false
}

// Buttons and logo squares share the same one-pixel cursor reflection.
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
    if (item.metal) {
      item.el.style.setProperty('--light-x', `${field.x - rect.left}px`)
      item.el.style.setProperty('--light-y', `${field.y - rect.top}px`)
    }
  }
  for (const { el, heading, rect, bounds } of ink) {
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top >= innerHeight) continue
    if (heading) {
      el.style.setProperty('--light-x', `${(field.x - rect.left).toFixed(1)}px`)
      el.style.setProperty('--light-y', `${(field.y - rect.top).toFixed(1)}px`)
      // Keep the fill over the letters; distant vertical motion has less influence.
      const half = Math.max(bounds.width / 2, 1), cx = bounds.left + half, cy = bounds.top + bounds.height / 2
      el.style.setProperty('--shine-x', `${(cx - rect.left + half * Math.tanh((field.x - cx) / half)).toFixed(1)}px`)
      el.style.setProperty('--shine-y', `${(cy - rect.top + 60 * Math.tanh((field.y - cy) / 240)).toFixed(1)}px`)
    } else el.style.setProperty('--light-power', illumination(rect).power.toFixed(3))
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

// Derive both letter contours from the canonical SVG, including the stroked Z.
if (logos.length) try {
  const response = await fetch(new URL('../jz.svg', import.meta.url))
  if (!response.ok) throw new Error('Logo unavailable')
  const source = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement
  if (source.localName !== 'svg') throw new Error('Invalid logo')
  for (const [i, logo] of logos.entries()) {
    const img = logo.el.querySelector('img')
    if (!img) continue
    const svg = document.importNode(source, true)
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', img.alt || 'JZ')
    svg.setAttribute('focusable', 'false')
    img.replaceWith(svg)
    logoMetal(svg, logo.el, i)
    logo.metal = true
  }
  invalidate()
} catch { /* Keep the canonical image if its silver enhancement cannot load. */ }

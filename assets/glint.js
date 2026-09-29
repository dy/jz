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
const boxes = new Map(), headings = new Set()
const motion = matchMedia('(prefers-reduced-motion: reduce)')
const mouse = matchMedia('(hover: hover) and (pointer: fine)')
const field = { x: innerWidth / 2, y: -160 }
let pointer = null, raf = 0, dirty = true, ink = []
const reveal = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    entry.target.classList.add('is-lit'); reveal.unobserve(entry.target)
  }
}, { rootMargin: '0px 0px -40px 0px', threshold: .15 }) : null

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
  ruler = { el, grid, gradient: el.querySelector('radialGradient'), path: el.querySelector('path') }
}

const layout = () => {
  if (ruler) {
    for (const el of headings) if (!el.isConnected) { reveal?.unobserve(el); headings.delete(el) }
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
    ink = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, .metrics .lab, footer .legal > *, a')]
      .filter(el => el.textContent.trim() && !el.matches('.logo, .wordmark, .gh')).map(el => {
      if (!el.classList.contains('reflect-text')) el.classList.add('reflect-text')
      if (/^H[1-6]$/.test(el.tagName) && !headings.has(el)) {
        headings.add(el); el.classList.add('ink-reveal')
        if (motion.matches || !reveal) el.classList.add('is-lit')
        else reveal.observe(el)
      }
      if (motion.matches) el.classList.add('is-lit')
      return { el, rect: el.getBoundingClientRect() }
    })
  }
  dirty = false
}

// Both a button and a logo use this same one-pixel directional bevel.
const light = (item, x, y, width) => {
  const { ring, offsets, blur } = item
  const angle = Math.atan2(x, -y) * 180 / Math.PI
  const rgb = root.dataset.theme === 'light' ? '0 0 0' : '255 255 255'
  ring.style.background = `conic-gradient(from ${angle}deg, rgb(${rgb} / .72), rgb(${rgb} / .08) 65deg, rgb(${rgb} / .03) 110deg, rgb(${rgb} / .31) 180deg, rgb(${rgb} / .03) 250deg, rgb(${rgb} / .08) 295deg, rgb(${rgb} / .72))`
  if (!offsets) return
  const length = Math.hypot(x, y) || 1, pixel = 630 / width
  blur.setAttribute('stdDeviation', pixel * 1.25)
  offsets.forEach((offset, i) => {
    const side = i ? -1 : 1
    offset.setAttribute('dx', -x / length * pixel * side)
    offset.setAttribute('dy', -y / length * pixel * side)
  })
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
    light(item, x, y, rect.width)
  }
  for (const { el, rect } of ink) {
    if (!rect.width || rect.bottom < 0 || rect.top >= innerHeight) continue
    const { x, y, power } = illumination(rect)
    el.style.setProperty('--light-power', power.toFixed(3))
    el.style.setProperty('--light-dx', `${x.toFixed(3)}px`)
    el.style.setProperty('--light-dy', `${y.toFixed(3)}px`)
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
  const x = e.clientX, y = e.clientY + scrollY
  import('./grid-click.js').then(({ spark }) => spark(x, y)).catch(() => {})
}, { passive: true })
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
      const face = `logo-face-${i}`, glow = `logo-glow-${i}`
      defs.innerHTML = `<linearGradient id="${face}" x1="0" y1="0" x2=".65" y2="1">
        <stop stop-color="#fff"/><stop offset=".5" stop-color="#e7eaee"/>
        <stop offset="1" stop-color="#cbd2dc"/>
      </linearGradient>
      <filter id="${glow}" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
        <feOffset in="SourceAlpha" result="litOffset"/>
        <feComposite in="SourceAlpha" in2="litOffset" operator="out" result="litEdge"/>
        <feFlood flood-color="#fff" flood-opacity=".85"/>
        <feComposite in2="litEdge" operator="in" result="highlight"/>
        <feOffset in="SourceAlpha" result="backOffset"/>
        <feComposite in="SourceAlpha" in2="backOffset" operator="out" result="backEdge"/>
        <feFlood flood-color="#fff" flood-opacity=".25"/>
        <feComposite in2="backEdge" operator="in"/>
        <feMerge result="outline"><feMergeNode/><feMergeNode in="highlight"/></feMerge>
        <feGaussianBlur in="outline" result="halo"/>
        <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/><feMergeNode in="outline"/></feMerge>
      </filter>`
      const letters = document.createElementNS(ns, 'g')
      letters.setAttribute('filter', `url(#${glow})`)
      for (const path of svg.querySelectorAll('path')) {
        const paint = path.getAttribute('fill') === 'white' ? 'fill' : path.getAttribute('stroke') === 'white' ? 'stroke' : null
        if (!paint) continue
        path.setAttribute(paint, `url(#${face})`)
        letters.append(path)
      }
      svg.prepend(defs)
      svg.append(letters)
      logo.offsets = [...defs.querySelectorAll('feOffset')]
      logo.blur = defs.querySelector('feGaussianBlur')
      img.replaceWith(svg)
    }
    schedule()
  } catch { /* Keep the original image when the enhancement cannot load. */ }
}

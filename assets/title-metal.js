// Cache letter contours when the layout changes; CSS paints the moving light.
export function metal(title) {
  if (!CSS.supports('background', 'conic-gradient(from atan2(1, 1), white, black)')) return
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
  if (!ctx) return
  const layer = document.createElement('div')
  layer.className = 'title-metal'
  layer.setAttribute('aria-hidden', 'true')
  layer.inert = true
  let key = '', markup, raf = 0
  const build = () => {
    raf = 0
    const fill = title.querySelector('.title-fill')
    if (!fill) return
    const face = title.querySelector('.title-outline')
    if (face && markup !== fill.innerHTML) {
      face.innerHTML = markup = fill.innerHTML
      for (const node of face.querySelectorAll('[id]')) node.removeAttribute('id')
    }
    const box = fill.getBoundingClientRect(), host = title.getBoundingClientRect(), style = getComputedStyle(fill)
    const scale = Math.max(2, Math.min(devicePixelRatio || 1, 3)), pad = 2
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const next = [box.width, box.height, box.left - host.left, box.top - host.top, font, style.letterSpacing, style.fontKerning, scale, fill.innerHTML].join('|')
    if (next === key) return
    const tiles = [], walker = document.createTreeWalker(fill, NodeFilter.SHOW_TEXT), range = document.createRange()
    if (box.width && box.height) for (let node; (node = walker.nextNode());) {
      let offset = 0
      for (const char of node.textContent) {
        range.setStart(node, offset); offset += char.length; range.setEnd(node, offset)
        if (!char.trim()) continue
        const rect = range.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        canvas.width = Math.ceil((rect.width + pad * 2) * scale)
        canvas.height = Math.ceil((rect.height + pad * 2) * scale)
        ctx.scale(scale, scale)
        ctx.font = font; ctx.letterSpacing = style.letterSpacing; ctx.fontKerning = style.fontKerning
        const m = ctx.measureText(char), ascent = m.fontBoundingBoxAscent
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'
        ctx.strokeText(char, pad, pad + ascent)
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillText(char, pad, pad + ascent)
        const glyph = document.createElement('i')
        const x = rect.left - box.left - pad, y = rect.top - box.top - pad
        const cx = pad + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2
        const cy = pad + ascent - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
        glyph.style.cssText = `left:${x}px;top:${y}px;width:${canvas.width / scale}px;height:${canvas.height / scale}px;--cx:${cx}px;--cy:${cy}px;--gx:${rect.left - host.left - pad + cx}px;--gy:${rect.top - host.top - pad + cy}px;mask-image:url("${canvas.toDataURL()}")`
        tiles.push(glyph)
      }
    }
    layer.style.cssText = `left:${box.left - host.left}px;top:${box.top - host.top}px;width:${box.width}px;height:${box.height}px`
    layer.replaceChildren(...tiles)
    if (!layer.isConnected) title.append(layer)
    title.dataset.metalReady = String(tiles.length > 0)
    key = next
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(build) }
  new ResizeObserver(schedule).observe(title)
  new MutationObserver(schedule).observe(title, { childList: true, characterData: true, subtree: true })
  addEventListener('resize', schedule, { passive: true })
  document.fonts.ready.then(schedule)
  document.fonts.addEventListener('loadingdone', () => { key = ''; schedule() })
  schedule()
}

// SVG masks preserve the exact J path and the Z's square-capped stroke.
export function logoMetal(svg, el, id) {
  if (!CSS.supports('background', 'conic-gradient(from atan2(1, 1), white, black)')) return
  const ns = svg.namespaceURI, size = svg.viewBox.baseVal.width
  const paths = [...svg.querySelectorAll('path')].filter(p => p.getAttribute('fill') === 'white' || p.getAttribute('stroke') === 'white')
  const shapes = paths.map(path => ({ path: path.cloneNode(true), box: path.getBBox() }))
  const face = svg.cloneNode(true), defs = document.createElementNS(ns, 'defs')
  defs.innerHTML = `<linearGradient id="metal-face-${id}" x2=".65" y2="1"><stop stop-color="#fff"/><stop offset=".5" stop-color="#edf0f5"/><stop offset="1" stop-color="#cbd2dc"/></linearGradient>`
  face.prepend(defs)
  face.setAttribute('class', 'metal-face')
  face.setAttribute('aria-hidden', 'true'); face.removeAttribute('aria-label'); face.removeAttribute('role')
  for (const path of face.querySelectorAll('path')) {
    const paint = path.getAttribute('fill') === 'white' ? 'fill' : path.getAttribute('stroke') === 'white' ? 'stroke' : null
    if (paint) path.setAttribute(paint, `url(#metal-face-${id})`)
    else path.remove()
  }
  const layer = document.createElement('div')
  layer.className = 'title-metal'; layer.setAttribute('aria-hidden', 'true'); layer.inert = true
  let key = ''
  const build = () => {
    const rect = svg.getBoundingClientRect(), host = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const next = [rect.width, rect.height, rect.left - host.left, rect.top - host.top].join('|')
    if (next === key) return
    const scale = rect.width / size, edge = 1.6 / scale
    const tiles = shapes.map(({ path, box }) => {
      const outer = path.cloneNode(true), inner = path.cloneNode(true)
      outer.setAttribute('fill', path.getAttribute('fill') === 'white' ? 'white' : 'none')
      outer.setAttribute('stroke', 'white')
      outer.setAttribute('stroke-width', Number(path.getAttribute('stroke-width') || 0) + edge)
      inner.setAttribute('fill', path.getAttribute('fill') === 'white' ? 'white' : 'none')
      const mask = path => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="${ns}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${path.outerHTML}</svg>`)}")`
      const glyph = document.createElement('i'), x = (box.x + box.width / 2) * scale, y = (box.y + box.height / 2) * scale
      glyph.style.cssText = `inset:0;--cx:${x}px;--cy:${y}px;--gx:${x + rect.left - host.left}px;--gy:${y + rect.top - host.top}px;mask-image:${mask(outer)},${mask(inner)};mask-composite:exclude`
      return glyph
    })
    layer.style.cssText = `left:${rect.left - host.left}px;top:${rect.top - host.top}px;width:${rect.width}px;height:${rect.height}px`
    face.style.cssText = layer.style.cssText
    layer.replaceChildren(...tiles)
    key = next
  }
  build()
  el.append(face, layer)
  el.classList.add('metal-logo')
  for (const path of paths) path.style.opacity = '0'
  new ResizeObserver(build).observe(svg)
}

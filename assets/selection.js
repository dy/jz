// Outline native selection rectangles; leave copying, keyboard selection and editors native.
const root = document.documentElement
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
const path = document.createElementNS(svg.namespaceURI, 'path')
svg.setAttribute('class', 'selection-outline')
svg.setAttribute('aria-hidden', 'true')
svg.append(path)
document.body.append(svg)
let raf = 0
const draw = () => {
  raf = 0
  const selection = document.getSelection(), rects = []
  const editing = document.activeElement?.closest('input, textarea, [contenteditable]')
  if (!editing && selection && !selection.isCollapsed) for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i), ancestor = range.commonAncestorContainer
    const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT)
    let node = ancestor.nodeType === 3 ? ancestor : walker.nextNode()
    while (node) {
      if (node.textContent.trim() && range.intersectsNode(node)) {
        const part = document.createRange()
        part.selectNodeContents(node)
        if (node === range.startContainer) part.setStart(node, range.startOffset)
        if (node === range.endContainer) part.setEnd(node, range.endOffset)
        for (const r of part.getClientRects()) if (r.width && r.height && r.bottom > 0 && r.top < innerHeight)
          rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
      }
      node = walker.nextNode()
    }
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines = []
  for (const r of rects) {
    const last = lines.at(-1)
    if (last && Math.abs(last.top - r.top) < 2 && Math.abs(last.bottom - r.bottom) < 2 && r.left <= last.right + 2)
      last.right = Math.max(last.right, r.right)
    else lines.push(r)
  }
  path.setAttribute('d', lines.map(r => `M${r.left},${r.top}H${r.right}V${r.bottom}H${r.left}Z`).join(''))
  root.classList.toggle('outline-selection', !!lines.length)
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
document.addEventListener('selectionchange', schedule)
addEventListener('scroll', schedule, { passive: true, capture: true })
addEventListener('resize', schedule, { passive: true })
draw()

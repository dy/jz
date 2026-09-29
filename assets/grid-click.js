// Click-only grid current. Document coordinates keep bursts attached to their
// crossings while scrolling; no backing buffer or frame loop exists before a click.
const root = document.documentElement
let cv, ctx, view, raf = 0, bursts = []
const active = () => root.dataset.theme === 'dark' && !document.hidden &&
  !root.classList.contains('jz-saver') && !root.classList.contains('jz-embed')
const clear = () => {
  cancelAnimationFrame(raf); raf = 0; bursts = []
  if (ctx) ctx.clearRect(0, 0, innerWidth, innerHeight)
}
const fit = () => {
  if (!cv) return
  view = cv.getBoundingClientRect()
  if (!view.width || !view.height) return
  const scale = Math.max(1, Math.min(devicePixelRatio || 1, 2))
  cv.width = Math.round(view.width * scale); cv.height = Math.round(view.height * scale)
  ctx.setTransform(cv.width / view.width, 0, 0, cv.height / view.height, 0, 0)
}
const frame = now => {
  raf = 0
  if (!active()) { clear(); return }
  ctx.clearRect(0, 0, innerWidth, innerHeight)
  bursts = bursts.filter(b => now - b.start < b.life)
  for (const b of bursts) {
    const travel = (now - b.start) * .168, tail = Math.min(travel, 108)
    for (const [dx, dy, power] of [[1, 0, .5 - .45 * b.ox], [-1, 0, .5 + .45 * b.ox],
      [0, 1, .5 - .45 * b.oy], [0, -1, .5 + .45 * b.oy]]) {
      const x = b.x - view.left + dx * travel + .5, y = b.y - scrollY - view.top + dy * travel + .5
      const tx = x - dx * Math.max(tail, 1), ty = y - dy * Math.max(tail, 1)
      const gradient = ctx.createLinearGradient(tx, ty, x, y)
      gradient.addColorStop(0, 'transparent')
      gradient.addColorStop(1, `rgb(235 235 235 / ${Math.min(1, power * 1.5)})`)
      ctx.strokeStyle = gradient; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke()
    }
  }
  if (bursts.length) raf = requestAnimationFrame(frame)
}
export const spark = (x, y) => {
  if (!active() || !Number.isFinite(x) || !Number.isFinite(y)) return
  if (!cv) {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    if (!context) return
    cv = canvas; ctx = context
    cv.className = 'grid-bursts'; cv.setAttribute('aria-hidden', 'true')
    document.body.append(cv); fit()
  }
  if (!view.width || !view.height) return
  const gx = parseFloat(getComputedStyle(root).backgroundPositionX) || 0
  const jx = gx + Math.round((x - gx) / 40) * 40, jy = Math.round(y / 40) * 40
  bursts.push({ x: jx, y: jy, ox: (x - jx) / 20, oy: (y - jy) / 20,
    start: performance.now(), life: (Math.max(innerWidth, innerHeight) + 108) / .168 })
  if (bursts.length > 16) bursts.shift()
  if (!raf) raf = requestAnimationFrame(frame)
}
addEventListener('resize', () => { clear(); fit() }, { passive: true })
document.addEventListener('visibilitychange', () => { if (!active()) clear() })
new MutationObserver(() => { if (!active()) clear() })
  .observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] })

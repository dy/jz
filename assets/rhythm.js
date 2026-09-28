// Vertical rhythm on the blueprint grid. A block whose height follows its text can't land on a grid line by
// CSS alone, so `snap` grows one of its margins or paddings until the named edge sits on the next line of
// `step` (page y from the top, where the grid starts). `rhythm(apply)` re-runs the page's snaps once per
// frame whenever the page's size changes; each snap resets before it measures, so the pass is idempotent.
export const snap = (el, prop, edge, step) => {
  el.style[prop] = ''
  const y = el.getBoundingClientRect()[edge] + scrollY
  el.style[prop] = parseFloat(getComputedStyle(el)[prop]) + Math.ceil(y / step - .01) * step - y + 'px'
}

export default apply => {
  let queued = 0
  new ResizeObserver(() => { queued ||= requestAnimationFrame(() => { queued = 0; apply() }) }).observe(document.body)
}

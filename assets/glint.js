// Logo glint, dark theme: every .logo on the page gets a 1px bevel ring (.logo-refl, styled in site.css) that
// catches light. On a mouse the glare faces the cursor and sharpens/brightens as it nears — no autonomous spin;
// on touch / no pointer it's a gentle rotating sheen. A smaller back-light always sits opposite the highlight,
// and a faint floor keeps the ring visible at rest, so the black mark never dissolves into the black page.
// Pure pointer math, no sim. On light paper a screen-blended glint has nothing to light, so the loop idles.
const N = 72, STEP = 360 / N, root = document.documentElement
const logos = [...document.querySelectorAll('.logo')].map(el => {
  let ring = el.querySelector('.logo-refl')
  if (!ring) { ring = document.createElement('span'); ring.className = 'logo-refl'; ring.setAttribute('aria-hidden', 'true'); el.append(ring) }
  return { el, ring, smooth: new Float32Array(N) }
})
const hasMouse = matchMedia('(hover: hover) and (pointer: fine)').matches   // drive by cursor, else animate
let pmx = innerWidth * 0.5, pmy = -200   // start above the page → an initial top-edge glow
addEventListener('pointermove', e => { pmx = e.clientX; pmy = e.clientY }, { passive: true })

const frame = now => {
  requestAnimationFrame(frame)
  if (root.dataset.theme !== 'dark') return
  for (const { el, ring, smooth } of logos) {
    const lr = el.getBoundingClientRect()
    if (lr.bottom < 0 || lr.top > innerHeight) continue
    let ang, prox
    if (hasMouse) {                              // face the cursor; intensity falls off with distance, no spin
      const reach = Math.max(lr.width, 160)      // a small masthead mark answers the cursor from as far as the hero's
      const dx = pmx - (lr.left + lr.width / 2), dy = pmy - (lr.top + lr.height / 2)
      prox = Math.exp(-Math.hypot(dx, dy) / reach * 0.7)
      ang = Math.atan2(dx, -dy)
    } else {                                     // touch / no pointer: a gentle rotating sheen
      prox = 0.55
      ang = now * 0.00018
    }
    const bright = 0.22 + 0.7 * prox             // bright spot near; the far floor keeps the ring visible
    const sigma = 5.4 - 3.5 * prox               // wide/diffuse far, tight near (in bins)
    const center = ((ang / (2 * Math.PI)) * N % N + N) % N, opp = (center + N / 2) % N
    const stops = []
    for (let i = 0; i < N; i++) {
      let d1 = Math.abs(i - center); d1 = Math.min(d1, N - d1)
      let d2 = Math.abs(i - opp); d2 = Math.min(d2, N - d2)
      const target = bright * Math.exp(-(d1 * d1) / (2 * sigma * sigma))          // primary highlight
        + bright * 0.4 * Math.exp(-(d2 * d2) / (2 * (sigma * 1.3) ** 2))         // smaller back-light
      smooth[i] += (target - smooth[i]) * 0.16
      stops.push(`rgba(255,255,255,${smooth[i].toFixed(3)}) ${(i * STEP).toFixed(1)}deg`)
    }
    stops.push(`rgba(255,255,255,${smooth[0].toFixed(3)}) 360deg`)
    ring.style.background = `conic-gradient(${stops.join(',')})`
    const blur = 2 + 3 * (1 - prox)              // near → 2px, far → 5px: a glint, not a dissolving haze
    ring.style.filter = `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(255,255,255,.45)) drop-shadow(0 0 ${(blur * 2).toFixed(1)}px rgba(255,255,255,.22))`   // neutral white: no tint
  }
}
if (logos.length) requestAnimationFrame(frame)

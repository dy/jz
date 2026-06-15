// Voronoi — brute-force nearest-site, computed per pixel against every drifting site
// (O(pixels × sites)). For each pixel it tracks the nearest and second-nearest site:
// the nearest picks the cell's shade, and where the two are nearly tied a dark cell wall
// is drawn. No acceleration structure — just a tight distance-compare inner loop, which
// is exactly the branchy scan jz keeps fast. Click to drop a new site.
// resize(w,h) → Uint32Array; frame(t) moves sites + renders.

let W = 0, H = 0, px
let MAXN = 80
let sx = new Float64Array(MAXN)
let sy = new Float64Array(MAXN)
let svx = new Float64Array(MAXN)
let svy = new Float64Array(MAXN)
let sg = new Float64Array(MAXN)      // cell gray 0..255
let count = 0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

let add = (x, y) => {
  if (count >= MAXN) return
  let i = count
  sx[i] = x; sy[i] = y
  let a = Math.random() * 6.283185307179586, sp = 0.15 + Math.random() * 0.35
  svx[i] = Math.cos(a) * sp; svy[i] = Math.sin(a) * sp
  sg[i] = 55.0 + Math.random() * 180.0
  count++
}

export let init = () => {
  count = 0
  let i = 0
  while (i < 26) { add(Math.random() * W, Math.random() * H); i++ }
}
export let addSite = (x, y) => add(x, y)

export let frame = (t) => {
  // drift sites, bounce off edges
  let i = 0
  while (i < count) {
    sx[i] += svx[i]; sy[i] += svy[i]
    if (sx[i] < 0.0) { sx[i] = 0.0; svx[i] = -svx[i] } else if (sx[i] > W - 1) { sx[i] = W - 1; svx[i] = -svx[i] }
    if (sy[i] < 0.0) { sy[i] = 0.0; svy[i] = -svy[i] } else if (sy[i] > H - 1) { sy[i] = H - 1; svy[i] = -svy[i] }
    i++
  }

  let w = W, h = H, j = 0, py = 0
  while (py < h) {
    let qx = 0
    while (qx < w) {
      let best = 1e18, second = 1e18, bi = 0
      let k = 0
      while (k < count) {
        let dx = qx - sx[k], dy = py - sy[k]
        let d2 = dx * dx + dy * dy
        if (d2 < best) { second = best; best = d2; bi = k }
        else if (d2 < second) { second = d2 }
        k++
      }
      // cell shade, shaded a touch darker toward the cell wall; dark wall where tied
      let d1 = Math.sqrt(best), d2b = Math.sqrt(second)
      let edge = d2b - d1
      let g = sg[bi]
      if (edge < 1.4) g = 18.0                 // cell wall
      else { let f = d1 * 0.006; if (f > 0.5) f = 0.5; g = g * (1.0 - f) }
      let gi = g | 0
      px[j] = (255 << 24) | (gi << 16) | (gi << 8) | gi
      j++; qx++
    }
    py++
  }
}

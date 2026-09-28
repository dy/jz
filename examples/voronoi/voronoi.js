// Voronoi — brute-force nearest-site, computed per pixel against every drifting site
// (O(pixels × sites)). For each pixel it tracks the nearest and second-nearest site: where the two
// are nearly tied the pixel is on a cell wall — drawn as a white rib, anti-aliased by how nearly —
// and the cells stay black, each site a small white dot. No acceleration structure — just a tight
// distance-compare inner loop, which is exactly the branchy scan jz keeps fast.
// Current runs along the ribs: a rib pixel knows its two sites a, b, so its coordinate along the
// wall is its offset from their midpoint along the wall's direction; a comet profile moving in that
// coordinate (phase-shifted per wall by a hash of the pair) sends pulses flowing down every rib.
// Click to drop a new site.
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
      let best = 1e18, second = 1e18, bi = 0, bj = 0
      let k = 0
      while (k < count) {
        let dx = qx - sx[k], dy = py - sy[k]
        let d2 = dx * dx + dy * dy
        if (d2 < best) { second = best; bj = bi; best = d2; bi = k }
        else if (d2 < second) { second = d2; bj = k }
        k++
      }
      let d1 = Math.sqrt(best)
      let ax = sx[bi], ay = sy[bi], bx = sx[bj], by = sy[bj]
      let nx = ay - by, ny = bx - ax
      let nl = 1.0 / (Math.sqrt(nx * nx + ny * ny) + 1e-9)
      let edge = (second - best) * 0.5 * nl    // the exact distance to the wall (the bisector of a, b)
      let g = 0.0
      if (edge < 1.6) {
        let c = 1.3 - edge                     // the rib, ~1.5 px, anti-aliased
        c = c < 0.0 ? 0.0 : c > 1.0 ? 1.0 : c
        // the pulse: position along this wall, a comet moving along it
        let along = ((qx - (ax + bx) * 0.5) * nx + (py - (ay + by) * 0.5) * ny) * nl
        if (bi > bj) along = -along            // one direction per wall, whichever site is nearer
        let lo = bi < bj ? bi : bj, hi = bi < bj ? bj : bi
        let ph = along * 0.011 - t * 0.4 + (lo * 0.618 + hi * 0.382)
        let f = ph - Math.floor(ph)
        let f2 = f * f, f4 = f2 * f2, f8 = f4 * f4
        g = c * (0.35 + 0.65 * f8 + 0.3 * f2 * f)
      }
      if (d1 < 2.6) { let dd = 2.6 - d1; g = g > dd ? g : dd }   // the site
      if (g > 1.0) g = 1.0
      let gi = (g * 255.0) | 0
      px[j] = (255 << 24) | (gi << 16) | (gi << 8) | gi
      j++; qx++
    }
    py++
  }
}

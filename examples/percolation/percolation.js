// Site percolation — 2D lattice where each site is occupied with probability p.
// Connected clusters found via union-find each frame. Near critical p_c≈0.5927,
// a spanning cluster first appears — highlighted white. Below p_c: isolated islands.
// Above: a single giant cluster threads the grid. Drag ↕ to see the phase transition.
//
// The threshold is also made legible as DATA: union-find is done by SIZE (not rank), which
// yields the size of every cluster as a free byproduct — from it, P∞(p) = (largest cluster) / N,
// the standard percolation order parameter, and the cluster count. Because the random field `r`
// is frozen (filled once, never regenerated), P∞ at a given p is DETERMINISTIC — occupancy only
// ever grows as p rises, so clusters only ever merge/grow, never split. That means P∞(p) is a
// genuine function of p for this frozen field, not a noisy sample: a bottom strip plots it
// p-indexed (not time-indexed) and it builds up as p sweeps, then holds steady — the S-curve
// snapping in at p_c.

let W = 0, H = 0
let r       // Float32Array: fixed random field, filled once in resize
let parent  // Int32Array union-find parent array
let rnk     // Int32Array union-find size array (reused as spanning marker after UF)
let px      // Uint32Array output pixels
let clusters = 0   // cluster count, refreshed each frame (cheap byproduct of the size scan)

// Strip-chart state: P∞(p) indexed by p-column (NOT time), built up as p sweeps [0,1].
let stripH = 0        // px height of the bottom strip (set in resize)
let pinfHist          // Float32Array[W] — P∞ measured at each p-column; -1 = not yet visited
const PC = 0.5927

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  r = new Float32Array(n)
  parent = new Int32Array(n)
  rnk = new Int32Array(n)
  px = new Uint32Array(n)
  // Fill random field once — never regenerated
  let i = 0
  while (i < n) { r[i] = Math.random(); i++ }

  stripH = (h * 0.12) | 0
  if (stripH < 16) stripH = 16
  if (stripH > 40) stripH = 40

  pinfHist = new Float32Array(w)
  let k = 0
  while (k < w) { pinfHist[k] = -1.0; k++ }

  return px
}

// Find root with path halving (path compression variant).
// Use explicit local `cur` (int) to avoid jz inferring param as f64 from array reads.
let find = (i) => {
  let cur = i
  while (parent[cur] !== cur) {
    let pp = parent[parent[cur]] | 0
    parent[cur] = pp
    cur = pp
  }
  return cur
}

// Union by size — merging the smaller tree under the larger one's root also leaves `rnk[root]`
// holding that root's true cluster size once every union is done, so P∞ falls out for free.
let union = (a, b) => {
  let ra = find(a), rb = find(b)
  if (ra === rb) return
  if (rnk[ra] < rnk[rb]) { let tmp = ra; ra = rb; rb = tmp }
  parent[rb] = ra
  rnk[ra] = rnk[ra] + rnk[rb]
}

export let frame = (t, p) => {
  let w = W, h = H, n = w * h

  // Initialize union-find: occupied sites → self root, size 1; empty → -1
  let i = 0
  while (i < n) {
    if (r[i] < p) { parent[i] = i; rnk[i] = 1 }
    else { parent[i] = -1 }
    i++
  }

  // Union occupied 4-neighbors (no wrap)
  let y = 0
  while (y < h) {
    let x = 0
    while (x < w) {
      let idx = y * w + x
      if (parent[idx] >= 0) {
        if (x < w - 1 && parent[idx + 1] >= 0) union(idx, idx + 1)
        if (y < h - 1 && parent[idx + w] >= 0) union(idx, idx + w)
      }
      x++
    }
    y++
  }

  // P∞(p) = largest cluster / N, + cluster count — read straight off the union-by-size roots,
  // BEFORE rnk[] is repurposed below as the spanning marker.
  let maxSize = 0
  clusters = 0
  i = 0
  while (i < n) {
    if (parent[i] === i) {
      clusters = clusters + 1
      if (rnk[i] > maxSize) maxSize = rnk[i]
    }
    i++
  }
  let pinf = maxSize / n

  // Detect spanning cluster: roots touching both top row and bottom row.
  // Reuse rnk[] as marker now that its size data has been read.
  // 0 = untouched, 1 = touches top, 2 = spanning (touches both)
  i = 0
  while (i < n) { rnk[i] = 0; i++ }

  // Mark roots of top-row occupied sites
  let x = 0
  while (x < w) {
    if (parent[x] >= 0) {
      let root = find(x)
      rnk[root] = 1
    }
    x++
  }

  // Mark roots touching bottom row — if already marked top, set spanning=2
  x = 0
  while (x < w) {
    let botIdx = (h - 1) * w + x
    if (parent[botIdx] >= 0) {
      let root = find(botIdx)
      if (rnk[root] === 1) rnk[root] = 2
    }
    x++
  }

  // Render pixels
  i = 0
  while (i < n) {
    if (parent[i] < 0) {
      // empty site = black (alpha=255, rgb=0)
      px[i] = (255 << 24)
    } else {
      let root = find(i)
      if (rnk[root] === 2) {
        // spanning cluster = white (255, R==G==B)
        px[i] = (255 << 24) | (255 << 16) | (255 << 8) | 255
      } else {
        // hash root id → pseudo-random gray in 60..229
        let gh = (root * 2654435761 | 0)
        if (gh < 0) gh = -gh
        let g = 60 + (gh >>> 24) % 170
        px[i] = (255 << 24) | (g << 16) | (g << 8) | g
      }
    }
    i++
  }

  // Record P∞ at this p's column (frozen field ⇒ deterministic: revisits just rewrite the
  // same value, so the curve holds steady rather than flickering).
  let col = (p * (w - 1)) | 0
  if (col < 0) col = 0
  if (col > w - 1) col = w - 1
  pinfHist[col] = pinf

  // Strip-chart overlay: bottom `stripH` rows become the p-indexed P∞(p) curve, with a static
  // tick at p_c≈0.5927 and a flag on the frame line marking the CURRENT p — the S-curve snaps
  // from 0 to 1 right where the tick sits.
  let top = h - stripH
  let dataH = stripH - 1
  let tickCol = (PC * (w - 1)) | 0
  let cx = 0
  while (cx < w) {
    px[top * w + cx] = (255 << 24) | (60 << 16) | (60 << 8) | 60   // frame line
    let v = pinfHist[cx]
    let measured = v >= 0.0
    let prow = measured ? (dataH - 1) - ((v * (dataH - 1)) | 0) : -1
    let isTick = cx === tickCol
    let r2 = 0
    while (r2 < dataH) {
      let val
      if (r2 === prow) val = (255 << 24) | (235 << 16) | (235 << 8) | 235   // P∞(p) — bright
      else if (isTick) val = (255 << 24) | (90 << 16) | (90 << 8) | 90      // p_c gridline
      else val = 255 << 24                                                  // background
      px[(top + 1 + r2) * w + cx] = val
      r2++
    }
    cx++
  }
  // current-p flag: a brighter mark on the frame line itself, above the curve
  px[top * w + col] = (255 << 24) | (200 << 16) | (200 << 8) | 200

  return pinf
}

// Cluster count at the current p — a cheap byproduct of the P∞ scan above (read after frame()).
export let clusterCount = () => clusters

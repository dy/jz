// Site percolation — 2D lattice where each site is occupied with probability p.
// Connected clusters found via union-find each frame. Near critical p_c≈0.5927,
// a spanning cluster first appears — highlighted white. Below p_c: isolated islands.
// Above: a single giant cluster threads the grid. Drag ↕ to see the phase transition.

let W = 0, H = 0
let r       // Float32Array: fixed random field, filled once in resize
let parent  // Int32Array union-find parent array
let rnk     // Int32Array union-find rank array (reused as spanning marker after UF)
let px      // Uint32Array output pixels

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

// Union by rank
let union = (a, b) => {
  let ra = find(a), rb = find(b)
  if (ra === rb) return
  if (rnk[ra] < rnk[rb]) { let tmp = ra; ra = rb; rb = tmp }
  parent[rb] = ra
  if (rnk[ra] === rnk[rb]) rnk[ra]++
}

export let frame = (t, p) => {
  let w = W, h = H, n = w * h

  // Initialize union-find: occupied sites → self, empty → -1
  let i = 0
  while (i < n) {
    if (r[i] < p) { parent[i] = i; rnk[i] = 0 }
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

  // Detect spanning cluster: roots touching both top row and bottom row.
  // Reuse rnk[] as marker after union-find is complete.
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
}

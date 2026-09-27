// Maze — generate then solve, animated. Generation is a randomized depth-first "recursive
// backtracker" carving passages on a cell grid (explicit stack); solving is a breadth-first
// flood from the top-left to the bottom-right that then backtraces the shortest path. Branchy
// integer bookkeeping over grids + queues/stacks — a control-flow stress for jz.
//
// Rendered classic-style: a coarse cell-grid bitmap (BW×BH) is stretched to the canvas with
// CORRIDORS WIDE and WALLS 1px, and a wall only lights up where it borders a carved cell — so
// the background is always black and the maze grows out of the dark as it carves.
//
// Current runs through the walls: a perfect maze's walls form one connected tree, so electrons walk
// it cell by cell — straight on or a random turn at each junction, never back, dying at a dead end
// and reborn elsewhere — each leaving a fading heat trail. spark(fx, fy) sends a burst of them out
// of the wall nearest a touch. The solved path is a conductor too: a dim trace with pulses streaming
// from the entrance to the exit.
// resize(w,h) → Uint32Array; frame() advances; restart() begins anew.

let W = 0, H = 0, px
let BW = 0, BH = 0      // bitmap (cell-grid) dims — coarser than the canvas
let bit                 // 1 = wall, 0 = passage, 2 = solution path
let GX = 0, GY = 0      // logical cell grid dims
let colMap, rowMap      // output pixel → bitmap col/row (corridors wide, walls thin)
let shade               // per-cell gray value (computed each frame)
let vis                 // generation visited per cell
let stack, sp           // DFS stack of cell indices
let dist, prev          // BFS distance + parent (bitmap indices)
let q, qh, qt           // BFS queue
let phase = 0           // 0 generate · 1 solve · 2 backtrace · 3 done
let waitc = 0
let cur = 0             // backtrace cursor
let heat                // Float32Array per bitmap cell — the electrons' fading trails
let NP = 0, MAXP = 512  // live electrons (ambient count, set from the grid) and the cap with sparks
let ex = new Int32Array(MAXP), ey = new Int32Array(MAXP), ed = new Int32Array(MAXP)   // cell + heading
let pn = 0              // electrons in flight
let tick = 0            // frame count: electrons step every other frame
let path, plen = 0      // the solution, goal → start (bitmap indices), and its length
let pp = new Int32Array(16), pq = 0   // pulses on the solution: their positions (index into path from its start end)
let DX = new Int32Array([0, 1, 0, -1]), DY = new Int32Array([-1, 0, 1, 0])
// theme palette: [paperR,G,B, inkR,G,B] — harness-fed; default = dark theme (black ground, light maze)
let th = new Float64Array(6)
th[0] = 0.0; th[1] = 0.0; th[2] = 0.0; th[3] = 235.0; th[4] = 235.0; th[5] = 235.0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  // fine cell grid sized for a ~5px pitch → a dense maze: ~4px black corridors, thin 1px walls
  // (still a clean ~4:1 corridor:wall ratio, so it reads as a black-bg maze, not a gray mesh).
  let PITCH = 5
  GX = (w / PITCH) | 0; if (GX < 10) GX = 10
  GY = (h / PITCH) | 0; if (GY < 8) GY = 8
  BW = 2 * GX + 1; BH = 2 * GY + 1
  bit = new Int32Array(BW * BH)
  shade = new Int32Array(BW * BH)
  heat = new Float32Array(BW * BH)
  path = new Int32Array(BW * BH)
  NP = ((GX * GY) / 45) | 0; if (NP < 8) NP = 8
  vis = new Int32Array(GX * GY)
  stack = new Int32Array(GX * GY)
  dist = new Int32Array(BW * BH)
  prev = new Int32Array(BW * BH)
  q = new Int32Array(BW * BH)
  colMap = new Int32Array(w)
  rowMap = new Int32Array(h)
  buildMaps()
  restart()
  return px
}

// output pixel → bitmap cell index, with corridor cells (odd) wide and wall cells (even) 1px.
// The walls take GX+1 px (1 each); the rest is split across the GX corridors, the leftover
// spread one-px-each across the first few so the maze fills the canvas exactly (no edge strip).
let buildMaps = () => {
  let corrW = W - (GX + 1), cw = (corrW / GX) | 0, exW = corrW - cw * GX
  let x = 0, bc = 0, ci = 0
  while (bc < BW && x < W) {
    let wpx = 1
    if ((bc & 1) === 1) { wpx = cw + (ci < exW ? 1 : 0); ci++ }
    let k = 0
    while (k < wpx && x < W) { colMap[x] = bc; x++; k++ }
    bc++
  }
  while (x < W) { colMap[x] = BW - 1; x++ }
  let corrH = H - (GY + 1), ch = (corrH / GY) | 0, exH = corrH - ch * GY
  let y = 0, br = 0, ri = 0
  while (br < BH && y < H) {
    let hpx = 1
    if ((br & 1) === 1) { hpx = ch + (ri < exH ? 1 : 0); ri++ }
    let k = 0
    while (k < hpx && y < H) { rowMap[y] = br; y++; k++ }
    br++
  }
  while (y < H) { rowMap[y] = BH - 1; y++ }
}

let cellBit = (cx, cy) => (2 * cy + 1) * BW + (2 * cx + 1)

export let restart = () => {
  let n = BW * BH, i = 0
  while (i < n) { bit[i] = 1; dist[i] = -1; i++ }     // all walls
  i = 0
  while (i < GX * GY) { vis[i] = 0; i++ }
  vis[0] = 1; bit[cellBit(0, 0)] = 0                  // start cell (0,0)
  stack[0] = 0; sp = 1
  phase = 0; waitc = 0
  i = 0
  while (i < n) { heat[i] = 0.0; i++ }
  pn = 0; plen = 0; pq = 0
}

// a lit wall is a wall cell that shading drew (it borders a carved cell)
let lit = (x, y) => x >= 0 && x < BW && y >= 0 && y < BH && bit[y * BW + x] === 1 && shade[y * BW + x] > 0

// place electron k on a random lit wall, heading any way
let born = (k) => {
  let tries = 0
  while (tries < 40) {
    let x = (Math.random() * BW) | 0, y = (Math.random() * BH) | 0
    if (lit(x, y)) { ex[k] = x; ey[k] = y; ed[k] = (Math.random() * 4) | 0; return 1 }
    tries++
  }
  return 0
}

// one step along the walls: straight on, or a random open turn; never back; a dead end ends the walk
let walk = (k) => {
  let d = ed[k], x = ex[k], y = ey[k]
  let opts = 0, pick = -1
  let j = 0
  while (j < 4) {
    if (j !== ((d + 2) & 3) && lit(x + DX[j], y + DY[j])) {
      opts++
      if (j === d && Math.random() < 0.55) { pick = j; opts = 99 }
      else if (opts < 99 && Math.random() * opts < 1.0) pick = j
    }
    j++
  }
  if (pick < 0) return 0
  ex[k] = x + DX[pick]; ey[k] = y + DY[pick]; ed[k] = pick
  return 1
}

// a touch: a burst of electrons from the lit wall nearest (fx, fy) ∈ 0..1
export let spark = (fx, fy) => {
  let cx = (fx * BW) | 0, cy = (fy * BH) | 0, r = 0
  while (r < 12) {
    let y = cy - r
    while (y <= cy + r) {
      let x = cx - r
      while (x <= cx + r) {
        if (lit(x, y)) {
          let k = 0
          while (k < 16 && pn < MAXP) { ex[pn] = x; ey[pn] = y; ed[pn] = k & 3; heat[y * BW + x] = 1.0; pn++; k++ }
          return 1
        }
        x++
      }
      y++
    }
    r++
  }
  return 0
}

let genStep = () => {
  if (sp === 0) { phase = 1; startSolve(); return }
  let c = stack[sp - 1]
  let cx = c % GX, cy = (c / GX) | 0
  // collect unvisited neighbours (one cell away on the cell grid)
  let dirs = 0, n0 = -1, n1 = -1, n2 = -1, n3 = -1
  if (cy > 0 && vis[c - GX] === 0) { n0 = c - GX; dirs++ }
  if (cy < GY - 1 && vis[c + GX] === 0) { n1 = c + GX; dirs++ }
  if (cx > 0 && vis[c - 1] === 0) { n2 = c - 1; dirs++ }
  if (cx < GX - 1 && vis[c + 1] === 0) { n3 = c + 1; dirs++ }
  if (dirs === 0) { sp--; return }
  let pick = (Math.random() * dirs) | 0
  let nb = -1
  if (n0 >= 0) { if (pick === 0) nb = n0; else pick-- }
  if (nb < 0 && n1 >= 0) { if (pick === 0) nb = n1; else pick-- }
  if (nb < 0 && n2 >= 0) { if (pick === 0) nb = n2; else pick-- }
  if (nb < 0 && n3 >= 0) { if (pick === 0) nb = n3; else pick-- }
  let nx = nb % GX, ny = (nb / GX) | 0
  // carve the wall between cell c and nb, and the neighbour cell
  let wallx = (2 * cx + 1) + (nx - cx), wally = (2 * cy + 1) + (ny - cy)
  bit[wally * BW + wallx] = 0
  bit[cellBit(nx, ny)] = 0
  vis[nb] = 1
  stack[sp] = nb; sp++
}

let startSolve = () => {
  let s = cellBit(0, 0)
  qh = 0; qt = 0; q[qt] = s; qt++; dist[s] = 0; prev[s] = -1
}

let solveStep = () => {
  if (qh >= qt) { phase = 3; return }                 // (shouldn't happen)
  let c = q[qh]; qh++
  let goal = cellBit(GX - 1, GY - 1)
  if (c === goal) { phase = 2; cur = c; return }
  // 4-neighbours through passages
  let nb = c - BW; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c + BW; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c - 1; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c + 1; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
}

// per-cell gray: corridors black (faint where flood-explored), bright solution, and a wall
// only lights up (thin) where one of its 8 neighbours is carved — so unused bulk stays black.
let shadeCells = () => {
  let cy = 0
  while (cy < BH) {
    let cx = 0
    while (cx < BW) {
      let bi = cy * BW + cx
      let b = bit[bi], g = 0
      if (b === 2) g = 60                                // the solution: a dim trace the pulses light
      else if (b === 0) { if (dist[bi] >= 0) g = 20 }   // explored flood: near-black so the bg stays black
      else {
        let seen = 0, yy = cy - 1
        while (yy <= cy + 1) {
          let xx = cx - 1
          while (xx <= cx + 1) {
            if (yy >= 0 && yy < BH && xx >= 0 && xx < BW) { if (bit[yy * BW + xx] !== 1) seen = 1 }
            xx++
          }
          yy++
        }
        if (seen === 1) g = 90
      }
      shade[bi] = g
      cx++
    }
    cy++
  }
}

export let setTheme = (pr, pg, pb, ir, ig, ib) => { th[0] = pr; th[1] = pg; th[2] = pb; th[3] = ir; th[4] = ig; th[5] = ib }

export let frame = (t) => {
  // per-frame work scales with the (now finer) grid so generation stays a brisk ~2s and the
  // solve flood / backtrace keep pace — the 5px pitch has ~4× the cells of the old 10px one.
  if (phase === 0) { let k = 0; while (k < GX * 2) { genStep(); if (phase !== 0) break; k++ } }
  else if (phase === 1) { let k = 0; while (k < GX * 5) { solveStep(); if (phase !== 1) break; k++ } }
  else if (phase === 2) {
    let k = 0
    while (k < GX * 2) {
      bit[cur] = 2                                     // mark path (special value)
      path[plen] = cur; plen++
      if (prev[cur] < 0) { phase = 3; waitc = 0; break }
      cur = prev[cur]; k++
    }
  } else {
    // current along the solution: a pulse leaves the entrance every 30 frames, a cell a frame
    if (waitc % 30 === 0 && pq < 16) { pp[pq] = 0; pq++ }
    let k = 0
    while (k < pq) {
      let s2 = 0
      while (s2 < 1 && pp[k] < plen) { heat[path[plen - 1 - pp[k]]] = 1.0; pp[k]++; s2++ }
      if (pp[k] >= plen) { pq--; pp[k] = pp[pq]; k-- }
      k++
    }
    waitc++; if (waitc > 520) restart()
  }

  shadeCells()

  // the current: trails cool, the ambient crew is topped up, every electron takes its steps
  let n = BW * BH, i = 0
  while (i < n) { heat[i] = heat[i] * 0.95; i++ }
  tick++
  while (pn < NP && born(pn) === 1) pn++
  let k = 0
  while (k < pn) {
    let s2 = 0, alive = 1
    while (s2 < (tick & 1) && alive === 1) { alive = walk(k); if (alive === 1) heat[ey[k] * BW + ex[k]] = 1.0; s2++ }
    if (alive === 0) {
      if (k >= NP) { pn--; ex[k] = ex[pn]; ey[k] = ey[pn]; ed[k] = ed[pn]; k-- }   // a spark's electron is spent
      else born(k)
    }
    k++
  }

  // render: stretch the cell grid to the canvas — wide black corridors, thin light walls, hot current
  let y = 0
  while (y < H) {
    let brow = rowMap[y] * BW
    let x = 0
    while (x < W) {
      let c = brow + colMap[x]
      let v = shade[c] / 255.0 + heat[c]          // 0 = ground, 1 = bright wall/solution/current
      if (v > 1.0) v = 1.0
      let r = (th[0] + (th[3] - th[0]) * v) | 0
      let g = (th[1] + (th[4] - th[1]) * v) | 0
      let b = (th[2] + (th[5] - th[2]) * v) | 0
      px[y * W + x] = (255 << 24) | (b << 16) | (g << 8) | r
      x++
    }
    y++
  }
}

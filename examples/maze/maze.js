// Maze — generate then solve, animated. Generation is a randomized depth-first "recursive
// backtracker" carving passages on a cell grid (explicit stack); solving is a breadth-first
// flood from the top-left to the bottom-right that then backtraces the shortest path. Branchy
// integer bookkeeping over grids + queues/stacks — a control-flow stress for jz.
//
// Rendered classic-style: a coarse cell-grid bitmap (BW×BH) is stretched to the canvas with
// CORRIDORS WIDE and WALLS 1px, and a wall only lights up where it borders a carved cell — so
// the background is always black and the maze grows out of the dark as it carves.
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
      if (b === 2) g = 255
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
      if (prev[cur] < 0) { phase = 3; waitc = 0; break }
      cur = prev[cur]; k++
    }
  } else { waitc++; if (waitc > 150) restart() }

  // render: stretch the cell grid to the canvas — wide black corridors, thin light walls
  shadeCells()
  let y = 0
  while (y < H) {
    let brow = rowMap[y] * BW
    let x = 0
    while (x < W) {
      let v = shade[brow + colMap[x]] / 255.0   // 0 = ground, 1 = bright wall/solution
      let r = (th[0] + (th[3] - th[0]) * v) | 0
      let g = (th[1] + (th[4] - th[1]) * v) | 0
      let b = (th[2] + (th[5] - th[2]) * v) | 0
      px[y * W + x] = (255 << 24) | (b << 16) | (g << 8) | r
      x++
    }
    y++
  }
}

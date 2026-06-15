// Maze — generate then solve, animated. Generation is a randomized depth-first
// "recursive backtracker" carving passages on a cell grid (explicit stack); solving is a
// breadth-first flood from the top-left to the bottom-right that then backtraces the
// shortest path. Branchy integer bookkeeping over grids + queues/stacks — a control-flow
// stress for jz. resize(w,h) → Uint32Array; frame() advances; restart() begins anew.

let W = 0, H = 0, px
let bit                 // 1 = wall, 0 = passage (the rendered bitmap)
let GX = 0, GY = 0      // cell grid dims
let vis                 // generation visited per cell
let stack, sp           // DFS stack of cell indices
let dist, prev          // BFS distance + parent (bitmap indices)
let q, qh, qt           // BFS queue
let phase = 0           // 0 generate · 1 solve · 2 backtrace · 3 done
let waitc = 0
let cur = 0             // backtrace cursor

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  bit = new Int32Array(w * h)
  GX = (w - 1) >> 1; GY = (h - 1) >> 1
  vis = new Int32Array(GX * GY)
  stack = new Int32Array(GX * GY)
  dist = new Int32Array(w * h)
  prev = new Int32Array(w * h)
  q = new Int32Array(w * h)
  restart()
  return px
}

let cellBit = (cx, cy) => (2 * cy + 1) * W + (2 * cx + 1)

export let restart = () => {
  let n = W * H, i = 0
  while (i < n) { bit[i] = 1; dist[i] = -1; i++ }     // all walls
  i = 0
  while (i < GX * GY) { vis[i] = 0; i++ }
  // start cell (0,0)
  vis[0] = 1; bit[cellBit(0, 0)] = 0
  stack[0] = 0; sp = 1
  phase = 0; waitc = 0
}

let genStep = () => {
  if (sp === 0) { phase = 1; startSolve(); return }
  let c = stack[sp - 1]
  let cx = c % GX, cy = (c / GX) | 0
  // collect unvisited neighbours (2 cells away)
  let dirs = 0, n0 = -1, n1 = -1, n2 = -1, n3 = -1
  if (cy > 0 && vis[c - GX] === 0) { n0 = c - GX; dirs++ }
  if (cy < GY - 1 && vis[c + GX] === 0) { n1 = c + GX; dirs++ }
  if (cx > 0 && vis[c - 1] === 0) { n2 = c - 1; dirs++ }
  if (cx < GX - 1 && vis[c + 1] === 0) { n3 = c + 1; dirs++ }
  if (dirs === 0) { sp-- ; return }
  let pick = (Math.random() * dirs) | 0
  let nb = -1
  if (n0 >= 0) { if (pick === 0) nb = n0; else pick-- }
  if (nb < 0 && n1 >= 0) { if (pick === 0) nb = n1; else pick-- }
  if (nb < 0 && n2 >= 0) { if (pick === 0) nb = n2; else pick-- }
  if (nb < 0 && n3 >= 0) { if (pick === 0) nb = n3; else pick-- }
  let nx = nb % GX, ny = (nb / GX) | 0
  // carve the wall between cell c and nb, and the neighbour cell
  let wallx = (2 * cx + 1) + (nx - cx), wally = (2 * cy + 1) + (ny - cy)
  bit[wally * W + wallx] = 0
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
  let nb = c - W; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c + W; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c - 1; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
  nb = c + 1; if (bit[nb] === 0 && dist[nb] < 0) { dist[nb] = dist[c] + 1; prev[nb] = c; q[qt] = nb; qt++ }
}

export let frame = (t) => {
  if (phase === 0) { let k = 0; while (k < GX) { genStep(); if (phase !== 0) break; k++ } }
  else if (phase === 1) { let k = 0; while (k < GX * 3) { solveStep(); if (phase !== 1) break; k++ } }
  else if (phase === 2) {
    let k = 0
    while (k < GX) {
      bit[cur] = 2                                     // mark path (special value)
      if (prev[cur] < 0) { phase = 3; waitc = 0; break }
      cur = prev[cur]; k++
    }
  } else { waitc++; if (waitc > 150) restart() }

  // render — wall dark, passage light, BFS-explored mid-gray, solution path black
  let n = W * H, i = 0
  while (i < n) {
    let g = 235
    if (bit[i] === 1) g = 55                           // wall
    else if (bit[i] === 2) g = 15                      // solution path
    else if (dist[i] >= 0) g = 150                     // explored
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}

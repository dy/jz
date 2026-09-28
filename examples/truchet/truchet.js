// Truchet tiles — each square cell of the grid holds one of two tile orientations:
// two quarter-circle arcs joining midpoints of adjacent edges. Orientation 0 places arcs
// centered at top-left and bottom-right corners; orientation 1 at top-right and bottom-left.
// Randomly assigned, they spontaneously form flowing loops and mazes.
//
// Drawn per pixel, flat: every arc is a clean anti-aliased stroke; underneath, the plane takes
// Truchet's two-colouring (corner regions of a tile share a tone with their neighbours across every
// edge), so the labyrinth's rooms read in two quiet greys. Current runs along the paths: the arcs
// chain edge-midpoint to edge-midpoint into closed loops and walls-to-wall runs, so a pulse entering
// a tile at one midpoint rides the one arc bound to it, leaves by its partner midpoint and enters the
// neighbour — its head splatted into a fading heat field that draws the tail. spark(fx, fy) fires
// four from the touched tile, one out of each edge.
// init()/seed() randomize; frame(t, tileSize) draws.

let W = 0, H = 0, px, heat

let TILE = 22     // default tile size in pixels

// The random orientation grid is a FIXED large field (GRID×GRID), seeded once. Each frame draws a
// screen-sized window into it at the current tile — so shrinking tiles always fill the whole canvas
// and the pattern stays put as you resize the tiles. GRID 300 covers any budgeted backing down to 8px.
let GRID = 300
let cells = new Uint8Array(GRID * GRID)

// pulses: tile (gx, gy), the edge it entered by (0 top · 1 right · 2 bottom · 3 left), progress along the arc
let NA = 36, MAXP = 96
let pgx = new Int32Array(MAXP), pgy = new Int32Array(MAXP), pe = new Int32Array(MAXP)
let ps = new Float64Array(MAXP)
let np = 0
// edge midpoints (x, y) in tile units, by edge
let MX = new Float64Array([0.5, 1.0, 0.5, 0.0]), MY = new Float64Array([0.0, 0.5, 1.0, 0.5])

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  heat = new Float32Array(w * h)
  np = 0
  return px
}

export let seed = () => {
  let n = GRID * GRID, i = 0
  while (i < n) { cells[i] = Math.random() < 0.5 ? 0 : 1; i++ }
  np = 0
}

export let init = () => {
  seed()
}

// the arc a pulse rides: entering edge e of a tile with orientation o, it leaves by partner(e, o)
// — orientation 0 pairs top↔left, right↔bottom; orientation 1 pairs top↔right, bottom↔left
let partner = (e, o) => o === 0 ? 3 - e : (e === 0 ? 1 : e === 1 ? 0 : e === 2 ? 3 : 2)
// that arc's centre: the corner shared by the two edges
let cxOf = (e, f) => (e === 1 || f === 1) ? 1.0 : 0.0
let cyOf = (e, f) => (e === 2 || f === 2) ? 1.0 : 0.0

let born = (k, gw, gh) => {
  pgx[k] = (Math.random() * gw) | 0; pgy[k] = (Math.random() * gh) | 0
  pe[k] = (Math.random() * 4) | 0; ps[k] = Math.random()
}

// a touch: four pulses out of the touched tile, one per edge
export let spark = (fx, fy, tileSize) => {
  let ts = tileSize | 0
  if (ts < 8) ts = TILE
  let gx = (fx * W / ts) | 0, gy = (fy * H / ts) | 0
  let e = 0
  while (e < 4 && np < MAXP) { pgx[np] = gx; pgy[np] = gy; pe[np] = e; ps[np] = 0.0; np++; e++ }
}

// splat a soft hot dot of radius r px at (hx, hy) into the heat field
let dot = (hx, hy, r) => {
  let x0 = (hx - r) | 0, x1 = (hx + r + 1.0) | 0, y0 = (hy - r) | 0, y1 = (hy + r + 1.0) | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let ir2 = 1.0 / (r * r)
  let y = y0
  while (y <= y1) {
    let x = x0
    while (x <= x1) {
      let dx = x + 0.5 - hx, dy = y + 0.5 - hy
      let q = 1.0 - (dx * dx + dy * dy) * ir2
      if (q > 0.0) { let p = y * W + x; if (heat[p] < q) heat[p] = q }
      x++
    }
    y++
  }
}

export let frame = (t, tileSize) => {
  let ts = tileSize | 0
  if (ts < 8) ts = TILE
  let inv = 1.0 / ts
  let w = 0.05                                   // stroke half-width, in tile units
  let gw = (W * inv | 0) + 1, gh = (H * inv | 0) + 1
  if (gw > GRID) gw = GRID
  if (gh > GRID) gh = GRID

  // move the pulses: three sub-steps a frame, a dot each, so the tail is continuous
  while (np < NA) { born(np, gw, gh); np++ }
  let rd = ts * 0.12 + 1.0
  let k = 0
  while (k < np) {
    let sub = 0
    while (sub < 3) {
      let e = pe[k], o = cells[pgy[k] * GRID + pgx[k]]
      let f = partner(e, o)
      let cx = cxOf(e, f), cy = cyOf(e, f)
      let a0 = Math.atan2(MY[e] - cy, MX[e] - cx), a1 = Math.atan2(MY[f] - cy, MX[f] - cx)
      let da = a1 - a0
      if (da > 3.141592653589793) da -= 6.283185307179586
      if (da < -3.141592653589793) da += 6.283185307179586
      let a = a0 + da * ps[k]
      dot((pgx[k] + cx + 0.5 * Math.cos(a)) * ts, (pgy[k] + cy + 0.5 * Math.sin(a)) * ts, rd)
      ps[k] = ps[k] + 0.5 / ts                   // ~½ px per sub-step
      if (ps[k] >= 1.0) {                        // out by edge f, into the neighbour through its opposite edge
        ps[k] = 0.0
        if (f === 0) pgy[k] = pgy[k] - 1
        else if (f === 1) pgx[k] = pgx[k] + 1
        else if (f === 2) pgy[k] = pgy[k] + 1
        else pgx[k] = pgx[k] - 1
        pe[k] = (f + 2) & 3
        if (pgx[k] < 0 || pgy[k] < 0 || pgx[k] >= gw || pgy[k] >= gh) {
          if (k >= NA) { np--; pgx[k] = pgx[np]; pgy[k] = pgy[np]; pe[k] = pe[np]; ps[k] = ps[np]; k--; sub = 3 }
          else born(k, gw, gh)
        }
      }
      sub++
    }
    k++
  }

  let y = 0
  while (y < H) {
    let gy = (y * inv) | 0
    if (gy > GRID - 1) gy = GRID - 1
    let v = (y + 0.5) * inv - gy
    let x = 0
    while (x < W) {
      let gx = (x * inv) | 0
      let u = (x + 0.5) * inv - gx
      let ori = cells[gy * GRID + (gx < GRID ? gx : GRID - 1)]
      // the tile's two arc centres: (0,0)+(1,1) for orientation 0, (1,0)+(0,1) for 1
      let ax = ori === 0 ? 0.0 : 1.0
      let d1x = u - ax, d1y = v, d2x = u - (1.0 - ax), d2y = v - 1.0
      let r1 = Math.sqrt(d1x * d1x + d1y * d1y), r2 = Math.sqrt(d2x * d2x + d2y * d2y)
      let e1 = r1 - 0.5, e2 = r2 - 0.5
      let de = Math.min(e1 < 0.0 ? -e1 : e1, e2 < 0.0 ? -e2 : e2)      // distance to the nearer arc
      // the ground: Truchet's two-colouring — inside a corner quarter-disc or in the band between
      let corner = r1 < 0.5 || r2 < 0.5 ? 1 : 0
      let tone = (corner ^ ((gx + gy + ori) & 1)) === 1 ? 0.09 : 0.0
      // the stroke, anti-aliased by its distance in pixels; the current's heat brightens it
      let cov = (w - de) * ts + 0.5
      cov = cov < 0.0 ? 0.0 : cov > 1.0 ? 1.0 : cov
      let p = y * W + x
      let hh = heat[p] * 0.96
      heat[p] = hh
      let g = tone + (0.55 + 0.45 * hh - tone) * cov + hh * 0.35
      let c = g >= 1.0 ? 255 : (g * 255.0) | 0
      px[p] = (255 << 24) | (c << 16) | (c << 8) | c
      x++
    }
    y++
  }
}

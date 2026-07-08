// Abelian sandpile (Bak–Tang–Wiesenfeld) — grains pile up one site at a time; any site
// holding ≥4 grains topples, giving 1 grain to each von-Neumann neighbor and losing 4 itself
// (open boundary: a neighbor off the grid just loses the grain — it falls off the edge). One
// toppling can push a neighbor over the same threshold, cascading into an avalanche of
// arbitrary size — and because toppling order never changes the final stable configuration
// (the model is "abelian"), grains can be added in bulk and relaxed with an efficient WORKLIST
// instead of a grain-by-grain, full-grid sweep. Seeded from a point, the stable configuration
// self-organizes into the famous concentric, self-similar mandala.
//
// Algorithm: `grid` holds a grain count per cell; toppling-eligible sites live in an explicit
// circular FIFO QUEUE (`queue`/`qHead`/`qTail`/`qCount`), deduplicated by an `inq` flag so a site
// queues at most once at a time. relax() pops the OLDEST eligible site, drains it fully (it may
// hold several multiples of 4 at once — e.g. a fresh deposit), and pushes any neighbor that
// crosses the threshold — following the avalanche FRONT, never sweeping the whole grid. FIFO
// (not a LIFO stack) matters once there are several independent emitters: a stack lets whichever
// front was disturbed most recently monopolize the whole topple budget every frame, starving an
// older front indefinitely; a queue guarantees every pending site is reached within bounded time.
// Work is capped per call (`MAXTOPPLE`); an unfinished avalanche simply resumes next frame (the
// queue persists across frames), so one huge cascade never stalls a frame — it just ripples
// visibly across a few of them.
//
// The sim grid is coarser than the canvas (`CELL` px per side) so each cell paints a crisp
// block. The mandala only exists in the FREE pile — a pile that fits inside the grid. A free
// pile of N grains reaches radius ≈ √(N/6.68) (bulk density ≈2.125·π), so every source gets a
// grain BUDGET of ~6·r² (r = a safe fraction of the half-grid) and stops feeding when it's
// spent: the finished mandala holds on screen instead of overflowing the boundary and washing
// into the featureless saturated recurrent state. Feeding tapers exponentially with the
// remaining budget — rings rush out early, the last filigree settles slowly. Once every
// source is spent, a sparse deterministic RAIN (one grain every couple dozen frames, LCG
// placed) keeps the pile alive: each drop sparks a small avalanche shimmering across the
// pattern — self-organized criticality itself, at a rate that preserves the artwork.
//
// The level palette is deliberately NON-MONOTONE (0→black, 1→white, 2→dark, 3→light): the
// mandala's regions are periodic TILINGS of levels, not gradients — mapping neighboring
// levels to contrasting brightness is what makes the patchwork pop (1s are rare sparkle).
// `heat` gives a cell a brief extra brightness the FIRST time it ever topples (`everToppled`
// gates it) — the advancing growth front sparks; interior re-topples stay calm.
//
// resize(w,h) → Uint32Array. click = addSource (a new emitter with its own budget — colliding
// mandalas where two fronts meet); drag = pour (a one-off deposit trail). seed() reseeds one
// centered source. All randomness is a fixed-seed integer LCG — JS and jz stay bit-exact.

let CELL = 2              // px per sim cell, per side — fine enough for the mandala's filigree,
                           // chunky enough to read crisply at gallery scale

let W = 0, H = 0, px
let Gw = 0, Gh = 0        // sim grid dims — canvas / CELL
let grid                  // Int32Array grain count per cell
let heat                  // Int32Array avalanche-flash brightness, decays toward 0
let everToppled           // Int32Array 1 once a cell has toppled at least once (gates the flash)
let inq                   // Int32Array 1 while a cell sits in the queue, else 0
let queue                 // Int32Array circular FIFO of toppling-eligible cell indices
let qHead = 0, qTail = 0, qCount = 0, QN = 0   // queue read/write cursors, live count, capacity

let SRC_MAX = 10
let srcX, srcY            // Int32Array grid-space emitter positions (ring buffer)
let srcBudget             // Int32Array grains left to feed per source (0 = spent)
let srcN = 0, srcNext = 0
let capPer = 0            // per-source grain budget ≈ 6·r² — the free-pile capacity of the grid

let frameCount = 0
let K_MIN = 8, K_MAX = 800   // grains/frame per source: budget-proportional taper, clamped
let MAXTOPPLE = 150000    // topple budget per frame — bounds worst-case frame cost (~4-5ms measured)
let RAIN_EVERY = 24       // idle rain cadence (frames/grain) once every source is spent
let rng = 1234567         // fixed-seed integer LCG (Math.imul — exact in both engines)

let L1 = 255, L2 = 70, L3 = 190     // NON-MONOTONE level palette (0 grains = black): the mandala's
                                     // patches are periodic level-tilings, so neighboring levels get
                                     // contrasting brightness — 2s dark, 3s light, rare 1s sparkle white
let HEAT_MAX = 45, HEAT_DECAY = 15  // growth-front flash: added brightness on a cell's FIRST topple
                                     // only, fading over ~3 frames — a quick spark, not a wash

export let resize = (w, h) => {
  W = w; H = h
  Gw = (w / CELL) | 0; Gh = (h / CELL) | 0
  let n = Gw * Gh
  grid = new Int32Array(n)
  heat = new Int32Array(n)
  everToppled = new Int32Array(n)
  inq = new Int32Array(n)
  queue = new Int32Array(n)
  QN = n
  srcX = new Int32Array(SRC_MAX)
  srcY = new Int32Array(SRC_MAX)
  srcBudget = new Int32Array(SRC_MAX)
  // free-pile capacity: a pile of 6·r² grains relaxes to radius ≈ 0.95·r — kept inside the grid
  let r = 0.45 * (Gw < Gh ? Gw : Gh)
  capPer = (6.0 * r * r) | 0
  px = new Uint32Array(w * h)
  qHead = 0; qTail = 0; qCount = 0; srcN = 0; srcNext = 0; frameCount = 0
  return px
}

export let clear = () => {
  let n = Gw * Gh, i = 0
  while (i < n) { grid[i] = 0; heat[i] = 0; everToppled[i] = 0; inq[i] = 0; i++ }
  qHead = 0; qTail = 0; qCount = 0; srcN = 0; srcNext = 0; frameCount = 0
}

// Reseed a single source dead-center — the canonical single-point mandala.
export let seed = () => {
  clear()
  srcX[0] = Gw >> 1; srcY[0] = Gh >> 1
  srcBudget[0] = capPer
  srcN = 1; srcNext = 1
}

let push = (c) => {
  if (inq[c] === 0) {
    inq[c] = 1
    queue[qTail] = c
    qTail++
    if (qTail >= QN) qTail = 0
    qCount++
  }
}

// Click: register a new permanent emitter (ring buffer — the oldest is evicted once SRC_MAX is
// exceeded, so stacking up emitters never grows the per-frame work without bound).
export let addSource = (x, y) => {
  let gx = (x / CELL) | 0, gy = (y / CELL) | 0
  if (gx < 0) gx = 0
  if (gx > Gw - 1) gx = Gw - 1
  if (gy < 0) gy = 0
  if (gy > Gh - 1) gy = Gh - 1
  srcX[srcNext] = gx; srcY[srcNext] = gy
  srcBudget[srcNext] = capPer
  srcNext = (srcNext + 1) % SRC_MAX
  if (srcN < SRC_MAX) srcN++
}

// Drag: pour n grains directly onto one cell (a one-off deposit, not a new emitter).
export let pour = (x, y, n) => {
  let gx = (x / CELL) | 0, gy = (y / CELL) | 0
  if (gx < 0 || gx > Gw - 1 || gy < 0 || gy > Gh - 1) return
  let c = gy * Gw + gx
  grid[c] += n
  if (grid[c] >= 4) push(c)
}


// Drain the avalanche worklist, front-first, up to `budget` topples. A site may hold several
// multiples of 4 (e.g. a fresh K-grain deposit) — drained fully in one visit. Open boundary:
// a neighbor off the grid simply loses the grain (bounds checked once per popped site).
let relax = (budget) => {
  let done = 0, gw = Gw, gh = Gh
  while (qCount > 0 && done < budget) {
    let c = queue[qHead]
    qHead++
    if (qHead >= QN) qHead = 0
    qCount--
    inq[c] = 0
    if (grid[c] >= 4) {                     // always true here — grid[c] only grows while queued
      let gx = c % gw, gy = (c / gw) | 0
      let hasL = gx > 0, hasR = gx < gw - 1, hasU = gy > 0, hasD = gy < gh - 1
      while (grid[c] >= 4 && done < budget) {
        grid[c] -= 4
        if (everToppled[c] === 0) { everToppled[c] = 1; heat[c] = HEAT_MAX }
        done++
        if (hasL) { let nb = c - 1;  grid[nb]++; if (grid[nb] >= 4) push(nb) }
        if (hasR) { let nb = c + 1;  grid[nb]++; if (grid[nb] >= 4) push(nb) }
        if (hasU) { let nb = c - gw; grid[nb]++; if (grid[nb] >= 4) push(nb) }
        if (hasD) { let nb = c + gw; grid[nb]++; if (grid[nb] >= 4) push(nb) }
      }
      if (grid[c] >= 4) push(c)             // budget ran out mid-drain — resume next frame
    }
  }
}

export let frame = (t) => {
  frameCount++
  // feed each live source in proportion to its remaining budget — rings rush out early,
  // the last filigree settles slowly; a spent source stops (the free pile stays a mandala)
  let feeding = 0
  let i = 0
  while (i < srcN) {
    let left = srcBudget[i]
    if (left > 0) {
      let k = (left * 0.005) | 0
      if (k < K_MIN) k = K_MIN
      if (k > K_MAX) k = K_MAX
      if (k > left) k = left
      srcBudget[i] = left - k
      let c = srcY[i] * Gw + srcX[i]
      grid[c] += k
      if (grid[c] >= 4) push(c)
      feeding = 1
    }
    i++
  }
  // idle rain: single grains at LCG spots spark small avalanches over the finished pile —
  // SOC shimmer, sparse enough that the mandala persists for minutes. Gated to cells that
  // have toppled before (i.e. ON the pile) so the void stays clean of stray specks.
  if (feeding === 0 && srcN > 0 && frameCount % RAIN_EVERY === 0) {
    rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff
    let rx2 = rng % Gw
    rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff
    let ry2 = rng % Gh
    let c = ry2 * Gw + rx2
    if (everToppled[c] === 1) {
      grid[c] += 4
      heat[c] = HEAT_MAX
      push(c)
    }
  }

  relax(MAXTOPPLE)

  // render: one pass over the sim grid, each cell painted as a crisp CELL×CELL pixel block
  let gw = Gw, gh = Gh, w = W, cell = CELL, gy = 0
  while (gy < gh) {
    let baseRow = gy * cell * w, rowG = gy * gw
    let gx = 0
    while (gx < gw) {
      let ci = rowG + gx
      let g = grid[ci]
      let v = 0
      if (g === 1) v = L1
      else if (g === 2) v = L2
      else if (g >= 3) v = L3

      let h = heat[ci]
      if (h > 0) {
        v += h
        if (v > 255) v = 255
        h -= HEAT_DECAY
        if (h < 0) h = 0
        heat[ci] = h
      }

      let col = (255 << 24) | (v << 16) | (v << 8) | v
      let baseCol = baseRow + gx * cell
      let ry = 0
      while (ry < cell) {
        let p = baseCol + ry * w
        let rx = 0
        while (rx < cell) { px[p + rx] = col; rx++ }
        ry++
      }
      gx++
    }
    gy++
  }
}

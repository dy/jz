// Wireworld — a 4-state cellular automaton that models electronics. Cells are empty,
// conductor, electron head, or electron tail. Each step: head→tail, tail→conductor, and
// conductor→head iff exactly 1 or 2 of its 8 neighbours are heads (else stays conductor).
//   states: 0 empty · 1 head · 2 tail · 3 conductor
//
// The seed lays out an IC-DIE FLOORPLAN: a grid of tiled macro-cell BLOCKS separated by empty
// routing gutters, each one of 14 canonical machines DEALT FROM A SHUFFLE-BAG (every kind appears
// once before any repeats) so a screenful shows each machine ~once — no "spiral twice / net twice";
// the deal also skips a kind that would touch a matching LEFT or ABOVE neighbour. Blocks are big
// (only ~one grid of them per die, ≈ the kind count) and each tile's occupied rect is jittered
// a little smaller than its grid cell so the die doesn't read as a rigid uniform matrix —
//   busBank      a bank of parallel wires, each one-way gated by a DIODE (the canonical
//                Wireworld valve: a 3-cell cap + offset stub; verified both directions ×4
//                cardinal orientations — see diode()).
//   combTree     a bus that fans out into many teeth (drips a copy of every passing electron
//                down each tooth — the fan-out / clock-distribution primitive).
//   clockFarm    a packed grid of small conductor LOOPS, each circulating electrons forever —
//                a bank of free-running ring-oscillator clocks.
//   serpentineMesh  parallel folded delay lines (shift registers) threading one electron
//                each through a maze of turns.
//   bigRing      ONE large loop filling most of the block — the slow, bold size-contrast
//                partner to clockFarm's many small fast loops (same primitive, different scale).
//   diagMesh     a hatch of parallel 45° wires — the die's one non-orthogonal texture.
//   spiralCoil   a single wire wound into a square spiral, gun-fed at the outer end, dead-ending
//                at the centre.
//   hTree        a clock-distribution H-tree: one trunk, 2-3 branch levels, each level tapped
//                straight off the last through a shared conductor cell (see "Gates" below).
//   busTaps      a bus ribbed with short alternating up/down stubs — denser and more regular
//                than combTree's longer one-sided teeth.
//   radialStar   a small clock loop with 4 cardinal spokes reading its passing pulses.
//   checkerboardOsc  clockFarm's small loops on a checkerboard skip (half the cells left empty)
//                — the sparse counterpart to clockFarm's fully-packed grid.
//   maze         a perfect maze (spanning TREE, no loops) carved by randomized depth-first
//                backtracking on a coarse cell lattice — corridors are 1px conductor; a pulse
//                from the entrance floods every branch and dies at each dead end, refilled by
//                the source next cycle — current racing through a labyrinth.
//   sierpinski   the Sierpinski triangle's EDGES, subdivided to a fixed depth — one connected
//                fractal web of conductor where every internal vertex is a 4-way crossing;
//                a source at the apex cascades current down through the whole lattice.
//   hilbert      a single continuous Hilbert space-filling curve threading every cell of the
//                block exactly once — one gun-fed path with no branches, so a pulse marches
//                the entire meander in strict sequence.
// Block kind/size/position are all randomized (Math.random) so the die differs every reload,
// but tiles densely across however big the grid is — a phone-sized preview gets a couple of
// blocks, the full desktop canvas gets dozens, reading as one dense, routed, varied microchip.
//
// Gates: taps are NOT spliced mid-LOOP (a loop is a closed, self-contained oscillator — see
// placeLoop). Mid-WIRE taps, though, are fine in two verified shapes: an OFFSET stub one row off
// the through-wire (comb's teeth: the tap cell is Moore-adjacent to the bus, not shared with it)
// and a plain SHARED-CELL junction (a T or + crossing, the through-wire and the tap sharing one
// conductor cell). Both were empirically re-verified while building this file's new blocks —
// single pulses, chained taps-of-taps (hTree), and independently-clocked crossings all settle
// into a bounded, echo-free rhythm over thousands of ticks; the one shape that DOES backfire is a
// loop tapped at a CORNER (a cell that already carries two arms of the loop; a third breaks the
// neighbour count and kills the whole oscillator) — radialStar's spokes stay off the loop's
// corners, touching only its edge midpoints. Every electron is injected only at true wire DEAD
// ENDS via the kernel-side "gun" in frame(), and clock loops stay purely self-contained
// oscillators, never bridged into a bus.
//
// resize(w,h) → Uint32Array; frame() steps; seed() rebuilds; paint() to edit.

let W = 0, H = 0, px
let a, b                 // ping-pong state grids
let srcX, srcY           // electron-injection sources (wire dead ends)
let srcPeriod, srcPhase  // each source's OWN cadence — a chip full of clock domains, not one
                         // synchronized strobe (set once, when the source is placed)
let srcN = 0             // number of sources
let tick = 0             // free-running step counter, drives every source's schedule
let MAXSRC = 4096        // generous cap for a dense tiled die across 14 block kinds
let prevKind             // previous ROW's block kind per column (≤8 cols) — the no-repeat rule's memory
let KINDS = 14           // total macro-cell kinds
let bag = new Int32Array(14)   // shuffle-bag: every kind is dealt ONCE before any repeats, so a
let bagPos = 14                // screenful shows each machine ~once — no "spiral twice / net twice"
let mazeVis, mazeStack  // maze recursive-backtracker scratch: visited flags + explicit DFS stack
                        // (sized in resize() to the largest lattice any single block could hold)
let TRI_CAP = 256       // sierpinski subdivision stack depth cap (empirically ~10 deep, max — huge margin)
let triStack            // explicit DFS stack for sierpinski's triangle subdivision: 7 ints/frame
                        // (3 vertices + depth), TRI_CAP frames deep

export let resize = (w, h) => {
  W = w; H = h
  a = new Int32Array(w * h); b = new Int32Array(w * h)
  srcX = new Int32Array(MAXSRC); srcY = new Int32Array(MAXSRC)
  srcPeriod = new Int32Array(MAXSRC); srcPhase = new Int32Array(MAXSRC)
  prevKind = new Int32Array(8)
  // a block's rect always sits INSIDE the canvas, so its cell-lattice cell count can never
  // exceed w*h / pitch² — pitch ≥ 5, so /25 is a provable (not just generous) upper bound.
  let mazeCap = ((w * h / 25) | 0) + 64
  mazeVis = new Int32Array(mazeCap); mazeStack = new Int32Array(mazeCap)
  triStack = new Int32Array(TRI_CAP * 7)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { a[i] = 0; b[i] = 0; i++ } }

// Rectangular brush: the cell under the cursor plus r cells right & down — an
// (r+1)-wide filled square. r=0 paints one cell, r=1 a 2×2 block (a 2px line under
// a drag). A circular brush (dx²+dy² ≤ r²) silently painted NOTHING at r=0: with a
// sub-pixel centre, x|0 ≠ cx so dx² > 0 = r² and no cell qualified.
export let paint = (cx, cy, r, state) => {
  let x0 = cx | 0, y0 = cy | 0, x1 = x0 + r, y1 = y0 + r
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let y = y0
  while (y <= y1) {
    let row = y * W, x = x0
    while (x <= x1) { a[row + x] = state; x++ }
    y++
  }
}

// map a clockwise perimeter index s∈[0,per) of the rectangle to a cell and set its state
let setPerim = (ax, ay, bx, by, pw, ph, s, state) => {
  let x = ax, y = ay
  if (s < pw) { x = ax + s; y = ay }                       // top edge, L→R
  else if (s < pw + ph) { x = bx; y = ay + (s - pw) }      // right edge, T→B
  else if (s < pw + ph + pw) { x = bx - (s - pw - ph); y = by }  // bottom, R→L
  else { x = ax; y = by - (s - pw - ph - pw) }             // left edge, B→T
  a[y * W + x] = state
}

// a rectangular conductor loop (outline) carrying k electrons evenly spaced around it, all
// circulating clockwise. Small loops tick fast (clocks); large loops carry trains (buses).
// Self-contained — never tap a loop mid-perimeter (see file header): the loop itself is the
// whole gadget, its only job is to blink forever at a period set by its own size.
let placeLoop = (x0, y0, x1, y1, k) => {
  let ax = (x0 < x1 ? x0 : x1) | 0, bx = (x0 < x1 ? x1 : x0) | 0
  let ay = (y0 < y1 ? y0 : y1) | 0, by = (y0 < y1 ? y1 : y0) | 0
  if (ax < 1) ax = 1
  if (ay < 1) ay = 1
  if (bx > W - 2) bx = W - 2
  if (by > H - 2) by = H - 2
  if (bx - ax < 4 || by - ay < 4) return
  let x = ax
  while (x <= bx) { a[ay * W + x] = 3; a[by * W + x] = 3; x++ }
  let y = ay
  while (y <= by) { a[y * W + ax] = 3; a[y * W + bx] = 3; y++ }
  let pw = bx - ax, ph = by - ay, per = 2 * (pw + ph)
  let j = 0
  while (j < k) {
    let s = (per * j / k) | 0
    setPerim(ax, ay, bx, by, pw, ph, s, 1)                 // head
    setPerim(ax, ay, bx, by, pw, ph, (s + per - 1) % per, 2)  // tail just behind it
    j++
  }
}

let hwire = (x0, x1, y) => { let x = x0; while (x <= x1) { a[y * W + x] = 3; x++ } }
let vwire = (x, y0, y1) => { let y = y0; while (y <= y1) { a[y * W + x] = 3; y++ } }

// a 45°-only wire (|dx|=|dy| per step) — same two-neighbours-per-cell topology as a straight
// hwire/vwire, just rotated: a single pulse travels it cleanly end to end, no self-interference
// (verified). The die's one non-axis-aligned primitive, used by diagMesh.
let diagWire = (x0, y0, x1, y1) => {
  let dx = x1 > x0 ? 1 : -1, dy = y1 > y0 ? 1 : -1
  let x = x0, y = y0
  while (x !== x1) { a[y * W + x] = 3; x = x + dx; y = y + dy }
  a[y * W + x] = 3
}

// arbitrary-slope 1px conductor line (integer Bresenham) — wire/diagWire only cover the
// horizontal/vertical/45° cases; sierpinski's fractal edges are general-slope segments of a
// subdivided triangle. Standard "error accumulator" form: exactly max(dx,dy)+1 pixels plotted,
// always landing exactly on (x1,y1) — verified against a plain-JS reference (no dupes, no gaps).
let lineWire = (x0, y0, x1, y1) => {
  let dx = x1 - x0; if (dx < 0) dx = -dx
  let dy = y1 - y0; if (dy < 0) dy = -dy
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let steps = (dx > dy ? dx : dy) + 1
  let err = dx - dy, x = x0, y = y0, i = 0
  while (i < steps) {
    a[y * W + x] = 3
    let e2 = 2 * err
    if (e2 > -dy) { err = err - dy; x = x + sx }
    if (e2 < dx) { err = err + dx; y = y + sy }
    i++
  }
}

let addSrc = (x, y, period, phase) => {
  if (srcN < MAXSRC) { srcX[srcN] = x; srcY[srcN] = y; srcPeriod[srcN] = period; srcPhase[srcN] = phase; srcN = srcN + 1 }
}

// integer in [lo, lo+span) — Math.random is seeded per run (per instantiation in jz), so the
// layout below differs on every page load and every reseed.
let rndi = (lo, span) => lo + ((Math.random() * span) | 0)

// A Wireworld DIODE, the canonical one-way valve, oriented to one of 4 cardinal directions
// (dir: 0 east 1 south 2 west 3 north — forward = the direction current is allowed to travel).
// Base shape (east): a 3-cell cap straddling the wire one row upstream, plus a single stub one
// row downstream on the trailing side. The other 3 orientations are the same shape rotated /
// mirrored — valid because the head-count rule only counts neighbours, never their identity,
// so it is symmetric under every rotation & reflection of the grid (empirically verified all
// 4 directions: forward passes, reverse is blocked).
let diode = (cx, cy, dir) => {
  if (dir === 0) {          // east
    a[(cy - 1) * W + (cx - 1)] = 3; a[(cy - 1) * W + cx] = 3; a[(cy - 1) * W + (cx + 1)] = 3
    a[(cy + 1) * W + (cx - 1)] = 3
  } else if (dir === 2) {   // west (mirror of east)
    a[(cy - 1) * W + (cx - 1)] = 3; a[(cy - 1) * W + cx] = 3; a[(cy - 1) * W + (cx + 1)] = 3
    a[(cy + 1) * W + (cx + 1)] = 3
  } else if (dir === 1) {   // south (transpose of east)
    a[(cy - 1) * W + (cx - 1)] = 3; a[cy * W + (cx - 1)] = 3; a[(cy + 1) * W + (cx - 1)] = 3
    a[(cy - 1) * W + (cx + 1)] = 3
  } else {                  // north (mirror of south)
    a[(cy - 1) * W + (cx - 1)] = 3; a[cy * W + (cx - 1)] = 3; a[(cy + 1) * W + (cx - 1)] = 3
    a[(cy + 1) * W + (cx + 1)] = 3
  }
}

// FAN-OUT COMB: a horizontal bus fed by a gun at its left end, with `teeth` vertical wires hanging
// down at even intervals. Each electron streaming along the bus drips a copy down every tooth it
// passes — the canonical clock-distribution / fan-out primitive. (Verified echo-free: a single
// pulse produces exactly one hit at the far end and the whole gate falls silent after.)
let comb = (x0, x1, y, teeth, toothLen) => {
  hwire(x0, x1, y)
  let yend = y + toothLen; if (yend > H - 2) yend = H - 2
  let span = x1 - x0, i = 0
  while (i < teeth) {
    let tx = x0 + ((span * (i + 1) / (teeth + 1)) | 0)
    vwire(tx, y + 1, yend)
    i++
  }
  addSrc(x0, y, rndi(9, 14), rndi(0, 24))
}

// SERPENTINE DELAY LINE: one long folded wire snaking back and forth across `rows`, fed by a gun at
// the start. A single electron threads the whole maze — a delay line / shift register. Runs join at
// alternating ends, the same L-corners the clock loops already turn cleanly.
let serpentine = (x0, x1, y0, rows, gap) => {
  let r = 0
  while (r < rows) {
    let yy = y0 + r * gap
    if (yy > H - 2) break
    hwire(x0, x1, yy)
    if (r < rows - 1) {
      let yn = y0 + (r + 1) * gap; if (yn > H - 2) yn = H - 2
      vwire((r % 2 == 0) ? x1 : x0, yy, yn)   // link this run's far end down to the next
    }
    r++
  }
  addSrc(x0, y0, rndi(9, 14), rndi(0, 24))
}

// ── macro-cell BLOCKS: each tiles its own machine to fill a die-floorplan rectangle ──────────

// busBank: a stack of parallel diode-gated wires, each fed from a random end (matching diode
// orientation, so the intended signal always passes and the reverse direction is blocked).
let busBank = (x0, y0, x1, y1) => {
  let wx0 = x0 + 3, wx1 = x1 - 3
  if (wx1 - wx0 < 14) return
  let y = y0 + 2
  while (y + 2 <= y1) {
    let fromLeft = Math.random() < 0.5
    hwire(wx0, wx1, y)
    let gates = Math.random() < 0.72 ? rndi(1, 2) : 0, gi = 0   // some rows run bare, for contrast
    while (gi < gates) {
      let gx = wx0 + 5 + (((wx1 - wx0 - 10) * (gi + 1) / (gates + 1)) | 0)
      diode(gx, y, fromLeft ? 0 : 2)
      gi++
    }
    if (fromLeft) addSrc(wx0, y, rndi(9, 14), rndi(0, 24))
    else addSrc(wx1, y, rndi(9, 14), rndi(0, 24))
    y = y + rndi(4, 3)
  }
}

// combTree: a stack of fan-out combs, teeth hanging toward the block's bottom. Teeth are
// capped well under the full block height so several rows tile per block (density) instead
// of one long-toothed comb swallowing the whole thing.
let combTree = (x0, y0, x1, y1) => {
  let wx0 = x0 + 2, wx1 = x1 - 2
  if (wx1 - wx0 < 12) return
  let cap = ((y1 - y0) * 0.3) | 0; if (cap < 6) cap = 6
  let y = y0 + 2
  while (y + 6 <= y1) {
    let maxTooth = y1 - y - 2
    if (maxTooth < 4) break
    let toothMax = maxTooth - 3 < 1 ? 1 : maxTooth - 3
    if (toothMax > cap) toothMax = cap
    let toothLen = rndi(4, toothMax)
    let teeth = rndi(2, 4)
    comb(wx0, wx1, y, teeth, toothLen)
    y = y + toothLen + rndi(4, 4)
  }
}

// clockFarm: a packed 2D grid of small self-oscillating loops (ring-oscillator bank).
let clockFarm = (x0, y0, x1, y1) => {
  let cw = x1 - x0, ch = y1 - y0
  if (cw < 16 || ch < 12) return
  let cols = (cw / 22) | 0; if (cols < 1) cols = 1
  let rows = (ch / 16) | 0; if (rows < 1) rows = 1
  let cellW = (cw / cols) | 0, cellH = (ch / rows) | 0
  let r = 0
  while (r < rows) {
    let c = 0
    while (c < cols) {
      let lx0 = x0 + c * cellW + rndi(0, 3)
      let ly0 = y0 + r * cellH + rndi(0, 3)
      let lw = cellW - rndi(4, 6); if (lw < 5) lw = 5
      let lh = cellH - rndi(3, 5); if (lh < 5) lh = 5
      placeLoop(lx0, ly0, lx0 + lw, ly0 + lh, rndi(1, 3))
      c++
    }
    r++
  }
}

// serpentineMesh: parallel folded delay lines side by side — a shift-register bank.
let serpentineMesh = (x0, y0, x1, y1) => {
  let cw = x1 - x0, ch = y1 - y0
  let lanes = (cw / 24) | 0; if (lanes < 1) lanes = 1
  let laneW = (cw / lanes) | 0
  let gap = rndi(4, 3)
  let maxRows = ((ch - 4) / gap) | 0
  if (maxRows < 2) return
  let i = 0
  while (i < lanes) {
    let lx0 = x0 + i * laneW + 3, lx1 = lx0 + laneW - 6
    if (lx1 - lx0 >= 6) {
      let rows = rndi(2, maxRows - 1 < 1 ? 1 : maxRows - 1)
      serpentine(lx0, lx1, y0 + 2, rows, gap)
    }
    i++
  }
}

// bigRing: ONE large loop filling most of the block — the size-contrast partner to clockFarm's
// many small loops. Same placeLoop primitive, just handed almost the whole tile: a slow, bold
// single ring (long perimeter ⇒ long rotational period) instead of a frantic packed grid.
let bigRing = (x0, y0, x1, y1) => {
  let mx = ((x1 - x0) * 0.08) | 0, my = ((y1 - y0) * 0.08) | 0
  placeLoop(x0 + mx, y0 + my, x1 - mx, y1 - my, rndi(1, 3))
}

// diagMesh: a hatch of parallel 45° wires, all the same direction (chosen per block), each its
// own gun-fed dead-end line spaced well past the 2-cell safe gap. Reads as a woven/hatched
// texture against the die's otherwise all-orthogonal grid.
let diagMesh = (x0, y0, x1, y1) => {
  let bw = x1 - x0, bh = y1 - y0
  if (bw < 24 || bh < 20) return
  let len = bh - 6; if (len > bw - 6) len = bw - 6
  if (len < 8) return
  let pitch = rndi(4, 3)                // 4..6 apart
  let backslash = Math.random() < 0.5   // "\" vs "/"
  let sx = backslash ? x0 + 3 : x1 - 3
  while (backslash ? sx + len <= x1 - 3 : sx - len >= x0 + 3) {
    let ex = backslash ? sx + len : sx - len
    diagWire(sx, y0 + 3, ex, y0 + 3 + len)
    addSrc(sx, y0 + 3, rndi(9, 14), rndi(0, 24))
    sx = backslash ? sx + pitch : sx - pitch
  }
}

// spiralCoil: a single wire wound into a square spiral — outer gun feeds inward to a dead-end
// centre. A bold, singular coil shape against the die's rows-of-many blocks. Each ring sits
// `pitch` (≥2) cells inside the last, well past any cross-ring adjacency; verified over 2500+
// ticks — the long single track queues many simultaneous pulses and settles into a bounded,
// never-dying rhythm (the same saturating-conveyor behaviour any long enough wire/loop settles
// into in this CA).
let spiralCoil = (x0, y0, x1, y1) => {
  let pitch = rndi(3, 2)                // 3..4
  let ax = x0 + 2, ay = y0 + 2, bx = x1 - 2, by = y1 - 2
  if (bx - ax < 4 * pitch || by - ay < 4 * pitch) return
  let tipX = ax, tipY = ay
  while (bx - ax >= 2 * pitch && by - ay >= 2 * pitch) {
    hwire(ax, bx, ay); vwire(bx, ay, by); hwire(ax + pitch, bx, by); vwire(ax + pitch, ay + pitch, by)
    ax = ax + pitch; ay = ay + pitch; bx = bx - pitch; by = by - pitch
  }
  addSrc(tipX, tipY, rndi(9, 14), rndi(0, 24))
}

// hTree: a clock-distribution H-tree. One gun-fed vertical trunk; 2-3 horizontal branch levels
// tap straight off it through a SHARED conductor cell (a plain T junction — verified: splits a
// pulse into every connected arm cleanly, no backfire into the trunk; comb's offset-stub tooth
// isn't the only safe tap shape). Each branch is further tapped by short vertical sub-branches —
// a genuine 2-level fan-out, every tip a plain dead end.
let hTree = (x0, y0, x1, y1) => {
  let cx = (x0 + x1) >> 1
  let top = y0 + 3, bot = y1 - 3
  let armMax = ((x1 - x0) >> 1) - 4
  if (bot - top < 20 || armMax < 8) return
  vwire(cx, top, bot)
  addSrc(cx, bot, rndi(9, 14), rndi(0, 24))
  let levels = rndi(2, 2), i = 1        // 2-3 branch levels
  while (i <= levels) {
    let ty = top + (((bot - top) * i / (levels + 1)) | 0)
    let armLen = rndi(armMax - 3, 4)
    let rx = cx + armLen, lx = cx - armLen
    hwire(cx, rx, ty)
    hwire(lx, cx, ty)
    let subLen = 5, subR = cx + (armLen >> 1), subL = cx - (armLen >> 1)
    if (ty + subLen <= bot) { vwire(subR, ty, ty + subLen); vwire(rx, ty, ty + subLen) }
    if (ty - subLen >= top) { vwire(subL, ty - subLen, ty); vwire(lx, ty - subLen, ty) }
    i++
  }
}

// busTaps: a bus ribbed with short stubs alternating above/below at regular intervals, stacked
// in rows — denser and more regular than combTree's longer, one-sided, variable-length teeth.
let busTaps = (x0, y0, x1, y1) => {
  let wx0 = x0 + 2, wx1 = x1 - 2
  if (wx1 - wx0 < 24) return
  let ribLen = rndi(3, 4), spacing = rndi(6, 5), rowGap = ribLen + rndi(5, 3)
  let y = y0 + ribLen + 2
  while (y + ribLen + 2 <= y1) {
    hwire(wx0, wx1, y)
    addSrc(wx0, y, rndi(9, 14), rndi(0, 24))
    let x = wx0 + spacing, up = true
    while (x < wx1 - 2) {
      if (up) vwire(x, y - ribLen, y); else vwire(x, y, y + ribLen)
      x = x + spacing
      up = !up
    }
    y = y + rowGap
  }
}

// radialStar: a small clock loop with 4 cardinal spokes touching its perimeter — a plain wire
// picking up the loop's passing pulses by adjacency (same mechanism as a comb tooth). Diagonal /
// corner-touching spokes were tried and KILL the loop (a corner cell already carries two arms of
// the loop; a third breaks its neighbour count) — so spokes touch only the edge MIDPOINTS.
let radialStar = (x0, y0, x1, y1) => {
  let cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1
  let r = ((Math.min(x1 - x0, y1 - y0)) * 0.24) | 0; if (r < 4) r = 4
  if (x1 - x0 < r * 2 + 10 || y1 - y0 < r * 2 + 10) return
  placeLoop(cx - r, cy - r, cx + r, cy + r, rndi(1, 3))
  if (cx + r + 4 <= x1 - 2) hwire(cx + r, x1 - 2, cy)
  if (cx - r - 4 >= x0 + 2) hwire(x0 + 2, cx - r, cy)
  if (cy + r + 4 <= y1 - 2) vwire(cx, cy + r, y1 - 2)
  if (cy - r - 4 >= y0 + 2) vwire(cx, y0 + 2, cy - r)
}

// checkerboardOsc: clockFarm's small loops, but on a checkerboard skip (half the cells left
// empty) — the die's sparse, light-density counterpart to clockFarm's fully-packed grid.
let checkerboardOsc = (x0, y0, x1, y1) => {
  let cw = x1 - x0, ch = y1 - y0
  if (cw < 20 || ch < 16) return
  let cols = (cw / 14) | 0; if (cols < 2) cols = 2
  let rows = (ch / 14) | 0; if (rows < 2) rows = 2
  let cellW = (cw / cols) | 0, cellH = (ch / rows) | 0
  let r = 0
  while (r < rows) {
    let c = 0
    while (c < cols) {
      if ((r + c) % 2 === 0) {
        let lx0 = x0 + c * cellW + 2, ly0 = y0 + r * cellH + 2
        let lw = cellW - 5; if (lw < 5) lw = 5
        let lh = cellH - 5; if (lh < 5) lh = 5
        placeLoop(lx0, ly0, lx0 + lw, ly0 + lh, rndi(1, 2))
      }
      c++
    }
    r++
  }
}

// mazeBlock: a PERFECT maze (spanning TREE — no loops) carved by randomized depth-first
// "recursive backtracker" on a coarse cell lattice (~5-7px pitch), explicit stack (mazeVis /
// mazeStack, sized in resize() to the largest lattice any block could hold) — no recursion.
// Passages are 1px conductor: a dot at every visited cell's centre, a straight run knocking
// through to whichever neighbour gets carved. Being a TREE, the entrance has exactly one path
// to every cell: a pulse floods the whole structure and dies cleanly at each dead end, refilled
// by the source on the next cycle — current racing through a labyrinth (verified: heads reach
// deep branches, not just the first junction — see file header on T/+ junctions).
let mazeBlock = (x0, y0, x1, y1) => {
  let pitch = rndi(5, 3)                        // 5..7px cell pitch
  let m = 3
  let cols = ((x1 - x0 - 2 * m) / pitch) | 0
  let rows = ((y1 - y0 - 2 * m) / pitch) | 0
  if (cols < 3 || rows < 3) return
  let n = cols * rows, i = 0
  while (i < n) { mazeVis[i] = 0; i++ }
  let ox = x0 + m, oy = y0 + m                  // pixel of lattice cell (0,0)'s centre
  mazeVis[0] = 1
  a[oy * W + ox] = 3
  let sp = 0
  mazeStack[sp] = 0; sp++
  while (sp > 0) {
    let c = mazeStack[sp - 1]
    let ci = c % cols, cj = (c / cols) | 0
    // unvisited lattice-neighbours (N,S,E,W)
    let dirs = 0, n0 = -1, n1 = -1, n2 = -1, n3 = -1
    if (cj > 0 && mazeVis[c - cols] === 0) { n0 = c - cols; dirs++ }
    if (cj < rows - 1 && mazeVis[c + cols] === 0) { n1 = c + cols; dirs++ }
    if (ci > 0 && mazeVis[c - 1] === 0) { n2 = c - 1; dirs++ }
    if (ci < cols - 1 && mazeVis[c + 1] === 0) { n3 = c + 1; dirs++ }
    if (dirs === 0) { sp-- }
    else {
      let pick = (Math.random() * dirs) | 0
      let nb = -1
      if (n0 >= 0) { if (pick === 0) nb = n0; else pick-- }
      if (nb < 0 && n1 >= 0) { if (pick === 0) nb = n1; else pick-- }
      if (nb < 0 && n2 >= 0) { if (pick === 0) nb = n2; else pick-- }
      if (nb < 0 && n3 >= 0) { if (pick === 0) nb = n3; else pick-- }
      let ni = nb % cols, nj = (nb / cols) | 0
      let pcx = ox + ci * pitch, pcy = oy + cj * pitch
      let pnx = ox + ni * pitch, pny = oy + nj * pitch
      if (ni === ci) vwire(pcx, pcy < pny ? pcy : pny, pcy < pny ? pny : pcy)
      else hwire(pcx < pnx ? pcx : pnx, pcx < pnx ? pnx : pcx, pcy)
      mazeVis[nb] = 1
      mazeStack[sp] = nb; sp++
    }
  }
  // a short stub off the entrance — a TRUE dead end for the gun, whatever degree the maze
  // itself carved onto cell (0,0) (recursive backtracker can leave it anywhere from 1 to 4).
  a[(oy - 1) * W + ox] = 3; a[(oy - 2) * W + ox] = 3
  addSrc(ox, oy - 2, rndi(9, 14), rndi(0, 24))
}

// sierpinskiBlock: the Sierpinski triangle's EDGES as conductor, subdivided to a fixed depth
// via an explicit stack (triStack: 3 vertices + depth packed 7 ints/frame, TRI_CAP frames deep
// — verified against a plain-JS reference: max simultaneous depth ~10, nowhere near the cap).
// Midpoint subdivision is affine, so it works on the block's own (non-equilateral) triangle
// exactly like a true one. Every internal subdivision vertex is shared by the two triangles
// that meet there, each contributing 2 of its 3 edges — a validated 4-way shared-cell crossing
// (see file header's "Gates") — so the whole multi-scale edge set is ONE connected web (verified:
// a single connected pixel component reaching all 3 corners). A source at the apex cascades
// current through every one of those crossings, all the way down to the base.
let sierpinskiBlock = (x0, y0, x1, y1) => {
  let bw = x1 - x0, bh = y1 - y0
  if (bw < 40 || bh < 36) return
  let ins = 3
  let ax = (x0 + x1) >> 1, ay = y0 + ins           // apex
  let bx = x0 + ins, by = y1 - ins                 // base-left
  let cx = x1 - ins, cy = y1 - ins                 // base-right
  let depth = (bw > 170 && bh > 150) ? 4 : 3
  triStack[0] = ax; triStack[1] = ay; triStack[2] = bx; triStack[3] = by
  triStack[4] = cx; triStack[5] = cy; triStack[6] = 0
  let sp = 1
  while (sp > 0) {
    sp--
    let o = sp * 7
    let p0x = triStack[o], p0y = triStack[o + 1]
    let p1x = triStack[o + 2], p1y = triStack[o + 3]
    let p2x = triStack[o + 4], p2y = triStack[o + 5]
    let d = triStack[o + 6]
    if (d === depth) {
      lineWire(p0x, p0y, p1x, p1y)
      lineWire(p1x, p1y, p2x, p2y)
      lineWire(p2x, p2y, p0x, p0y)
    } else {
      // connect edge midpoints, keep the 3 corner sub-triangles, drop the middle (the hole)
      let m01x = (p0x + p1x) >> 1, m01y = (p0y + p1y) >> 1
      let m12x = (p1x + p2x) >> 1, m12y = (p1y + p2y) >> 1
      let m20x = (p2x + p0x) >> 1, m20y = (p2y + p0y) >> 1
      let d1 = d + 1, o0 = sp * 7
      triStack[o0] = p0x; triStack[o0 + 1] = p0y; triStack[o0 + 2] = m01x; triStack[o0 + 3] = m01y
      triStack[o0 + 4] = m20x; triStack[o0 + 5] = m20y; triStack[o0 + 6] = d1
      sp++
      let o1 = sp * 7
      triStack[o1] = m01x; triStack[o1 + 1] = m01y; triStack[o1 + 2] = p1x; triStack[o1 + 3] = p1y
      triStack[o1 + 4] = m12x; triStack[o1 + 5] = m12y; triStack[o1 + 6] = d1
      sp++
      let o2 = sp * 7
      triStack[o2] = m20x; triStack[o2 + 1] = m20y; triStack[o2 + 2] = m12x; triStack[o2 + 3] = m12y
      triStack[o2 + 4] = p2x; triStack[o2 + 5] = p2y; triStack[o2 + 6] = d1
      sp++
    }
  }
  a[(ay - 1) * W + ax] = 3; a[(ay - 2) * W + ax] = 3   // short stub off the apex — a TRUE dead end
  addSrc(ax, ay - 2, rndi(9, 14), rndi(0, 24))
}

// hilbertBlock: ONE continuous Hilbert space-filling curve threading the block — the standard
// iterative d2xy bit-twiddling (no recursion, no stack needed: it's a closed-form bit-loop per
// cell), order picked from the block's shorter side. Consecutive curve steps are always
// orthogonally adjacent by construction (verified against a plain-JS reference: zero
// discontinuities, every one of the n×n cells visited exactly once), so the drawn segments
// chain into one unbroken conductor path with no branches — a single source at the curve's
// first cell (a true dead end: nothing else ever touches it) sends every pulse marching the
// entire meander in strict sequence, a hypnotic single-file procession.
let hilbertBlock = (x0, y0, x1, y1) => {
  let bw = x1 - x0, bh = y1 - y0
  let side = bw < bh ? bw : bh
  let order = side >= 130 ? 5 : 4
  let n = 1 << order
  let cw = (bw / n) | 0, ch = (bh / n) | 0
  if (cw < 2 || ch < 2) { order = 4; n = 16; cw = (bw / n) | 0; ch = (bh / n) | 0 }
  if (cw < 2 || ch < 2) return
  let ox = x0 + ((bw - n * cw) >> 1), oy = y0 + ((bh - n * ch) >> 1)
  let total = n * n
  let lastX = -1, lastY = -1, startX = 0, startY = 0
  let d = 0
  while (d < total) {
    // d2xy: distance-along-curve → (x,y), the classic iterative bit-doubling form
    let t = d, x = 0, y = 0, s = 1
    while (s < n) {
      let rx = 1 & (t >> 1)
      let ry = 1 & (t ^ rx)
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y }
        let tmp = x; x = y; y = tmp
      }
      x = x + s * rx
      y = y + s * ry
      t = t >> 2
      s = s * 2
    }
    let curX = ox + x * cw + (cw >> 1), curY = oy + y * ch + (ch >> 1)
    if (d === 0) { startX = curX; startY = curY }
    else if (curX === lastX) vwire(curX, lastY < curY ? lastY : curY, lastY < curY ? curY : lastY)
    else hwire(lastX < curX ? lastX : curX, lastX < curX ? curX : lastX, lastY)
    lastX = curX; lastY = curY
    d++
  }
  addSrc(startX, startY, rndi(9, 14), rndi(0, 24))
}

// A fresh RANDOM die each load: a grid of macro-cell BLOCKS (14 kinds — bus banks, fan-out trees,
// clock farms, delay-line meshes, big rings, diagonal hatches, spiral coils, H-trees, ribbed
// buses, radial stars, checkerboard oscillators, mazes, Sierpinski fractals, Hilbert curves)
// tiled across whatever the canvas resolves to,
// separated by empty routing gutters. Each tile's kind is rerolled until it differs from both its
// LEFT and ABOVE neighbour, and its occupied rect is jittered a little smaller than its grid cell
// — so the die reads as varied and non-repeating, never a rigid uniform matrix. Block size is
// roughly constant in CELLS, so a bigger/denser grid gets MORE blocks (a richer die), not just
// bigger ones — same generator reads right at a small preview and fills a huge canvas with dozens
// of varied machines.
// Fisher–Yates reshuffle of the kind bag, dealt from the front. dealKind avoids the two given
// neighbour kinds when possible (scans the undealt remainder for a non-colliding entry and swaps
// it to the front), so within one deal every kind appears once and adjacent tiles rarely match.
let shuffleBag = () => {
  let i = 0
  while (i < KINDS) { bag[i] = i; i++ }
  i = KINDS - 1
  while (i > 0) { let j = (Math.random() * (i + 1)) | 0; let t = bag[i]; bag[i] = bag[j]; bag[j] = t; i-- }
  bagPos = 0
}
let dealKind = (avoidA, avoidB) => {
  if (bagPos >= KINDS) shuffleBag()
  let j = bagPos
  while (j < KINDS && (bag[j] === avoidA || bag[j] === avoidB)) j++
  if (j >= KINDS) j = bagPos                       // whole remainder collides — accept the front
  let k = bag[j]; bag[j] = bag[bagPos]; bag[bagPos] = k   // swap chosen entry to the front, deal it
  bagPos++
  return k
}

export let seed = () => {
  clear()
  srcN = 0; tick = 0
  shuffleBag()
  let mx = (W * 0.015) | 0; if (mx < 2) mx = 2
  let my = (H * 0.02) | 0; if (my < 2) my = 2
  let left = mx, right = W - 1 - mx, top = my, bottom = H - 1 - my
  let usableW = right - left, usableH = bottom - top
  if (usableW < 20 || usableH < 20) return

  // Fewer, BIGGER blocks (≈ the number of kinds) so one shuffle-bag deal covers the whole die and
  // each machine shows ~once — more distinct structure per tile, less repetition across the die.
  let cols = (usableW / 250) | 0; if (cols < 1) cols = 1; if (cols > 5) cols = 5
  let rows = (usableH / 230) | 0; if (rows < 1) rows = 1; if (rows > 4) rows = 4
  let gutter = 10; if (gutter > usableW * 0.1) gutter = (usableW * 0.1) | 0
  let bw = ((usableW - gutter * (cols - 1)) / cols) | 0
  let bh = ((usableH - gutter * (rows - 1)) / rows) | 0

  let K = KINDS                                  // total block kinds
  let ci = 0; while (ci < cols) { prevKind[ci] = -1; ci++ }   // no ABOVE neighbour for row 0

  let r = 0
  while (r < rows) {
    let c = 0, leftKind = -1                     // no LEFT neighbour at the start of a row
    while (c < cols) {
      let bx0 = left + c * (bw + gutter), by0 = top + r * (bh + gutter)
      let bx1 = bx0 + bw, by1 = by0 + bh
      if (bw >= 26 && bh >= 20) {
        // jitter the occupied rect a little within the cell (up to ~12% per side) so neighbouring
        // tiles' actual footprints vary, not just their contents
        let jw = (bw * 0.12) | 0, jh = (bh * 0.12) | 0
        let jx0 = bx0 + rndi(0, jw + 1), jy0 = by0 + rndi(0, jh + 1)
        let jx1 = bx1 - rndi(0, jw + 1), jy1 = by1 - rndi(0, jh + 1)

        let kind = dealKind(leftKind, prevKind[c])

        if (kind === 0) busBank(jx0, jy0, jx1, jy1)
        else if (kind === 1) combTree(jx0, jy0, jx1, jy1)
        else if (kind === 2) clockFarm(jx0, jy0, jx1, jy1)
        else if (kind === 3) serpentineMesh(jx0, jy0, jx1, jy1)
        else if (kind === 4) bigRing(jx0, jy0, jx1, jy1)
        else if (kind === 5) diagMesh(jx0, jy0, jx1, jy1)
        else if (kind === 6) spiralCoil(jx0, jy0, jx1, jy1)
        else if (kind === 7) hTree(jx0, jy0, jx1, jy1)
        else if (kind === 8) busTaps(jx0, jy0, jx1, jy1)
        else if (kind === 9) radialStar(jx0, jy0, jx1, jy1)
        else if (kind === 10) checkerboardOsc(jx0, jy0, jx1, jy1)
        else if (kind === 11) mazeBlock(jx0, jy0, jx1, jy1)
        else if (kind === 12) sierpinskiBlock(jx0, jy0, jx1, jy1)
        else hilbertBlock(jx0, jy0, jx1, jy1)

        leftKind = kind; prevKind[c] = kind
      }
      c++
    }
    r++
  }
}

export let frame = (t) => {
  let w = W, h = H, y = 0
  while (y < h) {
    let yn = y > 0 ? y - 1 : h - 1, ys = y < h - 1 ? y + 1 : 0
    let rc = y * w, rn = yn * w, rs = ys * w, x = 0
    while (x < w) {
      let c = rc + x, s = a[c]
      let nx = s
      if (s === 1) nx = 2
      else if (s === 2) nx = 3
      else if (s === 3) {
        let xw = x > 0 ? x - 1 : w - 1, xe = x < w - 1 ? x + 1 : 0
        let cnt = 0
        if (a[rn + xw] === 1) cnt++
        if (a[rn + x] === 1) cnt++
        if (a[rn + xe] === 1) cnt++
        if (a[rc + xw] === 1) cnt++
        if (a[rc + xe] === 1) cnt++
        if (a[rs + xw] === 1) cnt++
        if (a[rs + x] === 1) cnt++
        if (a[rs + xe] === 1) cnt++
        if (cnt === 1 || cnt === 2) nx = 1
      }
      b[c] = nx
      x++
    }
    y++
  }
  let tmp = a; a = b; b = tmp

  // kernel-driven guns: every source has its OWN period+phase (set when placed), so the die's
  // many buses/combs/serpentines pulse asynchronously — a chip full of independent clock
  // domains, not one synchronized strobe. (In-world taps backfire — see file header — so this
  // free-running counter in frame() is the only place new electrons are injected.)
  tick = tick + 1
  let k = 0
  while (k < srcN) {
    if ((tick + srcPhase[k]) % srcPeriod[k] === 0) {
      let idx = srcY[k] * W + srcX[k]
      if (a[idx] === 3) a[idx] = 1
    }
    k = k + 1
  }

  // render — an IC current-flow palette: empty PURE black (die substrate), conductor a dim
  // slate trace, tail a cooling blue afterglow, head hot electric cyan (live current).
  let n = w * h, i = 0
  while (i < n) {
    let s = a[i], r = 0, g = 0, bl = 0
    if (s === 3) { r = 44; g = 52; bl = 64 }
    else if (s === 2) { r = 32; g = 116; bl = 182 }
    else if (s === 1) { r = 160; g = 228; bl = 255 }
    px[i] = (255 << 24) | (bl << 16) | (g << 8) | r
    i++
  }
}

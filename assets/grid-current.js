// Hero grid current — the blueprint grid traced by its own flowing current. Each grid line carries AT MOST ONE
// 1-pixel pulse at a time: a single comet enters from one edge, glides the length of the line, leaves by the
// other edge, then the line rests before the next one enters. The gaps are randomised per cycle, so a line
// fires irregularly (no metronome), and lines run at their own speed/phase, so the field never falls into
// lockstep. The MAJOR (80) lines carry brighter, longer pulses; the SUBGRID (40) lines shorter, fainter ones.
// A mouse click fires a four-way burst from the nearest major intersection — one pulse out along each arm, each
// as bright as the cursor leans that way (outward arms brightest, balanced on a dead-on click).
//   resize(w,h) -> Uint32Array ;  configure(gridX, scale) ;  frame(t) ;  spawn(nx, ny)   // nx,ny in 0..1
//
// The ambient field is PROCEDURAL: a pulse's position is a pure function of time, computed fresh every frame —
// no accumulator, nothing that drifts (click bursts use a small fixed ring of typed arrays, also drift-free).
// That keeps the jz-compiled wasm and the same source run as plain JS byte-identical (the JS/JZ switch flips
// between identical frames), on two rules:
//
//  1. Persisted state lives in the Float64Array F (grid spacing, time anchor, the live tunables) and the typed
//     burst-ring arrays — never an integer-initialized module `let` global, which jz narrows to i32 and would
//     truncate a fraction. Every fractional quantity is an F slot or a local recomputed from `t`/`F` each frame.
//     Integers (W, H, the ring cursor) stay `let` — i32 is correct for them.
//  2. Per-line / per-cycle variety (direction, speed, rest, phase, brightness) comes from the STATELESS integer
//     hash rnd(n): a pure function of an i32 key built only from integer line/cycle indices. i32 mul/xor/shift
//     wrap identically in JS and wasm, and Math.floor/round are bit-exact, so both sides draw the same field.

let W = 0, H = 0, px

// persisted fractional state (rule 1). 0–3 are the grid + time anchor; 4–10 are the live TUNABLES set via
// param() (so a panel can tweak the field at runtime): SUB/MAJ rest (frequency), speed, tail, brightness,
// brightness-variation and regularity. All are plain f64 array slots — never module `let` globals.
const _GX = 0, _MID = 1, _MAJ = 2, _T0 = 3,
      _P_SUB = 4, _P_MAJ = 5, _P_SPD = 6, _P_TAIL = 7, _P_BRI = 8, _P_VAR = 9, _P_REG = 10
let F = new Float64Array(16)
F[_P_SUB] = 1.1    // subgrid rest÷crossing (↑ = fewer subgrid pulses)
F[_P_MAJ] = 0.5    // main-grid rest÷crossing (↑ = fewer main pulses)
F[_P_SPD] = 0.7    // speed multiplier
F[_P_TAIL] = 0.75  // tail-length multiplier
F[_P_BRI] = 0.7    // brightness multiplier
F[_P_VAR] = 0.18   // per-pulse brightness variation (0 = uniform, 1 = down to black)
F[_P_REG] = 0.62   // timing regularity (0 = irregular gaps, 1 = metronome)

// click bursts — a small ring so a new click no longer overrides the last; up to BMAX stay live at once.
let BMAX = 16
let bJX = new Float32Array(BMAX), bJY = new Float32Array(BMAX)
let bOX = new Float32Array(BMAX), bOY = new Float32Array(BMAX)
let bT = new Float32Array(BMAX)           // start time; -1 free, -2 pending (stamped next frame)
let bNext = 0

// Stateless integer hash → [0,1). Pure function of its key, so JS and jz always agree. Murmur-style finalizer.
let rnd = (n) => {
  let x = Math.imul(n | 0, 1664525) | 0
  x = Math.imul(x ^ (x >>> 15), 2246822519) | 0
  x = Math.imul(x ^ (x >>> 13), 3266489917) | 0
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296.0
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  F[_T0] = 1e30                     // "unanchored" sentinel — the first frame stamps the real start anchor. Must be OUT of the valid anchor range (a valid anchor is t−9, which is NEGATIVE for t<9): a −1 sentinel collided with that, so `F[_T0] < 0` re-fired every early frame and froze tt at 9 (static field, bursts that never travelled).
  let i = 0; while (i < BMAX) { bT[i] = -1.0; i = i + 1 }   // no click bursts live
  return px
}

// live tunables: param(0..6, value) writes one of the F[4..10] dials. A panel calls this on both engines so
// the JS⇄JZ switch stays in step. Out-of-range indices are ignored.
export let param = (i, v) => { let k = (i | 0) + 4; if (k >= 4 && k <= 10) F[k] = v }

export let configure = (gx, scale) => {
  F[_GX] = gx
  F[_MID] = 40.0 * scale
  F[_MAJ] = 80.0 * scale
  if (F[_MID] < 1.0) F[_MID] = 1.0
  if (F[_MAJ] < 1.0) F[_MAJ] = 1.0
}

// one pixel of white glow, added onto whatever is there (so crossings and overlaps brighten).
let put = (x, y, a) => {
  let ix = x | 0, iy = y | 0
  if (ix < 0 || ix >= W || iy < 0 || iy >= H || a < 1.0) return
  let p = iy * W + ix
  let old = (px[p] >>> 24) & 255
  let na = old + (a | 0)
  // light mode (brightness pushed high) → opaque BLACK pulses: dark-on-light reads cleanly over both the
  // gray band and the bold white grid the pulses travel along (white-on-white was invisible). Dark mode
  // keeps the soft neutral grey→white glow.
  let hi = F[_P_BRI] >= 1.5
  let cap = hi ? 255 : 235
  if (na > cap) na = cap
  let v = hi ? 0 : (198 + ((na * 44) >> 8))
  px[p] = (na << 24) | (v << 16) | (v << 8) | v
}

// one 1-pixel-wide comet: a bright head at `head` with a tail of length `tail` trailing the OPPOSITE way to
// travel, fading to nothing. Travel axis 0 → moves in x along the row `lineCoord`; axis 1 → moves in y.
let drawPulse = (tAxis, lineCoord, head, dir, tail, alpha) => {
  let k = 0
  while (k <= tail) {
    let a = alpha * (1.0 - k / tail)
    if (a < 1.0) return                 // a only shrinks with k → once it's invisible the rest is too
    let pos = head - dir * k
    if (tAxis === 0) put(pos, lineCoord, a)
    else put(lineCoord, pos, a)
    k = k + 1
  }
}

// one line's pulse over time `tt`, with AT MOST ONE pulse present. The line repeats a cycle: a pulse crosses
// (taking span/speed) then the line rests; cycle n's pulse enters at  startDelay + n·period + jitter(n), so the
// inter-pulse gap wanders (irregular, never a metronome) while the rest keeps cycles from overlapping — one
// pulse at a time. Only the 1–2 cycles around `now` can be live, so it stays O(1). Edge-in by construction (a
// pulse's head starts at 0 / span and moves inward). Direction, speed, rest, phase, brightness hashed from `seed`.
let train = (tAxis, lineCoord, span, seed, tail, alpha, restFrac, v, tt) => {
  let dir = rnd(seed * 2 + 1) < 0.5 ? 1.0 : -1.0
  let vv = v * F[_P_SPD] * (0.82 + rnd(seed * 2 + 7) * 0.28)   // per-line speed × the speed dial
  let etail = tail * F[_P_TAIL]
  let travel = span / vv
  let rest = travel * restFrac
  let period = travel + rest
  let startDelay = rnd(seed * 2 + 13) * 2.4
  let jitMax = rest * (1.0 - F[_P_REG]) * 0.9          // regularity dial: 1 → no jitter (metronome), 0 → gaps wander
  let nc = Math.floor((tt - startDelay) / period)
  let n = nc - 1
  while (n <= nc + 1) {
    if (n >= 0) {
      let tau = startDelay + n * period + rnd((seed * 131 + n * 17) | 0) * jitMax
      let trav = vv * (tt - tau)                         // distance the pulse has run in from the edge
      if (trav > 0.0 && trav < span + etail) {
        let head = dir > 0.0 ? trav : span - trav
        let av = alpha * F[_P_BRI] * (1.0 - F[_P_VAR] * rnd((seed * 577 + n * 101) | 0))   // brightness × variation dials
        drawPulse(tAxis, lineCoord, head, dir, etail, av)
      }
    }
    n = n + 1
  }
}

// every line at pitch `step` (rows carry x-travelling pulses, columns y-travelling), at the given
// brightness/length/rest/speed. `subOnly` skips lines that coincide with the coarser MAJOR grid so each line
// belongs to one level. `seedBase` separates this level's random streams from the others'. Rows run faster than
// columns by the band's aspect so long horizontal lines don't crawl while short vertical ones race.
let drawLevel = (step, subOnly, tail, alpha, restFrac, v, tt, seedBase) => {
  let gx = F[_GX], vRow = v * (W > H ? W / H : 1.0)
  if (vRow > v * 1.5) vRow = v * 1.5                     // cap the row speed-up so long lines don't crawl, but stay calm
  let j = 0
  while (true) {
    let y = Math.round(j * step)
    if (y > H) break
    if (!(subOnly && (j & 1) === 0)) train(0, y, W, seedBase + j * 2, tail, alpha, restFrac, vRow, tt)
    j = j + 1
  }
  let k = 0
  while (true) {
    let x = Math.round(gx + k * step)
    if (x > W) break
    if (!(subOnly && (k & 1) === 0)) train(1, x, H, seedBase + 500003 + k * 2, tail, alpha, restFrac, v, tt)
    k = k + 1
  }
}

// click → a four-way burst from the nearest grid intersection (MAJOR or the finer SUBGRID) to the cursor: one pulse out along each arm
// (±x, ±y). Each arm's intensity is biased by how far, and which way, the cursor sits from that junction — the
// arms pointing AWAY from the cursor are brightest (they shoot off the furthest), the arms toward it faintest, balanced on a dead-on click.
// Stored in F (one burst at a time); its start time is stamped on the next frame so it begins at the junction.
export let spawn = (nx, ny) => {
  let mid = F[_MID], gx = F[_GX]
  let cx = nx * W, cy = ny * H
  let jx = gx + Math.round((cx - gx) / mid) * mid    // nearest SUBGRID (40) intersection → clicks fire on the main lines AND the finer subgrid
  let jy = Math.round(cy / mid) * mid
  let half = mid * 0.5
  let ox = (cx - jx) / half; if (ox < -1.0) ox = -1.0; if (ox > 1.0) ox = 1.0   // signed offset, normalised to the cell
  let oy = (cy - jy) / half; if (oy < -1.0) oy = -1.0; if (oy > 1.0) oy = 1.0
  let i = bNext; bNext = bNext + 1; if (bNext >= BMAX) bNext = 0   // ring: up to BMAX live, the oldest recycled
  bJX[i] = Math.round(jx); bJY[i] = Math.round(jy); bOX[i] = ox; bOY[i] = oy
  bT[i] = -2.0                                            // pending → frame() stamps the real start time
}

export let frame = (t) => {
  let major = F[_MAJ], mid = F[_MID]
  if (F[_T0] > 1e29) F[_T0] = t - 9.0           // anchor 9s in the past on the FIRST frame only → grid opens already mid-stream (pulses spread across it), then keeps flowing. The >1e29 test fires once (a t−9 anchor is never that large), where the old `<0` test re-fired while t<9 and froze the field.
  let tt = t - F[_T0]; if (tt < 0.0) tt = 0.0

  let n = W * H, i = 0
  while (i < n) { px[i] = 0; i = i + 1 }

  // ambient: SUBGRID (40) — shorter, fainter, slower, sparser — then MAJOR (80) over it — brighter, longer, and a
  // touch more frequent. The rest÷crossing ratios come from the live SUB/MAJ dials (↑ = each line idle longer →
  // fewer pulses at once); speed/tail/brightness/variation/regularity ride along inside train() from F.
  drawLevel(mid,   1, mid * 0.9,    84.0, F[_P_SUB], major * 0.5,  tt, 1000003)
  drawLevel(major, 0, major * 0.95, 204.0, F[_P_MAJ], major * 0.62, tt, 0)

  // click bursts: each live one stamps its start, then sends four pulses outward from its junction, each as bright
  // as its arm's bias. The click is a fixed zap — independent of the ambient dials. Retire once the arms clear.
  let ckV = major * 2.1, ckTail = major * 1.35, base = 380.0, reach = (W > H ? W : H) + ckTail
  let bi = 0
  while (bi < BMAX) {
    let bt = bT[bi]
    if (bt === -2.0) { bT[bi] = tt; bt = tt }
    if (bt >= 0.0) {
      let trav = ckV * (tt - bt)
      if (trav > reach) bT[bi] = -1.0
      else {
        let jx = bJX[bi], jy = bJY[bi], ox = bOX[bi], oy = bOY[bi]
        let tl = trav < ckTail ? trav : ckTail; if (tl < 1.0) tl = 1.0   // tails grow from the junction; never 0
        drawPulse(0, jy, jx + trav, 1.0, tl, base * (0.5 - 0.45 * ox))   // +x (right): brightest when the cursor sits LEFT — this arm flies AWAY from it (further)
        drawPulse(0, jy, jx - trav, -1.0, tl, base * (0.5 + 0.45 * ox))  // −x (left): brightest when the cursor sits right
        drawPulse(1, jx, jy + trav, 1.0, tl, base * (0.5 - 0.45 * oy))   // +y (down): brightest when the cursor sits up
        drawPulse(1, jx, jy - trav, -1.0, tl, base * (0.5 + 0.45 * oy))  // −y (up): brightest when the cursor sits down
      }
    }
    bi = bi + 1
  }
}

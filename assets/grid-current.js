// Hero grid current — electron-like pulses gliding along the blueprint grid. They favour the MAJOR
// (80) lines, sometimes the MID (40) lines, never the 8px minor ones. At a major crossing a pulse may
// FORK a perpendicular branch — a live split that sheds intensity and may fork again until it dims.
// Pulses do not time-fade: each holds its birth brightness to the canvas edge, trailing a fading comet.
// A click sparks a four-way burst at the nearest major junction. A stateful sim: heads live in fixed
// typed-array pools; spawning is gradual (a trickle, never a frame-0 burst).
//   resize(w,h) -> Uint32Array ;  configure(gridX, scale) ;  frame(t) ;  spawn(nx, ny)   // nx,ny in 0..1
//
// TWO determinism rules make the jz-compiled wasm render the SAME picture as this source run as plain
// JS (the JS/JZ switch flips between identical frames):
//
//  1. FRACTIONAL STATE lives in a Float64Array `F`, not module `let` globals. jz narrows an integer-
//     initialized `let` global (e.g. `let acc = 0.0`) to i32 — a perf win for the common size/index
//     case, but it would SILENTLY TRUNCATE a fractional accumulator (`acc += dt` → stays 0) or a DPR-
//     scaled spacing (`major = 80 * 1.333`). That truncation was the entire "JS and JZ differ / the
//     grid is misaligned" symptom: at fractional device-pixel-ratios jz's `major` truncated and the
//     pulses drifted off the blueprint lines (it was invisible at DPR 2, which is why it hid). See
//     jz's `int-global-truncation` advisory. Integers (W, H, counters) stay as `let` — i32 is correct
//     for them.
//
//  2. RANDOMNESS is a STATELESS integer hash rnd(n) — a pure function of a key built only from
//     quantities that are bit-identical in JS and wasm (pulse ids, a spawn counter, a frame counter,
//     major-cell indices). i32 mul/xor/shift wrap the same way on both sides, so every decision
//     matches. A stateful LCG would instead desync the moment any float wobble changed how many times
//     it was sampled. Math.round (the grid snap) is also bit-identical (jz corrects f64.nearest's tie).

let W = 0, H = 0, px

// fractional module state (see rule 1 above). indices:
const _GX = 0, _MID = 1, _MAJ = 2, _ACC = 3, _LASTT = 4
let F = new Float64Array(8)

// ── pulse heads (fixed pool) ────────────────────────────────────────────────────────────────────
let MAX = 96
let hAxis = new Float32Array(MAX)   // 0 → travels in x (along a horizontal line); 1 → travels in y
let hLine = new Float32Array(MAX)   // the perpendicular coordinate (y for axis 0, x for axis 1) — snapped to a grid line
let hPos  = new Float32Array(MAX)   // position along the travel axis
let hDir  = new Float32Array(MAX)   // +1 / -1
let hPow  = new Float32Array(MAX)   // brightness; ≤ 0 → free slot
let hMaj  = new Float32Array(MAX)   // 1 if the travel line is a MAJOR (80) line → brighter, slower, may fork
let hCell = new Float32Array(MAX)   // last MAJOR-cell index crossed (fork at most once per cell)
let hId   = new Float32Array(MAX)   // unique lineage id (so each pulse hashes to its own random stream)

let WANT = 34                       // steady-state population — kept sparse so the band stays ambient
let CAP  = 66                       // hard cap on live heads; forks wait while live ≥ CAP so branching can't run away
let FORK_MIN_POW = 32               // only bright-enough pulses fork — forking terminates as branches dim

let frameN = 0                      // frame counter (integer → bit-identical JS/wasm)
let spawnN = 0                      // number of edge-spawns so far (integer key source)
let nextId = 1                      // monotonic pulse id (integer key source)

// Stateless integer hash → [0,1). Pure function of its key, so JS and jz always agree. The key is an
// i32; the mix below is a Murmur-style finalizer (good spread, no short cycles).
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
  let i = 0
  while (i < MAX) { hPow[i] = 0.0; hCell[i] = -99999.0; i = i + 1 }
  F[_ACC] = 0.0; F[_LASTT] = 0.0
  frameN = 0; spawnN = 0; nextId = 1
  return px
}

export let configure = (gx, scale) => {
  F[_GX] = gx
  F[_MID] = 40.0 * scale
  F[_MAJ] = 80.0 * scale
  if (F[_MID] < 1.0) F[_MID] = 1.0
  if (F[_MAJ] < 1.0) F[_MAJ] = 1.0
}

let put = (x, y, a) => {
  let ix = x | 0, iy = y | 0
  if (ix < 0 || ix >= W || iy < 0 || iy >= H || a < 1.0) return
  let p = iy * W + ix
  let old = (px[p] >>> 24) & 255
  let na = old + (a | 0)
  if (na > 235) na = 235
  let r = 176 + ((na * 40) >> 8)
  let g = 198 + ((na * 44) >> 8)
  let b = 240 + ((na * 15) >> 8)
  if (b > 255) b = 255
  px[p] = (na << 24) | (b << 16) | (g << 8) | r
}

// centre + a soft cross halo so a sub-CSS-pixel stroke still reads as a glowing line on the grid.
let mark = (x, y, a, wide) => {
  put(x, y, a)
  put(x - 1.0, y, a * 0.5); put(x + 1.0, y, a * 0.5)
  put(x, y - 1.0, a * 0.5); put(x, y + 1.0, a * 0.5)
  if (wide) {
    put(x - 2.0, y, a * 0.22); put(x + 2.0, y, a * 0.22)
    put(x, y - 2.0, a * 0.22); put(x, y + 2.0, a * 0.22)
  }
}

let spark = (x, y, a) => {
  mark(x, y, a, 1)
  put(x - 1.0, y - 1.0, a * 0.18); put(x + 1.0, y - 1.0, a * 0.18)
  put(x - 1.0, y + 1.0, a * 0.18); put(x + 1.0, y + 1.0, a * 0.18)
}

// nearest line of pitch `step` on the given axis. axis 0 → y values (horizontal travel); axis 1 →
// x values, offset by gridX so the page-origin grid and the canvas grid coincide.
let snapLine = (axis, c, step) => {
  let gx = F[_GX]
  if (axis === 0) { let k = Math.floor(c / step + 0.5); return Math.round(k * step) }
  let k = Math.floor((c - gx) / step + 0.5)
  return Math.round(gx + k * step)
}

// is this travel line a MAJOR (80) line? major lines are brighter, slower, and the only ones that fork.
let isMajorLine = (axis, line) => {
  let major = F[_MAJ]
  let m = axis === 0 ? line : line - F[_GX]
  m = m - major * Math.floor(m / major)        // m mod major, ≥ 0
  return (m < 1.5 || m > major - 1.5) ? 1.0 : 0.0
}

let freeSlot = () => { let i = 0; while (i < MAX) { if (hPow[i] <= 0.0) return i; i = i + 1 } return -1 }

let launch = (i, axis, line, pos, dir, pow) => {
  hAxis[i] = axis; hLine[i] = line; hPos[i] = pos; hDir[i] = dir; hPow[i] = pow
  hMaj[i] = isMajorLine(axis, line)
  hCell[i] = -99999.0
  hId[i] = nextId; nextId = nextId + 1
}

// a fresh pulse entering from a random edge — strongly favour MAJOR lines, a few on MID. Every random
// choice is hashed from spawnN so the SAME pulses appear in JS and jz.
let spawnEdge = () => {
  let i = freeSlot(); if (i < 0) return
  let major = F[_MAJ], mid = F[_MID], gx = F[_GX]
  let k = spawnN; spawnN = spawnN + 1
  let axis = rnd(101 + k * 131) < 0.5 ? 0 : 1
  let dir = rnd(103 + k * 137) < 0.5 ? 1.0 : -1.0
  let onMajor = rnd(107 + k * 149) < 0.86
  let step = onMajor ? major : mid
  let pow = onMajor ? 92.0 + rnd(109 + k * 151) * 68.0 : 58.0 + rnd(113 + k * 157) * 42.0
  let linePick = rnd(127 + k * 163)
  let startPos = dir > 0.0 ? -12.0 : (axis === 0 ? W : H) + 12.0
  if (axis === 0) launch(i, 0, snapLine(0, linePick * H, step), startPos, dir, pow)
  else launch(i, 1, snapLine(1, gx + linePick * W, step), startPos, dir, pow)
}

// click → a bright four-way burst at the nearest MAJOR junction
export let spawn = (nx, ny) => {
  let major = F[_MAJ]
  let jx = snapLine(1, nx * W, major), jy = snapLine(0, ny * H, major)
  let k = 0
  while (k < 4) {
    let i = freeSlot(); if (i < 0) return
    if ((k & 1) === 0) launch(i, 0, jy, jx, (k & 2) === 0 ? 1.0 : -1.0, 165.0)
    else               launch(i, 1, jx, jy, (k & 2) === 0 ? 1.0 : -1.0, 165.0)
    k = k + 1
  }
}

// speed scales with the grid spacing so the glide is the same wall-clock pace at any DPR:
// a major-line pulse crosses one 80px cell in ~2.5s.
let speedOf = (isMaj, major, mid) => isMaj > 0.5 ? major * 0.40 : mid * 0.80
let trailOf = (isMaj, major, mid) => isMaj > 0.5 ? major * 1.7 : mid * 2.2

// the head spark + a fading comet trail behind it (only the trail fades; the head stays full power).
let drawHead = (axis, line, pos, dir, pow, isMaj, major, mid) => {
  let steps = trailOf(isMaj, major, mid) | 0
  let wide = isMaj > 0.5 ? 1 : 0
  let k = 0
  while (k < steps) {
    let a = pow * (1.0 - k / steps)                  // linear falloff → the comet stays bright longer
    if (axis === 0) mark(pos - dir * k, line, a, wide)
    else mark(line, pos - dir * k, a, wide)
    k = k + 1
  }
  if (axis === 0) spark(pos, line, pow)
  else spark(line, pos, pow)
}

export let frame = (t) => {
  let major = F[_MAJ], mid = F[_MID], gx = F[_GX]
  let dt = t - F[_LASTT]; F[_LASTT] = t
  if (dt < 0.0) dt = 0.0
  if (dt > 0.05) dt = 0.05
  frameN = frameN + 1

  let n = W * H, i = 0
  while (i < n) { px[i] = 0; i = i + 1 }

  // count live heads, then TOP UP GRADUALLY — a trickle, never a frame-0 burst. Pulses enter one at a
  // time on a spawnN-keyed jittered clock, so the band warms up over a few seconds instead of flashing full.
  let live = 0
  i = 0
  while (i < MAX) { if (hPow[i] > 0.0) live = live + 1; i = i + 1 }
  let acc = F[_ACC]
  if (live < WANT) {
    acc = acc + dt
    while (live < WANT) {
      let interval = 0.08 + rnd(301 + spawnN * 173) * 0.12      // ~one new pulse every 0.08–0.20 s
      if (acc < interval) break
      acc = acc - interval
      spawnEdge()
      live = live + 1
    }
  } else {
    acc = 0.0
  }
  F[_ACC] = acc

  i = 0
  while (i < MAX) {
    if (hPow[i] > 0.0) {
      let axis = hAxis[i], line = hLine[i], dir = hDir[i], pow = hPow[i], isMaj = hMaj[i], id = hId[i]
      let pos = hPos[i] + dir * speedOf(isMaj, major, mid) * dt
      hPos[i] = pos

      // FORK at major crossings: when the head crosses a MAJOR line perpendicular to its travel, throw a
      // branch along that line. The head keeps going straight at full power; the fork is dimmer (sheds
      // intensity) and may fork again — until it dims past FORK_MIN_POW. At most one fork per major cell
      // (hCell), and the first cell after birth only primes the tracker (no fork), so a pulse always glides
      // a while before branching. All fork randomness is hashed from (id, cell) → identical JS/wasm.
      if (isMaj > 0.5 && pow > FORK_MIN_POW && live < CAP) {
        let along = axis === 0 ? pos - gx : pos
        let cell = Math.floor(along / major + 0.5)
        let prev = hCell[i]
        hCell[i] = cell
        if (prev !== -99999.0 && cell !== prev) {
          let chance = 0.22 + (pow / 160.0) * 0.20              // brighter pulses fork more often, never always
          if (rnd(7001 + Math.imul(id | 0, 100003) + cell * 971) < chance) {
            let cross = Math.round(axis === 0 ? gx + cell * major : cell * major)   // crossed major line, whole px
            let pax = axis === 0 ? 1 : 0                                            // fork travels perpendicular
            let keep = 0.48 + rnd(7003 + Math.imul(id | 0, 100003) + cell * 977) * 0.14   // keep 48–62 % brightness
            let fpow = pow * keep
            if (fpow > FORK_MIN_POW) {
              // usually ONE branch in a random direction; ~⅓ of the time a true +-split (both ways).
              let dirA = rnd(7009 + Math.imul(id | 0, 100003) + cell * 983) < 0.5 ? 1.0 : -1.0
              let s1 = freeSlot()
              if (s1 >= 0) { launch(s1, pax, cross, line, dirA, fpow); live = live + 1 }
              if (rnd(7013 + Math.imul(id | 0, 100003) + cell * 991) < 0.34) {
                let s2 = freeSlot()
                if (s2 >= 0) { launch(s2, pax, cross, line, -dirA, fpow); live = live + 1 }
              }
            }
          }
        }
      }

      // cull only once the whole pulse (head + comet) has left the canvas; otherwise draw it.
      let dim = axis === 0 ? W : H, tail = trailOf(isMaj, major, mid)
      if ((dir > 0.0 && pos > dim + tail + 4.0) || (dir < 0.0 && pos < -tail - 4.0)) hPow[i] = 0.0
      else drawHead(axis, line, pos, dir, pow, isMaj, major, mid)
    }
    i = i + 1
  }
}

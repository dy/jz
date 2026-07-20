// trace.js — square-tracing contour following over a bitmap: the first stage of every
// bitmap→vector pipeline (potrace, font autotracers). Scan for an untraced boundary
// pixel, then walk the contour with the square-tracing rule — standing on ink turn
// left, standing on paper turn right, step forward — emitting a chain code per step
// until the walk returns to its start pose (Jacob's criterion). The profile is what
// autovectorizers never touch: a tight data-dependent state machine, unpredictable
// branches, 2-D indexing, per-pixel bookkeeping — pure scalar codegen quality, branch
// layout, and bounds-check elimination.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over chain codes + loop lengths.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const W = 512, H = 512
const N_ITERS = 4
const N_RUNS = 21
const N_WARMUP = 5
const MAXCODES = 1 << 18

// bitmap: union of deterministic circles (xorshift placement) — islands and punched
// lakes, so the tracer meets outer and inner contours; 1px empty frame guaranteed
const buildBitmap = (bmp) => {
  let s = 0x51ce7a3 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < W * H; i++) bmp[i] = 0
  for (let c = 0; c < 42; c++) {
    const cx = 44 + (rnd() % (W - 88))
    const cy = 44 + (rnd() % (H - 88))
    const r = 8 + (rnd() % 33)
    const r2 = r * r
    const fill = c % 5 === 4 ? 0 : 1          // every 5th circle punches a lake
    for (let y = cy - r; y <= cy + r; y++) {
      const dy = y - cy
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx
        if (dx * dx + dy * dy <= r2) bmp[y * W + x] = fill
      }
    }
  }
}

// square tracing from (sx,sy) entering northward: on ink turn left, on paper turn
// right, then step. dx/dy per dir: 0=E 1=S 2=W 3=N. Marks traced ink in `visited`.
const traceLoop = (bmp, visited, codes, nc, sx, sy) => {
  let x = sx, y = sy
  let dir = 3                                  // entered heading north
  let steps = 0
  while (steps < MAXCODES) {
    const inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] === 1
    if (inside) {
      visited[y * W + x] = 1
      dir = (dir + 3) & 3                      // turn left
    } else {
      dir = (dir + 1) & 3                      // turn right
    }
    if (nc < MAXCODES) codes[nc++] = dir
    if (dir === 0) x++
    else if (dir === 1) y++
    else if (dir === 2) x--
    else y--
    steps++
    if (x === sx && y === sy && dir === 3) break
  }
  return nc
}

const traceAll = (bmp, visited, codes) => {
  let nc = 0
  let h = 0
  for (let i = 0; i < W * H; i++) visited[i] = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      // boundary start: ink with paper to the west, not already traced
      if (bmp[y * W + x] === 1 && bmp[y * W + x - 1] === 0 && visited[y * W + x] === 0) {
        const start = nc
        nc = traceLoop(bmp, visited, codes, nc, x, y)
        h = mix(h, nc - start) | 0
      }
    }
  }
  return mix(h, nc) | 0
}

const runKernel = (bmp, visited, codes) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) h = mix(h, traceAll(bmp, visited, codes))
  return h
}

export let main = () => {
  const bmp = new Uint8Array(W * H)
  const visited = new Uint8Array(W * H)
  const codes = new Uint8Array(MAXCODES)
  buildBitmap(bmp)

  let acc = 0
  for (let i = 0; i < N_WARMUP; i++) acc = mix(acc, runKernel(bmp, visited, codes))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    acc = mix(acc, runKernel(bmp, visited, codes))
    samples[i] = performance.now() - t0
  }
  let h = 0x811c9dc5 | 0
  h = mix(h, acc)
  for (let i = 0; i < MAXCODES; i += 64) h = mix(h, codes[i])
  printResult(medianUs(samples), h >>> 0, W * H * N_ITERS, 1, N_RUNS)
}

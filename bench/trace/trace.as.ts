// trace.as.ts — AssemblyScript translation of bench/trace/trace.js.
//
// square-tracing contour following over a bitmap: the first stage of every
// bitmap→vector pipeline (potrace, font autotracers). Scan for an untraced boundary
// pixel, then walk the contour with the square-tracing rule — standing on ink turn
// left, standing on paper turn right, step forward — emitting a chain code per step
// until the walk returns to its start pose (Jacob's criterion). The profile is what
// autovectorizers never touch: a tight data-dependent state machine, unpredictable
// branches, 2-D indexing, per-pixel bookkeeping — pure scalar codegen quality, branch
// layout, and bounds-check elimination.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over chain codes + loop lengths.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 512
const H: i32 = 512
const N_ITERS: i32 = 4
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5
const MAXCODES: i32 = 1 << 18

// XorShift32 state threaded through a 1-cell array (AS has no primitive by-ref params).
function nextRnd(state: Int32Array): i32 {
  let s = unchecked(state[0])
  s ^= s << 13
  s ^= <i32>(<u32>s >>> 17)
  s ^= s << 5
  unchecked(state[0] = s)
  return s
}

function mix(h: i32, x: i32): i32 {
  return <i32>Math.imul(h ^ x, 0x01000193)
}

// bitmap: union of deterministic circles (xorshift placement) — islands and punched
// lakes, so the tracer meets outer and inner contours; 1px empty frame guaranteed
function buildBitmap(bmp: Uint8Array, rng: Int32Array): void {
  unchecked(rng[0] = 0x51ce7a3)
  for (let i = 0; i < W * H; i++) unchecked(bmp[i] = 0)
  for (let c = 0; c < 42; c++) {
    const cx: i32 = 44 + <i32>(<u32>nextRnd(rng) % <u32>(W - 88))
    const cy: i32 = 44 + <i32>(<u32>nextRnd(rng) % <u32>(H - 88))
    const r: i32 = 8 + <i32>(<u32>nextRnd(rng) % 33)
    const r2 = r * r
    const fill: i32 = c % 5 === 4 ? 0 : 1
    for (let y = cy - r; y <= cy + r; y++) {
      const dy = y - cy
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx
        if (dx * dx + dy * dy <= r2) unchecked(bmp[y * W + x] = <u8>fill)
      }
    }
  }
}

// square tracing from (sx,sy) entering northward: on ink turn left, on paper turn
// right, then step. dx/dy per dir: 0=E 1=S 2=W 3=N. Marks traced ink in `visited`.
function traceLoop(bmp: Uint8Array, visited: Uint8Array, codes: Uint8Array, ncIn: i32, sx: i32, sy: i32): i32 {
  let x = sx, y = sy
  let dir: i32 = 3
  let steps: i32 = 0
  let nc = ncIn
  while (steps < MAXCODES) {
    const inside = x >= 0 && x < W && y >= 0 && y < H && unchecked(bmp[y * W + x]) === 1
    if (inside) {
      unchecked(visited[y * W + x] = 1)
      dir = (dir + 3) & 3
    } else {
      dir = (dir + 1) & 3
    }
    if (nc < MAXCODES) unchecked(codes[nc++] = <u8>dir)
    if (dir === 0) x++
    else if (dir === 1) y++
    else if (dir === 2) x--
    else y--
    steps++
    if (x === sx && y === sy && dir === 3) break
  }
  return nc
}

function traceAll(bmp: Uint8Array, visited: Uint8Array, codes: Uint8Array): i32 {
  let nc: i32 = 0
  let h: i32 = 0
  for (let i = 0; i < W * H; i++) unchecked(visited[i] = 0)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      // boundary start: ink with paper to the west, not already traced
      if (unchecked(bmp[y * W + x]) === 1 && unchecked(bmp[y * W + x - 1]) === 0 && unchecked(visited[y * W + x]) === 0) {
        const start = nc
        nc = traceLoop(bmp, visited, codes, nc, x, y)
        h = mix(h, nc - start)
      }
    }
  }
  return mix(h, nc)
}

function runKernel(bmp: Uint8Array, visited: Uint8Array, codes: Uint8Array): i32 {
  let h: i32 = 0
  for (let it = 0; it < N_ITERS; it++) h = mix(h, traceAll(bmp, visited, codes))
  return h
}

export function main(): void {
  const bmp = new Uint8Array(W * H)
  const visited = new Uint8Array(W * H)
  const codes = new Uint8Array(MAXCODES)
  const rng = new Int32Array(1)
  buildBitmap(bmp, rng)

  let acc: i32 = 0
  for (let i = 0; i < N_WARMUP; i++) acc = mix(acc, runKernel(bmp, visited, codes))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    acc = mix(acc, runKernel(bmp, visited, codes))
    unchecked(samples[i] = perfNow() - t0)
  }

  let h: i32 = 0x811c9dc5
  h = mix(h, acc)
  for (let i = 0; i < MAXCODES; i += 64) h = mix(h, <i32>unchecked(codes[i]))

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), <u32>h, W * H * N_ITERS, 1, N_RUNS)
}

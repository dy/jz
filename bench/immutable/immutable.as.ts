// immutable.as.ts — AssemblyScript translation of bench/immutable/immutable.js.
//
// A particle step in the immutable-update idiom: every step replaces each
// record with a FRESH object instead of mutating in place. The canonical
// functional-state kernel (reducers, persistent game state, event-sourced
// models). AssemblyScript classes are heap references, so — like JS — every
// step pays a real allocation (and the stub runtime never frees). Pure integer
// bounce physics, so positions are bit-identical across every engine and
// native target.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 4096              // particles
const STEPS: i32 = 32            // steps per pass (one fresh object per particle per step)
const LIM: i32 = 1023            // box bound
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

class P {
  constructor(
    public x: i32,
    public y: i32,
    public vx: i32,
    public vy: i32,
  ) {}
}

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
function initParticles(ps: StaticArray<P>): void {
  let s: i32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    const vx: i32 = <i32>((<u32>s >>> 4) & 15) - 8
    const vy: i32 = <i32>((<u32>s >>> 8) & 15) - 8
    unchecked(ps[i] = new P(
      <i32>((<u32>s >>> 12) & <u32>LIM),
      <i32>((<u32>s >>> 20) & <u32>LIM),
      vx == 0 ? 1 : vx,
      vy == 0 ? 1 : vy,
    ))
  }
}

function runKernel(ps: StaticArray<P>): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < STEPS; it++) {
    let sum: i32 = it
    for (let i = 0; i < N; i++) {
      const p = unchecked(ps[i])
      const nx = p.x + p.vx, ny = p.y + p.vy
      const hitX = nx < 0 || nx > LIM, hitY = ny < 0 || ny > LIM
      const x = hitX ? p.x : nx, y = hitY ? p.y : ny
      const vx = hitX ? -p.vx : p.vx, vy = hitY ? -p.vy : p.vy
      unchecked(ps[i] = new P(x, y, vx, vy))
      sum = sum + x + y * 31
    }
    h = mix(h, sum)
  }
  return <u32>h
}

export function main(): void {
  const ps = new StaticArray<P>(N)
  let cs: u32 = 0
  // Fresh particle set per run — the kernel mutates the array, so timing runs
  // must not compound each other's motion.
  for (let i: i32 = 0; i < N_WARMUP; i++) {
    initParticles(ps)
    cs = runKernel(ps)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    initParticles(ps)
    const t0 = perfNow()
    cs = runKernel(ps)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, N * STEPS, 1, N_RUNS)
}

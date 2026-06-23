// raytrace.as.ts — AssemblyScript translation of bench/raytrace/raytrace.js.
//
// Minimal sphere ray tracer: one primary ray per pixel, a closest-hit search
// over a small sphere scene, then Lambert diffuse + ambient shading into an
// f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select,
// normal + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded,
// so the framebuffer is bit-identical across engines and native targets. Go's
// arm64 backend force-fuses a*b+c → FMADDD (no flag to disable), so its
// checksum is the documented `fma` parity class.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 384
const H: i32 = 384
const NS: i32 = 8
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildScene(
  sx: Float64Array, sy: Float64Array, sz: Float64Array, sr: Float64Array,
  cr: Float64Array, cg: Float64Array, cb: Float64Array
): void {
  for (let i = 0; i < NS; i++) {
    unchecked(sx[i] = <f64>((i % 3) - 1) * 2.2)
    unchecked(sy[i] = <f64>(((i / 3) | 0) - 1) * 1.6)
    unchecked(sz[i] = -5.0 - <f64>i * 1.3)
    unchecked(sr[i] = 0.7 + <f64>(i % 4) * 0.18)
    unchecked(cr[i] = 0.30 + <f64>(i % 5) * 0.14)
    unchecked(cg[i] = 0.25 + <f64>(i % 3) * 0.24)
    unchecked(cb[i] = 0.40 + <f64>(i % 7) * 0.08)
  }
}

function render(
  fb: Float64Array,
  sx: Float64Array, sy: Float64Array, sz: Float64Array, sr: Float64Array,
  cr: Float64Array, cg: Float64Array, cb: Float64Array,
  lx: f64, ly: f64, lz: f64
): void {
  for (let py = 0; py < H; py++) {
    const sv: f64 = 1.0 - (<f64>py + 0.5) / <f64>H * 2.0
    for (let px = 0; px < W; px++) {
      const su: f64 = (<f64>px + 0.5) / <f64>W * 2.0 - 1.0
      let dx: f64 = su, dy: f64 = sv, dz: f64 = -1.0
      const dinv: f64 = 1.0 / Math.sqrt(dx * dx + dy * dy + dz * dz)
      dx = dx * dinv; dy = dy * dinv; dz = dz * dinv

      let tBest: f64 = 1e30
      let hit: i32 = -1
      for (let s = 0; s < NS; s++) {
        const ox: f64 = -unchecked(sx[s])
        const oy: f64 = -unchecked(sy[s])
        const oz: f64 = -unchecked(sz[s])
        const b: f64 = ox * dx + oy * dy + oz * dz
        const c: f64 = ox * ox + oy * oy + oz * oz - unchecked(sr[s]) * unchecked(sr[s])
        const disc: f64 = b * b - c
        if (disc > 0.0) {
          const t: f64 = -b - Math.sqrt(disc)
          if (t > 0.001 && t < tBest) { tBest = t; hit = s }
        }
      }

      let r: f64 = 0.0, g: f64 = 0.0, bl: f64 = 0.0
      if (hit >= 0) {
        const hx: f64 = dx * tBest, hy: f64 = dy * tBest, hz: f64 = dz * tBest
        let nx: f64 = hx - unchecked(sx[hit])
        let ny: f64 = hy - unchecked(sy[hit])
        let nz: f64 = hz - unchecked(sz[hit])
        const ninv: f64 = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz)
        nx = nx * ninv; ny = ny * ninv; nz = nz * ninv
        let diff: f64 = nx * lx + ny * ly + nz * lz
        if (diff < 0.0) diff = 0.0
        const shade: f64 = 0.15 + 0.85 * diff
        r = unchecked(cr[hit]) * shade
        g = unchecked(cg[hit]) * shade
        bl = unchecked(cb[hit]) * shade
      }
      const o: i32 = (py * W + px) * 3
      unchecked(fb[o] = r)
      unchecked(fb[o + 1] = g)
      unchecked(fb[o + 2] = bl)
    }
  }
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  // stride 128 f64 = stride 256 u32; take low 32 bits of each sampled f64
  for (let i = 0; i < n; i += 128) {
    const bits = reinterpret<u64>(unchecked(out[i]))
    h = (h ^ <u32>bits) * 0x01000193
  }
  return h
}

export function main(): void {
  const sx = new Float64Array(NS)
  const sy = new Float64Array(NS)
  const sz = new Float64Array(NS)
  const sr = new Float64Array(NS)
  const cr = new Float64Array(NS)
  const cg = new Float64Array(NS)
  const cb = new Float64Array(NS)
  buildScene(sx, sy, sz, sr, cr, cg, cb)

  const fb = new Float64Array(W * H * 3)

  const llen: f64 = 1.0 / Math.sqrt(0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5)
  const lx: f64 = -0.6 * llen
  const ly: f64 = 1.0 * llen
  const lz: f64 = 0.5 * llen

  for (let i = 0; i < N_WARMUP; i++) render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(fb)

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
  logLine(<i32>(medianMs * 1000.0), cs, W * H, NS, N_RUNS)
}

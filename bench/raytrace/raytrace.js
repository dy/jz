// raytrace.js — a minimal sphere ray tracer: one primary ray per pixel, a
// closest-hit search over a small sphere scene, then Lambert diffuse + ambient
// shading into an f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select, normal
// + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded, so
// the framebuffer is bit-identical across engines and native targets. Go's arm64
// backend force-fuses a*b+c → FMADDD (no flag to disable), so its checksum is the
// documented `fma` parity class, like fft/synth/biquad — same algorithm, last-ulp
// rounding only.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, Math.sqrt, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the rendered framebuffer.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const W = 384
const H = 384
const NS = 8                 // sphere count
const N_RUNS = 21
const N_WARMUP = 5

// Scene + a pre-normalized light direction, both built from integer arithmetic so
// every target gets the identical f64 bit pattern (no literal-parsing drift).
const buildScene = (sx, sy, sz, sr, cr, cg, cb) => {
  for (let i = 0; i < NS; i++) {
    sx[i] = ((i % 3) - 1) * 2.2
    sy[i] = (((i / 3) | 0) - 1) * 1.6
    sz[i] = -5.0 - i * 1.3
    sr[i] = 0.7 + (i % 4) * 0.18
    cr[i] = 0.30 + (i % 5) * 0.14
    cg[i] = 0.25 + (i % 3) * 0.24
    cb[i] = 0.40 + (i % 7) * 0.08
  }
}

const render = (fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz) => {
  for (let py = 0; py < H; py++) {
    const sv = 1.0 - (py + 0.5) / H * 2.0          // screen y in [-1, 1)
    for (let px = 0; px < W; px++) {
      const su = (px + 0.5) / W * 2.0 - 1.0        // screen x in [-1, 1)
      // primary ray direction (camera at origin, looking down -z), normalized
      let dx = su, dy = sv, dz = -1.0
      const dinv = 1.0 / Math.sqrt(dx * dx + dy * dy + dz * dz)
      dx = dx * dinv; dy = dy * dinv; dz = dz * dinv

      let tBest = 1e30, hit = -1
      for (let s = 0; s < NS; s++) {
        const ox = -sx[s], oy = -sy[s], oz = -sz[s]   // origin(0) - center
        const b = ox * dx + oy * dy + oz * dz
        const c = ox * ox + oy * oy + oz * oz - sr[s] * sr[s]
        const disc = b * b - c
        if (disc > 0.0) {
          const t = -b - Math.sqrt(disc)
          if (t > 0.001 && t < tBest) { tBest = t; hit = s }
        }
      }

      let r = 0.0, g = 0.0, bl = 0.0
      if (hit >= 0) {
        const hx = dx * tBest, hy = dy * tBest, hz = dz * tBest
        let nx = hx - sx[hit], ny = hy - sy[hit], nz = hz - sz[hit]
        const ninv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz)
        nx = nx * ninv; ny = ny * ninv; nz = nz * ninv
        let diff = nx * lx + ny * ly + nz * lz
        if (diff < 0.0) diff = 0.0
        const shade = 0.15 + 0.85 * diff             // ambient + diffuse
        r = cr[hit] * shade; g = cg[hit] * shade; bl = cb[hit] * shade
      }
      const o = (py * W + px) * 3
      fb[o] = r; fb[o + 1] = g; fb[o + 2] = bl
    }
  }
}

export let main = () => {
  const sx = new Float64Array(NS), sy = new Float64Array(NS), sz = new Float64Array(NS), sr = new Float64Array(NS)
  const cr = new Float64Array(NS), cg = new Float64Array(NS), cb = new Float64Array(NS)
  buildScene(sx, sy, sz, sr, cr, cg, cb)
  const fb = new Float64Array(W * H * 3)
  // normalize the light direction (-0.6, 1.0, 0.5) at runtime → identical everywhere
  const llen = 1.0 / Math.sqrt(0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5)
  const lx = -0.6 * llen, ly = 1.0 * llen, lz = 0.5 * llen

  for (let i = 0; i < N_WARMUP; i++) render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(fb), W * H, NS, N_RUNS)
}

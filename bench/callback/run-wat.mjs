#!/usr/bin/env node
// Host driver for callback.wat — assembles wat → wasm via wabt, instantiates,
// and drives init / kernel from JS using the same loop shape as callback.js.
// The wasm side reuses a single pre-allocated `b` buffer instead of allocating
// per outer iter (the "floor": pure inner-loop work, no allocator cost).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'callback')
fs.mkdirSync(buildDir, { recursive: true })

const N = 4096
const N_ITERS = 128
const N_RUNS = 21
const N_WARMUP = 5

const A_PTR = 0x0000_0000
const B_PTR = 0x0000_4000

const wasmPath = join(buildDir, 'callback-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('callback.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { init, kernel } = instance.exports

init(A_PTR, N)

let cs = 0
for (let i = 0; i < N_WARMUP; i++) cs = kernel(A_PTR, B_PTR, N, N_ITERS, 2) >>> 0

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  const t0 = performance.now()
  cs = kernel(A_PTR, B_PTR, N, N_ITERS, 2) >>> 0
  samples[i] = performance.now() - t0
}

const sorted = [...samples].sort((a, b) => a - b)
const medianMs = sorted[(N_RUNS - 1) >> 1]
const medianUs = (medianMs * 1000) | 0
console.log(`median_us=${medianUs} checksum=${cs} samples=${N * N_ITERS} stages=1 runs=${N_RUNS}`)

#!/usr/bin/env node
// Host driver for aos.wat — assembles wat → wasm via wabt, instantiates,
// and drives initRows / runKernel / checksum from JS using the same loop
// shape as aos.js. The "row" columns live in linear memory as three
// parallel f64 arrays (rowsX/Y/Z) — see comment in aos.wat.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'aos')
fs.mkdirSync(buildDir, { recursive: true })

const N = 16384
const N_ITERS = 64
const N_RUNS = 21
const N_WARMUP = 5

const RX_PTR = 0x0000_0000
const RY_PTR = 0x0002_0000
const RZ_PTR = 0x0004_0000
const XS_PTR = 0x0006_0000
const YS_PTR = 0x0008_0000
const ZS_PTR = 0x000a_0000

const wasmPath = join(buildDir, 'aos-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('aos.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { initRows, runKernel, checksum } = instance.exports

initRows(RX_PTR, RY_PTR, RZ_PTR, N)
for (let i = 0; i < N_WARMUP; i++) {
  runKernel(RX_PTR, RY_PTR, RZ_PTR, XS_PTR, YS_PTR, ZS_PTR, N, N_ITERS)
}

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  const t0 = performance.now()
  runKernel(RX_PTR, RY_PTR, RZ_PTR, XS_PTR, YS_PTR, ZS_PTR, N, N_ITERS)
  samples[i] = performance.now() - t0
}

const cs = checksum(XS_PTR, YS_PTR, ZS_PTR, N) >>> 0
const sorted = [...samples].sort((a, b) => a - b)
const medianUs = (sorted[(N_RUNS - 1) >> 1] * 1000) | 0
console.log(`median_us=${medianUs} checksum=${cs} samples=${N * N_ITERS} stages=3 runs=${N_RUNS}`)

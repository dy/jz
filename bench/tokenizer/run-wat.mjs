#!/usr/bin/env node
// Host driver for tokenizer.wat — assembles wat → wasm via wabt, instantiates,
// writes the source string into linear memory, and drives scan() from JS using
// the same loop shape as tokenizer.js.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'tokenizer')
fs.mkdirSync(buildDir, { recursive: true })

const BASE = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n'
const N_REPEAT = 512
const N_RUNS = 21
const N_WARMUP = 5
const SRC_PTR = 0

const wasmPath = join(buildDir, 'tokenizer-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('tokenizer.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { scan, memory } = instance.exports

// Build source the same way tokenizer.js does, then copy bytes into linear memory.
const enc = new TextEncoder()
const srcBytes = enc.encode(BASE.repeat(N_REPEAT))
new Uint8Array(memory.buffer).set(srcBytes, SRC_PTR)
const len = srcBytes.length

// Each run scans a slightly shorter prefix so scan() gets a different input
// every call — it can't be hoisted out of the timing loop (matches the .js).
let cs = 0
for (let i = 0; i < N_WARMUP; i++) cs = scan(SRC_PTR, len - (i & 7)) >>> 0

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  const t0 = performance.now()
  cs = scan(SRC_PTR, len - (i & 7)) >>> 0
  samples[i] = performance.now() - t0
}

const sorted = [...samples].sort((a, b) => a - b)
const medianUs = (sorted[(N_RUNS - 1) >> 1] * 1000) | 0
console.log(`median_us=${medianUs} checksum=${cs} samples=${len} stages=5 runs=${N_RUNS}`)

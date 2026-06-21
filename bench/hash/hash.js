// hash.js — MurmurHash3 x86_32 over a byte buffer, hammered many passes per run.
//
// The canonical non-cryptographic hash: a multiply / rotate / xor mixing chain
// with NO lookup table (unlike crc32) — so it stresses a different ALU profile
// (Math.imul throughput + rotates) on the same Uint8Array hot-read path. Pure
// 32-bit integer, bit-exact between wasm i32 and JS, so jz and V8 must agree on
// the checksum.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Uint8Array, Math.imul, no class/async/regex.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 16384        // buffer length in bytes (multiple of 4 → no murmur tail)
const N_ITERS = 700    // hash passes over the whole buffer per kernel run
const N_RUNS = 21
const N_WARMUP = 5

const C1 = 0xcc9e2d51 | 0
const C2 = 0x1b873593 | 0

const initBuf = (buf) => {
  let x = 0x12345678 | 0
  for (let i = 0; i < N; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    buf[i] = (x >>> 16) & 0xff
  }
}

// MurmurHash3 x86_32, body-only (N is a multiple of 4, so no tail bytes).
const murmur3 = (buf, n, seed) => {
  let h = seed | 0
  for (let i = 0; i + 4 <= n; i += 4) {
    let k = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) | 0
    k = Math.imul(k, C1)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, C2)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  h ^= n
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const runKernel = (buf) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    h = mix(h, murmur3(buf, N, 0x9747b28c) | 0)
    const j = it % N
    buf[j] = (buf[j] + 1) & 0xff   // perturb so the hash can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const buf = new Uint8Array(N)
  initBuf(buf)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(buf)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(buf)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 1, N_RUNS)
}

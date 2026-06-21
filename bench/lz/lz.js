// lz.js — LZSS compressor + decompressor round-trip, the canonical byte-oriented
// compression kernel. Greedy longest-match search over a sliding window (the work
// that dominates every LZ-family codec — gzip/deflate, LZ4, Zstd's match finder),
// then a byte-exact inflate that reproduces the source.
//
// Format: control byte per 8 tokens; bit 0 = literal (1 byte), bit 1 = match
// (2 bytes packing distance-1 in the high 12 bits and length-MIN_MATCH in the low
// 4). Greedy match: longest match wins; ties break to the nearest (smallest
// distance). Pure-integer byte twiddling, so the compressed stream and the
// round-trip are bit-identical across every engine and native target. The inflate
// result is verified against the source and folded into the checksum, so any codec
// bug changes the result.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Uint8Array, no class/async/regex.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 4096            // input bytes
const WINDOW = 1024       // max match distance (distance-1 fits 10 of 12 bits)
const MIN_MATCH = 3
const MAX_MATCH = 18      // length - MIN_MATCH fits 4 bits (0..15)
const CAP = N * 2 + 64    // compressed buffer headroom (incompressible worst case)
const N_ITERS = 5         // compress+inflate passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic, compressible input: an LCG byte stream with injected back-copies
// from the recent past, so real matches of varied length appear (a pure LCG would
// be near-incompressible). Identical per target.
const initBuf = (buf) => {
  let x = 0x12345678 | 0
  for (let i = 0; i < N; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    if (i > 64 && ((x & 0x70) === 0)) buf[i] = buf[i - 1 - ((x >>> 8) & 63)]
    else buf[i] = (x >>> 16) & 0xff
  }
}

const compress = (src, n, out) => {
  let op = 0
  let ip = 0
  while (ip < n) {
    const ctrlPos = op++
    let ctrl = 0
    for (let b = 0; b < 8 && ip < n; b++) {
      let start = ip - WINDOW
      if (start < 0) start = 0
      let maxLen = n - ip
      if (maxLen > MAX_MATCH) maxLen = MAX_MATCH
      let bestLen = 0
      let bestDist = 0
      // Scan nearest-first (j descending) so the first match of a given length
      // wins — the smallest distance — making ties deterministic.
      for (let j = ip - 1; j >= start; j--) {
        let len = 0
        while (len < maxLen && src[j + len] === src[ip + len]) len++
        if (len > bestLen) {
          bestLen = len
          bestDist = ip - j
          if (len >= maxLen) break
        }
      }
      if (bestLen >= MIN_MATCH) {
        ctrl |= (1 << b)
        const code = ((bestDist - 1) << 4) | (bestLen - MIN_MATCH)
        out[op] = (code >>> 8) & 0xff
        out[op + 1] = code & 0xff
        op += 2
        ip += bestLen
      } else {
        out[op++] = src[ip++]
      }
    }
    out[ctrlPos] = ctrl
  }
  return op
}

const inflate = (inp, clen, dst) => {
  let ip = 0
  let op = 0
  while (ip < clen) {
    const ctrl = inp[ip++]
    for (let b = 0; b < 8 && ip < clen; b++) {
      if (ctrl & (1 << b)) {
        const code = (inp[ip] << 8) | inp[ip + 1]
        ip += 2
        const dist = (code >>> 4) + 1
        const len = (code & 0x0f) + MIN_MATCH
        for (let k = 0; k < len; k++) {
          dst[op] = dst[op - dist]   // byte-by-byte so overlapping (run) matches work
          op++
        }
      } else {
        dst[op++] = inp[ip++]
      }
    }
  }
  return op
}

const runKernel = (src, comp, dec) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    const clen = compress(src, N, comp)
    const dlen = inflate(comp, clen, dec)
    let ok = (dlen === N) ? 1 : 0
    for (let i = 0; i < N; i++) if (dec[i] !== src[i]) ok = 0
    h = mix(h, clen)
    for (let i = 0; i < clen; i++) h = mix(h, comp[i])
    h = mix(h, ok)
    const j = it % N
    src[j] = (src[j] + 1) & 0xff   // perturb so the compress can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const src = new Uint8Array(N)
  const comp = new Uint8Array(CAP)
  const dec = new Uint8Array(N)
  initBuf(src)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(src, comp, dec)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(src, comp, dec)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 1, N_RUNS)
}

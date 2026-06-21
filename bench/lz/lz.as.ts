// lz.as.ts — AssemblyScript translation of bench/lz/lz.js.
//
// LZSS compressor + decompressor round-trip. Greedy longest-match search over a
// sliding window, then byte-exact inflate. Pure-integer byte twiddling — checksum
// is bit-identical to V8 and every native target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 4096
const WINDOW: i32 = 1024
const MIN_MATCH: i32 = 3
const MAX_MATCH: i32 = 18
const CAP: i32 = N * 2 + 64
const N_ITERS: i32 = 5
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function initBuf(buf: Uint8Array): void {
  let x: i32 = 0x12345678
  for (let i = 0; i < N; i++) {
    x = x * 1103515245 + 12345
    if (i > 64 && ((x & 0x70) == 0)) {
      const back: i32 = 1 + ((<u32>x >>> 8) & 63)
      unchecked(buf[i] = buf[i - back])
    } else {
      unchecked(buf[i] = <u8>((<u32>x >>> 16) & 0xff))
    }
  }
}

function compress(src: Uint8Array, nn: i32, out: Uint8Array): i32 {
  let op: i32 = 0
  let ip: i32 = 0
  while (ip < nn) {
    const ctrlPos: i32 = op
    op++
    let ctrl: u8 = 0
    for (let b = 0; b < 8 && ip < nn; b++) {
      let start: i32 = ip - WINDOW
      if (start < 0) start = 0
      let maxLen: i32 = nn - ip
      if (maxLen > MAX_MATCH) maxLen = MAX_MATCH
      let bestLen: i32 = 0
      let bestDist: i32 = 0
      for (let j = ip - 1; j >= start; j--) {
        let len: i32 = 0
        while (len < maxLen && unchecked(src[j + len]) == unchecked(src[ip + len])) len++
        if (len > bestLen) {
          bestLen = len
          bestDist = ip - j
          if (len >= maxLen) break
        }
      }
      if (bestLen >= MIN_MATCH) {
        ctrl = <u8>(<i32>ctrl | (1 << b))
        const code: i32 = ((bestDist - 1) << 4) | (bestLen - MIN_MATCH)
        unchecked(out[op] = <u8>((<u32>code >>> 8) & 0xff))
        unchecked(out[op + 1] = <u8>(code & 0xff))
        op += 2
        ip += bestLen
      } else {
        unchecked(out[op++] = src[ip++])
      }
    }
    unchecked(out[ctrlPos] = ctrl)
  }
  return op
}

function inflate(inp: Uint8Array, clen: i32, dst: Uint8Array): i32 {
  let ip: i32 = 0
  let op: i32 = 0
  while (ip < clen) {
    const ctrl: i32 = unchecked(inp[ip++])
    for (let b = 0; b < 8 && ip < clen; b++) {
      if ((ctrl & (1 << b)) != 0) {
        const code: i32 = (unchecked(inp[ip]) << 8) | unchecked(inp[ip + 1])
        ip += 2
        const dist: i32 = (<u32>code >>> 4) + 1
        const len: i32 = (code & 0x0f) + MIN_MATCH
        for (let k = 0; k < len; k++) {
          unchecked(dst[op] = dst[op - dist])
          op++
        }
      } else {
        unchecked(dst[op++] = inp[ip++])
      }
    }
  }
  return op
}

function mix(h: u32, x: u32): u32 {
  return (h ^ x) * <u32>0x01000193
}

function runKernel(src: Uint8Array, comp: Uint8Array, dec: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    const clen: i32 = compress(src, N, comp)
    const dlen: i32 = inflate(comp, clen, dec)
    let ok: u32 = (dlen == N) ? 1 : 0
    for (let i = 0; i < N; i++) if (unchecked(dec[i]) != unchecked(src[i])) ok = 0
    h = mix(h, <u32>clen)
    for (let i = 0; i < clen; i++) h = mix(h, <u32>unchecked(comp[i]))
    h = mix(h, ok)
    const j: i32 = it % N
    unchecked(src[j] = <u8>((unchecked(src[j]) + 1) & 0xff))
  }
  return h
}

export function main(): void {
  const src = new Uint8Array(N)
  const comp = new Uint8Array(CAP)
  const dec = new Uint8Array(N)
  initBuf(src)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(src, comp, dec)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(src, comp, dec)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 1, N_RUNS)
}

// conv2d.as.ts — AssemblyScript translation of bench/conv2d/conv2d.js.
//
// Int8 quantized 2-D convolution layer. int8 inputs × int8 weights accumulated
// into i32, requantized (arithmetic shift), ReLU-clamped, stored as uint8.
// Pure-integer: bit-identical checksum across engines and native targets.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const CIN: i32 = 4
const COUT: i32 = 16
const H: i32 = 34
const W: i32 = 34
const K: i32 = 3
const OH: i32 = H - K + 1   // 32
const OW: i32 = W - K + 1   // 32
const IN_LEN: i32 = CIN * H * W
const WT_LEN: i32 = COUT * CIN * K * K
const OUT_LEN: i32 = COUT * OH * OW
const SHIFT: i32 = 11
const N_ITERS: i32 = 24
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function fillI8(arr: Int8Array, n: i32, seed: i32): void {
  let x: i32 = seed
  for (let i = 0; i < n; i++) {
    x = x * 1103515245 + 12345
    unchecked(arr[i] = <i8>(x >> 24))
  }
}

function fillBias(arr: Int32Array, n: i32, seed: i32): void {
  let x: i32 = seed
  for (let i = 0; i < n; i++) {
    x = x * 1103515245 + 12345
    unchecked(arr[i] = (x >> 20) & 1023)
  }
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

function mix(h: u32, x: u32): u32 {
  return (h ^ x) * 0x01000193
}

function conv(inp: Int8Array, wt: Int8Array, bias: Int32Array, out: Uint8Array): void {
  for (let oc = 0; oc < COUT; oc++) {
    const b = unchecked(bias[oc])
    const ocBase = oc * OH * OW
    for (let oy = 0; oy < OH; oy++) {
      for (let ox = 0; ox < OW; ox++) {
        let acc: i32 = b
        for (let ic = 0; ic < CIN; ic++) {
          const inCh = ic * H * W
          const wCh = ((oc * CIN) + ic) * K * K
          for (let ky = 0; ky < K; ky++) {
            const irow = inCh + (oy + ky) * W + ox
            const wrow = wCh + ky * K
            for (let kx = 0; kx < K; kx++) {
              acc += <i32>unchecked(inp[irow + kx]) * <i32>unchecked(wt[wrow + kx])
            }
          }
        }
        let q: i32 = acc >> SHIFT
        if (q < 0) q = 0
        if (q > 127) q = 127
        unchecked(out[ocBase + oy * OW + ox] = <u8>q)
      }
    }
  }
}

function runKernel(inp: Int8Array, wt: Int8Array, bias: Int32Array, out: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    conv(inp, wt, bias, out)
    h = mix(h, checksumU8(out))
    const j = it % IN_LEN
    unchecked(inp[j] = <i8>(unchecked(inp[j]) + 1))
  }
  return h
}

export function main(): void {
  const inp  = new Int8Array(IN_LEN)
  const wt   = new Int8Array(WT_LEN)
  const bias = new Int32Array(COUT)
  const out  = new Uint8Array(OUT_LEN)
  fillI8(inp, IN_LEN, 0x12345678)
  fillI8(wt,  WT_LEN, 0x2bb3c1f7)
  fillBias(bias, COUT, 0x51e3a9d1)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(inp, wt, bias, out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(inp, wt, bias, out)
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
  logLine(<i32>(medianMs * 1000.0), cs, COUT * OH * OW * CIN * K * K * N_ITERS, 1, N_RUNS)
}

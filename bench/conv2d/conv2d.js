// conv2d.js — int8 quantized 2-D convolution layer, the hot kernel of edge / mobile
// neural-net inference. A valid (no-pad) Cin→Cout convolution with a 3×3 receptive
// field: int8 input × int8 weights accumulated into an int32 sum, then requantized
// (arithmetic right shift), ReLU-clamped, and stored as a uint8 activation.
//
// This is the spatial-convolution counterpart to the dense matmul case — six nested
// loops of integer multiply-accumulate, the shape that dominates CNN inference. All
// math is integer (int8 loads, i32 MAC, arithmetic shift), so the activation map is
// bit-identical across every engine and native target (no float, no FMA divergence).
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Int8Array / Int32Array / Uint8Array, no class/async.

import { medianUs, mix, checksumU8, printResult } from '../_lib/benchlib.js'

const CIN = 4
const COUT = 16
const H = 34
const W = 34
const K = 3
const OH = H - K + 1   // 32
const OW = W - K + 1   // 32
const IN_LEN = CIN * H * W
const WT_LEN = COUT * CIN * K * K
const OUT_LEN = COUT * OH * OW
const SHIFT = 11       // requant: acc >> SHIFT lands typical activations in 0..127
const N_ITERS = 24     // conv passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic int8 fill via LCG — the high byte spans the full signed range.
const fillI8 = (arr, n, seed) => {
  let x = seed | 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    arr[i] = x >> 24    // Int8Array truncates to signed 8-bit
  }
}

const fillBias = (arr, n, seed) => {
  let x = seed | 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    arr[i] = (x >> 20) & 1023   // small positive int32 bias
  }
}

const conv = (inp, wt, bias, out) => {
  for (let oc = 0; oc < COUT; oc++) {
    const b = bias[oc]
    const ocBase = oc * OH * OW
    for (let oy = 0; oy < OH; oy++) {
      for (let ox = 0; ox < OW; ox++) {
        let acc = b
        for (let ic = 0; ic < CIN; ic++) {
          const inCh = ic * H * W
          const wCh = ((oc * CIN) + ic) * K * K
          for (let ky = 0; ky < K; ky++) {
            const irow = inCh + (oy + ky) * W + ox
            const wrow = wCh + ky * K
            for (let kx = 0; kx < K; kx++) {
              acc += inp[irow + kx] * wt[wrow + kx]
            }
          }
        }
        let q = acc >> SHIFT   // requantize (arithmetic shift, sign-preserving)
        if (q < 0) q = 0       // ReLU
        if (q > 127) q = 127   // clamp to int8 range
        out[ocBase + oy * OW + ox] = q
      }
    }
  }
}

const runKernel = (inp, wt, bias, out) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    conv(inp, wt, bias, out)
    h = mix(h, checksumU8(out))
    const j = it % IN_LEN
    inp[j] = inp[j] + 1   // perturb so the conv can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const inp = new Int8Array(IN_LEN)
  const wt = new Int8Array(WT_LEN)
  const bias = new Int32Array(COUT)
  const out = new Uint8Array(OUT_LEN)
  fillI8(inp, IN_LEN, 0x12345678)
  fillI8(wt, WT_LEN, 0x2bb3c1f7)
  fillBias(bias, COUT, 0x51e3a9d1)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(inp, wt, bias, out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(inp, wt, bias, out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, COUT * OH * OW * CIN * K * K * N_ITERS, 1, N_RUNS)
}

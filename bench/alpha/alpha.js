// alpha.js — alpha compositing (constant-opacity "over" blend) of two RGBA8
// images, the canonical layer-blend / crossfade kernel. Pure-integer fixed-point
// blend per byte: out = (src*a + dst*(255-a) + 127) >> 8, so the result is
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// The blend is an embarrassingly-parallel per-byte map widening u8 → i32 → u8, so
// jz lifts it to i32x4 SIMD (the widening byte-map path) — the same vectorization
// clang/zig apply. Reports: median ms, throughput in bytes/µs, FNV-1a checksum.

import { checksumU8, medianUs, printResult } from '../_lib/benchlib.js'

const W = 512
const H = 512
const N = W * H * 4          // RGBA8
const A = 160                // source opacity, 0..255
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic RGBA noise — XorShift32, identical per target.
const mkImage = (n, seed) => {
  const out = new Uint8Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    out[i] = (s >>> 0) & 255
  }
  return out
}

const IA = 255 - A           // dest weight

// Per-byte fixed-point blend: out = (src*A + dst*(255-A) + 127) >> 8.
// src[i]/dst[i] (u8) widen to i32 for the multiply, then the result narrows
// back to a byte — an embarrassingly-parallel widening byte-map.
const blend = (src, dst, out, n) => {
  for (let i = 0; i < n; i++) out[i] = (Math.imul(src[i], A) + Math.imul(dst[i], IA) + 127) >> 8
}

export let main = () => {
  const src = mkImage(N, 0x1234abcd)
  const dst = mkImage(N, 0x7e1f93b5)
  const out = new Uint8Array(N)
  for (let i = 0; i < N_WARMUP; i++) blend(src, dst, out, N)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    blend(src, dst, out, N)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU8(out), N, 1, N_RUNS)
}

// deltae.js — CIEDE2000 color difference over Lab pairs: colorimetry's infamous formula
// (the one with a Wikipedia section on its own discontinuities) and the hot loop of any
// palette matcher, gamut auditor or perceptual diff. The profile per pair: atan2 with
// quadrant fix-ups into degrees, mean-hue case analysis (four branches), rotation term
// with exp and a 7th power, weighted euclidean assembly — heavy transcendental scalar
// code with unpredictable branches, where autovectorizers surrender. Engine-native
// transcendentals differ by ULPs across languages, so — like the suite's other colorjs
// cases (colorconv/colorlch/colorlog/colorpq) — this is a single-source JS-family case:
// jz vs the JS engines vs Porffor, checksum exact within that family.
//
// Reference: Sharma, Wu & Dalal, "The CIEDE2000 Color-Difference Formula" (2005) —
// the implementation notes with the hue-mean cases are followed exactly.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over ΔE00 values (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const NPAIR = 150000
const N_ITERS = 3
const N_RUNS = 21
const N_WARMUP = 5
const DEG = 180.0 / Math.PI
const RAD = Math.PI / 180.0

const buildPairs = (lab1, lab2) => {
  let s = 0x4e5d6c7 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < NPAIR; i++) {
    lab1[i * 3] = (rnd() % 10000) * 0.01
    lab1[i * 3 + 1] = (rnd() % 20000) * 0.01 - 100.0
    lab1[i * 3 + 2] = (rnd() % 20000) * 0.01 - 100.0
    lab2[i * 3] = (rnd() % 10000) * 0.01
    lab2[i * 3 + 1] = (rnd() % 20000) * 0.01 - 100.0
    lab2[i * 3 + 2] = (rnd() % 20000) * 0.01 - 100.0
  }
}

const pow7 = (x) => {
  const x2 = x * x
  return x2 * x2 * x2 * x
}

const de2000 = (L1, a1, b1, L2, a2, b2) => {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cm = (C1 + C2) * 0.5
  const c7 = pow7(Cm)
  const G = 0.5 * (1.0 - Math.sqrt(c7 / (c7 + 6103515625.0)))   // 25^7
  const ap1 = (1.0 + G) * a1
  const ap2 = (1.0 + G) * a2
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1)
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2)
  let hp1 = ap1 === 0.0 && b1 === 0.0 ? 0.0 : Math.atan2(b1, ap1) * DEG
  if (hp1 < 0.0) hp1 += 360.0
  let hp2 = ap2 === 0.0 && b2 === 0.0 ? 0.0 : Math.atan2(b2, ap2) * DEG
  if (hp2 < 0.0) hp2 += 360.0
  const dL = L2 - L1
  const dC = Cp2 - Cp1
  let dhp = 0.0
  const CC = Cp1 * Cp2
  if (CC !== 0.0) {
    dhp = hp2 - hp1
    if (dhp > 180.0) dhp -= 360.0
    else if (dhp < -180.0) dhp += 360.0
  }
  const dH = 2.0 * Math.sqrt(CC) * Math.sin(dhp * 0.5 * RAD)
  const Lm = (L1 + L2) * 0.5
  const Cpm = (Cp1 + Cp2) * 0.5
  let hpm
  if (CC === 0.0) hpm = hp1 + hp2
  else {
    const sum = hp1 + hp2
    const diff = hp1 - hp2
    const ad = diff < 0.0 ? -diff : diff
    if (ad <= 180.0) hpm = sum * 0.5
    else if (sum < 360.0) hpm = (sum + 360.0) * 0.5
    else hpm = (sum - 360.0) * 0.5
  }
  const T = 1.0 - 0.17 * Math.cos((hpm - 30.0) * RAD) + 0.24 * Math.cos(2.0 * hpm * RAD)
    + 0.32 * Math.cos((3.0 * hpm + 6.0) * RAD) - 0.20 * Math.cos((4.0 * hpm - 63.0) * RAD)
  const dTheta = 30.0 * Math.exp(-((hpm - 275.0) / 25.0) * ((hpm - 275.0) / 25.0))
  const cpm7 = pow7(Cpm)
  const RC = 2.0 * Math.sqrt(cpm7 / (cpm7 + 6103515625.0))
  const Lm50 = (Lm - 50.0) * (Lm - 50.0)
  const SL = 1.0 + 0.015 * Lm50 / Math.sqrt(20.0 + Lm50)
  const SC = 1.0 + 0.045 * Cpm
  const SH = 1.0 + 0.015 * Cpm * T
  const RT = -Math.sin(2.0 * dTheta * RAD) * RC
  const vL = dL / SL
  const vC = dC / SC
  const vH = dH / SH
  return Math.sqrt(vL * vL + vC * vC + vH * vH + RT * vC * vH)
}

const runKernel = (lab1, lab2, out) => {
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < NPAIR; i++) {
      out[i] = de2000(lab1[i * 3], lab1[i * 3 + 1], lab1[i * 3 + 2],
        lab2[i * 3], lab2[i * 3 + 1], lab2[i * 3 + 2])
    }
  }
}

export let main = () => {
  const lab1 = new Float64Array(NPAIR * 3)
  const lab2 = new Float64Array(NPAIR * 3)
  const out = new Float64Array(NPAIR)
  buildPairs(lab1, lab2)

  for (let i = 0; i < N_WARMUP; i++) runKernel(lab1, lab2, out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(lab1, lab2, out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), NPAIR * N_ITERS, 1, N_RUNS)
}

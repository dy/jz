// strbuild.js — per-record string formatting: render each integer record as a
// CSV-ish line (`id,name,value\n`) by concatenation, fold its chars, discard.
// The canonical serialization inner loop (loggers, exporters, code generators,
// row writers): every row allocates short-lived string temporaries and
// converts integers to text — in a JS engine the churn lands on the young-gen
// GC (rope/cons strings make each `+` cheap), while an AOT compiler must make
// eager concat, int→string, and allocation itself cheap. Pure ASCII and
// integer data, so the folded chars are bit-identical across every engine and
// native target.
//
// (A single giant `out += line` accumulator is deliberately NOT the shape
// here: with eager strings and no GC that is quadratic in allocation — jz
// exhausts memory on it — so the case measures the linear per-record loop
// every serializer actually hots.)
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines. Subset: const/let + arrows, string concat, charCodeAt,
// Math.imul, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 4096               // rows per pass
const N_ITERS = 4            // passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Small name table — the string field of each row.
const NAMES = ['alpha', 'bravo', 'carol', 'delta', 'echo', 'fox', 'golf', 'hotel',
  'india', 'jazz', 'kilo', 'lima', 'mike', 'nova', 'oscar', 'papa']

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
const fill = (code, vals) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    code[i] = s & 15
    vals[i] = s >> 4
  }
}

const runKernel = (code, vals) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < N; i++) {
      const line = i + ',' + NAMES[code[i]] + ',' + ((vals[i] + it) | 0) + '\n'
      for (let j = 0; j < line.length; j++) h = mix(h, line.charCodeAt(j))
    }
  }
  return h >>> 0
}

export let main = () => {
  const code = new Int32Array(N)
  const vals = new Int32Array(N)
  fill(code, vals)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(code, vals)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(code, vals)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 3, N_RUNS)
}

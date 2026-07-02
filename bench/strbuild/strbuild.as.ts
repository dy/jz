// strbuild.as.ts — AssemblyScript translation of bench/strbuild/strbuild.js.
//
// Per-record string formatting: render each integer record as a CSV-ish line
// (`id,name,value\n`), fold its chars, discard. The canonical serialization
// inner loop (loggers, exporters, code generators, row writers): every row
// allocates short-lived string temporaries and converts integers to text.
// Pure ASCII and integer data, so the folded chars are bit-identical across
// every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 4096              // rows per pass
const N_ITERS: i32 = 4           // passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const NAMES: StaticArray<string> = ['alpha', 'bravo', 'carol', 'delta', 'echo', 'fox', 'golf', 'hotel',
  'india', 'jazz', 'kilo', 'lima', 'mike', 'nova', 'oscar', 'papa']

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
function fill(code: Int32Array, vals: Int32Array): void {
  let s: i32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(code[i] = s & 15)
    unchecked(vals[i] = s >> 4)
  }
}

function runKernel(code: Int32Array, vals: Int32Array): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < N_ITERS; it++) {
    for (let i = 0; i < N; i++) {
      const line = i.toString() + ',' + unchecked(NAMES[unchecked(code[i])]) + ',' + (unchecked(vals[i]) + it).toString() + '\n'
      for (let j = 0; j < line.length; j++) h = mix(h, line.charCodeAt(j))
    }
  }
  return <u32>h
}

export function main(): void {
  const code = new Int32Array(N)
  const vals = new Int32Array(N)
  fill(code, vals)
  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(code, vals)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(code, vals)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 3, N_RUNS)
}

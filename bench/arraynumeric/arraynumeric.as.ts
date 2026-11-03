// arraynumeric.as.ts – AssemblyScript port of arraynumeric.js (Perry's
// bench_numeric_array_numeric.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT): a quarter million integers pushed one by one, then
// 25 passes that add 1 to every slot.
//
// The JS array of numbers is an Array<f64> grown by push. The lane builds with
// the stub runtime, which frees nothing, so each run's array stays allocated
// (about 2 MB a run).
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const SIZE: i32 = 250000
const ITERATIONS: i32 = 25
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 3

function mix(h: u32, x: u32): u32 {
  return (h ^ x) * 0x01000193
}

// x | 0 for the integers these sums hold
function i32of(x: f64): u32 {
  return <u32><i32>x
}

function buildNumericArray(): Array<f64> {
  const arr = new Array<f64>()
  for (let i = 0; i < SIZE; i++) {
    arr.push(<f64>i)
  }
  return arr
}

function mutateNumericArray(arr: Array<f64>): f64 {
  let checksum: f64 = 0

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < arr.length; i++) {
      unchecked(arr[i] = arr[i] + 1)
    }
    checksum = checksum + unchecked(arr[0]) + unchecked(arr[arr.length - 1])
  }

  return checksum + <f64>arr.length
}

function runNumericArray(): f64 {
  return mutateNumericArray(buildNumericArray())
}

function medianUs(samples: Float64Array): i32 {
  for (let i = 1; i < samples.length; i++) {
    const v = unchecked(samples[i])
    let j = i - 1
    while (j >= 0 && unchecked(samples[j]) > v) {
      unchecked(samples[j + 1] = samples[j])
      j--
    }
    unchecked(samples[j + 1] = v)
  }
  return <i32>(unchecked(samples[(samples.length - 1) >> 1]) * 1000.0)
}

export function main(): void {
  for (let i = 0; i < N_WARMUP; i++) runNumericArray()

  let h: u32 = 0x811c9dc5
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    const cs = runNumericArray()
    unchecked(samples[i] = perfNow() - t0)
    h = mix(h, i32of(cs))
  }

  const arr = buildNumericArray()
  h = mix(h, i32of(mutateNumericArray(arr)))
  for (let i = 0; i < arr.length; i++) h = mix(h, i32of(unchecked(arr[i])))
  logLine(medianUs(samples), h, SIZE, 2, N_RUNS)
}

// arraynumeric.js – a plain array that stays numeric: a quarter million
// integers pushed one by one, then 25 passes that add 1 to every slot. Perry's
// bench_numeric_array_numeric.ts (https://github.com/PerryTS/perry,
// benchmarks/suite, MIT), the positive control of arraydowngrade: the same
// array and passes with no object or string stored, so a compiler that proves
// the elements numeric can hold them unboxed and add without a type test, as a
// JIT does in its small-integer element kind.
//
// Perry's algorithm and data as it wrote them; the harness's timing (median of
// N_RUNS runs after N_WARMUP) replaces its Date.now around one. Its run builds
// the array and mutates it, both timed; here the mutation takes the array it
// builds as a parameter, so one more run after the timed ones hands the
// checksum its whole array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of the last run's array.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const SIZE = 250000
const ITERATIONS = 25
const N_RUNS = 21
const N_WARMUP = 3

const buildNumericArray = () => {
  const arr = []
  for (let i = 0; i < SIZE; i++) {
    arr.push(i)
  }
  return arr
}

const mutateNumericArray = (arr) => {
  let checksum = 0

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = arr[i] + 1
    }
    checksum = checksum + arr[0] + arr[arr.length - 1]
  }

  return checksum + arr.length
}

const runNumericArray = () => mutateNumericArray(buildNumericArray())

const fold = (h, arr) => {
  for (let i = 0; i < arr.length; i++) h = mix(h, arr[i])
  return h >>> 0
}

export let main = () => {
  for (let i = 0; i < N_WARMUP; i++) runNumericArray()

  let h = 0x811c9dc5 | 0
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    const cs = runNumericArray()
    samples[i] = performance.now() - t0
    h = mix(h, cs)
  }

  const arr = buildNumericArray()
  h = mix(h, mutateNumericArray(arr))
  printResult(medianUs(samples), fold(h, arr), SIZE, 2, N_RUNS)
}

// arraydowngrade.js – a plain array that starts numeric and stops being so: a
// quarter million integers pushed one by one, then an object and a string
// stored in the middle, then 25 passes that add 1 to every numeric slot on
// both sides of them. Perry's bench_numeric_array_downgrade.ts
// (https://github.com/PerryTS/perry, benchmarks/suite, MIT), the pair of
// arraynumeric, its positive control: the same array staying numeric. A JIT
// moves the array from its small-integer element kind to generic elements once
// the object lands; a compiler that types the array statically sees one array
// of mixed values, and either way every `arr[i] + 1` must stay JS's `+`, which
// would concatenate were the slot the string. Perry's per-pass checksum reads
// the first and last slots, the object's field and the string.
//
// Perry's algorithm and data as it wrote them; the harness's timing (median of
// N_RUNS runs after N_WARMUP) replaces its Date.now around one. Its run builds
// the array and mutates it, both timed; here the mutation takes the array it
// builds as a parameter, so one more run after the timed ones hands the
// checksum its whole array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of the last run's array (a number as itself, the object by
// its field, the string by its length).

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const SIZE = 250000
const ITERATIONS = 25
const OBJECT_INDEX = 125000
const STRING_INDEX = 125001
const N_RUNS = 21
const N_WARMUP = 3

const buildDowngradedArray = () => {
  const arr = []
  for (let i = 0; i < SIZE; i++) {
    arr.push(i)
  }

  arr[OBJECT_INDEX] = { value: 7 }
  arr[STRING_INDEX] = 'numeric-array-downgrade-payload'
  return arr
}

const mutateDowngradedArray = (arr) => {
  let checksum = 0

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < OBJECT_INDEX; i++) {
      arr[i] = arr[i] + 1
    }
    for (let i = STRING_INDEX + 1; i < arr.length; i++) {
      arr[i] = arr[i] + 1
    }

    checksum = checksum + arr[0] + arr[arr.length - 1] + arr[OBJECT_INDEX].value
    if (arr[STRING_INDEX] !== '') {
      checksum = checksum + 3
    }
  }

  return checksum + arr.length
}

const runDowngradedArray = () => mutateDowngradedArray(buildDowngradedArray())

const fold = (h, arr) => {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    h = mix(h, typeof v === 'number' ? v : typeof v === 'string' ? v.length : v.value)
  }
  return h >>> 0
}

export let main = () => {
  for (let i = 0; i < N_WARMUP; i++) runDowngradedArray()

  let h = 0x811c9dc5 | 0
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    const cs = runDowngradedArray()
    samples[i] = performance.now() - t0
    h = mix(h, cs)
  }

  const arr = buildDowngradedArray()
  h = mix(h, mutateDowngradedArray(arr))
  printResult(medianUs(samples), fold(h, arr), SIZE, 2, N_RUNS)
}

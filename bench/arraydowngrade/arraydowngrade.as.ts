// arraydowngrade.as.ts – AssemblyScript port of arraydowngrade.js (Perry's
// bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT): a quarter million integers pushed one by one, an
// object and a string stored in the middle, then 25 passes that add 1 to every
// numeric slot on both sides of them.
//
// AssemblyScript has no union type, so a JS value is a kind-tagged flat class
// (shapes.as.ts's idiom: a number, an object, a string) and the array an
// Array of references to one such cell per slot. `arr[i] = arr[i] + 1` is
// JS's `+` on a slot of any kind: a number adds, a string concatenates, an
// object concatenates its string form, so addOne tests the kind of every slot
// it updates and adds to a number in its cell. The lane builds with the stub
// runtime, which frees nothing: a fresh cell for every sum would allocate 6.25
// million cells a run, so the sum is stored in the slot's own cell, which
// nothing else references. Each run's array and cells stay allocated (about
// 12 MB a run).
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them (a number as
// itself, the object by its field, the string by its length).

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const SIZE: i32 = 250000
const ITERATIONS: i32 = 25
const OBJECT_INDEX: i32 = 125000
const STRING_INDEX: i32 = 125001
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 3

const NUM: i32 = 0
const OBJ: i32 = 1
const STR: i32 = 2

class Obj {
  constructor(public value: f64) {}
}

class Value {
  constructor(
    public kind: i32,
    public num: f64 = 0,
    public obj: Obj | null = null,
    public str: string | null = null,
  ) {}
}

function mix(h: u32, x: u32): u32 {
  return (h ^ x) * 0x01000193
}

// x | 0 for the integers these sums hold
function i32of(x: f64): u32 {
  return <u32><i32>x
}

// arr[i] = arr[i] + 1, JS's `+`
function addOne(v: Value): void {
  if (v.kind == NUM) {
    v.num += 1
  } else if (v.kind == STR) {
    v.str = v.str! + '1'
  } else {
    v.kind = STR
    v.str = '[object Object]1'
    v.obj = null
  }
}

// a slot in a numeric sum: a number, or NaN (an undefined field, a string's concatenation never taken here)
function num(v: Value): f64 {
  return v.kind == NUM ? v.num : NaN
}

function fieldValue(v: Value): f64 {
  return v.kind == OBJ ? v.obj!.value : NaN
}

function buildDowngradedArray(): Array<Value> {
  const arr = new Array<Value>()
  for (let i = 0; i < SIZE; i++) {
    arr.push(new Value(NUM, <f64>i))
  }

  unchecked(arr[OBJECT_INDEX] = new Value(OBJ, 0, new Obj(7)))
  unchecked(arr[STRING_INDEX] = new Value(STR, 0, null, 'numeric-array-downgrade-payload'))
  return arr
}

function mutateDowngradedArray(arr: Array<Value>): f64 {
  let checksum: f64 = 0

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < OBJECT_INDEX; i++) {
      addOne(unchecked(arr[i]))
    }
    for (let i = STRING_INDEX + 1; i < arr.length; i++) {
      addOne(unchecked(arr[i]))
    }

    checksum = checksum + num(unchecked(arr[0])) + num(unchecked(arr[arr.length - 1])) + fieldValue(unchecked(arr[OBJECT_INDEX]))
    const s = unchecked(arr[STRING_INDEX])
    if (!(s.kind == STR && s.str!.length == 0)) {
      checksum = checksum + 3
    }
  }

  return checksum + <f64>arr.length
}

function runDowngradedArray(): f64 {
  return mutateDowngradedArray(buildDowngradedArray())
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
  for (let i = 0; i < N_WARMUP; i++) runDowngradedArray()

  let h: u32 = 0x811c9dc5
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    const cs = runDowngradedArray()
    unchecked(samples[i] = perfNow() - t0)
    h = mix(h, i32of(cs))
  }

  const arr = buildDowngradedArray()
  h = mix(h, i32of(mutateDowngradedArray(arr)))
  for (let i = 0; i < arr.length; i++) {
    const v = unchecked(arr[i])
    h = mix(h, v.kind == NUM ? i32of(v.num) : v.kind == STR ? <u32>v.str!.length : i32of(v.obj!.value))
  }
  logLine(medianUs(samples), h, SIZE, 2, N_RUNS)
}

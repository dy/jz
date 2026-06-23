// Shared timing + checksum + print for the .mbt bench kernels — the MoonBit sibling
// of _lib/bench.h / _lib/bench.zig. The harness compiles this into the same `src`
// package as each case's main.mbt, so kernels call these helpers directly (no
// qualifier). Timing uses core's monotonic clock (moonrun, MoonBit's V8 wasm
// runner, supplies it); output is one `median_us=…` line that bench.mjs parses.

fn mix(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

// FNV-style hash over every 128th u32 element.
fn checksum_u32(xs : Array[UInt]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  let mut i = 0
  while i < xs.length() {
    h = mix(h, xs[i])
    i = i + 128
  }
  h
}

// Same hash over the low 32 bits of every 128th f64 — matches the C/zig word walk
// (which steps 256 u32 words, always landing on the low word of every 128th f64).
fn checksum_f64(xs : Array[Double]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  let mut i = 0
  while i < xs.length() {
    let lo = xs[i].reinterpret_as_int64().to_int().reinterpret_as_uint()
    h = mix(h, lo)
    i = i + 128
  }
  h
}

// Median of the middle sample, in microseconds — matches the C/zig `samples[(n-1)>>1]`.
fn median_us(samples : Array[Double], runs : Int) -> Int {
  samples.sort()
  samples[(runs - 1) / 2].to_int()
}

// Warmup, then `runs` timed iterations of `body`; returns the median µs.
fn measure(warmup : Int, runs : Int, body : () -> Unit) -> Int {
  measure_with_setup(warmup, runs, fn() {  }, body)
}

// Like `measure`, but `setup` runs before every iteration UNTIMED — for kernels
// that must reset state each run (nbody re-seeds) without charging it to the clock.
fn measure_with_setup(
  warmup : Int,
  runs : Int,
  setup : () -> Unit,
  body : () -> Unit,
) -> Int {
  for _i in 0..<warmup {
    setup()
    body()
  }
  let samples = Array::make(runs, 0.0)
  for i in 0..<runs {
    setup()
    let t = @bench.monotonic_clock_start()
    body()
    samples[i] = @bench.monotonic_clock_end(t)
  }
  median_us(samples, runs)
}

fn print_result(
  median : Int,
  checksum : UInt,
  samples : Int,
  stages : Int,
  runs : Int,
) -> Unit {
  println(
    "median_us=\{median} checksum=\{checksum} samples=\{samples} stages=\{stages} runs=\{runs}",
  )
}

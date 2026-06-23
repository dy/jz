// callback bench — ports callback.zig
let n = 4096
let n_iters = 64
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn run_kernel(a : Array[Int], b : Array[Int], scale : Int) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for i in 0..<n_iters {
    for k in 0..<n {
      b[k] = a[k] * scale + i
    }
    for j in 0..<n {
      h = mix_u32(h, b[j].reinterpret_as_uint())
    }
  }
  h
}

fn main {
  let a = Array::make(n, 0)
  let b = Array::make(n, 0)
  for i in 0..<n {
    a[i] = i % 97 - 48
  }
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = run_kernel(a, b, 2)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(a, b, 2)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 2, n_runs)
}

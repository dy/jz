// poly — mixed f64/i32 reduction (sum). Ports poly.js/.zig.
let n = 8192

let n_iters = 80

let n_runs = 21

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn init_data(f64s : Array[Double], i32s : Array[Int]) -> Unit {
  for i in 0..<n {
    f64s[i] = (i % 251).to_double() * 0.25
    i32s[i] = (i * 17) & 1023
  }
}

fn sum_f64(xs : Array[Double]) -> Double {
  let mut s = 0.0
  for i in 0..<n {
    s = s + xs[i]
  }
  s
}

fn sum_i32(xs : Array[Int]) -> Int {
  let mut s = 0
  for i in 0..<n {
    s = s + xs[i]
  }
  s
}

fn run_kernel(f64s : Array[Double], i32s : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for _i in 0..<n_iters {
    h = mix_u32(h, sum_f64(f64s).to_int().reinterpret_as_uint())
    h = mix_u32(h, sum_i32(i32s).reinterpret_as_uint())
  }
  h
}

fn main {
  let f64s = Array::make(n, 0.0)
  let i32s = Array::make(n, 0)
  init_data(f64s, i32s)
  let mut cs : UInt = 0
  let med = measure(5, n_runs, fn() { cs = run_kernel(f64s, i32s) })
  print_result(med, cs, n * n_iters * 2, 2, n_runs)
}

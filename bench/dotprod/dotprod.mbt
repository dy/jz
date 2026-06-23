// dotprod — multiply-accumulate dot product. Ports dotprod.js/.zig.
let n = 8192

let n_iters = 200

let n_runs = 21

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn init_data(a : Array[Double], b : Array[Double]) -> Unit {
  for i in 0..<n {
    a[i] = (i % 13 - 6).to_double()
    b[i] = (i * 7 % 11 - 5).to_double()
  }
}

fn dot(a : Array[Double], b : Array[Double]) -> Double {
  let mut s = 0.0
  for i in 0..<n {
    s = s + a[i] * b[i]
  }
  s
}

fn run_kernel(a : Array[Double], b : Array[Double]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for _i in 0..<n_iters {
    h = mix_u32(h, dot(a, b).to_int().reinterpret_as_uint())
  }
  h
}

fn main {
  let a = Array::make(n, 0.0)
  let b = Array::make(n, 0.0)
  init_data(a, b)
  let mut cs : UInt = 0
  let med = measure(5, n_runs, fn() { cs = run_kernel(a, b) })
  print_result(med, cs, n * n_iters, 2, n_runs)
}

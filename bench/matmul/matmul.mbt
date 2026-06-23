// matmul — dense C = A·Bᵀ, contiguous dot inner loop. Small-integer data keeps
// every product-sum exact in f64, so the checksum matches every target. Ports
// matmul.js/.zig.
let n = 256

let n_runs = 21

fn init_mats(a : Array[Double], bt : Array[Double]) -> Unit {
  for i in 0..<(n * n) {
    a[i] = (i % 13 - 6).to_double()
    bt[i] = (i * 7 % 11 - 5).to_double()
  }
}

fn matmul(a : Array[Double], bt : Array[Double], c : Array[Double]) -> Unit {
  for i in 0..<n {
    let ai = i * n
    for j in 0..<n {
      let bj = j * n
      let mut s = 0.0
      for k in 0..<n {
        s = s + a[ai + k] * bt[bj + k]
      }
      c[ai + j] = s
    }
  }
}

fn main {
  let a = Array::make(n * n, 0.0)
  let bt = Array::make(n * n, 0.0)
  let c = Array::make(n * n, 0.0)
  init_mats(a, bt)
  let med = measure(5, n_runs, fn() { matmul(a, bt, c) })
  print_result(med, checksum_f64(c), n * n * n, 2, n_runs)
}

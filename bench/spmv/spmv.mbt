// spmv — sparse matrix × dense vector (CSR). Ports spmv.js/.zig.
let rows = 4096
let npr = 16
let nnz = 65536 // rows * npr
let n_iters = 80
let n_runs = 21

fn build(
  row_ptr : Array[Int],
  col_idx : Array[Int],
  values : Array[Double],
  x : Array[Double],
) -> Unit {
  let mut s : UInt = 0x1234abcd
  let next = fn() -> UInt {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    s
  }
  for r in 0..=(rows) { row_ptr[r] = r * npr }
  for k in 0..<nnz {
    col_idx[k] = (next() % rows.reinterpret_as_uint()).reinterpret_as_int()
    let raw = (next() % 9).reinterpret_as_int() - 4
    values[k] = raw.to_double()
  }
  for i in 0..<rows {
    let raw = (next() % 7).reinterpret_as_int() - 3
    x[i] = raw.to_double()
  }
}

fn spmv_kernel(
  row_ptr : Array[Int],
  col_idx : Array[Int],
  values : Array[Double],
  x : Array[Double],
  y : Array[Double],
) -> Unit {
  for r in 0..<rows {
    let mut sum = 0.0
    let end = row_ptr[r + 1]
    let mut k = row_ptr[r]
    while k < end {
      sum = sum + values[k] * x[col_idx[k]]
      k = k + 1
    }
    y[r] = sum
  }
}

fn run_kernel(
  row_ptr : Array[Int],
  col_idx : Array[Int],
  values : Array[Double],
  x : Array[Double],
  y : Array[Double],
) -> Unit {
  for _it in 0..<n_iters {
    spmv_kernel(row_ptr, col_idx, values, x, y)
    for i in 0..<rows { x[i] = x[i] + 1.0 }
  }
}

fn main {
  let row_ptr = Array::make(rows + 1, 0)
  let col_idx = Array::make(nnz, 0)
  let values = Array::make(nnz, 0.0)
  let x = Array::make(rows, 0.0)
  let y = Array::make(rows, 0.0)
  let med = measure_with_setup(
    5,
    n_runs,
    fn() { build(row_ptr, col_idx, values, x) },
    fn() { run_kernel(row_ptr, col_idx, values, x, y) },
  )
  print_result(med, checksum_f64(y), nnz * n_iters, 2, n_runs)
}

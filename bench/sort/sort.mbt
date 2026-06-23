// in-place heapsort — call-heavy nested loops over f64, re-filled each iteration.
// Ports sort.js/.zig.
let n = 8192

let n_iters = 24

let n_runs = 21

fn fill(xs : Array[Double]) -> Unit {
  let mut s : UInt = 0x9e3779b9
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    xs[i] = s.to_double() / 4294967296.0
  }
}

fn heapsort(a : Array[Double]) -> Unit {
  let mut root = (n >> 1) - 1
  while root >= 0 {
    let mut i = root
    let mut child = 2 * i + 1
    while child < n {
      if child + 1 < n && a[child] < a[child + 1] {
        child = child + 1
      }
      if a[i] >= a[child] {
        break
      }
      let t = a[i]
      a[i] = a[child]
      a[child] = t
      i = child
      child = 2 * i + 1
    }
    root = root - 1
  }
  let mut end = n - 1
  while end > 0 {
    let t = a[0]
    a[0] = a[end]
    a[end] = t
    let mut i = 0
    let mut child = 1
    while child < end {
      if child + 1 < end && a[child] < a[child + 1] {
        child = child + 1
      }
      if a[i] >= a[child] {
        break
      }
      let u = a[i]
      a[i] = a[child]
      a[child] = u
      i = child
      child = 2 * i + 1
    }
    end = end - 1
  }
}

fn run_kernel(a : Array[Double], src : Array[Double]) -> Unit {
  for it in 0..<n_iters {
    let f = it.to_double()
    for i in 0..<n {
      a[i] = src[i] + f
    }
    heapsort(a)
  }
}

fn main {
  let src = Array::make(n, 0.0)
  let a = Array::make(n, 0.0)
  fill(src)
  let med = measure(5, n_runs, fn() { run_kernel(a, src) })
  print_result(med, checksum_f64(a), n * n_iters, 2, n_runs)
}

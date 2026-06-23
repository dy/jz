// AoS/SoA layout kernel — ports aos.zig
let n = 16384
let n_iters = 64
let n_runs = 21

fn init_rows(px : Array[Double], py : Array[Double], pz : Array[Double]) -> Unit {
  for i in 0..<n {
    let fi = i.to_double()
    px[i] = fi * 0.5
    py[i] = fi + 1.0
    pz[i] = ((i & 7) - 3).to_double()
  }
}

fn run_kernel(
  px : Array[Double],
  py : Array[Double],
  pz : Array[Double],
  xs : Array[Double],
  ys : Array[Double],
  zs : Array[Double],
) -> Unit {
  for r in 0..<n_iters {
    let rf = r.to_double()
    for i in 0..<n {
      xs[i] = px[i] + py[i] * 0.25 + rf
      ys[i] = py[i] - pz[i] * 0.5
      zs[i] = pz[i] + px[i] * 0.125
    }
  }
}

fn main {
  let px = Array::make(n, 0.0)
  let py = Array::make(n, 0.0)
  let pz = Array::make(n, 0.0)
  let xs = Array::make(n, 0.0)
  let ys = Array::make(n, 0.0)
  let zs = Array::make(n, 0.0)
  init_rows(px, py, pz)
  let med = measure(5, n_runs, fn() {
    run_kernel(px, py, pz, xs, ys, zs)
  })
  let cs = checksum_f64(xs) ^ checksum_f64(ys) ^ checksum_f64(zs)
  print_result(med, cs, n * n_iters, 3, n_runs)
}

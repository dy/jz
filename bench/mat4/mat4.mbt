// mat4 — 4×4 f64 matrix multiply chain. Ports mat4.js/.zig.
let n_iters = 200000

let n_runs = 21

fn init_data(a : Array[Double], b : Array[Double]) -> Unit {
  for i in 0..<16 {
    a[i] = (i.to_double() + 1.0) * 0.125
    b[i] = (16 - i).to_double() * 0.0625
  }
}

fn multiply_many(
  a : Array[Double],
  b : Array[Double],
  out : Array[Double],
  iters : Int,
) -> Unit {
  for n in 0..<iters {
    for r in 0..<4 {
      for c in 0..<4 {
        let mut s = 0.0
        for k in 0..<4 {
          s = s + a[r * 4 + k] * b[k * 4 + c]
        }
        out[r * 4 + c] = s + n.to_double() * 0.0000001
      }
    }
    let t = a[0]
    a[0] = out[15]
    a[5] = t + out[10] * 0.000001
    b[0] = b[0] + out[0] * 0.00000000001
    b[5] = b[5] - out[5] * 0.00000000001
  }
}

fn main {
  let a = Array::make(16, 0.0)
  let b = Array::make(16, 0.0)
  let out = Array::make(16, 0.0)
  // warmup without re-init (matching zig)
  init_data(a, b)
  for _i in 0..<5 {
    multiply_many(a, b, out, n_iters)
  }
  // timed runs: init is untimed setup, multiply is timed body
  let med = measure_with_setup(
    0,
    n_runs,
    fn() { init_data(a, b) },
    fn() { multiply_many(a, b, out, n_iters) },
  )
  print_result(med, checksum_f64(out), n_iters * 16, 4, n_runs)
}

// biquad filter cascade — ports biquad.zig
let n_samples = 480000
let n_stages = 8
let n_runs = 21
let n_warmup = 5

fn mk_input(out : Array[Double]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n_samples {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
  }
}

fn mk_coeffs(out : Array[Double]) -> Unit {
  for i in 0..<n_stages {
    let fi = i.to_double()
    out[i * 5 + 0] = 0.10 + fi * 0.001
    out[i * 5 + 1] = 0.20 - fi * 0.0005
    out[i * 5 + 2] = 0.10
    out[i * 5 + 3] = -1.50 + fi * 0.01
    out[i * 5 + 4] = 0.60 - fi * 0.005
  }
}

fn process_cascade(
  x : Array[Double],
  coeffs : Array[Double],
  state : Array[Double],
  out : Array[Double],
) -> Unit {
  for i in 0..<n_samples {
    let mut v = x[i]
    for s in 0..<n_stages {
      let c = s * 5
      let sb = s * 4
      let b0 = coeffs[c + 0]
      let b1 = coeffs[c + 1]
      let b2 = coeffs[c + 2]
      let a1 = coeffs[c + 3]
      let a2 = coeffs[c + 4]
      let x1 = state[sb + 0]
      let x2 = state[sb + 1]
      let y1 = state[sb + 2]
      let y2 = state[sb + 3]
      let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      state[sb + 0] = v
      state[sb + 1] = x1
      state[sb + 2] = y
      state[sb + 3] = y1
      v = y
    }
    out[i] = v
  }
}

fn main {
  let x = Array::make(n_samples, 0.0)
  let coeffs = Array::make(n_stages * 5, 0.0)
  let state = Array::make(n_stages * 4, 0.0)
  let out = Array::make(n_samples, 0.0)
  mk_input(x)
  mk_coeffs(coeffs)
  let med = measure_with_setup(
    n_warmup,
    n_runs,
    fn() {
      for i in 0..<(n_stages * 4) {
        state[i] = 0.0
      }
    },
    fn() { process_cascade(x, coeffs, state, out) },
  )
  print_result(med, checksum_f64(out), n_samples, n_stages, n_runs)
}

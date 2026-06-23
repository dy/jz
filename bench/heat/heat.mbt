// heat — 2-D heat diffusion, explicit-Euler 5-point Laplacian. Ports heat.js/.zig.
let w = 258

let h = 258

let steps = 100

let k = 0.125

let n_runs = 21

fn seed(a : Array[Double]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<(w * h) {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    a[i] = (s & 255).to_double()
  }
}

fn step_grid(src : Array[Double], dst : Array[Double]) -> Unit {
  for y in 1..<(h - 1) {
    let row = y * w
    for x in 1..<(w - 1) {
      let c = row + x
      dst[c] = src[c] + k * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4.0 * src[c])
    }
  }
}

fn run(a : Array[Double], b : Array[Double]) -> Unit {
  let mut s = 0
  while s < steps {
    step_grid(a, b)
    step_grid(b, a)
    s = s + 2
  }
}

fn main {
  let a = Array::make(w * h, 0.0)
  let b = Array::make(w * h, 0.0)
  let med = measure_with_setup(
    5,
    n_runs,
    fn() {
      seed(a)
      seed(b)
    },
    fn() { run(a, b) },
  )
  print_result(med, checksum_f64(a), (w - 2) * (h - 2) * steps, 6, n_runs)
}

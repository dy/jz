// Per-record string-formatting kernel — ports strbuild.js
let n = 4096 // rows per pass
let n_iters = 4
let n_runs = 21

let names : Array[String] = [
  "alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel", "india",
  "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa",
]

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
fn fill(code : Array[Int], vals : Array[Int]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    code[i] = (s & 15).reinterpret_as_int()
    vals[i] = s.reinterpret_as_int() >> 4
  }
}

fn run_kernel(code : Array[Int], vals : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<n_iters {
    for i in 0..<n {
      let v = (vals[i].reinterpret_as_uint() + it.reinterpret_as_uint()).reinterpret_as_int()
      let line = "\{i},\{names[code[i]]},\{v}\n"
      for j in 0..<line.length() {
        h = mix(h, line.at(j).to_int().reinterpret_as_uint())
      }
    }
  }
  h
}

fn main {
  let code = Array::make(n, 0)
  let vals = Array::make(n, 0)
  fill(code, vals)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(code, vals)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(code, vals)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 3, n_runs)
}

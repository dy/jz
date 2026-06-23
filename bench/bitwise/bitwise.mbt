// Bitwise xorshift kernel — ports bitwise.zig
let n = 65536
let n_rounds = 128
let n_runs = 21

fn init_data(state : Array[UInt]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    state[i] = s
  }
}

fn run_kernel(state : Array[UInt]) -> Unit {
  for _r in 0..<n_rounds {
    for i in 0..<n {
      let mut x = state[i]
      x = x ^ (x << 7)
      x = x ^ (x >> 9)
      x = x * 1103515245 + 12345
      state[i] = x ^ (x >> 16)
    }
  }
}

fn main {
  let state = Array::make(n, 0U)
  let med = measure_with_setup(5, n_runs, fn() { init_data(state) }, fn() { run_kernel(state) })
  print_result(med, checksum_u32(state), n * n_rounds, 3, n_runs)
}

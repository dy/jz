// Bytecode interpreter dispatch kernel — ports vm.zig
let steps : Int = 16384  // 1 << 14
let ninstr = 8
let n_iters = 64
let n_runs = 21

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn build_program(code : Array[Int]) -> Unit {
  let p = [
    0, 0, 0,
    0, 1, 16384,
    1, 0, 1103515245,
    2, 0, 12345,
    3, 0, 16,
    4, 1, 0,
    5, 1, 2,
    6, 0, 0,
  ]
  for i in 0..<p.length() {
    code[i] = p[i]
  }
}

fn run_vm(code : Array[Int], reg : Array[Int]) -> Int {
  let mut pc = 0
  while pc < ninstr {
    let o = pc * 3
    let op = code[o]
    let a = code[o + 1]
    let b = code[o + 2]
    if op == 0 {
      reg[a] = b
      pc = pc + 1
    } else if op == 1 {
      reg[a] = (reg[a].reinterpret_as_uint() * b.reinterpret_as_uint()).reinterpret_as_int()
      pc = pc + 1
    } else if op == 2 {
      reg[a] = (reg[a].reinterpret_as_uint() + b.reinterpret_as_uint()).reinterpret_as_int()
      pc = pc + 1
    } else if op == 3 {
      let shift = (b.reinterpret_as_uint() & 31).reinterpret_as_int()
      reg[a] = reg[a] ^ (reg[a].reinterpret_as_uint() >> shift).reinterpret_as_int()
      pc = pc + 1
    } else if op == 4 {
      reg[a] = (reg[a].reinterpret_as_uint() - 1).reinterpret_as_int()
      pc = pc + 1
    } else if op == 5 {
      if reg[a] != 0 {
        pc = b
      } else {
        pc = pc + 1
      }
    } else {
      pc = ninstr
    }
  }
  reg[0]
}

fn run_kernel(code : Array[Int], reg : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<n_iters {
    // patch seed: (0x12345678 + it) as wrapping u32 reinterpreted as i32
    code[2] = (0x12345678U + it.reinterpret_as_uint()).reinterpret_as_int()
    h = mix_u32(h, run_vm(code, reg).reinterpret_as_uint())
  }
  h
}

fn main {
  let code = Array::make(ninstr * 3, 0)
  let reg = Array::make(4, 0)
  build_program(code)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(code, reg)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(code, reg)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, steps * n_iters, ninstr, n_runs)
}

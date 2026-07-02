// Data-driven function-table dispatch kernel — ports dispatch.js
let n = 16384 // 1 << 14, opcode stream length
let nops = 8
let n_iters = 48
let n_runs = 21

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
fn op_add(x : Int, k : Int) -> Int {
  (x.reinterpret_as_uint() + k.reinterpret_as_uint()).reinterpret_as_int()
}

fn op_xor(x : Int, k : Int) -> Int {
  x ^ k
}

fn op_mul(x : Int, k : Int) -> Int {
  (x.reinterpret_as_uint() * (k | 1).reinterpret_as_uint()).reinterpret_as_int()
}

fn op_rsub(x : Int, k : Int) -> Int {
  (k.reinterpret_as_uint() - x.reinterpret_as_uint()).reinterpret_as_int()
}

fn op_shr(x : Int, k : Int) -> Int {
  x ^ (x.reinterpret_as_uint() >> 7).reinterpret_as_int() ^ k
}

fn op_m31(x : Int, k : Int) -> Int {
  let ux = x.reinterpret_as_uint()
  ((ux << 5) - ux + k.reinterpret_as_uint()).reinterpret_as_int()
}

fn op_rot(x : Int, k : Int) -> Int {
  let ux = x.reinterpret_as_uint()
  ((ux << 13) | (ux >> 19)).reinterpret_as_int() ^ k
}

fn op_and(x : Int, k : Int) -> Int {
  (x & k) ^ (x.reinterpret_as_uint() >> 11).reinterpret_as_int()
}

let ops : Array[(Int, Int) -> Int] = [
  op_add, op_xor, op_mul, op_rsub, op_shr, op_m31, op_rot, op_and,
]

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
fn fill(code : Array[Int], ks : Array[Int]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    code[i] = (s & 7).reinterpret_as_int()
    ks[i] = s.reinterpret_as_int() >> 3
  }
}

fn run_kernel(code : Array[Int], ks : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<n_iters {
    let mut x = (0x2545f491U + it.reinterpret_as_uint()).reinterpret_as_int()
    for i in 0..<n {
      x = ops[code[i]](x, ks[i])
    }
    h = mix(h, x.reinterpret_as_uint())
  }
  h
}

fn main {
  let code = Array::make(n, 0)
  let ks = Array::make(n, 0)
  fill(code, ks)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(code, ks)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(code, ks)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, nops, n_runs)
}

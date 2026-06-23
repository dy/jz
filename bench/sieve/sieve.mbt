// sieve — Sieve of Eratosthenes. Ports sieve.zig.
let limit : Int = 1 << 20  // 1048576
let n_iters = 6
let n_runs = 21
let n_warmup = 5

// FNV-1a over every byte — matches checksumU8 in sieve.zig (stride=1, not 128).
fn checksum_u8(comp : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for i in 0..<limit {
    h = (h ^ comp[i].reinterpret_as_uint()) * 0x01000193
  }
  h
}

fn sieve(comp : Array[Int]) -> Unit {
  for i in 0..<limit {
    comp[i] = 0
  }
  comp[0] = 1
  comp[1] = 1
  let mut i = 2
  while i * i < limit {
    if comp[i] == 0 {
      let mut j = i * i
      while j < limit {
        comp[j] = 1
        j = j + i
      }
    }
    i = i + 1
  }
}

fn run_kernel(comp : Array[Int]) -> Unit {
  for _it in 0..<n_iters {
    sieve(comp)
  }
}

fn main {
  let comp = Array::make(limit, 0)

  let mut cs : UInt = 0
  let med = measure(n_warmup, n_runs, fn() { run_kernel(comp) })
  cs = checksum_u8(comp)
  print_result(med, cs, limit * n_iters, 1, n_runs)
}

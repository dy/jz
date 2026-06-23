// levenshtein — rolling-row DP edit distance. Ports levenshtein.zig.
let la = 512
let lb = 512
let alpha : UInt = 8
let n_iters = 8
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn fill_str(out : Array[Int], n : Int, seed : UInt) -> Unit {
  let mut s = seed
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = (s % alpha).to_int()
  }
}

fn levenshtein(a : Array[Int], b : Array[Int], prev : Array[Int]) -> Int {
  for j in 0..=lb {
    prev[j] = j
  }
  for i in 1..=la {
    let mut diag = prev[0]
    prev[0] = i
    let ai = a[i - 1]
    for j in 1..=lb {
      let up = prev[j]
      let cost = if ai == b[j - 1] { 0 } else { 1 }
      let sub = diag + cost
      let mut m = up + 1
      let ins = prev[j - 1] + 1
      if ins < m { m = ins }
      if sub < m { m = sub }
      diag = up
      prev[j] = m
    }
  }
  prev[lb]
}

fn run_kernel(a : Array[Int], b : Array[Int], prev : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<n_iters {
    let j = it % la
    a[j] = ((a[j].reinterpret_as_uint() + 1) % alpha).to_int()
    let dist = levenshtein(a, b, prev)
    h = mix_u32(h, dist.reinterpret_as_uint())
  }
  h
}

fn main {
  let a = Array::make(la, 0)
  let b = Array::make(lb, 0)
  let prev = Array::make(lb + 1, 0)
  fill_str(a, la, 0x1234abcd)
  fill_str(b, lb, 0x9e3779b9)

  let mut cs : UInt = 0
  let med = measure(n_warmup, n_runs, fn() { cs = run_kernel(a, b, prev) })
  print_result(med, cs, la * lb * n_iters, 2, n_runs)
}

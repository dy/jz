// nqueens — bitmask N-Queens solver. Ports nqueens.zig.
let nmin = 8
let nspan : UInt = 4
let nq = 20
let n_runs = 21
let n_warmup = 5

fn mix_nq(h : Int, x : Int) -> Int {
  ((h ^ x).reinterpret_as_uint() * 0x01000193).reinterpret_as_int()
}

fn fill_sizes(out : Array[Int]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for q in 0..<nq {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[q] = nmin + (s % nspan).reinterpret_as_int()
  }
}

fn solve(all : Int, cols : Int, d1 : Int, d2 : Int) -> Int {
  if cols == all {
    return 1
  }
  let mut cnt = 0
  let mut avail = all & (cols | d1 | d2).lnot()
  while avail != 0 {
    let b = avail & (-avail)
    avail = avail - b
    cnt = cnt + solve(all, cols | b, (d1 | b) << 1, ((d2 | b).reinterpret_as_uint() >> 1).reinterpret_as_int())
  }
  cnt
}

fn count_n(n : Int) -> Int {
  solve((1 << n) - 1, 0, 0, 0)
}

fn run_kernel(sizes : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for q in 0..<nq {
    h = (h ^ count_n(sizes[q]).reinterpret_as_uint()) * 0x01000193
  }
  h
}

fn main {
  let sizes = Array::make(nq, 0)
  fill_sizes(sizes)

  let mut total = 0
  for q in 0..<nq {
    total = total + count_n(sizes[q])
  }

  let mut cs : UInt = 0
  let med = measure(n_warmup, n_runs, fn() { cs = run_kernel(sizes) })
  print_result(med, cs, total, nmin + (nspan - 1).reinterpret_as_int(), n_runs)
}

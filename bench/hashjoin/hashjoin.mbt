// Probe-dominated relational hash join — ports hashjoin.zig.
// Build a hash table on a small build relation, then stream a large probe relation
// through it and sum matched payloads — the kernel at the heart of every database.
let cap = 16384       // 1 << 14
let mask : UInt = 16383  // cap - 1
let build_n = 8192    // cap >> 1
let probe_n = 65536   // 1 << 16
let empty : Int = -1
let n_iters = 24
let n_runs = 21

fn mix_i32(h : Int, x : Int) -> Int {
  (h.reinterpret_as_uint() ^ x.reinterpret_as_uint()) * 0x01000193 |> _.reinterpret_as_int()
}

fn fill(out : Array[Int], n : Int, seed : UInt) -> Unit {
  let mut s : UInt = seed
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = (s & 0x7fffffff).reinterpret_as_int()
  }
}

fn hash_key(k : Int) -> Int {
  ((k.reinterpret_as_uint() * 0x9e3779b1) & mask).reinterpret_as_int()
}

fn table_insert(keys : Array[Int], vals : Array[Int], k : Int, v : Int) -> Unit {
  let mut h = hash_key(k)
  while keys[h] != empty {
    if keys[h] == k {
      vals[h] = v
      return
    }
    h = ((h.reinterpret_as_uint() + 1) & mask).reinterpret_as_int()
  }
  keys[h] = k
  vals[h] = v
}

fn table_probe(keys : Array[Int], vals : Array[Int], k : Int) -> Int {
  let mut h = hash_key(k)
  while keys[h] != empty {
    if keys[h] == k {
      return vals[h]
    }
    h = ((h.reinterpret_as_uint() + 1) & mask).reinterpret_as_int()
  }
  0
}

fn run_kernel(
  keys : Array[Int],
  vals : Array[Int],
  build : Array[Int],
  probes : Array[Int],
) -> UInt {
  let mut h : Int = 0x811c9dc5U.reinterpret_as_int()
  for it in 0..<n_iters {
    for ci in 0..<cap {
      keys[ci] = empty
    }
    for i in 0..<build_n {
      let v = (build[i].reinterpret_as_uint() + it.reinterpret_as_uint()).reinterpret_as_int()
      table_insert(keys, vals, build[i], v)
    }
    let mut sum : Int = 0
    for i in 0..<probe_n {
      sum = (sum.reinterpret_as_uint() + table_probe(keys, vals, probes[i]).reinterpret_as_uint()).reinterpret_as_int()
    }
    h = mix_i32(h, sum)
  }
  h.reinterpret_as_uint()
}

fn main {
  let keys = Array::make(cap, 0)
  let vals = Array::make(cap, 0)
  let build = Array::make(build_n, 0)
  let probes = Array::make(probe_n, 0)
  fill(build, build_n, 0x1234abcd)
  fill(probes, probe_n, 0x9e3779b9)
  for i = 0; i < probe_n; i = i + 2 {
    probes[i] = build[(i >> 1) & (build_n - 1)]
  }
  let mut cs : UInt = 0
  for _i in 0..<5 {
    cs = run_kernel(keys, vals, build, probes)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(keys, vals, build, probes)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, probe_n * n_iters, 2, n_runs)
}

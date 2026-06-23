// Open-addressing hash table kernel — ports dict.zig
let cap = 16384   // 1 << 14
let mask : UInt = 16383  // cap - 1
let nkeys = 8192  // cap >> 1
let empty : Int = -1
let n_iters = 60
let n_runs = 21

fn mix_i32(h : Int, x : Int) -> Int {
  (h.reinterpret_as_uint() ^ x.reinterpret_as_uint()) * 0x01000193 |> _.reinterpret_as_int()
}

fn fill_src(out : Array[Int]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<nkeys {
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

fn table_lookup(keys : Array[Int], vals : Array[Int], k : Int) -> Int {
  let mut h = hash_key(k)
  while keys[h] != empty {
    if keys[h] == k {
      return vals[h]
    }
    h = ((h.reinterpret_as_uint() + 1) & mask).reinterpret_as_int()
  }
  -1
}

fn run_kernel(keys : Array[Int], vals : Array[Int], src : Array[Int]) -> UInt {
  // h starts as 0x811c9dc5 reinterpreted as signed i32
  let mut h : Int = 0x811c9dc5U.reinterpret_as_int()
  for it in 0..<n_iters {
    // clear table
    for ci in 0..<cap {
      keys[ci] = empty
    }
    // insert
    for i in 0..<nkeys {
      let v = (src[i].reinterpret_as_uint() + it.reinterpret_as_uint()).reinterpret_as_int()
      table_insert(keys, vals, src[i], v)
    }
    // probe
    for i in 0..<nkeys {
      let idx = (i * 7) & (nkeys - 1)
      let v = table_lookup(keys, vals, src[idx])
      h = mix_i32(h, v)
    }
  }
  h.reinterpret_as_uint()
}

fn main {
  let keys = Array::make(cap, 0)
  let vals = Array::make(cap, 0)
  let src = Array::make(nkeys, 0)
  fill_src(src)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(keys, vals, src)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(keys, vals, src)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, nkeys * n_iters, 2, n_runs)
}

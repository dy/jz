// MurmurHash3 kernel — ports hash.zig
let n = 16384
let n_iters = 700
let n_runs = 21

let c1 : UInt = 0xcc9e2d51
let c2 : UInt = 0x1b873593

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn init_buf(buf : Array[UInt]) -> Unit {
  let mut x : UInt = 0x12345678
  for i in 0..<n {
    x = x * 1103515245 + 12345
    buf[i] = (x >> 16) & 0xff
  }
}

fn murmur3(buf : Array[UInt], seed : UInt) -> UInt {
  let mut h = seed
  let mut i = 0
  while i + 4 <= n {
    let mut k = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)
    k = k * c1
    k = (k << 15) | (k >> 17)
    k = k * c2
    h = h ^ k
    h = (h << 13) | (h >> 19)
    h = h * 5 + 0xe6546b64
    i = i + 4
  }
  h = h ^ n.reinterpret_as_uint()
  h = h ^ (h >> 16)
  h = h * 0x85ebca6b
  h = h ^ (h >> 13)
  h = h * 0xc2b2ae35
  h = h ^ (h >> 16)
  h
}

fn run_kernel(buf : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    let mr = murmur3(buf, 0x9747b28c)
    h = mix_u32(h, mr)
    let j = it % n
    buf[j] = (buf[j] + 1) & 0xff
  }
  h
}

fn main {
  let buf = Array::make(n, 0U)
  init_buf(buf)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(buf)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(buf)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 1, n_runs)
}

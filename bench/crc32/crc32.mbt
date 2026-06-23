// CRC32 kernel — ports crc32.zig
let n = 16384
let n_iters = 220
let n_runs = 21

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn build_table(table : Array[UInt]) -> Unit {
  for n_val in 0..<256 {
    let mut c = n_val.reinterpret_as_uint()
    for _k in 0..<8 {
      if (c & 1) != 0 {
        c = 0xedb88320 ^ (c >> 1)
      } else {
        c = c >> 1
      }
    }
    table[n_val] = c
  }
}

fn init_buf(buf : Array[UInt]) -> Unit {
  let mut x : UInt = 0x12345678
  for i in 0..<n {
    x = x * 1103515245 + 12345
    buf[i] = (x >> 16) & 0xff
  }
}

fn crc32_kernel(buf : Array[UInt], table : Array[UInt]) -> UInt {
  let mut c : UInt = 0xffffffff
  for i in 0..<n {
    c = table[((c ^ buf[i]) & 0xff).to_int()] ^ (c >> 8)
  }
  c ^ 0xffffffff
}

fn run_kernel(buf : Array[UInt], table : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    h = mix_u32(h, crc32_kernel(buf, table))
    let j = it % n
    buf[j] = (buf[j] + 1) & 0xff
  }
  h
}

fn main {
  let buf = Array::make(n, 0U)
  let table = Array::make(256, 0U)
  build_table(table)
  init_buf(buf)
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(buf, table)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(buf, table)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 1, n_runs)
}

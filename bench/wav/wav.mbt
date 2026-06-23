// wav bench kernel — ports wav.zig
let n = 131072
let sr : UInt = 44100
let hdr = 44
let bytes = 262188  // HDR + N*2 = 44 + 131072*2
let n_iters = 16
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn checksum_u8(xs : Array[UInt], len : Int) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for i in 0..<len {
    h = mix_u32(h, xs[i])
  }
  h
}

fn mk_samples(s : Array[Double]) -> Unit {
  let mut x : Int = 0x1234abcd
  for i in 0..<n {
    x = x ^ (x << 13)
    x = x ^ (x.reinterpret_as_uint() >> 17).reinterpret_as_int()
    x = x ^ (x << 5)
    s[i] = (x.reinterpret_as_uint().to_double() / 4294967296.0 * 2.0 - 1.0) * 1.2
  }
}

fn write_u32(b : Array[UInt], off : Int, v : UInt) -> Unit {
  b[off]     = v & 0xff
  b[off + 1] = (v >> 8)  & 0xff
  b[off + 2] = (v >> 16) & 0xff
  b[off + 3] = (v >> 24) & 0xff
}

fn write_u16(b : Array[UInt], off : Int, v : UInt) -> Unit {
  b[off]     = v & 0xff
  b[off + 1] = (v >> 8) & 0xff
}

fn encode(s : Array[Double], count : Int, out : Array[UInt]) -> Unit {
  let data_bytes : UInt = count.reinterpret_as_uint() * 2U
  out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70
  write_u32(out, 4, 36U + data_bytes)
  out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69
  out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32
  write_u32(out, 16, 16U)
  write_u16(out, 20, 1U)
  write_u16(out, 22, 1U)
  write_u32(out, 24, sr)
  write_u32(out, 28, sr * 2U)
  write_u16(out, 32, 2U)
  write_u16(out, 34, 16U)
  out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97
  write_u32(out, 40, data_bytes)
  let mut op = hdr
  for i in 0..<count {
    let mut v = s[i] * 32767.0
    if v > 32767.0 { v = 32767.0 } else if v < -32768.0 { v = -32768.0 }
    let iv = v.to_int()
    let u = iv.reinterpret_as_uint() & 0xffff
    out[op]     = u & 0xff
    out[op + 1] = (u >> 8) & 0xff
    op = op + 2
  }
}

fn run_kernel(s : Array[Double], out : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    encode(s, n, out)
    h = mix_u32(h, checksum_u8(out, bytes))
    let j = it % n
    s[j] = -s[j]
  }
  h
}

fn main {
  let s = Array::make(n, 0.0)
  let out = Array::make(bytes, 0U)
  mk_samples(s)
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = run_kernel(s, out)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(s, out)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 1, n_runs)
}

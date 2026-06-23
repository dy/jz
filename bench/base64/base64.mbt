// base64 bench kernel — ports base64.zig
let n = 24576
let enc_len = 32768  // (N/3)*4
let n_iters = 64
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn checksum_u8(xs : Array[UInt], len : Int) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for i in 0..<len {
    h = (h ^ xs[i]) * 0x01000193
  }
  h
}

fn build_enc(enc : Array[UInt]) -> Unit {
  let mut i = 0
  let mut c : UInt = 65
  while c <= 90 {
    enc[i] = c
    i = i + 1
    c = c + 1
  }
  c = 97
  while c <= 122 {
    enc[i] = c
    i = i + 1
    c = c + 1
  }
  c = 48
  while c <= 57 {
    enc[i] = c
    i = i + 1
    c = c + 1
  }
  enc[i] = 43
  i = i + 1
  enc[i] = 47
}

fn build_dec(enc : Array[UInt], dec : Array[UInt]) -> Unit {
  for i in 0..<256 {
    dec[i] = 0
  }
  for i in 0..<64 {
    dec[enc[i].to_int()] = i.reinterpret_as_uint()
  }
}

fn init_buf(buf : Array[UInt]) -> Unit {
  let mut x : UInt = 0x12345678
  for i in 0..<n {
    x = x * 1103515245 + 12345
    buf[i] = (x >> 16) & 0xff
  }
}

fn encode(src : Array[UInt], enc : Array[UInt], out : Array[UInt]) -> Unit {
  let mut op = 0
  let mut i = 0
  while i + 3 <= n {
    let a = src[i]
    let b = src[i + 1]
    let c = src[i + 2]
    out[op]     = enc[(a >> 2).to_int()]
    out[op + 1] = enc[((a & 3) << 4 | (b >> 4)).to_int()]
    out[op + 2] = enc[((b & 15) << 2 | (c >> 6)).to_int()]
    out[op + 3] = enc[(c & 63).to_int()]
    op = op + 4
    i = i + 3
  }
}

fn decode(src : Array[UInt], dec : Array[UInt], out : Array[UInt]) -> Unit {
  let mut op = 0
  let mut i = 0
  while i + 4 <= enc_len {
    let a = dec[src[i].to_int()]
    let b = dec[src[i + 1].to_int()]
    let c = dec[src[i + 2].to_int()]
    let d = dec[src[i + 3].to_int()]
    out[op]     = ((a << 2) | (b >> 4)) & 0xff
    out[op + 1] = ((b & 15) << 4 | (c >> 2)) & 0xff
    out[op + 2] = ((c & 3) << 6 | d) & 0xff
    op = op + 3
    i = i + 4
  }
}

fn run_kernel(src : Array[UInt], enc : Array[UInt], dec : Array[UInt], b64 : Array[UInt], back : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    encode(src, enc, b64)
    decode(b64, dec, back)
    let mut ok : UInt = 1
    for i in 0..<n {
      if back[i] != src[i] { ok = 0 }
    }
    let cs_b64 = checksum_u8(b64, enc_len)
    h = mix_u32(mix_u32(h, cs_b64), ok)
    let j = it % n
    src[j] = (src[j] + 1) & 0xff
  }
  h
}

fn main {
  let src = Array::make(n, 0U)
  let enc_tab = Array::make(64, 0U)
  let dec_tab = Array::make(256, 0U)
  let b64 = Array::make(enc_len, 0U)
  let back = Array::make(n, 0U)
  build_enc(enc_tab)
  build_dec(enc_tab, dec_tab)
  init_buf(src)
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = run_kernel(src, enc_tab, dec_tab, b64, back)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(src, enc_tab, dec_tab, b64, back)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 1, n_runs)
}

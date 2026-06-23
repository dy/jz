// lz bench kernel — ports lz.zig
let n = 4096
let window = 1024
let min_match = 3
let max_match = 18
let cap = 8256  // N*2+64
let n_iters = 5
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn init_buf(buf : Array[UInt]) -> Unit {
  let mut x : UInt = 0x12345678
  for i in 0..<n {
    x = x * 1103515245 + 12345
    if i > 64 && (x & 0x70) == 0 {
      let back = ((x >> 8) & 63).to_int() + 1
      buf[i] = buf[i - back]
    } else {
      buf[i] = (x >> 16) & 0xff
    }
  }
}

fn compress(src : Array[UInt], nn : Int, out : Array[UInt]) -> Int {
  let mut op = 0
  let mut ip = 0
  while ip < nn {
    let ctrl_pos = op
    op = op + 1
    let mut ctrl : UInt = 0
    let mut b = 0
    while b < 8 && ip < nn {
      let start = if ip >= window { ip - window } else { 0 }
      let max_len = if nn - ip < max_match { nn - ip } else { max_match }
      let mut best_len = 0
      let mut best_dist = 0
      let mut j = ip
      while j > start {
        j = j - 1
        let mut len = 0
        while len < max_len && src[j + len] == src[ip + len] {
          len = len + 1
        }
        if len > best_len {
          best_len = len
          best_dist = ip - j
          if len >= max_len { break }
        }
      }
      if best_len >= min_match {
        ctrl = ctrl | (1U << b)
        let code : UInt = (best_dist - 1).reinterpret_as_uint() << 4 | (best_len - min_match).reinterpret_as_uint()
        out[op]     = (code >> 8) & 0xff
        out[op + 1] = code & 0xff
        op = op + 2
        ip = ip + best_len
      } else {
        out[op] = src[ip]
        op = op + 1
        ip = ip + 1
      }
      b = b + 1
    }
    out[ctrl_pos] = ctrl
  }
  op
}

fn inflate(inp : Array[UInt], clen : Int, dst : Array[UInt]) -> Int {
  let mut ip = 0
  let mut op = 0
  while ip < clen {
    let ctrl = inp[ip]
    ip = ip + 1
    let mut b = 0
    while b < 8 && ip < clen {
      if (ctrl & (1U << b)) != 0 {
        let code : UInt = (inp[ip] << 8) | inp[ip + 1]
        ip = ip + 2
        let dist = ((code >> 4) + 1).to_int()
        let len = ((code & 0x0f) + min_match.reinterpret_as_uint()).to_int()
        let mut k = 0
        while k < len {
          dst[op] = dst[op - dist]
          op = op + 1
          k = k + 1
        }
      } else {
        dst[op] = inp[ip]
        op = op + 1
        ip = ip + 1
      }
      b = b + 1
    }
  }
  op
}

fn run_kernel(src : Array[UInt], comp : Array[UInt], dec : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    let clen = compress(src, n, comp)
    let dlen = inflate(comp, clen, dec)
    let mut ok : UInt = if dlen == n { 1 } else { 0 }
    for i in 0..<n {
      if dec[i] != src[i] { ok = 0 }
    }
    h = mix_u32(h, clen.reinterpret_as_uint())
    for i in 0..<clen {
      h = mix_u32(h, comp[i])
    }
    h = mix_u32(h, ok)
    let j = it % n
    src[j] = (src[j] + 1) & 0xff
  }
  h
}

fn main {
  let src = Array::make(n, 0U)
  let comp = Array::make(cap, 0U)
  let dec = Array::make(n, 0U)
  init_buf(src)
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = run_kernel(src, comp, dec)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(src, comp, dec)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, 1, n_runs)
}

// tokenizer bench — ports tokenizer.zig
let base_str = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"
let n_repeat = 512
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn is_alpha(c : Int) -> Bool {
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95
}

fn scan(src : Array[Int], len : Int) -> UInt {
  let mut h : UInt = 0x811c9dc5
  let mut number : UInt = 0
  let mut in_number = false
  let mut in_ident = false
  let mut tokens : UInt = 0
  for i in 0..<len {
    let c = src[i]
    if c >= 48 && c <= 57 {
      number = number * 10 + (c - 48).reinterpret_as_uint()
      in_number = true
    } else {
      if in_number {
        h = mix_u32(h, number)
        tokens = tokens + 1
        number = 0
        in_number = false
      }
      if is_alpha(c) {
        if not(in_ident) {
          h = mix_u32(h, c.reinterpret_as_uint())
          tokens = tokens + 1
        }
        in_ident = true
      } else {
        if c > 32 {
          h = mix_u32(h, c.reinterpret_as_uint())
          tokens = tokens + 1
        }
        in_ident = false
      }
    }
  }
  if in_number {
    h = mix_u32(h, number)
    tokens = tokens + 1
  }
  mix_u32(h, tokens)
}

fn main {
  // Build source: repeat base_str n_repeat times as Array[Int] of char codes
  let base_bytes : Array[Int] = []
  let base_chars = base_str.to_array()
  for ch in base_chars {
    base_bytes.push(ch.to_int())
  }
  let base_len = base_bytes.length()
  let total_len = base_len * n_repeat
  let src = Array::make(total_len, 0)
  for i in 0..<n_repeat {
    for j in 0..<base_len {
      src[i * base_len + j] = base_bytes[j]
    }
  }
  let mut cs : UInt = 0
  for i in 0..<n_warmup {
    cs = scan(src, total_len - (i & 7))
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = scan(src, total_len - (i & 7))
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, total_len, 5, n_runs)
}

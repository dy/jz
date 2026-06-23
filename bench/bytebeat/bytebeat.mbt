// Bytebeat audio synthesis kernel — ports bytebeat.zig
// checksumU8 mixes EVERY byte (no stride) — implemented inline
let n : Int = 1 << 21
let n_runs = 21

fn mix_byte(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn checksum_u8(buf : Array[UInt]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for i in 0..<n {
    h = mix_byte(h, buf[i])
  }
  h
}

fn sample(t : UInt) -> UInt {
  let v1 = ((t * 5) & (t >> 7)) | ((t * 3) & (t >> 10))
  let v2 = t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))
  (v1 + v2) & 255
}

fn render(buf : Array[UInt]) -> Unit {
  let mut t : UInt = 0
  for i in 0..<n {
    buf[i] = sample(t)
    t = t + 1
  }
}

fn main {
  let buf = Array::make(n, 0U)
  let med = measure(5, n_runs, fn() { render(buf) })
  print_result(med, checksum_u8(buf), n, 1, n_runs)
}

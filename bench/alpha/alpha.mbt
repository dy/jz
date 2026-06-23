// alpha — alpha-composite two RGBA8 images. Ports alpha.zig.
let width : Int = 512
let height : Int = 512
let nn : Int = 512 * 512 * 4
let alpha_a : Int = 160
let alpha_ia : Int = 255 - 160  // 95
let n_runs : Int = 21
let n_warmup : Int = 5

fn mix_u8(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

// FNV-1a over every byte — matches checksumU8 in the zig.
fn checksum_u8(out : Array[Int]) -> UInt {
  let mut hh : UInt = 0x811c9dc5
  let len = out.length()
  let mut i = 0
  while i < len {
    hh = mix_u8(hh, (out[i] & 0xff).reinterpret_as_uint())
    i = i + 1
  }
  hh
}

fn mk_image(out : Array[Int], seed : UInt) -> Unit {
  let mut s : UInt = seed
  let len = out.length()
  let mut i = 0
  while i < len {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = (s & 255).reinterpret_as_int()
    i = i + 1
  }
}

fn blend(src : Array[Int], dst : Array[Int], out : Array[Int]) -> Unit {
  let mut i = 0
  while i < nn {
    let v = (src[i] * alpha_a + dst[i] * alpha_ia + 127) >> 8
    out[i] = v & 0xff
    i = i + 1
  }
}

fn main {
  let src = Array::make(nn, 0)
  let dst = Array::make(nn, 0)
  let out = Array::make(nn, 0)
  mk_image(src, 0x1234abcd)
  mk_image(dst, 0x7e1f93b5)
  let med = measure(n_warmup, n_runs, fn() { blend(src, dst, out) })
  let cs = checksum_u8(out)
  print_result(med, cs, nn, 1, n_runs)
}

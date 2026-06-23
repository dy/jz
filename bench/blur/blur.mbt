// blur — separable box blur on RGBA8 image. Ports blur.zig.
let w : Int = 512
let h : Int = 512
let r : Int = 4
let win : Int = 2 * 4 + 1  // 9
let n : Int = 512 * 512 * 4
let n_runs : Int = 21
let n_warmup : Int = 5

fn mix_u8(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

// FNV-1a over every byte — matches checksumU8 in the zig (all bytes, not strided).
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

fn mk_image(out : Array[Int]) -> Unit {
  let mut s : UInt = 0x1234abcd
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

fn hblur(src : Array[Int], dst : Array[Int]) -> Unit {
  let mut y = 0
  while y < h {
    let row = y * w
    let mut x = 0
    while x < w {
      let mut sr = 0
      let mut sg = 0
      let mut sb = 0
      let mut sa = 0
      let mut k = -r
      while k <= r {
        let mut xi = x + k
        if xi < 0 {
          xi = 0
        } else if xi >= w {
          xi = w - 1
        }
        let p = (row + xi) * 4
        sr = sr + src[p]
        sg = sg + src[p + 1]
        sb = sb + src[p + 2]
        sa = sa + src[p + 3]
        k = k + 1
      }
      let o = (row + x) * 4
      dst[o]     = sr / win
      dst[o + 1] = sg / win
      dst[o + 2] = sb / win
      dst[o + 3] = sa / win
      x = x + 1
    }
    y = y + 1
  }
}

fn vblur(src : Array[Int], dst : Array[Int]) -> Unit {
  let mut y = 0
  while y < h {
    let mut x = 0
    while x < w {
      let mut sr = 0
      let mut sg = 0
      let mut sb = 0
      let mut sa = 0
      let mut k = -r
      while k <= r {
        let mut yi = y + k
        if yi < 0 {
          yi = 0
        } else if yi >= h {
          yi = h - 1
        }
        let p = (yi * w + x) * 4
        sr = sr + src[p]
        sg = sg + src[p + 1]
        sb = sb + src[p + 2]
        sa = sa + src[p + 3]
        k = k + 1
      }
      let o = (y * w + x) * 4
      dst[o]     = sr / win
      dst[o + 1] = sg / win
      dst[o + 2] = sb / win
      dst[o + 3] = sa / win
      x = x + 1
    }
    y = y + 1
  }
}

fn main {
  let img = Array::make(n, 0)
  let tmp = Array::make(n, 0)
  let out = Array::make(n, 0)
  mk_image(img)
  let med = measure(n_warmup, n_runs, fn() {
    hblur(img, tmp)
    vblur(tmp, out)
  })
  let cs = checksum_u8(out)
  print_result(med, cs, w * h, win, n_runs)
}

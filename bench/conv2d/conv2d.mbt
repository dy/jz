// conv2d — fixed-point 2D convolution (NCHW, i8 weights). Ports conv2d.zig.
let cin : Int = 4
let cout : Int = 16
let hh : Int = 34
let ww : Int = 34
let kk : Int = 3
let oh : Int = 34 - 3 + 1  // 32
let ow : Int = 34 - 3 + 1  // 32
let in_len : Int = 4 * 34 * 34      // 4624
let wt_len : Int = 16 * 4 * 3 * 3  // 576
let out_len : Int = 16 * 32 * 32    // 16384
let shift : Int = 11
let n_iters : Int = 24
let n_runs : Int = 21
let n_warmup : Int = 5

fn mix_fn(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

// FNV-1a over every byte of out (u8 values stored as Int).
fn checksum_u8(out : Array[Int]) -> UInt {
  let mut hv : UInt = 0x811c9dc5
  let len = out.length()
  let mut i = 0
  while i < len {
    hv = mix_fn(hv, (out[i] & 0xff).reinterpret_as_uint())
    i = i + 1
  }
  hv
}

// LCG: x = x *% 1103515245 +% 12345; store x >> 24 as signed i8 (-128..127).
// We represent i8 values as Int keeping sign (range -128..127).
fn fill_i8(arr : Array[Int], seed : Int) -> Unit {
  let mut x : UInt = seed.reinterpret_as_uint()
  let len = arr.length()
  let mut i = 0
  while i < len {
    x = x * 1103515245 + 12345
    // x >> 24 as signed i8: take top byte with sign
    let v = x.reinterpret_as_int() >> 24
    arr[i] = v
    i = i + 1
  }
}

fn fill_bias(arr : Array[Int], seed : Int) -> Unit {
  let mut x : UInt = seed.reinterpret_as_uint()
  let len = arr.length()
  let mut i = 0
  while i < len {
    x = x * 1103515245 + 12345
    arr[i] = (x.reinterpret_as_int() >> 20) & 1023
    i = i + 1
  }
}

fn conv(inp : Array[Int], wt : Array[Int], bias : Array[Int], out : Array[Int]) -> Unit {
  let mut oc = 0
  while oc < cout {
    let b = bias[oc]
    let oc_base = oc * oh * ow
    let mut oy = 0
    while oy < oh {
      let mut ox = 0
      while ox < ow {
        let mut acc = b
        let mut ic = 0
        while ic < cin {
          let in_ch = ic * hh * ww
          let w_ch = ((oc * cin) + ic) * kk * kk
          let mut ky = 0
          while ky < kk {
            let irow = in_ch + (oy + ky) * ww + ox
            let wrow = w_ch + ky * kk
            let mut kx = 0
            while kx < kk {
              acc = acc + inp[irow + kx] * wt[wrow + kx]
              kx = kx + 1
            }
            ky = ky + 1
          }
          ic = ic + 1
        }
        let mut q = acc >> shift
        if q < 0 {
          q = 0
        } else if q > 127 {
          q = 127
        }
        out[oc_base + oy * ow + ox] = q
        ox = ox + 1
      }
      oy = oy + 1
    }
    oc = oc + 1
  }
}

fn run_kernel(inp : Array[Int], wt : Array[Int], bias : Array[Int], out : Array[Int]) -> UInt {
  let mut hv : UInt = 0
  let mut it = 0
  while it < n_iters {
    conv(inp, wt, bias, out)
    hv = mix_fn(hv, checksum_u8(out))
    let j = it % in_len
    // inp[j] +%= 1 — wrapping i8 add: keep in -128..127
    let v = inp[j] + 1
    inp[j] = if v > 127 { v - 256 } else { v }
    it = it + 1
  }
  hv
}

fn main {
  let inp = Array::make(in_len, 0)
  let wt = Array::make(wt_len, 0)
  let bias = Array::make(cout, 0)
  let out = Array::make(out_len, 0)

  fill_i8(inp, 0x12345678)
  fill_i8(wt,  0x2bb3c1f7)
  fill_bias(bias, 0x51e3a9d1)

  let mut cs : UInt = 0
  let stages = cout * oh * ow * cin * kk * kk * n_iters

  let med = measure(n_warmup, n_runs, fn() { cs = run_kernel(inp, wt, bias, out) })
  print_result(med, cs, stages, 1, n_runs)
}

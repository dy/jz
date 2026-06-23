// radixsort — LSD radix sort, 4 × 8-bit passes. Ports radixsort.zig.
let n_keys : Int = 1 << 14  // 16384
let radix : Int = 256
let passes : Int = 4
let n_iters : Int = 40
let n_runs : Int = 21
let n_warmup : Int = 5

fn fill_keys(out : Array[UInt]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n_keys {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = s
  }
}

fn radix_sort(src : Array[UInt], tmp : Array[UInt], count : Array[UInt]) -> Unit {
  let mut a = src
  let mut b = tmp
  let mut shift : Int = 0
  for _pass in 0..<passes {
    // zero histogram
    for i in 0..<radix {
      count[i] = 0
    }
    // histogram
    for i in 0..<n_keys {
      let d = ((a[i] >> shift) & 0xff).reinterpret_as_int()
      count[d] = count[d] + 1
    }
    // prefix sum
    let mut sum : UInt = 0
    for i in 0..<radix {
      let c = count[i]
      count[i] = sum
      sum = sum + c
    }
    // scatter
    for i in 0..<n_keys {
      let d = ((a[i] >> shift) & 0xff).reinterpret_as_int()
      b[count[d].reinterpret_as_int()] = a[i]
      count[d] = count[d] + 1
    }
    // ping-pong
    let t = a
    a = b
    b = t
    shift = shift + 8
  }
}

fn run_kernel(a : Array[UInt], base : Array[UInt], tmp : Array[UInt], count : Array[UInt]) -> Unit {
  for it in 0..<n_iters {
    let itu : UInt = it.reinterpret_as_uint()
    for i in 0..<n_keys {
      a[i] = base[i] + itu
    }
    radix_sort(a, tmp, count)
  }
}

fn main {
  let base = Array::make(n_keys, (0 : UInt))
  let a = Array::make(n_keys, (0 : UInt))
  let tmp = Array::make(n_keys, (0 : UInt))
  let count = Array::make(radix, (0 : UInt))
  fill_keys(base)

  let med = measure(n_warmup, n_runs, fn() { run_kernel(a, base, tmp, count) })
  let cs = checksum_u32(a)
  print_result(med, cs, n_keys * n_iters, passes, n_runs)
}

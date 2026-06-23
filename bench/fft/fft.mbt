// FFT — ports fft.zig
let n : Int = 1 << 16
let log2n = 16
let n_runs = 21
let n_warmup = 5

fn sin_poly(x : Double) -> Double {
  let x2 = x * x
  x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))))
}

fn cos_poly(x : Double) -> Double {
  let x2 = x * x
  1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))))
}

fn build_twiddles(wre : Array[Double], wim : Array[Double]) -> Unit {
  let half = n >> 1
  let dt = -6.283185307179586 / n.to_double()
  let c1 = cos_poly(dt)
  let s1 = sin_poly(dt)
  let mut cr = 1.0
  let mut ci = 0.0
  for k in 0..<half {
    wre[k] = cr
    wim[k] = ci
    let nr = cr * c1 - ci * s1
    let ni = cr * s1 + ci * c1
    cr = nr
    ci = ni
  }
}

fn do_fft(re : Array[Double], im : Array[Double], wre : Array[Double], wim : Array[Double]) -> Unit {
  // bit-reverse permutation
  let mut j = 0
  for i in 1..<n {
    let mut bit = n >> 1
    while (j & bit) != 0 {
      j = j ^ bit
      bit = bit >> 1
    }
    j = j ^ bit
    if i < j {
      let tmp_r = re[i]
      re[i] = re[j]
      re[j] = tmp_r
      let tmp_i = im[i]
      im[i] = im[j]
      im[j] = tmp_i
    }
  }
  // butterfly
  let mut len = 2
  while len <= n {
    let half = len >> 1
    let step = n / len
    let mut base = 0
    while base < n {
      let mut k = 0
      for jj in 0..<half {
        let wr = wre[k]
        let wi = wim[k]
        let a = base + jj
        let b = a + half
        let xr = re[b]
        let xi = im[b]
        let tr = wr * xr - wi * xi
        let ti = wr * xi + wi * xr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] = re[a] + tr
        im[a] = im[a] + ti
        k = k + step
      }
      base = base + len
    }
    len = len << 1
  }
}

fn mk_signal(out : Array[Double]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    out[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
  }
}

fn main {
  let sig = Array::make(n, 0.0)
  let re = Array::make(n, 0.0)
  let im = Array::make(n, 0.0)
  let wre = Array::make(n >> 1, 0.0)
  let wim = Array::make(n >> 1, 0.0)
  mk_signal(sig)
  build_twiddles(wre, wim)
  let med = measure_with_setup(
    n_warmup,
    n_runs,
    fn() {
      for i in 0..<n {
        re[i] = sig[i]
        im[i] = 0.0
      }
    },
    fn() { do_fft(re, im, wre, wim) },
  )
  print_result(med, checksum_f64(re), (n * log2n) >> 1, log2n, n_runs)
}

// noise — 2-D Perlin gradient noise (fBm). Ports noise.js/.zig.
let w = 256
let h_dim = 256
let oct = 5
let n_runs = 21

fn build_perm(perm : Array[Int]) -> Unit {
  for i in 0..<256 { perm[i] = i }
  let mut s : UInt = 0x1234abcd
  let mut i = 255
  while i > 0 {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    let j = (s % (i.reinterpret_as_uint() + 1)).to_int()
    let t = perm[i]
    perm[i] = perm[j]
    perm[j] = t
    i = i - 1
  }
  for i in 0..<256 { perm[256 + i] = perm[i] }
}

fn fade(t : Double) -> Double {
  t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(a : Double, b : Double, t : Double) -> Double {
  a + t * (b - a)
}

fn grad(hash : Int, x : Double, y : Double) -> Double {
  let hh = hash & 3
  let u = if (hh & 1) == 0 { x } else { -x }
  let v = if (hh & 2) == 0 { y } else { -y }
  u + v
}

fn perlin(perm : Array[Int], x : Double, y : Double) -> Double {
  let xi = x.floor().to_int()
  let yi = y.floor().to_int()
  let xf = x - xi.to_double()
  let yf = y - yi.to_double()
  let cap_x = xi & 255
  let cap_y = yi & 255
  let u = fade(xf)
  let v = fade(yf)
  let aa = perm[perm[cap_x] + cap_y]
  let ab = perm[perm[cap_x] + cap_y + 1]
  let ba = perm[perm[cap_x + 1] + cap_y]
  let bb = perm[perm[cap_x + 1] + cap_y + 1]
  let x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u)
  let x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u)
  lerp(x1, x2, v)
}

fn fbm(perm : Array[Int], x : Double, y : Double) -> Double {
  let mut sum = 0.0
  let mut amp = 0.5
  let mut freq = 1.0
  for _o in 0..<oct {
    sum = sum + amp * perlin(perm, x * freq, y * freq)
    freq = freq * 2.0
    amp = amp * 0.5
  }
  sum
}

fn render(perm : Array[Int], field : Array[Double]) -> Unit {
  for py in 0..<h_dim {
    let y = py.to_double() * 0.03125
    for px in 0..<w {
      let x = px.to_double() * 0.03125
      field[py * w + px] = fbm(perm, x, y)
    }
  }
}

fn main {
  let perm = Array::make(512, 0)
  let field = Array::make(w * h_dim, 0.0)
  build_perm(perm)
  let med = measure(5, n_runs, fn() { render(perm, field) })
  print_result(med, checksum_f64(field), w * h_dim, oct, n_runs)
}

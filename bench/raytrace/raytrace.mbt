// raytrace — minimal sphere ray tracer. Ports raytrace.js/.zig.
let cap_w = 384
let cap_h = 384
let ns = 8
let n_runs = 21

fn build_scene(
  sx : Array[Double], sy : Array[Double], sz : Array[Double], sr : Array[Double],
  cr : Array[Double], cg : Array[Double], cb : Array[Double],
) -> Unit {
  for i in 0..<ns {
    let fi = i.to_double()
    sx[i] = (i % 3 - 1).to_double() * 2.2
    sy[i] = (i / 3 - 1).to_double() * 1.6
    sz[i] = -5.0 - fi * 1.3
    sr[i] = 0.7 + (i % 4).to_double() * 0.18
    cr[i] = 0.30 + (i % 5).to_double() * 0.14
    cg[i] = 0.25 + (i % 3).to_double() * 0.24
    cb[i] = 0.40 + (i % 7).to_double() * 0.08
  }
}

fn render(
  fb : Array[Double],
  sx : Array[Double], sy : Array[Double], sz : Array[Double], sr : Array[Double],
  cr : Array[Double], cg : Array[Double], cb : Array[Double],
  lx : Double, ly : Double, lz : Double,
) -> Unit {
  for py in 0..<cap_h {
    let sv = 1.0 - (py.to_double() + 0.5) / cap_h.to_double() * 2.0
    for px in 0..<cap_w {
      let su = (px.to_double() + 0.5) / cap_w.to_double() * 2.0 - 1.0
      let mut dx = su
      let mut dy = sv
      let mut dz = -1.0
      let dinv = 1.0 / (dx * dx + dy * dy + dz * dz).sqrt()
      dx = dx * dinv
      dy = dy * dinv
      dz = dz * dinv

      let mut t_best = 1.0e30
      let mut hit = -1
      for s in 0..<ns {
        let ox = -sx[s]
        let oy = -sy[s]
        let oz = -sz[s]
        let b = ox * dx + oy * dy + oz * dz
        let c = ox * ox + oy * oy + oz * oz - sr[s] * sr[s]
        let disc = b * b - c
        if disc > 0.0 {
          let t = -b - disc.sqrt()
          if t > 0.001 && t < t_best {
            t_best = t
            hit = s
          }
        }
      }

      let mut r = 0.0
      let mut gg = 0.0
      let mut bl = 0.0
      if hit >= 0 {
        let hi = hit
        let hx = dx * t_best
        let hy = dy * t_best
        let hz = dz * t_best
        let mut nx = hx - sx[hi]
        let mut ny = hy - sy[hi]
        let mut nz = hz - sz[hi]
        let ninv = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt()
        nx = nx * ninv
        ny = ny * ninv
        nz = nz * ninv
        let mut diff = nx * lx + ny * ly + nz * lz
        if diff < 0.0 { diff = 0.0 }
        let shade = 0.15 + 0.85 * diff
        r = cr[hi] * shade
        gg = cg[hi] * shade
        bl = cb[hi] * shade
      }
      let o = (py * cap_w + px) * 3
      fb[o] = r
      fb[o + 1] = gg
      fb[o + 2] = bl
    }
  }
}

fn main {
  let sx = Array::make(ns, 0.0)
  let sy = Array::make(ns, 0.0)
  let sz = Array::make(ns, 0.0)
  let sr = Array::make(ns, 0.0)
  let cr = Array::make(ns, 0.0)
  let cg = Array::make(ns, 0.0)
  let cb = Array::make(ns, 0.0)
  build_scene(sx, sy, sz, sr, cr, cg, cb)
  let fb = Array::make(cap_w * cap_h * 3, 0.0)
  let llen = 1.0 / (0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5).sqrt()
  let lx = -0.6 * llen
  let ly = 1.0 * llen
  let lz = 0.5 * llen
  let med = measure(5, n_runs, fn() { render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz) })
  print_result(med, checksum_f64(fb), cap_w * cap_h, ns, n_runs)
}

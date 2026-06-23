// mandelbrot escape — f64 escape loop with a data-dependent break.
// Ports mandelbrot.js/.zig; checksum is over the per-pixel iteration counts.
let w = 256

let h = 256

let max_iter = 256

let n_runs = 21

fn render(out : Array[UInt]) -> Unit {
  let x0 = -2.0
  let x1 = 0.5
  let y0 = -1.25
  let y1 = 1.25
  let dx = (x1 - x0) / w.to_double()
  let dy = (y1 - y0) / h.to_double()
  for py in 0..<h {
    let cy = y0 + py.to_double() * dy
    for px in 0..<w {
      let cx = x0 + px.to_double() * dx
      let mut zx = 0.0
      let mut zy = 0.0
      let mut it = 0
      while it < max_iter {
        let x2 = zx * zx
        let y2 = zy * zy
        if x2 + y2 > 4.0 {
          break
        }
        zy = 2.0 * zx * zy + cy
        zx = x2 - y2 + cx
        it = it + 1
      }
      out[py * w + px] = it.reinterpret_as_uint()
    }
  }
}

fn main {
  let out = Array::make(w * h, (0 : UInt))
  let med = measure(5, n_runs, fn() { render(out) })
  print_result(med, checksum_u32(out), w * h, max_iter, n_runs)
}

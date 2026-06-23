// lorenz — ports lorenz.zig (RK4 integration of Lorenz attractor)
let n_samples : Int = 1 << 16
let substeps = 16
let dt : Double = 0.002
let sigma : Double = 10.0
let rho : Double = 28.0
let beta : Double = 8.0 / 3.0
let n_runs = 21
let n_warmup = 5

let xs : Array[Double] = Array::make(1 << 16, 0.0)

fn integrate() -> Unit {
  let h = dt * 0.5
  let sc = dt / 6.0
  let mut x = 0.1
  let mut y = 0.0
  let mut z = 0.0
  for s in 0..<n_samples {
    for _i in 0..<substeps {
      let k1x = sigma * (y - x)
      let k1y = x * (rho - z) - y
      let k1z = x * y - beta * z
      let ax = x + k1x * h
      let ay = y + k1y * h
      let az = z + k1z * h
      let k2x = sigma * (ay - ax)
      let k2y = ax * (rho - az) - ay
      let k2z = ax * ay - beta * az
      let bx = x + k2x * h
      let by = y + k2y * h
      let bz = z + k2z * h
      let k3x = sigma * (by - bx)
      let k3y = bx * (rho - bz) - by
      let k3z = bx * by - beta * bz
      let cx = x + k3x * dt
      let cy = y + k3y * dt
      let cz = z + k3z * dt
      let k4x = sigma * (cy - cx)
      let k4y = cx * (rho - cz) - cy
      let k4z = cx * cy - beta * cz
      x = x + sc * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
      y = y + sc * (k1y + 2.0 * k2y + 2.0 * k3y + k4y)
      z = z + sc * (k1z + 2.0 * k2z + 2.0 * k3z + k4z)
    }
    xs[s] = x + y + z
  }
}

fn main {
  let med = measure(n_warmup, n_runs, fn() { integrate() })
  print_result(med, checksum_f64(xs), n_samples * substeps, substeps, n_runs)
}

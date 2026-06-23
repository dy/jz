// nbody — O(n²) gravitational step, f64 throughout. Re-seeded (untimed) before
// each timed run. Ports nbody.js/.zig; checksum xors the position + x-velocity hashes.
let n = 1024

let steps = 8

let dt = 0.01

let eps2 = 0.05

let n_runs = 21

fn seed(
  px : Array[Double],
  py : Array[Double],
  pz : Array[Double],
  vx : Array[Double],
  vy : Array[Double],
  vz : Array[Double],
  m : Array[Double],
) -> Unit {
  let mut s : UInt = 0x1234abcd
  let r = fn() -> Double {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    s.to_double() / 4294967296.0 * 2.0 - 1.0
  }
  for i in 0..<n {
    px[i] = r()
    py[i] = r()
    pz[i] = r()
    vx[i] = r() * 0.1
    vy[i] = r() * 0.1
    vz[i] = r() * 0.1
    m[i] = r() + 1.5
  }
}

fn step(
  px : Array[Double],
  py : Array[Double],
  pz : Array[Double],
  vx : Array[Double],
  vy : Array[Double],
  vz : Array[Double],
  m : Array[Double],
) -> Unit {
  for i in 0..<n {
    let xi = px[i]
    let yi = py[i]
    let zi = pz[i]
    let mut ax = 0.0
    let mut ay = 0.0
    let mut az = 0.0
    for j in 0..<n {
      let dx = px[j] - xi
      let dy = py[j] - yi
      let dz = pz[j] - zi
      let r2 = dx * dx + dy * dy + dz * dz + eps2
      let inv = 1.0 / (r2 * r2.sqrt())
      let f = m[j] * inv
      ax = ax + dx * f
      ay = ay + dy * f
      az = az + dz * f
    }
    vx[i] = vx[i] + ax * dt
    vy[i] = vy[i] + ay * dt
    vz[i] = vz[i] + az * dt
  }
  for i in 0..<n {
    px[i] = px[i] + vx[i] * dt
    py[i] = py[i] + vy[i] * dt
    pz[i] = pz[i] + vz[i] * dt
  }
}

fn main {
  let px = Array::make(n, 0.0)
  let py = Array::make(n, 0.0)
  let pz = Array::make(n, 0.0)
  let vx = Array::make(n, 0.0)
  let vy = Array::make(n, 0.0)
  let vz = Array::make(n, 0.0)
  let m = Array::make(n, 0.0)
  let med = measure_with_setup(
    5,
    n_runs,
    fn() { seed(px, py, pz, vx, vy, vz, m) },
    fn() { for _s in 0..<steps { step(px, py, pz, vx, vy, vz, m) } },
  )
  print_result(med, checksum_f64(px) ^ checksum_f64(vx), n * n * steps, steps, n_runs)
}

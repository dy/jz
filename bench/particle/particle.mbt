// particle — N-body particle simulation with gravity. Ports particle.js/.zig.
let n_particles = 65536 // 1 << 16
let steps = 256
let dt = 0.015625
let g = -9.8
let n_runs = 21

fn seed_state(
  px : Array[Double],
  py : Array[Double],
  vx : Array[Double],
  vy : Array[Double],
) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n_particles {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    px[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    py[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    vx[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    vy[i] = s.to_double() / 4294967296.0 * 2.0 - 1.0
  }
}

fn step_particles(
  px : Array[Double],
  py : Array[Double],
  vx : Array[Double],
  vy : Array[Double],
) -> Unit {
  for i in 0..<n_particles {
    let nvy = vy[i] + g * dt
    px[i] = px[i] + vx[i] * dt
    py[i] = py[i] + nvy * dt
    vy[i] = nvy
  }
}

fn run_sim(
  px : Array[Double],
  py : Array[Double],
  vx : Array[Double],
  vy : Array[Double],
) -> Unit {
  for _f in 0..<steps {
    step_particles(px, py, vx, vy)
  }
}

fn main {
  let px = Array::make(n_particles, 0.0)
  let py = Array::make(n_particles, 0.0)
  let vx = Array::make(n_particles, 0.0)
  let vy = Array::make(n_particles, 0.0)
  let med = measure_with_setup(
    5,
    n_runs,
    fn() { seed_state(px, py, vx, vy) },
    fn() { run_sim(px, py, vx, vy) },
  )
  let cs = checksum_f64(py) ^ checksum_f64(px)
  print_result(med, cs, n_particles * steps, steps, n_runs)
}

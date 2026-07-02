// Immutable-update particle-step kernel — ports immutable.js
let n = 4096 // particles
let steps = 32 // steps per pass (one fresh record per particle per step)
let lim = 1023 // box bound
let n_runs = 21

// MoonBit structs are heap records — a fresh allocation per step, like the JS
// object literal (reference-counted rather than GC'd).
struct P {
  x : Int
  y : Int
  vx : Int
  vy : Int
}

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
fn init_particles(ps : Array[P]) -> Unit {
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    let vx0 = ((s >> 4) & 15).reinterpret_as_int() - 8
    let vy0 = ((s >> 8) & 15).reinterpret_as_int() - 8
    ps[i] = P::{
      x: ((s >> 12) & 1023).reinterpret_as_int(),
      y: ((s >> 20) & 1023).reinterpret_as_int(),
      vx: if vx0 == 0 { 1 } else { vx0 },
      vy: if vy0 == 0 { 1 } else { vy0 },
    }
  }
}

fn run_kernel(ps : Array[P]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<steps {
    let mut sum = it
    for i in 0..<n {
      let p = ps[i]
      let nx = p.x + p.vx
      let ny = p.y + p.vy
      let hit_x = nx < 0 || nx > lim
      let hit_y = ny < 0 || ny > lim
      let x = if hit_x { p.x } else { nx }
      let y = if hit_y { p.y } else { ny }
      let vx = if hit_x { -p.vx } else { p.vx }
      let vy = if hit_y { -p.vy } else { p.vy }
      ps[i] = P::{ x, y, vx, vy }
      sum = (sum.reinterpret_as_uint() +
        x.reinterpret_as_uint() +
        y.reinterpret_as_uint() * 31).reinterpret_as_int()
    }
    h = mix(h, sum.reinterpret_as_uint())
  }
  h
}

fn main {
  let ps : Array[P] = Array::make(n, P::{ x: 0, y: 0, vx: 1, vy: 1 })
  let mut cs : UInt = 0
  // Fresh particle set per run — the kernel mutates the array, so timing runs
  // must not compound each other's motion.
  for _i in 0..<5 {
    init_particles(ps)
    cs = run_kernel(ps)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    init_particles(ps)
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(ps)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * steps, 1, n_runs)
}

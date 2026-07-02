// Heterogeneous-shape record scan kernel — ports shapes.js
let n = 16384 // 1 << 14, records
let nshapes = 8
let n_iters = 48
let n_runs = 21

// MoonBit's idiomatic answer to heterogeneous records — a payload enum + match.
enum Rec {
  Point(Int, Int) // x, y
  Circle(Int) // r
  Rect(Int, Int) // w, h
  Line(Int, Int, Int, Int) // x0, y0, x1, y1
  Tri(Int, Int, Int) // a, b, c
  Prism(Int, Int, Int) // w, h, d
  Arc(Int, Int) // r, s
  Poly(Int, Int) // n, s
}

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
fn init_rows() -> Array[Rec] {
  let rows = Array::make(n, Point(0, 0))
  let mut s : UInt = 0x1234abcd
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    let k = (s & 7).reinterpret_as_int()
    let a = ((s >> 3) & 1023).reinterpret_as_int()
    let b = ((s >> 13) & 1023).reinterpret_as_int()
    let c = ((s >> 23) & 511).reinterpret_as_int()
    rows[i] = if k == 0 {
      Point(a, b)
    } else if k == 1 {
      Circle(a)
    } else if k == 2 {
      Rect(a, b)
    } else if k == 3 {
      Line(a, b, c, (a ^ b) & 511)
    } else if k == 4 {
      Tri(a, b, c)
    } else if k == 5 {
      Prism(a, b, c)
    } else if k == 6 {
      Arc(a, b)
    } else {
      Poly(c, b)
    }
  }
  rows
}

// One measure per variant — mirrors shapes.js measure() exactly.
// (named measure_rec: the shared bench.mbt helper already owns `measure`)
fn measure_rec(o : Rec) -> Int {
  match o {
    Point(x, y) => x + y
    Circle(r) => r * (r * 3)
    Rect(w, h) => w * h
    Line(x0, y0, x1, y1) => {
      let dx = x1 - x0
      let dy = y1 - y0
      (if dx < 0 { -dx } else { dx }) + (if dy < 0 { -dy } else { dy })
    }
    Tri(a, b, c) => a + b + c
    Prism(w, h, d) => w * h - d
    Arc(r, s) => r * s + r
    Poly(m, s) => m * (s * s)
  }
}

fn run_kernel(rows : Array[Rec]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for it in 0..<n_iters {
    let mut sum : UInt = it.reinterpret_as_uint()
    for i in 0..<n {
      sum = sum + measure_rec(rows[i]).reinterpret_as_uint()
    }
    h = mix(h, sum)
  }
  h
}

fn main {
  let rows = init_rows()
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(rows)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(rows)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, nshapes, n_runs)
}

// shapes.rs — a per-variant measure summed over records of 8 heterogeneous
// shapes, in data-shuffled order. The canonical shape-polymorphism kernel
// (JSON rows, AST nodes, ECS entities, event streams). Rust's idiomatic
// answer to heterogeneous records is a payload-carrying enum + match — the
// static reference for what the dynamic-shape JS source costs. Pure 32-bit
// integer fields, so the sum is bit-identical across every engine and native
// target.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.
use std::time::Instant;

const N: usize = 1 << 14;        // records
const NSHAPES: i32 = 8;          // distinct record shapes
const N_ITERS: usize = 48;       // record-stream passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

enum Rec {
    Point { x: i32, y: i32 },
    Circle { r: i32 },
    Rect { w: i32, h: i32 },
    Line { x0: i32, y0: i32, x1: i32, y1: i32 },
    Tri { a: i32, b: i32, c: i32 },
    Prism { w: i32, h: i32, d: i32 },
    Arc { r: i32, s: i32 },
    Poly { n: i32, s: i32 },
}

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
fn init_rows() -> Vec<Rec> {
    let mut rows = Vec::with_capacity(N);
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for _ in 0..N {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32; // >>> 17 (unsigned right shift)
        s ^= s << 5;
        let u = s as u32;
        let k = s & (NSHAPES - 1);
        let a = ((u >> 3) & 1023) as i32;
        let b = ((u >> 13) & 1023) as i32;
        let c = ((u >> 23) & 511) as i32;
        rows.push(match k {
            0 => Rec::Point { x: a, y: b },
            1 => Rec::Circle { r: a },
            2 => Rec::Rect { w: a, h: b },
            3 => Rec::Line { x0: a, y0: b, x1: c, y1: (a ^ b) & 511 },
            4 => Rec::Tri { a, b, c },
            5 => Rec::Prism { w: a, h: b, d: c },
            6 => Rec::Arc { r: a, s: b },
            _ => Rec::Poly { n: c, s: b },
        });
    }
    rows
}

// One measure per variant — mirrors shapes.js measure() exactly.
fn measure(o: &Rec) -> i32 {
    match o {
        Rec::Point { x, y } => x + y,
        Rec::Circle { r } => r * (r * 3),
        Rec::Rect { w, h } => w * h,
        Rec::Line { x0, y0, x1, y1 } => {
            let dx = x1 - x0;
            let dy = y1 - y0;
            (if dx < 0 { -dx } else { dx }) + (if dy < 0 { -dy } else { dy })
        }
        Rec::Tri { a, b, c } => a + b + c,
        Rec::Prism { w, h, d } => w * h - d,
        Rec::Arc { r, s } => r * s + r,
        Rec::Poly { n, s } => n * (s * s),
    }
}

fn run_kernel(rows: &[Rec]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..N_ITERS {
        let mut sum: i32 = it as i32;
        for o in rows {
            sum = sum.wrapping_add(measure(o));
        }
        h = mix(h, sum as u32);
    }
    h
}

fn main() {
    let rows = init_rows();

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&rows);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&rows);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * N_ITERS,
        NSHAPES,
        N_RUNS
    );
}

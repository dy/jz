// nqueens.rs — bitmask N-Queens solver, counting all solutions for a range of
// board sizes. The canonical backtracking / constraint-search kernel (the shape
// behind SAT solvers, puzzle search, combinatorial enumeration): deep recursion
// with a per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the suite's
// flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// The board sizes are drawn from a runtime XorShift32 array rather than a literal
// loop bound: with literal sizes the whole recursion is a compile-time constant
// that clang/zig fold away (0 µs), making the native lane meaningless. Sourcing
// the size from runtime data is bit-identical across targets but forces every
// engine to actually run the search.
//
// Reports: median ms across N_RUNS, throughput in solutions/µs, FNV-1a checksum
// over the per-query solution counts.
use std::time::Instant;

const NMIN: i32 = 8;
const NSPAN: u32 = 4;
const NQ: usize = 20;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: i32, x: i32) -> i32 {
    (h ^ x).wrapping_mul(0x0100_0193_u32 as i32)
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

// Deterministic per-query board sizes — XorShift32, identical per target. Held in
// a heap Vec (not a fixed-size stack array) so LLVM cannot SCCP-fold the whole
// search to a compile-time constant — clang/zig keep it runtime via the same data
// dependence; rustc's wasm pipeline folds a stack `[i32; NQ]` but not a Vec.
fn fill_sizes(out: &mut [i32]) {
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for q in 0..NQ {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32;
        s ^= s << 5;
        out[q] = NMIN + ((s as u32) % NSPAN) as i32;
    }
}

// Count placements that complete the board. Pure i32 to match JS bitwise semantics.
// avail & -avail: signed negation; d2 >> 1: arithmetic (signed) right shift.
fn solve(all: i32, cols: i32, d1: i32, d2: i32) -> i32 {
    if cols == all { return 1; }
    let mut cnt: i32 = 0;
    let mut avail = all & !(cols | d1 | d2);
    while avail != 0 {
        let b = avail & avail.wrapping_neg();
        avail = avail - b;
        cnt = cnt + solve(all, cols | b, (d1 | b) << 1, (d2 | b) >> 1);
    }
    cnt
}

fn count_n(n: i32) -> i32 {
    solve((1i32 << n) - 1, 0, 0, 0)
}

fn run_kernel(sizes: &[i32]) -> u32 {
    let mut h: i32 = 0x811c9dc5_u32 as i32;
    for q in 0..NQ {
        // black_box keeps the size opaque so rustc/LLVM cannot constant-fold the
        // pure recursion to a literal (the idiomatic Rust microbenchmark guard);
        // clang/zig/jz/V8 keep it runtime via the data dependence alone.
        h = mix(h, count_n(std::hint::black_box(sizes[q])));
    }
    h as u32
}

fn main() {
    let mut sizes = vec![0i32; NQ];
    fill_sizes(&mut sizes);

    let mut total: i64 = 0;
    for q in 0..NQ {
        total += count_n(sizes[q]) as i64;
    }

    let mut cs: u32 = 0;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&sizes);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&sizes);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        total,
        NMIN + NSPAN as i32 - 1,
        N_RUNS
    );
}

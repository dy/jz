// dotprod.rs — multiply-accumulate (dot-product) reductions: the fundamental
// DSP/numeric kernel (correlation, energy, projection, FIR tap-sum). The
// accumulator `s += a[i]*b[i]` is a latency-bound dependency chain — exactly
// where multi-accumulator vectorization (independent partial sums combined at
// the end) earns its keep.
use std::time::Instant;

const N: usize = 8192;
const N_ITERS: usize = 200;
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

fn init(a: &mut [f64], b: &mut [f64]) {
    for i in 0..N {
        a[i] = (i % 13) as f64 - 6.0;
        b[i] = ((i * 7) % 11) as f64 - 5.0;
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0f64;
    for i in 0..N { s += a[i] * b[i]; }
    s
}

fn run_kernel(a: &[f64], b: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for _ in 0..N_ITERS {
        h = mix(h, dot(a, b) as i32 as u32);
    }
    h
}

fn main() {
    let mut a = vec![0.0f64; N];
    let mut b = vec![0.0f64; N];
    init(&mut a, &mut b);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP { cs = run_kernel(&a, &b); }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&a, &b);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N * N_ITERS, 2, N_RUNS
    );
}

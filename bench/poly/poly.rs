use std::time::Instant;

const N: usize = 8192;
const N_ITERS: usize = 80;
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

fn init(f64: &mut [f64], i32: &mut [i32]) {
    for i in 0..N {
        f64[i] = (i % 251) as f64 * 0.25;
        i32[i] = ((i * 17) & 1023) as i32;
    }
}

fn sum_f64(xs: &[f64]) -> f64 {
    let mut s = 0.0;
    for &x in xs { s += x; }
    s
}

fn sum_i32(xs: &[i32]) -> i32 {
    let mut s = 0i32;
    for &x in xs { s += x; }
    s
}

fn run_kernel(f64: &[f64], i32: &[i32]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for _ in 0..N_ITERS {
        h = mix(h, sum_f64(f64) as u32);
        h = mix(h, sum_i32(i32) as u32);
    }
    h
}

fn main() {
    let mut f64 = vec![0.0f64; N];
    let mut i32 = vec![0i32; N];
    init(&mut f64, &mut i32);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP { cs = run_kernel(&f64, &i32); }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&f64, &i32);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N * N_ITERS * 2, 2, N_RUNS
    );
}

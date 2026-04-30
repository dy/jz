use std::time::Instant;

const N: usize = 4096;
const N_ITERS: usize = 128;
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

fn run_kernel(a: &[f64], scale: f64) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut b = vec![0.0f64; N];
    for i in 0..N_ITERS {
        let i_local = i as f64;
        for k in 0..N { b[k] = a[k] * scale + i_local; }
        for j in (0..N).step_by(64) {
            h = mix(h, b[j] as i32 as u32);
        }
    }
    h
}

fn main() {
    let a: Vec<f64> = (0..N).map(|i| (i % 97) as f64 - 48.0).collect();

    let mut cs = 0u32;
    for _ in 0..N_WARMUP { cs = run_kernel(&a, 2.0); }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&a, 2.0);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N * N_ITERS, 1, N_RUNS
    );
}

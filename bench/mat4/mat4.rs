use std::hint::black_box;
use std::time::Instant;

const N_ITERS: usize = 200_000;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for i in (0..out.len() * 2).step_by(256) {
        let bytes = out[i / 2].to_le_bytes();
        let off = (i & 1) * 4;
        let w = u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
        h = mix(h, w);
    }
    h
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

fn init(a: &mut [f64; 16], b: &mut [f64; 16]) {
    for i in 0..16 {
        a[i] = (i as f64 + 1.0) * 0.125;
        b[i] = (16 - i) as f64 * 0.0625;
    }
}

fn multiply_many(a: &mut [f64; 16], b: &[f64; 16], out: &mut [f64; 16], iters: usize) {
    for n in 0..iters {
        let nf = black_box(n) as f64;
        for r in 0..4 {
            for c in 0..4 {
                let mut s = 0.0;
                for k in 0..4 {
                    s += a[r * 4 + k] * b[k * 4 + c];
                }
                out[r * 4 + c] = s + nf * 0.0000001;
            }
        }
        let t = a[0];
        a[0] = out[15];
        a[5] = t + out[10] * 0.000001;
    }
}

fn main() {
    let mut a = [0.0; 16];
    let mut b = [0.0; 16];
    let mut out = [0.0; 16];
    init(&mut a, &mut b);
    for _ in 0..N_WARMUP {
        multiply_many(&mut a, &b, &mut out, N_ITERS);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        init(&mut a, &mut b);
        let t0 = Instant::now();
        multiply_many(&mut a, &b, &mut out, N_ITERS);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        N_ITERS * 16,
        4,
        N_RUNS
    );
}

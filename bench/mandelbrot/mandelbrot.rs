use std::time::Instant;

const W: usize = 256;
const H: usize = 256;
const MAX_ITER: u32 = 256;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const X0: f64 = -2.0;
const X1: f64 = 0.5;
const Y0: f64 = -1.25;
const Y1: f64 = 1.25;

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

fn checksum_u32(xs: &[u32]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0;
    while i < xs.len() { h = mix(h, xs[i]); i += 128; }
    h
}

fn render(out: &mut [u32]) {
    let dx = (X1 - X0) / W as f64;
    let dy = (Y1 - Y0) / H as f64;
    for py in 0..H {
        let cy = Y0 + py as f64 * dy;
        for px in 0..W {
            let cx = X0 + px as f64 * dx;
            let mut zx = 0.0f64;
            let mut zy = 0.0f64;
            let mut i = 0u32;
            while i < MAX_ITER {
                let x2 = zx * zx;
                let y2 = zy * zy;
                if x2 + y2 > 4.0 { break; }
                zy = 2.0 * zx * zy + cy;
                zx = x2 - y2 + cx;
                i += 1;
            }
            out[py * W + px] = i;
        }
    }
}

fn main() {
    let mut out = vec![0u32; W * H];

    for _ in 0..N_WARMUP { render(&mut out); }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        render(&mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_u32(&out),
        W * H,
        MAX_ITER,
        N_RUNS
    );
}

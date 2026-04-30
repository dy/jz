use std::time::Instant;

const N: usize = 16_384;
const N_ITERS: usize = 64;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

#[derive(Clone, Copy)]
struct Row {
    x: f64,
    y: f64,
    z: f64,
}

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

fn init_rows() -> Vec<Row> {
    (0..N)
        .map(|i| Row {
            x: i as f64 * 0.5,
            y: i as f64 + 1.0,
            z: ((i & 7) as i32 - 3) as f64,
        })
        .collect()
}

fn run_kernel(rows: &[Row], xs: &mut [f64], ys: &mut [f64], zs: &mut [f64]) {
    for r in 0..N_ITERS {
        let rf = r as f64;
        for i in 0..rows.len() {
            let p = rows[i];
            xs[i] = p.x + p.y * 0.25 + rf;
            ys[i] = p.y - p.z * 0.5;
            zs[i] = p.z + p.x * 0.125;
        }
    }
}

fn main() {
    let rows = init_rows();
    let mut xs = vec![0.0; N];
    let mut ys = vec![0.0; N];
    let mut zs = vec![0.0; N];
    for _ in 0..N_WARMUP {
        run_kernel(&rows, &mut xs, &mut ys, &mut zs);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run_kernel(&rows, &mut xs, &mut ys, &mut zs);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&xs) ^ checksum_f64(&ys) ^ checksum_f64(&zs);
    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        cs,
        N * N_ITERS,
        3,
        N_RUNS
    );
}

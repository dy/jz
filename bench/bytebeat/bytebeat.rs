use std::time::Instant;

const N: usize = 1 << 21;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum_u8(out: &[u8]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &b in out {
        h = mix(h, b as u32);
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

#[inline]
fn sample(t: u32) -> u32 {
    let v1 = (t.wrapping_mul(5) & (t >> 7)) | (t.wrapping_mul(3) & (t >> 10));
    let v2 = t.wrapping_mul(((t >> 12) | (t >> 8)) & (63 & (t >> 4)));
    v1.wrapping_add(v2) & 255
}

fn render(buf: &mut [u8]) {
    for (t, slot) in buf.iter_mut().enumerate() {
        *slot = sample(t as u32) as u8;
    }
}

fn main() {
    let mut buf = vec![0u8; N];
    for _ in 0..N_WARMUP {
        render(&mut buf);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        render(&mut buf);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_u8(&buf),
        N,
        1,
        N_RUNS
    );
}

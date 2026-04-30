use std::time::Instant;

const N: usize = 65_536;
const N_ROUNDS: usize = 128;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum_u32(out: &[u32]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for i in (0..out.len()).step_by(128) {
        h = mix(h, out[i]);
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

fn init(state: &mut [u32]) {
    let mut s = 0x1234_abcdu32;
    for x in state {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = s;
    }
}

fn run_kernel(state: &mut [u32]) {
    for _ in 0..N_ROUNDS {
        for x in state.iter_mut() {
            let mut v = *x;
            v ^= v << 7;
            v ^= v >> 9;
            v = v.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            *x = v ^ (v >> 16);
        }
    }
}

fn main() {
    let mut state = vec![0u32; N];
    init(&mut state);
    for _ in 0..N_WARMUP {
        init(&mut state);
        run_kernel(&mut state);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        init(&mut state);
        let t0 = Instant::now();
        run_kernel(&mut state);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_u32(&state),
        N * N_ROUNDS,
        3,
        N_RUNS
    );
}

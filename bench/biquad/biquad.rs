use std::time::Instant;

const N_SAMPLES: usize = 480_000;
const N_STAGES: usize = 8;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum(out: &[f64]) -> u32 {
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

fn mk_input(out: &mut [f64]) {
    let mut s = 0x1234_abcdu32;
    for x in out {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4_294_967_296.0) * 2.0 - 1.0;
    }
}

fn mk_coeffs(out: &mut [f64]) {
    for i in 0..N_STAGES {
        out[i * 5] = 0.10 + i as f64 * 0.001;
        out[i * 5 + 1] = 0.20 - i as f64 * 0.0005;
        out[i * 5 + 2] = 0.10;
        out[i * 5 + 3] = -1.50 + i as f64 * 0.01;
        out[i * 5 + 4] = 0.60 - i as f64 * 0.005;
    }
}

fn reset_state(state: &mut [f64]) {
    for x in state {
        *x = 0.0;
    }
}

fn process_cascade(x: &[f64], coeffs: &[f64], state: &mut [f64], out: &mut [f64]) {
    for i in 0..x.len() {
        let mut v = x[i];
        for s in 0..N_STAGES {
            let c = s * 5;
            let sb = s * 4;
            let b0 = coeffs[c];
            let b1 = coeffs[c + 1];
            let b2 = coeffs[c + 2];
            let a1 = coeffs[c + 3];
            let a2 = coeffs[c + 4];
            let x1 = state[sb];
            let x2 = state[sb + 1];
            let y1 = state[sb + 2];
            let y2 = state[sb + 3];
            let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            state[sb] = v;
            state[sb + 1] = x1;
            state[sb + 2] = y;
            state[sb + 3] = y1;
            v = y;
        }
        out[i] = v;
    }
}

fn main() {
    let mut x = vec![0.0; N_SAMPLES];
    let mut coeffs = vec![0.0; N_STAGES * 5];
    let mut state = vec![0.0; N_STAGES * 4];
    let mut out = vec![0.0; N_SAMPLES];
    mk_input(&mut x);
    mk_coeffs(&mut coeffs);

    for _ in 0..N_WARMUP {
        reset_state(&mut state);
        process_cascade(&x, &coeffs, &mut state, &mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        reset_state(&mut state);
        let t0 = Instant::now();
        process_cascade(&x, &coeffs, &mut state, &mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum(&out),
        N_SAMPLES,
        N_STAGES,
        N_RUNS
    );
}

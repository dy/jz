use std::time::Instant;

const SR: f64 = 44100.0;
const N_NOTES: usize = 64;
const NOTE_LEN: usize = 8192;
const N: usize = N_NOTES * NOTE_LEN;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const ATTACK: f64 = 400.0;
const DECAY: f64 = 1600.0;
const RELEASE: f64 = 2400.0;
const NOTE_LEN_F: f64 = 8192.0;
const SUSTAIN: f64 = 0.6;

const B0: f64 = 0.0675;
const B1: f64 = 0.135;
const B2: f64 = 0.0675;
const A1: f64 = -1.143;
const A2: f64 = 0.412;

const FREQS: [f64; 8] = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
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
fn sin_tau(ph: f64) -> f64 {
    let q = ph * 4.0;
    let m = (q + 0.5).floor();
    let phi = (q - m) * 1.5707963267948966;
    let p2 = phi * phi;
    let sp = phi * (1.0 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))));
    let cp = 1.0 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))));
    let r = (m as i32) & 3;
    if r == 0 { sp } else if r == 1 { cp } else if r == 2 { -sp } else { -cp }
}

fn render(out: &mut [f64]) {
    let mut x1 = 0.0;
    let mut x2 = 0.0;
    let mut y1 = 0.0;
    let mut y2 = 0.0;
    for note in 0..N_NOTES {
        let freq = FREQS[(note * 3 + 1) & 7] * if (note >> 2) & 1 != 0 { 2.0 } else { 1.0 };
        let dph = freq / SR;
        let mut ph = 0.0;
        let off = note * NOTE_LEN;
        for t in 0..NOTE_LEN {
            let tf = t as f64;
            let env = if tf < ATTACK {
                tf / ATTACK
            } else if tf < ATTACK + DECAY {
                1.0 - (1.0 - SUSTAIN) * (tf - ATTACK) / DECAY
            } else if tf < NOTE_LEN_F - RELEASE {
                SUSTAIN
            } else {
                (NOTE_LEN_F - tf) / RELEASE * SUSTAIN
            };
            let s = sin_tau(ph) * env;
            ph += dph;
            if ph >= 1.0 {
                ph -= 1.0;
            }
            let y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
            x2 = x1;
            x1 = s;
            y2 = y1;
            y1 = y;
            out[off + t] = y;
        }
    }
}

fn main() {
    let mut out = vec![0.0f64; N];
    for _ in 0..N_WARMUP {
        render(&mut out);
    }
    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        render(&mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }
    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        N,
        N_NOTES,
        N_RUNS
    );
}

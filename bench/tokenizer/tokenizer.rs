use std::time::Instant;

const BASE: &str =
    "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n";
const N_REPEAT: usize = 512;
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

fn is_alpha(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn scan(src: &[u8]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut number = 0u32;
    let mut in_number = false;
    let mut in_ident = false;
    let mut tokens = 0u32;

    for &c in src {
        if c.is_ascii_digit() {
            number = number.wrapping_mul(10).wrapping_add((c - b'0') as u32);
            in_number = true;
        } else {
            if in_number {
                h = mix(h, number);
                tokens += 1;
                number = 0;
                in_number = false;
            }
            if is_alpha(c) {
                if !in_ident {
                    h = mix(h, c as u32);
                    tokens += 1;
                }
                in_ident = true;
            } else {
                if c > 32 {
                    h = mix(h, c as u32);
                    tokens += 1;
                }
                in_ident = false;
            }
        }
    }
    if in_number {
        h = mix(h, number);
        tokens += 1;
    }
    mix(h, tokens)
}

fn main() {
    let src = BASE.repeat(N_REPEAT);
    let bytes = src.as_bytes();
    // Each run scans a slightly shorter prefix so `scan` gets a different input
    // every call — it can't be hoisted out of the timing loop (matches the .js).
    let mut cs = 0u32;
    for i in 0..N_WARMUP {
        cs = scan(&bytes[..bytes.len() - (i & 7)]);
    }

    let mut samples = [0.0; N_RUNS];
    for i in 0..N_RUNS {
        let t0 = Instant::now();
        cs = scan(&bytes[..bytes.len() - (i & 7)]);
        samples[i] = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        cs,
        bytes.len(),
        5,
        N_RUNS
    );
}

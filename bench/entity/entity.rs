// entity.rs — in-place entity update over a Vec of structs. Bit-identical to entity.js.
use std::time::Instant;

const N: usize = 1 << 16;
const STEPS: usize = 256;
const DT: f64 = 0.015625;
const G: f64 = -9.8;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

#[derive(Clone, Copy, Default)]
struct Entity {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

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

fn seed_state(ps: &mut [Entity]) {
    let mut s = 0x1234abcdu32;
    let mut r = || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s as f64) / 4294967296.0 * 2.0 - 1.0
    };
    for p in ps.iter_mut() {
        p.x = r();
        p.y = r();
        p.vx = r();
        p.vy = r();
    }
}

fn step(ps: &mut [Entity]) {
    for p in ps.iter_mut() {
        let nvy = p.vy + G * DT;
        p.x = p.x + p.vx * DT;
        p.y = p.y + nvy * DT;
        p.vy = nvy;
    }
}

fn run(ps: &mut [Entity]) {
    for _ in 0..STEPS {
        step(ps);
    }
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

fn main() {
    let mut ps = vec![Entity::default(); N];

    for _ in 0..N_WARMUP {
        seed_state(&mut ps);
        run(&mut ps);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        seed_state(&mut ps);
        let t0 = Instant::now();
        run(&mut ps);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let px: Vec<f64> = ps.iter().map(|p| p.x).collect();
    let py: Vec<f64> = ps.iter().map(|p| p.y).collect();
    let cs = checksum(&py) ^ checksum(&px);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * STEPS,
        STEPS,
        N_RUNS
    );
}

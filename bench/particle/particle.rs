// particle.rs — fixed-timestep particle integrator. Bit-identical to particle.js.
use std::time::Instant;

const N: usize = 1 << 16;
const STEPS: usize = 256;
const DT: f64 = 0.015625;
const G: f64 = -9.8;
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

fn seed_state(px: &mut [f64], py: &mut [f64], vx: &mut [f64], vy: &mut [f64]) {
    let mut s = 0x1234abcdu32;
    let mut r = || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s as f64) / 4294967296.0 * 2.0 - 1.0
    };
    for i in 0..N {
        px[i] = r();
        py[i] = r();
        vx[i] = r();
        vy[i] = r();
    }
}

fn step(px: &mut [f64], py: &mut [f64], vx: &mut [f64], vy: &mut [f64]) {
    for i in 0..N {
        let nvy = vy[i] + G * DT;
        px[i] = px[i] + vx[i] * DT;
        py[i] = py[i] + nvy * DT;
        vy[i] = nvy;
    }
}

fn run(px: &mut [f64], py: &mut [f64], vx: &mut [f64], vy: &mut [f64]) {
    for _ in 0..STEPS {
        step(px, py, vx, vy);
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
    let mut px = vec![0.0f64; N];
    let mut py = vec![0.0f64; N];
    let mut vx = vec![0.0f64; N];
    let mut vy = vec![0.0f64; N];

    for _ in 0..N_WARMUP {
        seed_state(&mut px, &mut py, &mut vx, &mut vy);
        run(&mut px, &mut py, &mut vx, &mut vy);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        seed_state(&mut px, &mut py, &mut vx, &mut vy);
        let t0 = Instant::now();
        run(&mut px, &mut py, &mut vx, &mut vy);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

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

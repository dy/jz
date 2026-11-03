// quatmul.rs – quaternion products, inverses and normalizations over two
// arrays of quaternions, the fixed-size linear-algebra kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: random/mulberry32.js (create, next, sample), core/quat.js (create,
// multiply, invert) and core/vec4.js normalize, which quat.js re-exports as
// quat::normalize. Each JS module is a Rust module. A quaternion, a
// four-element plain array in the JS, is a [f64; 4]; an array of them a
// Vec<[f64; 4]> filled by push. The functions keep their out-parameter (the
// `return out` meant for chaining is dropped); where the JS passes out as an
// input too (normalize(out, out)), the caller copies it first, which reads what
// the JS reads, since the library loads every input before it writes. Only
// square roots and divisions: every target answers the same bits.
//
// Reports: median ms across N_RUNS, throughput in quaternion products/µs,
// FNV-1a checksum (checksumF64) of the six results: its stride of 128 values
// hashes the low word of the first, the normalized products' running sum.
use std::time::Instant;

const N: usize = 4096;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
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

// pmndrs/math random/mulberry32
mod mulberry32 {
    pub struct State {
        pub a: u32,
    }

    pub fn create(seed: u32) -> State {
        State { a: seed }
    }

    pub fn next(state: &mut State) -> u32 {
        state.a = state.a.wrapping_add(0x6d2b79f5);
        let mut t = state.a;
        t = (t ^ t >> 15).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ t >> 7).wrapping_mul(t | 61));
        t ^ t >> 14
    }

    pub fn sample(state: &mut State) -> f64 {
        next(state) as f64 / 4294967296.0
    }
}

// pmndrs/math core/vec4
mod vec4 {
    pub fn normalize(out: &mut [f64; 4], a: &[f64; 4]) {
        let x = a[0];
        let y = a[1];
        let z = a[2];
        let w = a[3];
        let mut len = x * x + y * y + z * z + w * w;
        if len > 0.0 {
            len = 1.0 / len.sqrt();
        }
        out[0] = x * len;
        out[1] = y * len;
        out[2] = z * len;
        out[3] = w * len;
    }
}

// pmndrs/math core/quat
mod quat {
    pub use super::vec4::normalize;

    pub fn create() -> [f64; 4] {
        [0.0, 0.0, 0.0, 1.0]
    }

    pub fn multiply(out: &mut [f64; 4], a: &[f64; 4], b: &[f64; 4]) {
        let ax = a[0];
        let ay = a[1];
        let az = a[2];
        let aw = a[3];
        let bx = b[0];
        let by = b[1];
        let bz = b[2];
        let bw = b[3];
        out[0] = ax * bw + aw * bx + ay * bz - az * by;
        out[1] = ay * bw + aw * by + az * bx - ax * bz;
        out[2] = az * bw + aw * bz + ax * by - ay * bx;
        out[3] = aw * bw - ax * bx - ay * by - az * bz;
    }

    pub fn invert(out: &mut [f64; 4], a: &[f64; 4]) {
        let a0 = a[0];
        let a1 = a[1];
        let a2 = a[2];
        let a3 = a[3];
        let dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
        if dot == 0.0 {
            out[0] = 0.0;
            out[1] = 0.0;
            out[2] = 0.0;
            out[3] = 0.0;
            return;
        }
        let inv_dot = 1.0 / dot;
        out[0] = -a0 * inv_dot;
        out[1] = -a1 * inv_dot;
        out[2] = -a2 * inv_dot;
        out[3] = a3 * inv_dot;
    }
}

fn make_quats(seed: u32) -> Vec<[f64; 4]> {
    let mut rand = mulberry32::create(seed);
    let mut quats = Vec::new();
    for _ in 0..N {
        let mut q = [
            mulberry32::sample(&mut rand) - 0.5,
            mulberry32::sample(&mut rand) - 0.5,
            mulberry32::sample(&mut rand) - 0.5,
            mulberry32::sample(&mut rand) + 0.5,
        ];
        let v = q;
        quat::normalize(&mut q, &v);
        quats.push(q);
    }
    quats
}

fn run(acc: &mut [f64; 6], a: &[[f64; 4]], b: &[[f64; 4]], out: &mut [f64; 4], inv: &mut [f64; 4]) {
    let mut sm = 0.0;
    let mut si = 0.0;
    for i in 0..N {
        quat::multiply(out, &a[i], &b[i]);
        let v = *out;
        quat::normalize(out, &v);
        sm += out[0] + out[3];
        quat::invert(inv, &a[i]);
        quat::multiply(out, inv, &b[i]);
        si += out[1] + out[2];
    }
    acc[0] = sm;
    acc[1] = si;
    acc[2] = out[0];
    acc[3] = out[1];
    acc[4] = out[2];
    acc[5] = out[3];
}

fn main() {
    let a = make_quats(1);
    let b = make_quats(2);
    let mut out = quat::create();
    let mut inv = quat::create();

    let mut acc = [0.0f64; 6];
    for _ in 0..N_WARMUP {
        run(&mut acc, &a, &b, &mut out, &mut inv);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut acc, &a, &b, &mut out, &mut inv);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&acc),
        N * 2,
        2,
        N_RUNS
    );
}

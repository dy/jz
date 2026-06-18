// heat.rs — 2-D heat diffusion: an explicit-Euler 5-point Laplacian stencil, the
// canonical PDE / scientific-computing kernel. Each interior cell relaxes toward
// its 4 neighbours, updated from a SECOND buffer (dst≠src) with a fixed border
// and no wraparound — the clean neighbour-load shape jz lifts to f64x2 SIMD.
use std::time::Instant;

const W: usize = 258;
const H: usize = 258;
const K: f64 = 0.125;
const STEPS: usize = 100;
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

fn checksum_f64(xs: &[f64]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let n = xs.len();
    // for i in (0..n*2).step_by(256): read u32 at byte offset i*4
    let mut i: usize = 0;
    while i < n * 2 {
        let byte_offset = i * 4;
        let x = unsafe {
            let ptr = (xs.as_ptr() as *const u8).add(byte_offset);
            u32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)])
        };
        h = mix(h, x);
        i += 256;
    }
    h
}

// Deterministic integer field 0..255 (XorShift32), identical per target.
fn seed(a: &mut [f64]) {
    let mut s: u32 = 0x1234_abcd;
    for cell in a.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *cell = (s & 255) as f64;
    }
}

// One diffusion sweep over the interior: dst = src + K·(∇²src).
fn step(src: &[f64], dst: &mut [f64], w: usize, h: usize) {
    for y in 1..h - 1 {
        let row = y * w;
        for x in 1..w - 1 {
            let c = row + x;
            dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4.0 * src[c]);
        }
    }
}

// Ping-pong without reference-swapping: a→b then b→a, STEPS even.
fn run(a: &mut [f64], b: &mut [f64]) {
    let mut s = 0;
    while s < STEPS {
        // step(a, b) then step(b, a) — but we need to pass non-overlapping slices
        // Use raw pointer approach to avoid borrow checker issues with two muts
        unsafe {
            let ap = a.as_mut_ptr();
            let bp = b.as_mut_ptr();
            let len = a.len();
            let a_slice = std::slice::from_raw_parts(ap, len);
            let b_mut = std::slice::from_raw_parts_mut(bp, len);
            step(a_slice, b_mut, W, H);
            let b_slice = std::slice::from_raw_parts(bp, len);
            let a_mut = std::slice::from_raw_parts_mut(ap, len);
            step(b_slice, a_mut, W, H);
        }
        s += 2;
    }
}

fn main() {
    let mut a = vec![0.0f64; W * H];
    let mut b = vec![0.0f64; W * H];
    for _ in 0..N_WARMUP {
        seed(&mut a);
        seed(&mut b);
        run(&mut a, &mut b);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        seed(&mut a);
        seed(&mut b);
        let t0 = Instant::now();
        run(&mut a, &mut b);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&a);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, (W - 2) * (H - 2) * STEPS, 6, N_RUNS
    );
}

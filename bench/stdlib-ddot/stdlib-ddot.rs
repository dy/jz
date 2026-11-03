// stdlib-ddot.rs – BLAS level-1 ddot (the dot product of two strided vectors)
// swept over 4096 calls through @stdlib/blas/base/ddot from stdlib 0.4.1
// (Apache-2.0; Copyright (c) The Stdlib Authors).
//
// Ported as written from the bundle stdlib-ddot.js holds: the strided entry
// point ddot (lib/ddot.js), which turns each stride into a starting offset
// through @stdlib/strided/base/stride2offset, and the kernel it calls,
// ddot_ndarray (lib/ndarray.js), with its offsets, its strides and its
// unit-stride path unrolled by M = 5 after a clean-up loop over N % M.
// Vectors are slices; lengths, strides and offsets are isize, so a negative
// stride walks back from its offset, and each element is indexed as written,
// bounds-checked.
//
// The sweep follows the package's benchmark: two vectors of 1024 values uniform
// in [-100, 100] (XorShift32 from 0x1234abcd and 0x9e3779b9) floored to
// integers, so every product and sum is exact in any order; 4096 calls per run
// at unit strides, the length cycling from 1024 down to 1017; 5 warmup runs,
// the median of 21 timed. Checksum: benchlib checksumF64 over the 4096 dot
// products.
use std::time::Instant;

const N_IN: usize = 1024;
const N_EVAL: usize = 1 << 12;
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

// @stdlib/strided/base/stride2offset
fn stride2offset(n: isize, stride: isize) -> isize {
    if stride > 0 {
        return 0;
    }
    (1 - n) * stride
}

// @stdlib/blas/base/ddot: lib/ndarray.js
const M: isize = 5;

fn ddot_ndarray(n: isize, x: &[f64], stride_x: isize, offset_x: isize, y: &[f64], stride_y: isize, offset_y: isize) -> f64 {
    let mut dot = 0.0;
    if n <= 0 {
        return dot;
    }
    let mut ix = offset_x;
    let mut iy = offset_y;
    if stride_x == 1 && stride_y == 1 {
        let m = n % M;
        if m > 0 {
            for _ in 0..m {
                dot += x[ix as usize] * y[iy as usize];
                ix += 1;
                iy += 1;
            }
        }
        if n < M {
            return dot;
        }
        let mut i = m;
        while i < n {
            dot += x[ix as usize] * y[iy as usize]
                + x[(ix + 1) as usize] * y[(iy + 1) as usize]
                + x[(ix + 2) as usize] * y[(iy + 2) as usize]
                + x[(ix + 3) as usize] * y[(iy + 3) as usize]
                + x[(ix + 4) as usize] * y[(iy + 4) as usize];
            ix += M;
            iy += M;
            i += M;
        }
        return dot;
    }
    for _ in 0..n {
        dot += x[ix as usize] * y[iy as usize];
        ix += stride_x;
        iy += stride_y;
    }
    dot
}

// @stdlib/blas/base/ddot: lib/ddot.js
fn ddot(n: isize, x: &[f64], stride_x: isize, y: &[f64], stride_y: isize) -> f64 {
    if n <= 0 {
        return 0.0;
    }
    let ix = stride2offset(n, stride_x);
    let iy = stride2offset(n, stride_y);
    ddot_ndarray(n, x, stride_x, ix, y, stride_y, iy)
}

// XorShift32, uniform in [lo, hi): deterministic per target.
fn uniform(n: usize, lo: f64, hi: f64, seed: u32) -> Vec<f64> {
    let mut out = vec![0.0f64; n];
    let mut s = seed;
    for v in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *v = lo + (s as f64 / 4294967296.0) * (hi - lo);
    }
    out
}

fn sweep(x: &[f64], y: &[f64], out: &mut [f64]) {
    for i in 0..N_EVAL {
        out[i] = ddot((N_IN - (i & 7)) as isize, x, 1, y, 1);
    }
}

fn main() {
    let mut x = uniform(N_IN, -100.0, 100.0, 0x1234abcd);
    let mut y = uniform(N_IN, -100.0, 100.0, 0x9e3779b9);
    // exact products and sums, whatever the lane order
    for i in 0..N_IN {
        x[i] = x[i].floor();
        y[i] = y[i].floor();
    }
    let mut out = vec![0.0f64; N_EVAL];

    for _ in 0..N_WARMUP {
        sweep(&x, &y, &mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        sweep(&x, &y, &mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        N_EVAL,
        1,
        N_RUNS
    );
}

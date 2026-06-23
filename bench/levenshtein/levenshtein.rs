// levenshtein.rs — Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in DP-cells/µs, FNV-1a checksum
// over the per-iteration distances.
use std::time::Instant;

const LA: usize = 512;
const LB: usize = 512;
const ALPHA: u32 = 8;
const N_ITERS: usize = 8;
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

fn fill(out: &mut [u8], n: usize, seed: u32) {
    let mut s = seed;
    for i in 0..n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = (s % ALPHA) as u8;
    }
}

fn levenshtein(a: &[u8], b: &[u8], prev: &mut [i32]) -> i32 {
    for j in 0..=LB {
        prev[j] = j as i32;
    }
    for i in 1..=LA {
        let mut diag = prev[0];
        prev[0] = i as i32;
        let ai = a[i - 1];
        for j in 1..=LB {
            let up = prev[j];
            let sub = diag + if ai == b[j - 1] { 0 } else { 1 };
            let mut m = up + 1;
            let ins = prev[j - 1] + 1;
            if ins < m { m = ins; }
            if sub < m { m = sub; }
            diag = up;
            prev[j] = m;
        }
    }
    prev[LB]
}

fn run_kernel(a: &mut [u8], b: &[u8], prev: &mut [i32]) -> u32 {
    let mut h = 0x811c9dc5u32;
    for it in 0..N_ITERS {
        let j = it % LA;
        a[j] = ((a[j] as u32 + 1) % ALPHA) as u8;
        h = mix(h, levenshtein(a, b, prev) as u32);
    }
    h
}

fn main() {
    let mut a = vec![0u8; LA];
    let mut b = vec![0u8; LB];
    let mut prev = vec![0i32; LB + 1];
    fill(&mut a, LA, 0x1234abcd);
    fill(&mut b, LB, 0x9e3779b9);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut a, &mut b, &mut prev);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut a, &mut b, &mut prev);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, LA * LB * N_ITERS, 2, N_RUNS
    );
}

// sieve.rs — Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
// number-theory / enumeration kernel: for each prime, a strided inner loop writes
// a composite flag at i², i²+i, i²+2i, … The access pattern is pure strided
// scatter guarded by an outer branch (skip already-composite i), a memory profile
// distinct from the suite's dense contiguous loops. Pure integer, so the sieved
// bitmap is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in numbers/µs, FNV-1a checksum over
// the composite bitmap.
use std::time::Instant;

const LIMIT: usize = 1 << 20;
const N_ITERS: usize = 6;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn checksum_u8(buf: &[u8]) -> u32 {
    let mut h = 0x811c_9dc5u32 as i32;
    for &b in buf {
        h = (h ^ b as i32).wrapping_mul(0x0100_0193u32 as i32);
    }
    h as u32
}

fn sieve(comp: &mut [u8]) {
    for i in 0..LIMIT { comp[i] = 0; }
    comp[0] = 1;
    comp[1] = 1;
    let mut i = 2usize;
    while i * i < LIMIT {
        if comp[i] == 0 {
            let mut j = i * i;
            while j < LIMIT {
                comp[j] = 1;
                j += i;
            }
        }
        i += 1;
    }
}

fn run_kernel(comp: &mut [u8]) {
    for _ in 0..N_ITERS { sieve(comp); }
}

fn main() {
    let mut comp = vec![0u8; LIMIT];

    for _ in 0..N_WARMUP { run_kernel(&mut comp); }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        run_kernel(&mut comp);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_u8(&comp);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        LIMIT * N_ITERS,
        1,
        N_RUNS
    );
}

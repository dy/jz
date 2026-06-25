// hashjoin.rs — probe-dominated relational hash join (build a hash table on a small
// "build" relation, then stream a large "probe" relation through it and sum matched
// payloads). The kernel at the heart of every database and dataframe engine. Pure
// 32-bit integer — the matched-payload sum is bit-identical across every engine and
// native target.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.
use std::time::Instant;

const CAP: usize = 1 << 14;          // slot count (power of two) → mask = CAP-1
const MASK: u32 = (CAP - 1) as u32;
const BUILD: usize = CAP >> 1;       // 8192 build rows → load factor 0.5
const PROBE: usize = 1 << 16;        // 65536 probe rows — probe-dominated
const EMPTY: i32 = -1;               // sentinel; keys forced non-negative so never collide
const N_ITERS: usize = 24;           // build+probe passes per kernel run
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

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
fn fill(out: &mut [i32], seed: i32) {
    let mut s: i32 = seed;
    for i in 0..out.len() {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32;
        s ^= s << 5;
        out[i] = (s as u32 & 0x7fffffff) as i32;
    }
}

fn hash(k: i32) -> usize {
    ((k as u32).wrapping_mul(0x9e3779b1) & MASK) as usize
}

fn insert(keys: &mut [i32], vals: &mut [i32], k: i32, v: i32) {
    let mut h = hash(k);
    loop {
        if keys[h] == EMPTY {
            keys[h] = k;
            vals[h] = v;
            return;
        }
        if keys[h] == k {
            vals[h] = v;
            return;
        }
        h = (h + 1) & (CAP - 1);
    }
}

fn probe(keys: &[i32], vals: &[i32], k: i32) -> i32 {
    let mut h = hash(k);
    loop {
        if keys[h] == EMPTY { return 0; }
        if keys[h] == k { return vals[h]; }
        h = (h + 1) & (CAP - 1);
    }
}

fn run_kernel(keys: &mut [i32], vals: &mut [i32], build: &[i32], probes: &[i32]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..N_ITERS {
        for i in 0..CAP { keys[i] = EMPTY; }
        for i in 0..BUILD {
            insert(keys, vals, build[i], build[i].wrapping_add(it as i32));
        }
        let mut sum: i32 = 0;
        for i in 0..PROBE {
            sum = sum.wrapping_add(probe(keys, vals, probes[i]));
        }
        h = mix(h, sum as u32);
    }
    h
}

fn main() {
    let mut keys = vec![0i32; CAP];
    let mut vals = vec![0i32; CAP];
    let mut build = vec![0i32; BUILD];
    let mut probes = vec![0i32; PROBE];
    fill(&mut build, 0x1234abcd_u32 as i32);
    fill(&mut probes, 0x9e3779b9_u32 as i32);
    for i in (0..PROBE).step_by(2) {
        probes[i] = build[(i >> 1) & (BUILD - 1)];
    }

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut keys, &mut vals, &build, &probes);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut keys, &mut vals, &build, &probes);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, PROBE * N_ITERS, 2, N_RUNS
    );
}

// dict.rs — open-addressing hash table (build + probe) with linear probing. The
// canonical associative-container kernel (symbol tables, dedup, joins, counting):
// a multiply-shift hash scatters keys across a power-of-two slot array, and every
// insert/lookup walks a probe chain of branchy comparisons. It stresses
// scatter writes, dependent-load gather, and unpredictable branches — the
// hash-table shape no other case in the suite covers. Pure 32-bit integer, so the
// looked-up values are bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in ops/µs, FNV-1a checksum over
// the probe results.
use std::time::Instant;

const CAP: usize = 1 << 14;          // slot count (power of two) → mask = CAP-1
const MASK: u32 = (CAP - 1) as u32;
const NKEYS: usize = CAP >> 1;       // 8192 keys → load factor 0.5
const EMPTY: i32 = -1;               // sentinel; keys are forced non-negative so never collide
const N_ITERS: usize = 60;           // build+probe passes per kernel run
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
fn fill(out: &mut [i32]) {
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for i in 0..NKEYS {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32;  // >>> 17 (unsigned right shift)
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

fn lookup(keys: &[i32], vals: &[i32], k: i32) -> i32 {
    let mut h = hash(k);
    loop {
        if keys[h] == EMPTY { return -1; }
        if keys[h] == k { return vals[h]; }
        h = (h + 1) & (CAP - 1);
    }
}

fn run_kernel(keys: &mut [i32], vals: &mut [i32], src: &[i32]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..N_ITERS {
        for i in 0..CAP { keys[i] = EMPTY; }
        for i in 0..NKEYS {
            insert(keys, vals, src[i], src[i].wrapping_add(it as i32));
        }
        for i in 0..NKEYS {
            let v = lookup(keys, vals, src[(i * 7) & (NKEYS - 1)]);
            h = mix(h, v as u32);
        }
    }
    h
}

fn main() {
    let mut keys = vec![0i32; CAP];
    let mut vals = vec![0i32; CAP];
    let mut src = vec![0i32; NKEYS];
    fill(&mut src);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut keys, &mut vals, &src);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut keys, &mut vals, &src);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, NKEYS * N_ITERS, 2, N_RUNS
    );
}

// wordcount.rs — token-frequency counting into a string-keyed hash map, over a
// skewed synthetic word stream. The canonical associative text kernel (word
// counts, tag/label histograms, group-by aggregation). Rust's idiomatic answer
// is HashMap<&str, i32> with the entry API — the static reference for what the
// dynamic-keyed JS object costs. Counts are exact integers, so the probed
// totals are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.
use std::collections::HashMap;
use std::time::Instant;

const NWORDS: usize = 512;       // distinct words in the vocabulary
const N: usize = 1 << 14;        // tokens per pass
const NPROBES: usize = 64;       // fixed lookups folded into the checksum
const N_ITERS: usize = 16;       // passes per kernel run
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

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
fn build_words() -> Vec<String> {
    let mut words = Vec::with_capacity(NWORDS);
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for _ in 0..NWORDS {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32; // >>> 17 (unsigned right shift)
        s ^= s << 5;
        let len = 3 + (((s as u32) >> 8) % 6) as usize;
        let mut w = String::with_capacity(len);
        let mut x = s;
        for j in 0..len {
            x = (x as u32).wrapping_mul(0x9e37_79b1).wrapping_add(j as u32) as i32;
            w.push((97 + (((x as u32) >> 16) % 26) as u8) as char);
        }
        words.push(w);
    }
    words
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
fn fill_tokens(toks: &mut [i32]) {
    let mut s: i32 = 0x2545f491_u32 as i32;
    for i in 0..N {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32;
        s ^= s << 5;
        toks[i] = if s & 8 == 0 { (((s as u32) >> 4) & 15) as i32 } else { (((s as u32) >> 4) & (NWORDS as u32 - 1)) as i32 };
    }
}

fn run_kernel(words: &[String], toks: &[i32], probes: &[String]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for _ in 0..N_ITERS {
        let mut counts: HashMap<&str, i32> = HashMap::new();
        for &t in toks {
            *counts.entry(words[t as usize].as_str()).or_insert(0) += 1;
        }
        for p in probes {
            h = mix(h, *counts.get(p.as_str()).unwrap_or(&0) as u32);
        }
    }
    h
}

fn main() {
    let words = build_words();
    let mut toks = vec![0i32; N];
    fill_tokens(&mut toks);
    // Probe every 8th word plus 8 absent keys — a missing count reads 0.
    let mut probes: Vec<String> = Vec::with_capacity(NPROBES);
    for j in 0..NPROBES - 8 {
        probes.push(words[(j * 8) & (NWORDS - 1)].clone());
    }
    for j in 0..8 {
        probes.push(format!("zz{}", j));
    }

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&words, &toks, &probes);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&words, &toks, &probes);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * N_ITERS,
        NWORDS,
        N_RUNS
    );
}

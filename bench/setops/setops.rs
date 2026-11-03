// setops.rs – near-duplicate detection over tokenized documents with sets:
// each document becomes a set of its words minus the stop words, every word
// joins a vocabulary union, and each document is compared with the eight that
// follow it (intersection by probing, union by inclusion-exclusion, Jaccard in
// thousandths); duplicates pay for a set difference both ways (clone, remove).
// Rust's idiomatic answer is HashSet<&str>; no fold depends on its order.
//
// Reports: median ms across N_RUNS, throughput in documents/µs, FNV-1a
// checksum over the vocabulary size, scores and differences.
use std::collections::HashSet;
use std::time::Instant;

const NWORDS: u32 = 1024;
const NSTOP: usize = 32; // the most common words are stop words
const NDOCS: usize = 256;
const WINDOW: usize = 8; // documents compared after each one
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    // a word index skewed toward common words: the minimum of two uniform draws
    fn pick(&mut self) -> usize {
        let a = self.next() % NWORDS;
        let b = self.next() % NWORDS;
        a.min(b) as usize
    }
}

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

fn build_words(rng: &mut Rng) -> Vec<String> {
    (0..NWORDS).map(|i| {
        let len = 3 + rng.next() % 7;
        let mut w: String = (0..len).map(|_| (97 + rng.next() % 26) as u8 as char).collect();
        w.push_str(&i.to_string());
        w
    }).collect()
}

fn build_docs<'a>(rng: &mut Rng, words: &'a [String]) -> Vec<Vec<&'a str>> {
    let mut docs: Vec<Vec<&str>> = Vec::with_capacity(NDOCS);
    for d in 0..NDOCS {
        let mut doc = Vec::new();
        if d % 8 == 7 {
            for k in 0..docs[d - 1].len() {
                let w = if rng.next() % 10 == 0 { words[rng.pick()].as_str() } else { docs[d - 1][k] };
                doc.push(w);
            }
        } else {
            let len = 24 + rng.next() % 73;
            for _ in 0..len { doc.push(words[rng.pick()].as_str()); }
        }
        docs.push(doc);
    }
    docs
}

fn compare(docs: &[Vec<&str>], stop_words: &[String]) -> (usize, usize, usize, usize) {
    let stop: HashSet<&str> = stop_words.iter().map(|w| w.as_str()).collect();
    let mut vocab: HashSet<&str> = HashSet::new();
    let mut sets: Vec<HashSet<&str>> = Vec::with_capacity(docs.len());
    for doc in docs {
        let mut s = HashSet::new();
        for &w in doc { if !stop.contains(w) { s.insert(w); } }
        for &w in &s { vocab.insert(w); }
        sets.push(s);
    }
    let (mut score, mut dupes, mut diff) = (0, 0, 0);
    for i in 0..sets.len() {
        let a = &sets[i];
        for j in i + 1..(i + WINDOW + 1).min(sets.len()) {
            let b = &sets[j];
            let (small, large) = if a.len() < b.len() { (a, b) } else { (b, a) };
            let inter = small.iter().filter(|w| large.contains(*w)).count();
            let union = a.len() + b.len() - inter;
            let jac = if union == 0 { 0 } else { inter * 1000 / union };
            score += jac;
            if jac >= 600 {
                dupes += 1;
                let mut only_a = a.clone();
                for w in b { only_a.remove(w); }
                let mut only_b = b.clone();
                for w in a { only_b.remove(w); }
                diff += only_a.len() + only_b.len();
            }
        }
    }
    (vocab.len(), score, dupes, diff)
}

fn main() {
    let mut rng = Rng(0x6d2b79f5);
    let words = build_words(&mut rng);
    let docs = build_docs(&mut rng, &words);
    let stop_words = &words[..NSTOP];
    let mut r = (0, 0, 0, 0);
    for _ in 0..N_WARMUP { r = compare(&docs, stop_words); }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        r = compare(&docs, stop_words);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    let cs = mix(mix(mix(mix(0x811c9dc5, r.0 as u32), r.1 as u32), r.2 as u32), r.3 as u32);
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), cs, NDOCS, 3, N_RUNS);
}

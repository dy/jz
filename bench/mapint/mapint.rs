// mapint.rs – graph analytics over sparse integer ids with integer-keyed
// maps: adjacency lists keyed by 30-bit node id, the degree histogram, and a
// breadth-first search per source with its distance map, from four sources.
// Rust's idiomatic answer is HashMap<i32, T> with the entry API. Map folds are
// sums; a search visits neighbors in insertion order, as the JavaScript does.
//
// Reports: median ms across N_RUNS, throughput in edges/µs, FNV-1a checksum
// over the degree histogram and the searches.
use std::collections::HashMap;
use std::time::Instant;

const NODES: u32 = 1 << 12;
const EDGES: usize = 3 * NODES as usize;
const SOURCES: usize = 4;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

struct Result { nodes: usize, degrees: HashMap<usize, u32>, searches: Vec<u32> }

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

// a node number to its id: a bijective scramble of 30 bits
fn id_of(n: u32) -> i32 {
    let mut x = (n + 1).wrapping_mul(0x2c1b3c6d) & 0x3fffffff;
    x ^= x >> 15;
    (x.wrapping_mul(0x297a2d39) & 0x3fffffff) as i32
}

fn build_edges(src: &mut [i32], dst: &mut [i32]) {
    let mut s: u32 = 0x2545f491;
    for i in 0..EDGES {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let a = (s >> 2) & (NODES - 1);
        let mut b = if s & 1 == 0 { (s >> 16) & 1023 } else { (s >> 16) & (NODES - 1) };
        if b == a { b = (a + 1) & (NODES - 1); }
        src[i] = id_of(a);
        dst[i] = id_of(b);
    }
}

fn analyze(src: &[i32], dst: &[i32]) -> Result {
    let mut adj: HashMap<i32, Vec<i32>> = HashMap::new();
    for i in 0..src.len() {
        let (a, b) = (src[i], dst[i]);
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    let mut degrees: HashMap<usize, u32> = HashMap::new();
    for list in adj.values() { *degrees.entry(list.len()).or_insert(0) += 1; }
    let mut searches = Vec::with_capacity(2 * SOURCES);
    let mut queue: Vec<i32> = Vec::with_capacity(NODES as usize);
    for k in 0..SOURCES {
        let root = src[(k * 6151) % src.len()];
        let mut dist: HashMap<i32, u32> = HashMap::new();
        dist.insert(root, 0);
        queue.clear();
        queue.push(root);
        let mut sum = 0u32;
        let mut head = 0;
        while head < queue.len() {
            let v = queue[head];
            head += 1;
            let d = dist[&v] + 1;
            for &w in &adj[&v] {
                if !dist.contains_key(&w) {
                    dist.insert(w, d);
                    sum += d;
                    queue.push(w);
                }
            }
        }
        searches.push(dist.len() as u32);
        searches.push(sum);
    }
    Result { nodes: adj.len(), degrees, searches }
}

fn checksum(r: &Result) -> u32 {
    let mut h = mix(0x811c9dc5, r.nodes as u32);
    let acc = r.degrees.iter().fold(0u32, |a, (&deg, &count)| a.wrapping_add(mix(deg as u32, count)));
    h = mix(mix(h, r.degrees.len() as u32), acc);
    for &x in &r.searches { h = mix(h, x); }
    h
}

fn main() {
    let (mut src, mut dst) = (vec![0i32; EDGES], vec![0i32; EDGES]);
    build_edges(&mut src, &mut dst);
    let mut r = analyze(&src, &dst);
    for _ in 1..N_WARMUP { r = analyze(&src, &dst); }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        r = analyze(&src, &dst); // drops the previous run's maps, as a GC would reclaim them
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(&r), EDGES, 3, N_RUNS);
}

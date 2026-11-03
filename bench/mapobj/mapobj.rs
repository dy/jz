// mapobj.rs – a build tool's pass over a module graph with identity-keyed
// maps: in-degree and reverse edges, Kahn's topological order with each
// module's depth (the longest dependency chain under it), then a deep copy of
// the graph through a memo map that keeps shared dependencies shared and a
// set that counts the distinct copies. Names repeat, so only identity keys the
// tables.
//
// Rust holds the graph as an arena, a Vec<Module> whose dependencies are
// ModuleId indices into it, the way Rust holds a graph without shared
// ownership, and a module's identity is its ModuleId. The case measures side
// tables keyed by identity, so they stay HashMap<ModuleId, T> and
// HashSet<ModuleId> keyed by that index (the deep copy builds its copies into
// a second arena and the memo maps an original's id to its copy's), not Vecs
// indexed by id, which would turn the maps into arrays.
//
// Reports: median ms across N_RUNS, throughput in modules/µs, FNV-1a checksum
// over the order, depths and copy counts. The order is FIFO in module order
// and the reverse edges in insertion order, so the order and depths are fixed;
// the rest are sums.
use std::collections::{HashMap, HashSet};
use std::time::Instant;

const N: usize = 4096; // modules
const ENTRIES: usize = 64; // entry points copied from the end of the order
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const NAMES: [&str; 10] = ["react", "lodash", "util", "core", "events", "buffer", "path", "stream", "zlib", "url"];

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct ModuleId(u32);

impl ModuleId {
    fn ix(self) -> usize {
        self.0 as usize
    }
}

struct Module { id: i32, name: &'static str, size: i32, deps: Vec<ModuleId> }

struct Result { order: Vec<ModuleId>, depth: HashMap<ModuleId, i32>, copies: usize, distinct: usize, bytes: i32 }

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
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

fn build_graph() -> Vec<Module> {
    let mut rng = Rng(0x9e3779b9);
    let mut modules: Vec<Module> = Vec::with_capacity(N);
    for i in 0..N {
        let n_deps = if i == 0 { 0 } else { rng.next() % 5 };
        let deps = (0..n_deps).map(|_| ModuleId(rng.next() % i as u32)).collect();
        let name = NAMES[(rng.next() % NAMES.len() as u32) as usize];
        let size = 100 + (rng.next() % 9900) as i32;
        modules.push(Module { id: i as i32, name, size, deps });
    }
    modules
}

fn copy(m: ModuleId, modules: &[Module], copies: &mut Vec<Module>, memo: &mut HashMap<ModuleId, ModuleId>) -> ModuleId {
    if let Some(&c) = memo.get(&m) { return c; }
    let src = &modules[m.ix()];
    let c = ModuleId(copies.len() as u32);
    copies.push(Module { id: src.id, name: src.name, size: src.size, deps: Vec::with_capacity(src.deps.len()) });
    memo.insert(m, c);
    for &d in &src.deps {
        let dc = copy(d, modules, copies, memo);
        copies[c.ix()].deps.push(dc);
    }
    c
}

fn plan(modules: &[Module]) -> Result {
    let mut indeg: HashMap<ModuleId, i32> = HashMap::new();
    let mut users: HashMap<ModuleId, Vec<ModuleId>> = HashMap::new();
    for (i, m) in modules.iter().enumerate() {
        let id = ModuleId(i as u32);
        indeg.entry(id).or_insert(0);
        for &d in &m.deps {
            *indeg.entry(id).or_insert(0) += 1;
            users.entry(d).or_default().push(id);
        }
    }
    let mut depth: HashMap<ModuleId, i32> = HashMap::new();
    let mut order: Vec<ModuleId> = Vec::new();
    for i in 0..modules.len() {
        let id = ModuleId(i as u32);
        if indeg[&id] == 0 {
            order.push(id);
            depth.insert(id, 0);
        }
    }
    let mut head = 0;
    while head < order.len() {
        let m = order[head];
        head += 1;
        let u = match users.get(&m) { Some(u) => u, None => continue };
        let d = depth[&m] + 1;
        for &v in u {
            let dv = depth.entry(v).or_insert(d);
            if *dv < d { *dv = d; }
            if let Some(left) = indeg.get_mut(&v) {
                *left -= 1;
                if *left == 0 { order.push(v); }
            }
        }
    }
    let mut copies: Vec<Module> = Vec::new();
    let mut memo: HashMap<ModuleId, ModuleId> = HashMap::new();
    let mut seen: HashSet<ModuleId> = HashSet::new();
    let mut stack: Vec<ModuleId> = Vec::new();
    let mut bytes = 0;
    for e in order.len() - ENTRIES..order.len() {
        stack.push(copy(order[e], modules, &mut copies, &mut memo));
        while let Some(c) = stack.pop() {
            if !seen.insert(c) { continue; }
            bytes += copies[c.ix()].size;
            stack.extend_from_slice(&copies[c.ix()].deps);
        }
    }
    Result { order, depth, copies: memo.len(), distinct: seen.len(), bytes }
}

fn checksum(r: &Result, modules: &[Module]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for m in &r.order { h = mix(mix(h, modules[m.ix()].id as u32), r.depth[m] as u32); }
    mix(mix(mix(h, r.copies as u32), r.distinct as u32), r.bytes as u32)
}

fn main() {
    let modules = build_graph();
    let mut r = plan(&modules);
    for _ in 1..N_WARMUP { r = plan(&modules); }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        r = plan(&modules); // drops the previous run's maps, as a GC would reclaim them
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(&r, &modules), N, 3, N_RUNS);
}

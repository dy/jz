// hashjoin.goose: Goose port of hashjoin.js (same build and probe sides,
// passes and checksum): a probe-dominated hash join, build a small
// open-addressing table, stream a large probe side, sum matched payloads.

import bench from "../_lib";

let CAP = 1 << 14;          // slot count (power of two): mask = CAP - 1
let MASK = CAP - 1;
let BUILD = CAP >> 1;       // 8192 build rows: load factor 0.5
let PROBE = 1 << 16;        // 65536 probe rows: probe-dominated (8× build)
let EMPTY = -1;             // sentinel; keys forced non-negative so never collide
let N_ITERS = 24;           // build + probe passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

fn fill_keys(out: i32[:], seed: u32) {
    var s = seed;
    for &k in out {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        k = (s & 0x7fffffff) as i32;
    }
}

fn home(k: i32) -> i64 { (k as! u32 * 0x9e3779b1) & MASK }

fn insert(keys: i32[:], vals: i32[:], k: i32, v: i32) {
    var h = home(k);
    while keys[h] != EMPTY {
        if keys[h] == k { vals[h] = v; return; }
        h = (h + 1) & MASK;
    }
    keys[h] = k;
    vals[h] = v;
}

fn probe(keys: i32[:], vals: i32[:], k: i32) -> i32 {
    var h = home(k);
    while keys[h] != EMPTY {
        if keys[h] == k { return vals[h]; }
        h = (h + 1) & MASK;
    }
    return 0;
}

fn run_kernel(keys: i32[:], vals: i32[:], build: i32[:], probes: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it: i32 in 0..N_ITERS {
        for i in CAP { keys[i] = EMPTY; }       // clear table
        for i in BUILD { insert(keys, vals, build[i], build[i] + it); }
        var sum: u32 = 0;
        for i in PROBE { sum = sum + probe(keys, vals, probes[i]) as! u32; }
        h = mix(h, sum);
    }
    return h;
}

fn main() {
    var keys: i32[>..] = [];
    var vals: i32[>..] = [];
    var build: i32[>..] = [];
    var probes: i32[>..] = [];
    keys.resize(CAP, 0);
    vals.resize(CAP, 0);
    build.resize(BUILD, 0);
    probes.resize(PROBE, 0);
    fill_keys(build, 0x1234abcd);
    fill_keys(probes, 0x9e3779b9);
    var i = 0;
    while i < PROBE {
        probes[i] = build[(i >> 1) & (BUILD - 1)];
        i += 2;
    }
    var cs: u32 = 0;
    for w in N_WARMUP { cs = run_kernel(keys, vals, build, probes); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        cs = run_kernel(keys, vals, build, probes);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), cs, PROBE * N_ITERS, 2, N_RUNS);
}

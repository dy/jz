// dict.goose: Goose port of dict.js (same keys, passes and checksum): an
// open-addressing hash table with linear probing, built and probed per pass.

import bench from "../_lib";

let CAP = 1 << 14;          // slot count (power of two): mask = CAP - 1
let MASK = CAP - 1;
let NKEYS = CAP >> 1;       // 8192 keys: load factor 0.5
let EMPTY = -1;             // sentinel; keys are forced non-negative so never collide
let N_ITERS = 60;           // build + probe passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic positive keys: XorShift32 masked to 31 bits, identical per target.
fn fill(out: i32[:]) {
    var s: u32 = 0x1234abcd;
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

fn lookup(keys: i32[:], vals: i32[:], k: i32) -> i32 {
    var h = home(k);
    while keys[h] != EMPTY {
        if keys[h] == k { return vals[h]; }
        h = (h + 1) & MASK;
    }
    return -1;
}

fn run_kernel(keys: i32[:], vals: i32[:], src: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it: i32 in 0..N_ITERS {
        for i in CAP { keys[i] = EMPTY; }       // clear table
        for i in NKEYS { insert(keys, vals, src[i], src[i] + it); }
        for i in NKEYS {
            let v = lookup(keys, vals, src[(i * 7) & (NKEYS - 1)]);
            h = mix(h, v as! u32);
        }
    }
    return h;
}

fn main() {
    var keys: i32[>..] = [];
    var vals: i32[>..] = [];
    var src: i32[>..] = [];
    keys.resize(CAP, 0);
    vals.resize(CAP, 0);
    src.resize(NKEYS, 0);
    fill(src);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(keys, vals, src); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(keys, vals, src);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, NKEYS * N_ITERS, 2, N_RUNS);
}

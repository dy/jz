// levenshtein.goose: Goose port of levenshtein.js (same strings, passes and
// checksum): edit distance over one rolling row, `diag` carrying the
// upper-left cell across the inner loop.

import bench from "../_lib";

let LA = 512;               // length of string A
let LB = 512;               // length of string B
let ALPHA = 8;              // small alphabet: realistic match/mismatch mix
let N_ITERS = 8;            // distance evaluations per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic strings over a small alphabet: XorShift32, identical per target.
fn fill(out: u8[:], seed: u32) {
    var s = seed;
    for &c in out {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        c = (s % ALPHA) as u8;
    }
}

fn levenshtein(a: u8[:], b: u8[:], prev: i32[:]) -> i32 {
    for j in LB + 1 { prev[j] = j as i32; }
    for i in 1..LA + 1 {
        var diag = prev[0];
        prev[0] = i as i32;
        let ai = a[i - 1];
        for j in 1..LB + 1 {
            let up = prev[j];
            let sub = diag + (if ai == b[j - 1] { 0 } else { 1 });
            var m = up + 1;
            let ins = prev[j - 1] + 1;
            if ins < m { m = ins; }
            if sub < m { m = sub; }
            diag = up;
            prev[j] = m;
        }
    }
    return prev[LB];
}

fn run_kernel(a: u8[:], b: u8[:], prev: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it in N_ITERS {
        let j = it % LA;
        a[j] = (a[j] + 1) % ALPHA;        // perturb so the distance changes and the call can't be hoisted
        h = mix(h, levenshtein(a, b, prev) as! u32);
    }
    return h;
}

fn main() {
    var a: u8[>..] = [];
    var b: u8[>..] = [];
    var prev: i32[>..] = [];
    a.resize(LA, 0);
    b.resize(LB, 0);
    prev.resize(LB + 1, 0);
    fill(a, 0x1234abcd);
    fill(b, 0x9e3779b9);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(a, b, prev); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(a, b, prev);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, LA * LB * N_ITERS, 2, N_RUNS);
}

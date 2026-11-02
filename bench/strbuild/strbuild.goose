// strbuild.goose: Goose port of strbuild.js (same rows, passes and checksum):
// per-record `id,name,value\n` formatting, every byte folded into the hash.
// Each row is a fresh string from str(), built on a data stack and freed when
// the loop body's scope ends.

import bench from "../_lib";

let N = 4096;               // rows per pass
let N_ITERS = 4;            // passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

let NAMES = ["alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel",
             "india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa"];

fn fill(code: i32[:], vals: i32[:]) {
    var s: u32 = 0x1234abcd;
    for i in N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        code[i] = (s & 15) as i32;
        vals[i] = (s as! i32) >> 4;
    }
}

fn run_kernel(code: i32[:], vals: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it in N_ITERS {
        for i in N {
            let line = str(i, ",", NAMES[code[i]], ",", vals[i] + it, "\n");
            for c in line { h = mix(h, c); }
        }
    }
    return h;
}

fn main() {
    var code: i32[>..] = [];
    var vals: i32[>..] = [];
    code.resize(N, 0);
    vals.resize(N, 0);
    fill(code, vals);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(code, vals); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(code, vals);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 3, N_RUNS);
}

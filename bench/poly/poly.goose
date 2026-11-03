// poly.goose: Goose port of poly.js (same arrays, passes and checksum): one
// sum over an f64 array and an i32 array. The JS calls one function with both
// typed arrays; Goose's generic std sum is instantiated once per element type.

import bench from "../_lib";

let N = 8192;
let N_ITERS = 80;
let N_RUNS = 21;
let N_WARMUP = 5;

fn init(f: f64[:], n: i32[:]) {
    for i in N {
        f[i] = (i % 251) * 0.25;
        n[i] = ((i * 17) & 1023) as i32;
    }
}

fn run_kernel(f: f64[:], n: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for i in N_ITERS {
        let a = sum(f);
        let b = sum(n);
        h = mix(h, a as i64 as! u32);
        h = mix(h, b as! u32);
    }
    return h;
}

fn main() {
    var f: f64[>..] = [];
    var n: i32[>..] = [];
    f.resize(N, 0.0);
    n.resize(N, 0);
    init(f, n);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(f, n); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(f, n);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS * 2, 2, N_RUNS);
}

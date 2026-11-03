// dotprod.goose: Goose port of dotprod.js (same vectors, passes and
// checksum): an f64 multiply-accumulate reduction, in source order.

import bench from "../_lib";

let N = 8192;
let N_ITERS = 200;
let N_RUNS = 21;
let N_WARMUP = 5;

fn dot(a: f64[:], b: f64[:]) -> f64 {
    var s = 0.0;
    for i in a.len { s += a[i] * b[i]; }
    return s;
}

fn init(a: f64[:], b: f64[:]) {
    for i in N {
        a[i] = (i % 13) - 6;
        b[i] = ((i * 7) % 11) - 5;
    }
}

fn run_kernel(a: f64[:], b: f64[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for i in N_ITERS { h = mix(h, dot(a, b) as i64 as! u32); }
    return h;
}

fn main() {
    var a: f64[>..] = [];
    var b: f64[>..] = [];
    a.resize(N, 0.0);
    b.resize(N, 0.0);
    init(a, b);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(a, b); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(a, b);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 2, N_RUNS);
}

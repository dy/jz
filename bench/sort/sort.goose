// sort.goose: Goose port of sort.js (same keys, passes and checksum): in-place
// heapsort over an f64 array, refilled from the source before every sort.

import bench from "../_lib";

let N = 8192;
let N_ITERS = 24;
let N_RUNS = 21;
let N_WARMUP = 5;

fn fill(a: f64[:]) {
    var s: u32 = 0x9e3779b9;
    for &x in a {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x = s / 4294967296.0;
    }
}

fn heapsort(a: f64[:]) {
    let n = a.len;
    var root = (n >> 1) - 1;
    while root >= 0 {
        var i = root;
        var child = 2 * i + 1;
        while child < n {
            if child + 1 < n && a[child] < a[child + 1] { child++; }
            if a[i] >= a[child] { break; }
            let t = a[i]; a[i] = a[child]; a[child] = t;
            i = child;
            child = 2 * i + 1;
        }
        root--;
    }
    var end = n - 1;
    while end > 0 {
        let t = a[0]; a[0] = a[end]; a[end] = t;
        var i = 0;
        var child = 1;
        while child < end {
            if child + 1 < end && a[child] < a[child + 1] { child++; }
            if a[i] >= a[child] { break; }
            let u = a[i]; a[i] = a[child]; a[child] = u;
            i = child;
            child = 2 * i + 1;
        }
        end--;
    }
}

fn run_kernel(a: f64[:], src: f64[:]) {
    for it in N_ITERS {
        for i in a.len { a[i] = src[i] + it; }
        heapsort(a);
    }
}

fn main() {
    var src: f64[>..] = [];
    var a: f64[>..] = [];
    src.resize(N, 0.0);
    a.resize(N, 0.0);
    fill(src);
    for i in N_WARMUP { run_kernel(a, src); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        run_kernel(a, src);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(a), N * N_ITERS, 2, N_RUNS);
}

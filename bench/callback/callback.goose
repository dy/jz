// callback.goose: Goose port of callback.js (same array, scale, passes and
// checksum): a callback mapped over an array into a fresh array each pass.
// Goose's map takes the callback as a block and builds the result in place.

import bench from "../_lib";

let N = 4096;
let N_ITERS = 64;
let N_RUNS = 21;
let N_WARMUP = 5;

fn init() -> i64[>..] {
    var a: i64[>..] = [];
    for i in N { a.push((i % 97) - 48); }
    return a;
}

fn run_kernel(a: i64[:], scale: i64) -> u32 {
    var h: u32 = 0x811c9dc5;
    for i in N_ITERS {
        let b = a.map() { it * scale + i };
        for x in b { h = mix(h, x as! u32); }
    }
    return h;
}

fn main() {
    let a = init();
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(a, 2); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(a, 2);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 2, N_RUNS);
}

// sieve.goose: Goose port of sieve.js (same limit, passes and checksum over
// the composite bitmap): comp[k] = 1 if k is composite, 0 if prime.

import bench from "../_lib";

let LIMIT = 1 << 20;
let N_ITERS = 6;
let N_RUNS = 21;
let N_WARMUP = 5;

fn sieve(comp: u8[:]) {
    for i in LIMIT { comp[i] = 0; }
    comp[0] = 1;
    comp[1] = 1;
    var i = 2;
    while i * i < LIMIT {
        if comp[i] == 0 {
            var j = i * i;
            while j < LIMIT {
                comp[j] = 1;
                j += i;
            }
        }
        i++;
    }
}

fn run_kernel(comp: u8[:]) {
    for it in N_ITERS { sieve(comp); }
}

fn main() {
    var comp: u8[>..] = [];
    comp.resize(LIMIT, 0);
    for i in N_WARMUP { run_kernel(comp); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        run_kernel(comp);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u8(comp), LIMIT * N_ITERS, 1, N_RUNS);
}

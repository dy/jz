// bitwise.goose: Goose port of bitwise.js (same xorshift seed, rounds and
// checksum). The state is u32: unsigned arithmetic wraps, as Math.imul does.

import bench from "../_lib";

let N = 65536;
let N_ROUNDS = 128;
let N_RUNS = 21;
let N_WARMUP = 5;

fn init(state: u32[:]) {
    var s: u32 = 0x1234abcd;
    for &x in state {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x = s;
    }
}

fn run_kernel(state: u32[:]) {
    for r in N_ROUNDS {
        for &v in state {
            var x = v;
            x ^= x << 7;
            x ^= x >> 9;
            x = x * 1103515245 + 12345;
            v = x ^ (x >> 16);
        }
    }
}

fn main() {
    var state: u32[>..] = [];
    state.resize(N, 0);
    init(state);
    for i in N_WARMUP { init(state); run_kernel(state); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        init(state);
        let t0 = now_ms();
        run_kernel(state);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u32(state), N * N_ROUNDS, 3, N_RUNS);
}

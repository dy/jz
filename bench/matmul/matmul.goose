// matmul.goose: Goose port of matmul.js (same matrices and checksum): C = A·Bᵀ
// over row-major N x N f64 arrays, the inner loop a contiguous dot product.
// The small-integer inputs keep every sum exact in f64.

import bench from "../_lib";

let N = 256;
let N_RUNS = 21;
let N_WARMUP = 5;

fn init(a: f64[:], bt: f64[:]) {
    for i in N * N {
        a[i] = (i % 13) - 6;
        bt[i] = ((i * 7) % 11) - 5;
    }
}

fn matmul(a: f64[:], bt: f64[:], c: f64[:]) {
    for i in N {
        let ai = i * N;
        for j in N {
            let bj = j * N;
            var s = 0.0;
            for k in N { s += a[ai + k] * bt[bj + k]; }
            c[ai + j] = s;
        }
    }
}

fn main() {
    var a: f64[>..] = [];
    var bt: f64[>..] = [];
    var c: f64[>..] = [];
    a.resize(N * N, 0.0);
    bt.resize(N * N, 0.0);
    c.resize(N * N, 0.0);
    init(a, bt);
    for i in N_WARMUP { matmul(a, bt, c); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        matmul(a, bt, c);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(c), N * N * N, 2, N_RUNS);
}

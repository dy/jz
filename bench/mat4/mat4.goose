// mat4.goose: Goose port of mat4.js (same matrices, iterations and checksum):
// repeated 4x4 f64 matrix products with a feedback tweak per iteration. The
// matrices are fixed f64[16] arrays.

import bench from "../_lib";

let N_ITERS = 200000;
let N_RUNS = 21;
let N_WARMUP = 5;

fn init(a: f64[16]&, b: f64[16]&) {
    for i in 16 {
        a[i] = (i + 1) * 0.125;
        b[i] = (16 - i) * 0.0625;
    }
}

fn multiply_many(a: f64[16]&, b: f64[16]&, out: f64[16]&, iters: i64) {
    for n in iters {
        for r in 4 {
            for c in 4 {
                var s = 0.0;
                for k in 4 { s += a[r * 4 + k] * b[k * 4 + c]; }
                out[r * 4 + c] = s + n * 0.0000001;
            }
        }
        let t = a[0];
        a[0] = out[15];
        a[5] = t + out[10] * 0.000001;
        b[0] += out[0] * 0.00000000001;
        b[5] -= out[5] * 0.00000000001;
    }
}

fn main() {
    var a = [0.0; 16];
    var b = [0.0; 16];
    var out = [0.0; 16];
    init(a, b);
    for i in N_WARMUP { multiply_many(a, b, out, N_ITERS); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        init(a, b);
        let t0 = now_ms();
        multiply_many(a, b, out, N_ITERS);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N_ITERS * 16, 4, N_RUNS);
}

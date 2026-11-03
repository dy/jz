// stdlib-ddot.goose: Goose port of stdlib-ddot.js (same vectors, sweep and
// checksum): @stdlib/blas/base/ddot from stdlib 0.4.1 (Apache-2.0, The Stdlib
// Authors), ported as written: the strided dot product with its offset helper
// and its 5-way unrolled unit-stride path, swept over integer-valued inputs.

import bench from "../_lib";
import math;

let N_IN = 1024;
let N_EVAL = 1 << 12;
let N_RUNS = 21;
let N_WARMUP = 5;
let M = 5;

fn stride2offset(n: i64, stride: i64) -> i64 { if stride > 0 { 0 } else { (1 - n) * stride } }

fn ddot_ndarray(n: i64, x: f64[:], stride_x: i64, offset_x: i64, y: f64[:], stride_y: i64, offset_y: i64) -> f64 {
    var dot = 0.0;
    if n <= 0 { return dot; }
    var ix = offset_x;
    var iy = offset_y;
    if stride_x == 1 && stride_y == 1 {
        let m = n % M;
        if m > 0 {
            for i in m {
                dot += x[ix] * y[iy];
                ix += 1;
                iy += 1;
            }
        }
        if n < M { return dot; }
        var i = m;
        while i < n {
            dot += x[ix] * y[iy] + x[ix + 1] * y[iy + 1] + x[ix + 2] * y[iy + 2] + x[ix + 3] * y[iy + 3] + x[ix + 4] * y[iy + 4];
            ix += M;
            iy += M;
            i += M;
        }
        return dot;
    }
    for i in n {
        dot += x[ix] * y[iy];
        ix += stride_x;
        iy += stride_y;
    }
    return dot;
}

fn ddot(n: i64, x: f64[:], stride_x: i64, y: f64[:], stride_y: i64) -> f64 {
    if n <= 0 { return 0.0; }
    let ix = stride2offset(n, stride_x);
    let iy = stride2offset(n, stride_y);
    return ddot_ndarray(n, x, stride_x, ix, y, stride_y, iy);
}

fn uniform(n: i64, lo: f64, hi: f64, seed: u32) -> f64[>..] {
    var out: f64[>..] = [];
    var s = seed;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push(lo + s / 4294967296.0 * (hi - lo));
    }
    return out;
}

fn main() {
    var x = uniform(N_IN, -100, 100, 0x1234abcd);
    var y = uniform(N_IN, -100, 100, 0x9e3779b9);
    for i in N_IN { x[i] = floor(x[i]); y[i] = floor(y[i]); }   // exact products and sums, whatever the lane order
    var out: f64[>..] = [];
    out.resize(N_EVAL, 0.0);
    fn sweep() { for i in N_EVAL { out[i] = ddot(N_IN - (i & 7), x, 1, y, 1); } }
    for i in N_WARMUP { sweep(); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        sweep();
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N_EVAL, 1, N_RUNS);
}

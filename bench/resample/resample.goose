// resample.goose: Goose port of resample.js (same input, rates and checksum):
// fractional-rate resampling with 4-point Hermite interpolation, up then down.

import bench from "../_lib";

let N = 1 << 16;            // input samples
let STEP_UP = 0.7317314443021356;   // rate < 1: output longer (upsample)
let STEP_DN = 1.3186248722190522;   // rate > 1: output shorter (downsample)
let M_UP = 89000;           // fixed output counts (fit within phase range)
let M_DN = 49000;
let N_ITERS = 5;
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_input(input: f64[:]) {
    var s: u32 = 0x6d2f4b1;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for &v in input { v = rnd() / 4294967296.0 * 2.0 - 1.0; }
}

fn resample_pass(input: f64[:], out: f64[:], m: i64, step: f64) {
    var phase = 1.0;
    for k in m {
        let idx = phase as i64;             // exact truncation: phase stays well below 2^31
        let f = phase - idx;
        let x0 = input[idx - 1];
        let x1 = input[idx];
        let x2 = input[idx + 1];
        let x3 = input[idx + 2];
        let c0 = x1;
        let c1 = 0.5 * (x2 - x0);
        let c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
        let c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
        out[k] = ((c3 * f + c2) * f + c1) * f + c0;
        phase += step;
    }
}

fn run_kernel(input: f64[:], up: f64[:], dn: f64[:]) {
    for it in N_ITERS {
        resample_pass(input, up, M_UP, STEP_UP);
        resample_pass(up, dn, M_DN, STEP_DN);
    }
}

fn main() {
    var input: f64[>..] = [];
    var up: f64[>..] = [];
    var dn: f64[>..] = [];
    input.resize(N, 0.0);
    up.resize(M_UP, 0.0);
    dn.resize(M_DN, 0.0);
    build_input(input);
    for i in N_WARMUP { run_kernel(input, up, dn); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run_kernel(input, up, dn);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(up) ^ checksum_f64(dn), (M_UP + M_DN) * N_ITERS, 2, N_RUNS);
}

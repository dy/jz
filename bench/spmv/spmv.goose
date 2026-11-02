// spmv.goose: Goose port of spmv.js (same CSR structure, values, passes and
// checksum): sparse matrix times vector, the MAC loop gathering x[col[k]].

import bench from "../_lib";

let ROWS = 4096;
let NPR = 16;               // nonzeros per row
let NNZ = ROWS * NPR;
let N_ITERS = 80;           // SpMV passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// A deterministic CSR matrix (fixed nonzeros per row) and dense x, all from
// one XorShift32 stream, so every target gets the same structure and values.
fn build(row_ptr: i32[:], col_idx: i32[:], values: f64[:], x: f64[:]) {
    var s: u32 = 0x1234abcd;
    fn next() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for r in ROWS + 1 { row_ptr[r] = (r * NPR) as i32; }
    for k in NNZ {
        col_idx[k] = (next() % ROWS) as i32;
        values[k] = (next() % 9) - 4.0;            // small int in [-4, 4]
    }
    for &v in x { v = (next() % 7) - 3.0; }        // small int in [-3, 3]
}

fn spmv(row_ptr: i32[:], col_idx: i32[:], values: f64[:], x: f64[:], y: f64[:]) {
    for r in ROWS {
        var sum = 0.0;
        for k in row_ptr[r]..row_ptr[r + 1] { sum += values[k] * x[col_idx[k]]; }
        y[r] = sum;
    }
}

fn run_kernel(row_ptr: i32[:], col_idx: i32[:], values: f64[:], x: f64[:], y: f64[:]) {
    for it in N_ITERS {
        spmv(row_ptr, col_idx, values, x, y);
        for &v in x { v = v + 1; }    // bounded integer drift: each pass distinct, all products exact
    }
}

fn main() {
    var row_ptr: i32[>..] = [];
    var col_idx: i32[>..] = [];
    var values: f64[>..] = [];
    var x: f64[>..] = [];
    var y: f64[>..] = [];
    row_ptr.resize(ROWS + 1, 0);
    col_idx.resize(NNZ, 0);
    values.resize(NNZ, 0.0);
    x.resize(ROWS, 0.0);
    y.resize(ROWS, 0.0);
    build(row_ptr, col_idx, values, x);
    for i in N_WARMUP { build(row_ptr, col_idx, values, x); run_kernel(row_ptr, col_idx, values, x, y); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        build(row_ptr, col_idx, values, x);
        let t0 = now_ms();
        run_kernel(row_ptr, col_idx, values, x, y);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(y), NNZ * N_ITERS, 2, N_RUNS);
}

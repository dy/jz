// spmv.rs — sparse matrix × dense vector in CSR form (y = A·x). The canonical
// sparse-linear-algebra kernel (iterative solvers, PageRank, GNN message passing,
// FEM): the inner loop is a multiply-accumulate whose vector operand is an
// INDIRECT gather x[col[k]] through a column-index array. That data-dependent
// gather — distinct from the suite's contiguous reductions — is the access
// pattern dense codegen handles worst.
//
// Values and x are small integers, so each product and the row sum are exact in
// f64 regardless of summation order or FMA fusion — the result vector is
// bit-identical across every engine and native target (no fma parity class here).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in nonzeros/µs, FNV-1a checksum
// over the result vector.
use std::time::Instant;

const ROWS: usize = 4096;
const NPR: usize = 16;               // nonzeros per row
const NNZ: usize = ROWS * NPR;
const N_ITERS: usize = 80;           // SpMV passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

fn checksum_f64(xs: &[f64]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let n = xs.len();
    let mut i: usize = 0;
    while i < n * 2 {
        let byte_offset = i * 4;
        let x = unsafe {
            let ptr = (xs.as_ptr() as *const u8).add(byte_offset);
            u32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)])
        };
        h = mix(h, x);
        i += 256;
    }
    h
}

fn build(row_ptr: &mut [i32], col_idx: &mut [i32], values: &mut [f64], x: &mut [f64]) {
    let mut s: u32 = 0x1234_abcd;
    let next = |s: &mut u32| -> u32 {
        *s ^= *s << 13;
        *s ^= *s >> 17;
        *s ^= *s << 5;
        *s
    };
    for r in 0..=ROWS {
        row_ptr[r] = (r * NPR) as i32;
    }
    for k in 0..NNZ {
        col_idx[k] = (next(&mut s) % ROWS as u32) as i32;
        values[k] = (next(&mut s) % 9) as f64 - 4.0;   // small int in [-4, 4]
    }
    for i in 0..ROWS {
        x[i] = (next(&mut s) % 7) as f64 - 3.0;        // small int in [-3, 3]
    }
}

fn spmv(row_ptr: &[i32], col_idx: &[i32], values: &[f64], x: &[f64], y: &mut [f64]) {
    for r in 0..ROWS {
        let mut sum = 0.0f64;
        let end = row_ptr[r + 1] as usize;
        for k in row_ptr[r] as usize..end {
            sum += values[k] * x[col_idx[k] as usize];
        }
        y[r] = sum;
    }
}

fn run_kernel(row_ptr: &[i32], col_idx: &[i32], values: &[f64], x: &mut [f64], y: &mut [f64]) {
    for _ in 0..N_ITERS {
        spmv(row_ptr, col_idx, values, x, y);
        for i in 0..ROWS {
            x[i] = x[i] + 1.0;   // bounded integer drift
        }
    }
}

fn main() {
    let mut row_ptr = vec![0i32; ROWS + 1];
    let mut col_idx = vec![0i32; NNZ];
    let mut values = vec![0.0f64; NNZ];
    let mut x = vec![0.0f64; ROWS];
    let mut y = vec![0.0f64; ROWS];

    build(&mut row_ptr, &mut col_idx, &mut values, &mut x);
    for _ in 0..N_WARMUP {
        build(&mut row_ptr, &mut col_idx, &mut values, &mut x);
        run_kernel(&row_ptr, &col_idx, &values, &mut x, &mut y);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        build(&mut row_ptr, &mut col_idx, &mut values, &mut x);
        let t0 = Instant::now();
        run_kernel(&row_ptr, &col_idx, &values, &mut x, &mut y);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&y);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, NNZ * N_ITERS, 2, N_RUNS
    );
}

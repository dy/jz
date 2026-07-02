// dispatch.rs — data-driven dispatch through a table of first-class functions:
// an unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): every step is an
// indirect call through a data-selected function pointer. Pure 32-bit integer,
// so the fold result is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.
use std::time::Instant;

const N: usize = 1 << 14;        // opcode stream length
const NOPS: i32 = 8;             // distinct operators in the table
const N_ITERS: usize = 48;       // stream passes per kernel run
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

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
fn op_add(x: i32, k: i32) -> i32 { x.wrapping_add(k) }
fn op_xor(x: i32, k: i32) -> i32 { x ^ k }
fn op_mul(x: i32, k: i32) -> i32 { x.wrapping_mul(k | 1) }
fn op_rsub(x: i32, k: i32) -> i32 { k.wrapping_sub(x) }
fn op_shr(x: i32, k: i32) -> i32 { x ^ ((x as u32) >> 7) as i32 ^ k }
fn op_m31(x: i32, k: i32) -> i32 { (x << 5).wrapping_sub(x).wrapping_add(k) }
fn op_rot(x: i32, k: i32) -> i32 { ((((x as u32) << 13) | ((x as u32) >> 19)) as i32) ^ k }
fn op_and(x: i32, k: i32) -> i32 { (x & k) ^ ((x as u32) >> 11) as i32 }

const OPS: [fn(i32, i32) -> i32; 8] = [op_add, op_xor, op_mul, op_rsub, op_shr, op_m31, op_rot, op_and];

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
fn fill(code: &mut [i32], ks: &mut [i32]) {
    let mut s: i32 = 0x1234abcd_u32 as i32;
    for i in 0..N {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32; // >>> 17 (unsigned right shift)
        s ^= s << 5;
        code[i] = s & (NOPS - 1);
        ks[i] = s >> 3;
    }
}

fn run_kernel(code: &[i32], ks: &[i32]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for it in 0..N_ITERS {
        let mut x = 0x2545f491_u32.wrapping_add(it as u32) as i32;
        for i in 0..N {
            x = OPS[code[i] as usize](x, ks[i]);
        }
        h = mix(h, x as u32);
    }
    h
}

fn main() {
    let mut code = vec![0i32; N];
    let mut ks = vec![0i32; N];
    fill(&mut code, &mut ks);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&code, &ks);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&code, &ks);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * N_ITERS,
        NOPS,
        N_RUNS
    );
}

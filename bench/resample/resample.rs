// resample.rs — fractional-rate audio resampling with 4-point Hermite (Catmull–Rom)
// interpolation: the workhorse of samplers, time-stretchers and every audio graph that
// meets two clocks. Per output sample: truncate the running phase to an integer tap,
// gather four neighbours at a COMPUTED index, evaluate the cubic, advance phase by an
// irrational-ish step. Two stages (upsample then downsample) exercise both directions.
// The profile: float-derived gather indices + a fractional accumulator — the pattern
// that decides whether a compiler keeps typed loads on the fast path when the index
// comes from float math. Pure + − × ÷, so output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over both stage outputs (f64 bits).
use std::time::Instant;

const N: usize = 1 << 16;                       // input samples
const STEP_UP: f64 = 0.7317314443021356;        // rate < 1: output longer (upsample)
const STEP_DN: f64 = 1.3186248722190522;        // rate > 1: output shorter (downsample)
const M_UP: usize = 89000;                      // fixed output counts (fit within phase range)
const M_DN: usize = 49000;
const N_ITERS: usize = 5;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn checksum_f64(buf: &[f64]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let total = buf.len() * 2;
    let mut i: usize = 0;
    while i < total {
        let bits = buf[i / 2].to_bits();
        let w = if i & 1 == 0 { bits as u32 } else { (bits >> 32) as u32 };
        h = (h ^ w).wrapping_mul(0x0100_0193);
        i += 256;
    }
    h
}

fn build_input(input: &mut [f64]) {
    let mut s: u32 = 0x6d2f4b1;
    for x in input.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4294967296.0) * 2.0 - 1.0;
    }
}

// 4-point, 3rd-order Hermite (Catmull–Rom): y(f) around x1 with neighbours x0..x3
fn resample_pass(input: &[f64], out: &mut [f64], m: usize, step: f64) {
    let mut phase: f64 = 1.0;
    for k in 0..m {
        let idx = phase as i32;    // exact truncation — phase stays well below 2^31
        let f = phase - idx as f64;
        let x0 = input[(idx - 1) as usize];
        let x1 = input[idx as usize];
        let x2 = input[(idx + 1) as usize];
        let x3 = input[(idx + 2) as usize];
        let c0 = x1;
        let c1 = 0.5 * (x2 - x0);
        let c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
        let c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
        out[k] = ((c3 * f + c2) * f + c1) * f + c0;
        phase += step;
    }
}

fn run_kernel(input: &[f64], up: &mut [f64], dn: &mut [f64]) {
    for _ in 0..N_ITERS {
        resample_pass(input, up, M_UP, STEP_UP);
        resample_pass(up, dn, M_DN, STEP_DN);
    }
}

fn main() {
    let mut input = vec![0.0f64; N];
    let mut up = vec![0.0f64; M_UP];
    let mut dn = vec![0.0f64; M_DN];
    build_input(&mut input);

    for _ in 0..N_WARMUP {
        run_kernel(&input, &mut up, &mut dn);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run_kernel(&input, &mut up, &mut dn);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let h = checksum_f64(&up) ^ checksum_f64(&dn);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        h,
        (M_UP + M_DN) * N_ITERS,
        2,
        N_RUNS
    );
}

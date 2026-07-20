// delayline.rs — modulated feedback comb (flanger/chorus core) through a power-of-two
// ring buffer: the delay-line pattern under every reverb, echo and physical model. Per
// sample: an integer-LFO (triangle from a wrapping phase accumulator) sets a fractional
// delay; two taps are read at (head − d) & MASK and linearly interpolated; the feedback
// sum is written back at head & MASK. The profile: wrap-masked indexing the compiler
// must strength-reduce, a genuine loop-carried feedback (unsoftenable — it IS the
// filter), and integer→float fraction splits. The LFO fraction is q16 (÷65536), so
// every operation is exactly rounded and output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the wet output (f64 bits).
use std::time::Instant;

const N: usize = 1 << 17;    // samples per pass
const RB: usize = 1 << 14;   // ring size
const MASK: u32 = (RB - 1) as u32;
const DMIN: u32 = 96;        // delay range, samples
const DSPAN: u32 = 2000;
const N_ITERS: usize = 4;
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
    let mut s: u32 = 0x3c91e57;
    for x in input.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4294967296.0) * 2.0 - 1.0;
    }
}

fn run_pass(input: &[f64], out: &mut [f64], ring: &mut [f64], fb: f64, lfo_step: u32) {
    for x in ring.iter_mut() {
        *x = 0.0;
    }
    let mut head: u32 = 0;
    let mut lfo: u32 = 0;
    for i in 0..N {
        lfo = lfo.wrapping_add(lfo_step);
        let raw = lfo & 0x1ffff;                                  // 17-bit phase
        let tri = if raw < 0x10000 { raw } else { 0x20000 - raw }; // triangle 0..0x10000
        let dq = DMIN * 65536 + tri * DSPAN;                       // delay in q16 samples
        let d_int = dq / 65536;
        let d_frac = (dq - d_int * 65536) as f64 / 65536.0;        // exact: ÷2^16
        let i0 = head.wrapping_sub(d_int) & MASK;
        let i1 = head.wrapping_sub(d_int).wrapping_sub(1) & MASK;
        let tap = ring[i0 as usize] + (ring[i1 as usize] - ring[i0 as usize]) * d_frac;
        let y = input[i] + tap * fb;
        ring[(head & MASK) as usize] = y;
        head = head.wrapping_add(1);
        out[i] = y;
    }
}

fn run_kernel(input: &[f64], out: &mut [f64], ring: &mut [f64]) {
    for it in 0..N_ITERS {
        run_pass(input, out, ring, 0.6 + it as f64 * 0.05, 977 + it as u32 * 131);
    }
}

fn main() {
    let mut input = vec![0.0f64; N];
    let mut out = vec![0.0f64; N];
    let mut ring = vec![0.0f64; RB];
    build_input(&mut input);

    for _ in 0..N_WARMUP {
        run_kernel(&input, &mut out, &mut ring);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run_kernel(&input, &mut out, &mut ring);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_f64(&out),
        N * N_ITERS,
        N_ITERS,
        N_RUNS
    );
}

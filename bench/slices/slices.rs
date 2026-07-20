// slices.rs — block processing over RUNTIME SUB-VIEWS of one arena: every audio engine's
// inner life (mix busses, voice blocks, delay taps) and every font table walk. Each block
// reads input at arena[inOff + i] and accumulates into a bus at arena[busOff + i], where
// both offsets are runtime values from a schedule — the compiler must hoist the bases out
// of the loop (LLVM does it without blinking). A compiler that re-derives base + i per
// access, or falls off its typed-address fast path because the base is a variable, loses
// this case by an order of magnitude. One-pole smoothing keeps a loop-carried scalar in
// flight so the loop is real DSP, not a memcpy.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the bus (f64 bits).
use std::time::Instant;

const N: usize = 1 << 18;    // arena halves: input signal + mix bus
const NB: usize = 4096;      // scheduled blocks per pass
const N_ITERS: usize = 3;    // passes per kernel run
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

// deterministic schedule + input (xorshift32, the suite's idiom)
fn build_world(input: &mut [f64], bus: &mut [f64], in_off: &mut [i32], bus_off: &mut [i32], len: &mut [i32]) {
    let mut s: u32 = 0x2f6e2b1;
    let next = |s: &mut u32| -> u32 {
        *s ^= *s << 13;
        *s ^= *s >> 17;
        *s ^= *s << 5;
        *s
    };
    for i in 0..N {
        input[i] = (next(&mut s) as f64 / 4294967296.0) * 2.0 - 1.0;
    }
    for i in 0..N {
        bus[i] = 0.0;
    }
    for b in 0..NB {
        let l = 64 + (next(&mut s) % 257) as i32;      // 64..320 samples per block
        len[b] = l;
        in_off[b] = (next(&mut s) % (N as u32 - l as u32)) as i32;
        bus_off[b] = (next(&mut s) % (N as u32 - l as u32)) as i32;
    }
}

// one pass: every block smooths its input view and accumulates into its bus view
fn run_pass(input: &[f64], bus: &mut [f64], in_off: &[i32], bus_off: &[i32], len: &[i32], gain: f64) {
    for b in 0..NB {
        let io = in_off[b] as usize;
        let bo = bus_off[b] as usize;
        let l = len[b] as usize;
        let mut sm = 0.0f64;
        for i in 0..l {
            sm = sm * 0.995 + input[io + i] * 0.005;
            bus[bo + i] = bus[bo + i] + sm * gain;
        }
    }
}

fn run_kernel(input: &[f64], bus: &mut [f64], in_off: &[i32], bus_off: &[i32], len: &[i32]) {
    for it in 0..N_ITERS {
        run_pass(input, bus, in_off, bus_off, len, 0.25 + it as f64 * 0.125);
    }
}

fn main() {
    let mut input = vec![0.0f64; N];
    let mut bus = vec![0.0f64; N];
    let mut in_off = vec![0i32; NB];
    let mut bus_off = vec![0i32; NB];
    let mut len = vec![0i32; NB];
    build_world(&mut input, &mut bus, &mut in_off, &mut bus_off, &mut len);

    for _ in 0..N_WARMUP {
        run_kernel(&input, &mut bus, &in_off, &bus_off, &len);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run_kernel(&input, &mut bus, &in_off, &bus_off, &len);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_f64(&bus),
        NB * N_ITERS,
        N_ITERS,
        N_RUNS
    );
}

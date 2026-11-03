// delayline.goose: Goose port of delayline.js (same input, LFO, feedback and
// checksum): a modulated feedback comb through a power-of-two ring, the delay
// split into an integer tap and a q16 fraction.

import bench from "../_lib";

let N = 1 << 17;            // samples per pass
let RB = 1 << 14;           // ring size
let MASK = RB - 1;
let DMIN = 96;              // delay range, samples
let DSPAN = 2000;
let N_ITERS = 4;
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_input(input: f64[:]) {
    var s: u32 = 0x3c91e57;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for &v in input { v = rnd() / 4294967296.0 * 2.0 - 1.0; }
}

fn run_pass(input: f64[:], out: f64[:], ring: f64[:], fb: f64, lfo_step: u32) {
    for &r in ring { r = 0.0; }
    var head = 0;
    var lfo: u32 = 0;
    for i in N {
        lfo = lfo + lfo_step;
        let raw = lfo & 0x1ffff;                            // 17-bit phase
        let tri = if raw < 0x10000 { raw } else { 0x20000 - raw };   // triangle 0..0x10000
        let dq = DMIN * 65536 + tri * DSPAN;               // delay in q16 samples
        let d_int = dq / 65536;
        let d_frac = (dq - d_int * 65536) / 65536.0;       // exact: ÷2^16
        let i0 = (head - d_int) & MASK;
        let i1 = (head - d_int - 1) & MASK;
        let tap = ring[i0] + (ring[i1] - ring[i0]) * d_frac;
        let y = input[i] + tap * fb;
        ring[head & MASK] = y;
        head = head + 1;
        out[i] = y;
    }
}

fn run_kernel(input: f64[:], out: f64[:], ring: f64[:]) {
    for it in N_ITERS { run_pass(input, out, ring, 0.6 + it * 0.05, (977 + it * 131) as u32); }
}

fn main() {
    var input: f64[>..] = [];
    var out: f64[>..] = [];
    var ring: f64[>..] = [];
    input.resize(N, 0.0);
    out.resize(N, 0.0);
    ring.resize(RB, 0.0);
    build_input(input);
    for i in N_WARMUP { run_kernel(input, out, ring); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        run_kernel(input, out, ring);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N * N_ITERS, N_ITERS, N_RUNS);
}

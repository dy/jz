// slices.goose: Goose port of slices.js (same arena, schedule, gains and
// checksum): block processing over runtime sub-ranges of one input and one
// bus, each block a one-pole smoother mixed into the bus at an offset.

import bench from "../_lib";

let N = 1 << 18;            // arena halves: input signal + mix bus
let NB = 4096;              // scheduled blocks per pass
let N_ITERS = 3;            // passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_world(input: f64[:], bus: f64[:], in_off: i32[:], bus_off: i32[:], len: i32[:]) {
    var s: u32 = 0x2f6e2b1;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for &v in input { v = rnd() / 4294967296.0 * 2.0 - 1.0; }
    for &v in bus { v = 0.0; }
    for b in NB {
        let l = 64 + rnd() % 257;           // 64..320 samples per block
        len[b] = l as i32;
        in_off[b] = (rnd() % (N - l)) as i32;
        bus_off[b] = (rnd() % (N - l)) as i32;
    }
}

fn run_pass(input: f64[:], bus: f64[:], in_off: i32[:], bus_off: i32[:], len: i32[:], gain: f64) {
    for b in NB {
        let io = in_off[b];
        let bo = bus_off[b];
        let l = len[b];
        var sm = 0.0;
        for i in l {
            sm = sm * 0.995 + input[io + i] * 0.005;
            bus[bo + i] = bus[bo + i] + sm * gain;
        }
    }
}

fn run_kernel(input: f64[:], bus: f64[:], in_off: i32[:], bus_off: i32[:], len: i32[:]) {
    for it in N_ITERS { run_pass(input, bus, in_off, bus_off, len, 0.25 + it * 0.125); }
}

fn main() {
    var input: f64[>..] = [];
    var bus: f64[>..] = [];
    var in_off: i32[>..] = [];
    var bus_off: i32[>..] = [];
    var len: i32[>..] = [];
    input.resize(N, 0.0);
    bus.resize(N, 0.0);
    in_off.resize(NB, 0);
    bus_off.resize(NB, 0);
    len.resize(NB, 0);
    build_world(input, bus, in_off, bus_off, len);
    for i in N_WARMUP { run_kernel(input, bus, in_off, bus_off, len); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run_kernel(input, bus, in_off, bus_off, len);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(bus), NB * N_ITERS, N_ITERS, N_RUNS);
}

// movavg.goose: Goose port of movavg.js (same input, window and checksum): a
// running-sum boxcar over a ring of N_WINDOW doubles, the sum recomputed once
// per lap. The library's state bag becomes a ring zeroed before each run, as
// in the C port.

import bench from "../_lib";

let N_SAMPLES = 480000;     // 10 s @ 48 kHz mono
let N_WINDOW = 16;
let N_RUNS = 21;
let N_WARMUP = 5;

fn mk_input(n: i64) -> f64[>..] {
    var out: f64[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push(s / 4294967296.0 * 2 - 1);
    }
    return out;
}

fn moving_average(data: f64[:], mem: f64[:]) {
    let m = mem.len;
    var ptr = 0;
    var sum = 0.0;
    for v in mem { sum += v; }
    for &d in data {
        sum += d - mem[ptr];
        mem[ptr] = d;
        ptr = (ptr + 1) % m;
        d = sum / m;
        if ptr == 0 {
            sum = 0.0;
            for v in mem { sum += v; }
        }
    }
}

fn main() {
    let x = mk_input(N_SAMPLES);
    var data: f64[>..] = [];
    data.resize(N_SAMPLES, 0.0);
    var mem = [0.0; N_WINDOW];
    for i in N_WARMUP {
        copy_into(data, x);
        mem = [0.0; N_WINDOW];
        moving_average(data, mem);
    }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        copy_into(data, x);
        mem = [0.0; N_WINDOW];
        let t0 = now_ms();
        moving_average(data, mem);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(data), N_SAMPLES, N_WINDOW, N_RUNS);
}

// sosfilter.goose: Goose port of sosfilter.js (same input, sections and
// checksum): an 8-section biquad cascade in Direct Form II Transposed. The
// library's records become inline structs and its lazily made state a struct
// array zeroed before each run, as in the C port.

import bench from "../_lib";

let N_SAMPLES = 480000;     // 10 s @ 48 kHz mono
let N_STAGES = 8;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Sos { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64 }
struct State { z0: f64, z1: f64 }

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

fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Sos {
    Sos { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

fn design(sos: Sos[N_STAGES]&) {
    for &c, i in sos { c = norm(0.10 + i * 0.001, 0.20 - i * 0.0005, 0.10, 1.0, -1.50 + i * 0.01, 0.60 - i * 0.005); }
}

fn filter(data: f64[:], coefs: Sos[N_STAGES]&, state: State[N_STAGES]&) {
    for &d in data {
        var x = d;
        for j in N_STAGES {
            let c = coefs[j];
            let y = c.b0 * x + state[j].z0;
            state[j].z0 = c.b1 * x - c.a1 * y + state[j].z1;
            state[j].z1 = c.b2 * x - c.a2 * y;
            x = y;
        }
        d = x;
    }
}

fn main() {
    let x = mk_input(N_SAMPLES);
    var data: f64[>..] = [];
    data.resize(N_SAMPLES, 0.0);
    var coefs = [default<Sos>(); N_STAGES];
    design(coefs);
    var state = [default<State>(); N_STAGES];
    for i in N_WARMUP {
        copy_into(data, x);
        state = [default<State>(); N_STAGES];
        filter(data, coefs, state);
    }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        copy_into(data, x);
        state = [default<State>(); N_STAGES];
        let t0 = now_ms();
        filter(data, coefs, state);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(data), N_SAMPLES, N_STAGES, N_RUNS);
}

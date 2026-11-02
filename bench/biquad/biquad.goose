// biquad.goose: Goose port of biquad.js (same input, coefficients and
// checksum): an 8-stage biquad cascade per sample. Each stage's coefficients
// and state are inline records, the same bytes as the JS flat layout.

import bench from "../_lib";

let N_SAMPLES = 480000;     // 10 s @ 48 kHz mono
let N_STAGES = 8;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Coeffs { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64 }
struct State { x1: f64, x2: f64, y1: f64, y2: f64 }

// XorShift32: deterministic per target. Output is in [-1, 1).
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

// Stable lowpass-ish coefficients varied per stage so the cascade cannot fold.
fn mk_coeffs(out: Coeffs[N_STAGES]&) {
    for &c, i in out {
        c = Coeffs { b0: 0.10 + i * 0.001, b1: 0.20 - i * 0.0005, b2: 0.10,
                     a1: -1.50 + i * 0.01, a2: 0.60 - i * 0.005 };
    }
}

fn process_cascade(x: f64[:], coeffs: Coeffs[N_STAGES]&, state: State[N_STAGES]&, out: f64[:]) {
    for i in x.len {
        var v = x[i];
        for s in N_STAGES {
            let c = coeffs[s];
            let st = state[s];
            let y = c.b0 * v + c.b1 * st.x1 + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2;
            state[s] = State { x1: v, x2: st.x1, y1: y, y2: st.y1 };
            v = y;
        }
        out[i] = v;
    }
}

fn main() {
    let x = mk_input(N_SAMPLES);
    var coeffs: Coeffs[N_STAGES] = [default<Coeffs>(); N_STAGES];
    mk_coeffs(coeffs);
    var state: State[N_STAGES] = [default<State>(); N_STAGES];
    var out: f64[>..] = [];
    out.resize(N_SAMPLES, 0.0);

    for i in N_WARMUP {
        state = [default<State>(); N_STAGES];
        process_cascade(x, coeffs, state, out);
    }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        state = [default<State>(); N_STAGES];
        let t0 = now_ms();
        process_cascade(x, coeffs, state, out);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N_SAMPLES, N_STAGES, N_RUNS);
}

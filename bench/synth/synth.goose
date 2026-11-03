// synth.goose: Goose port of synth.js (same notes, envelope, filter and
// checksum): polynomial oscillator, ADSR envelope and a biquad per sample, the
// filter state carried across notes.

import bench from "../_lib";
import math;

let SR = 44100;
let N_NOTES = 64;
let NOTE_LEN = 8192;
let N = N_NOTES * NOTE_LEN; // 524288 samples (~11.9 s @ 44.1 kHz)
let N_RUNS = 21;
let N_WARMUP = 5;

let ATTACK = 400;
let DECAY = 1600;
let RELEASE = 2400;
let SUSTAIN = 0.6;
let B0 = 0.0675;
let B1 = 0.135;
let B2 = 0.0675;
let A1 = -1.143;
let A2 = 0.412;
let FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];

// sin(2π·ph) from a quarter-wave Taylor polynomial: no libm sine.
fn sin_tau(ph: f64) -> f64 {
    let q = ph * 4;
    let m = floor(q + 0.5);
    let phi = (q - m) * 1.5707963267948966;
    let p2 = phi * phi;
    let sp = phi * (1 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))));
    let cp = 1 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))));
    let r = (m as i64) & 3;
    return if r == 0 { sp } else if r == 1 { cp } else if r == 2 { -sp } else { -cp };
}

fn render(out: f64[:]) {
    var x1 = 0.0;           // biquad state, carried across notes
    var x2 = 0.0;
    var y1 = 0.0;
    var y2 = 0.0;
    for note in N_NOTES {
        let freq = FREQS[(note * 3 + 1) & 7] * (if (note >> 2) & 1 != 0 { 2 } else { 1 });
        let dph = freq / SR;
        var ph = 0.0;
        let off = note * NOTE_LEN;
        for t in NOTE_LEN {
            let tf: f64 = t;
            let env = if tf < ATTACK { tf / ATTACK }
                else if tf < ATTACK + DECAY { 1 - (1 - SUSTAIN) * (tf - ATTACK) / DECAY }
                else if tf < NOTE_LEN - RELEASE { SUSTAIN }
                else { (NOTE_LEN - tf) / RELEASE * SUSTAIN };
            let s = sin_tau(ph) * env;
            ph += dph;
            if ph >= 1 { ph -= 1; }
            let y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
            x2 = x1; x1 = s; y2 = y1; y1 = y;
            out[off + t] = y;
        }
    }
}

fn main() {
    var out: f64[>..] = [];
    out.resize(N, 0.0);
    for i in N_WARMUP { render(out); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        render(out);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N, N_NOTES, N_RUNS);
}

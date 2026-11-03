// upfirdn.goose: Goose port of upfirdn.js (same input, ratio and checksum):
// rational resampling by 6/4, reduced to 3/2: a windowed lowpass designed per
// call, padded to the decimation phase, then upsample, filter and decimate.

import bench from "../_lib";

let N_SAMPLES = 96000;      // 2 s @ 48 kHz mono
let UP = 6;                 // 48 kHz → 72 kHz once reduced to 3/2
let DOWN = 4;
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

fn taps(n: i64) -> f64[>..] {
    var h: f64[>..] = [];
    let c = (n - 1) / 2.0;
    var sum = 0.0;
    for k in n {
        let d = k - c;
        h.push((1 - abs(d) / (c + 1)) * (if d == 0 { 1.0 } else { (if k & 1 != 0 { -0.25 } else { 0.5 }) / (1 + abs(d)) }));
        sum += h[k];
    }
    for &v in h { v /= sum; }
    return h;
}

fn gcd(x: i64, y: i64) -> i64 {
    var a = abs(x);
    var b = abs(y);
    while b != 0 {
        let t = b;
        b = rem(a, b);
        a = t;
    }
    return a;
}

fn upfirdn(data: f64[:], h: f64[:], up: i64, down: i64) -> f64[>..] {
    let x_len = data.len;
    let h_len = h.len;
    let out_len = ((x_len - 1) * up + h_len + down - 1) / down;
    var out: f64[>..] = [];
    for n in out_len {
        var sum = 0.0;
        let up_idx = n * down;
        for k in h_len {
            let src_idx = up_idx - k;
            if src_idx >= 0 && src_idx % up == 0 {
                let xi = src_idx / up;
                if xi < x_len { sum += h[k] * data[xi]; }
            }
        }
        out.push(sum);
    }
    return out;
}

fn resample(data: f64[:], p0: i64, q0: i64) -> f64[>..] {
    let g = gcd(p0, q0);
    let p = p0 / g;
    let q = q0 / g;
    var numtaps = 10 * max(p, q) + 1;
    if numtaps % 2 == 0 { numtaps++; }
    var h = taps(numtaps);
    for &v in h { v *= p; }
    var delay = (numtaps - 1) / 2;
    let pre_pad = (q - delay % q) % q;
    var hp: f64[>..] = [];
    hp.resize(pre_pad, 0.0);
    hp.append(h);
    delay += pre_pad;
    let out = upfirdn(data, hp, p, q);
    let expected = (data.len * p + q - 1) / q;     // ceil(len·p/q)
    let start_idx = delay / q;
    var result: f64[>..] = [];
    for i in expected {
        let idx = start_idx + i;
        result.push(if idx < out.len { out[idx] } else { 0.0 });
    }
    return result;
}

fn main() {
    let x = mk_input(N_SAMPLES);
    var out: f64[>..] = [];
    for i in N_WARMUP { out = resample(x, UP, DOWN); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        out = resample(x, UP, DOWN);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), out.len, UP, N_RUNS);
}

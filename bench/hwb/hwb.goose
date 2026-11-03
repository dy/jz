// hwb.goose: Goose port of hwb.js (same colors, runs and checksum): the
// color-space library's rgb to HWB conversion over a buffer of colors,
// converted in place. The conversion returns its three channels as results.

import bench from "../_lib";

let N_COLORS = 1500000;
let N_RUNS = 11;
let N_WARMUP = 2;

fn rgb_hue(r: f64, g: f64, b: f64, lo: f64, hi: f64, delta: f64) -> f64 {
    var h = 0.0;
    if hi == lo { h = 0.0; }
    else if r == hi { h = (g - b) / delta; }
    else if g == hi { h = 2 + (b - r) / delta; }
    else if b == hi { h = 4 + (r - g) / delta; }
    h = min(h / 6, 1.0);
    return if h < 0 { h + 1 } else { h };
}

fn rgb_hue_deg(r0: f64, g0: f64, b0: f64) -> f64 {
    let r = r0 / 255;
    let g = g0 / 255;
    let b = b0 / 255;
    let lo = min(min(r, g), b);
    let hi = max(max(r, g), b);
    return rgb_hue(r, g, b, lo, hi, hi - lo) * 360;
}

fn rgb_hwb(r0: f64, g0: f64, b0: f64) -> f64, f64, f64 {
    let r = r0 / 255;
    let g = g0 / 255;
    let b = b0 / 255;
    return rgb_hue_deg(r * 255, g * 255, b * 255), min(r, min(g, b)) * 100, (1 - max(r, max(g, b))) * 100;
}

fn mk_input(n: i64) -> f64[>..] {
    var out: f64[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n * 3 {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push(255 * (s / 4294967296.0));
    }
    return out;
}

fn convert(src: f64[:], buf: f64[:], n: i64) {
    copy_into(buf, src);
    for i in n {
        let j = 3 * i;
        buf[j], buf[j + 1], buf[j + 2] = rgb_hwb(buf[j], buf[j + 1], buf[j + 2]);
    }
}

fn main() {
    let src = mk_input(N_COLORS);
    var dst: f64[>..] = [];
    dst.resize(N_COLORS * 3, 0.0);
    for i in N_WARMUP { convert(src, dst, N_COLORS); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        convert(src, dst, N_COLORS);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64_near(dst), N_COLORS, 1, N_RUNS);
}

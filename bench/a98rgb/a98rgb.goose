// a98rgb.goose: Goose port of a98rgb.js (same colors, runs and checksum): the
// color-space library's rgb to Adobe RGB conversion (sRGB decode, linear rgb
// to XYZ, XYZ to A98 with its signed power), three in-place passes over a
// buffer of colors. Each conversion returns its three channels as results.

import bench from "../_lib";
import math;

let N_COLORS = 300000;
let N_RUNS = 11;
let N_WARMUP = 2;

fn spow(a: f64, e: f64) -> f64 {
    let s = if a < 0 { -1.0 } else { 1.0 };
    let av = if a < 0 { -a } else { a };
    return s * pow(av, e);
}

fn sgn(v: f64) -> f64 { if v < 0 { -1.0 } else { 1.0 } }

fn srgb_dec(v: f64) -> f64 {
    let a = abs(v);
    return sgn(v) * (if a > 0.04045 { pow((a + 0.055) / 1.055, 2.4) } else { a / 12.92 });
}

fn rgb_lrgb(r: f64, g: f64, b: f64) -> f64, f64, f64 { return srgb_dec(r / 255), srgb_dec(g / 255), srgb_dec(b / 255); }

fn lrgb_xyz(r: f64, g: f64, b: f64) -> f64, f64, f64 {
    return 100 * (0.41239079926595 * r + 0.35758433938387 * g + 0.18048078840183 * b),
           100 * (0.21263900587151 * r + 0.71516867876775 * g + 0.072192315360733 * b),
           100 * (0.019330818715591 * r + 0.11919477979462 * g + 0.95053215224966 * b);
}

fn xyz_a98rgblinear(x0: f64, y0: f64, z0: f64) -> f64, f64, f64 {
    let x = x0 / 100;
    let y = y0 / 100;
    let z = z0 / 100;
    return 2.0415879038107465 * x - 0.5650069742788597 * y - 0.34473135077832956 * z,
           -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
           0.013444280632031149 * x - 0.11836239223101837 * y + 1.0151749943912054 * z;
}

fn xyz_a98rgb(x: f64, y: f64, z: f64) -> f64, f64, f64 {
    let r, g, b = xyz_a98rgblinear(x, y, z);
    let e = 256.0 / 563.0;
    return spow(r, e), spow(g, e), spow(b, e);
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
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = rgb_lrgb(buf[j], buf[j + 1], buf[j + 2]); }
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = lrgb_xyz(buf[j], buf[j + 1], buf[j + 2]); }
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = xyz_a98rgb(buf[j], buf[j + 1], buf[j + 2]); }
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

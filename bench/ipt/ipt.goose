// ipt.goose: Goose port of ipt.js (same colors, runs and checksum): the
// color-space library's rgb to IPT conversion (sRGB decode, linear rgb to
// XYZ, XYZ to IPT through two matrices and a signed power), three in-place
// passes over a buffer of colors. Each conversion returns its three channels.

import bench from "../_lib";
import math;

let N_COLORS = 250000;
let N_RUNS = 11;
let N_WARMUP = 2;

let M1_00 = 0.4002;   let M1_01 = 0.7075;   let M1_02 = -0.0807;
let M1_10 = -0.228;   let M1_11 = 1.15;     let M1_12 = 0.0612;
let M1_20 = 0.0;      let M1_21 = 0.0;      let M1_22 = 0.9184;
let M2_00 = 0.4;      let M2_01 = 0.4;      let M2_02 = 0.2;
let M2_10 = 4.455;    let M2_11 = -4.851;   let M2_12 = 0.396;
let M2_20 = 0.8056;   let M2_21 = 0.3572;   let M2_22 = -1.1628;

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

fn xyz_ipt(x: f64, y: f64, z: f64) -> f64, f64, f64 {
    let xn = x / 100;
    let yn = y / 100;
    let zn = z / 100;
    let lp = spow(M1_00 * xn + M1_01 * yn + M1_02 * zn, 0.43);
    let mp = spow(M1_10 * xn + M1_11 * yn + M1_12 * zn, 0.43);
    let sp = spow(M1_20 * xn + M1_21 * yn + M1_22 * zn, 0.43);
    return M2_00 * lp + M2_01 * mp + M2_02 * sp, M2_10 * lp + M2_11 * mp + M2_12 * sp, M2_20 * lp + M2_21 * mp + M2_22 * sp;
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
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = xyz_ipt(buf[j], buf[j + 1], buf[j + 2]); }
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

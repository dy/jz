// hct.goose: Goose port of hct.js (same colors, runs and checksum): the
// color-space library's rgb to HCT conversion (sRGB decode, linear rgb to
// XYZ, then CAM16 hue and chroma with CIELAB tone), three in-place passes
// over a buffer of colors. The viewing conditions are one record constant;
// cbrt is libm's, bound through extern fn (Goose's math module has none).

import bench from "../_lib";
import math;

let N_COLORS = 75000;
let N_RUNS = 11;
let N_WARMUP = 2;

extern fn cbrt(x: f64) -> f64;

let EPS = 216.0 / 24389.0;
let KAPPA = 24389.0 / 27.0;

fn lab_f(t: f64) -> f64 { if t > EPS { cbrt(t) } else { (KAPPA * t + 16) / 116 } }

struct Env { fl: f64, fl_root: f64, n: f64, z: f64, nbb: f64, ncb: f64, c: f64, nc: f64, a_w: f64,
             d_r: f64, d_g: f64, d_b: f64, d_ri: f64, d_gi: f64, d_bi: f64, ak: f64, aki: f64, uk: f64 }

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

// Math.sign: ±1, or the argument itself for ±0 and NaN.
fn js_sign(v: f64) -> f64 { if v > 0 { 1.0 } else if v < 0 { -1.0 } else { v } }
fn copy_sign(a: f64, b: f64) -> f64 { js_sign(b) * abs(a) }
fn zdiv(a: f64, b: f64) -> f64 { if b == 0 { 0.0 } else { a / b } }
fn hue360(h: f64) -> f64 { let r = h % 360; return if r < 0 { r + 360 } else { r }; }

fn cam_adapt(c: f64, fl: f64) -> f64 {
    let x = spow(fl * abs(c) * 0.01, 0.42);
    return 400 * copy_sign(x, c) / (x + 27.13);
}

fn to_cam16(x: f64, y: f64, z: f64, e: const Env&) -> f64, f64, f64 {
    let ra = cam_adapt((0.401288 * x + 0.650173 * y - 0.051461 * z) * e.d_r, e.fl);
    let ga = cam_adapt((-0.250268 * x + 1.204414 * y + 0.045854 * z) * e.d_g, e.fl);
    let ba = cam_adapt((-0.002079 * x + 0.048952 * y + 0.953127 * z) * e.d_b, e.fl);
    let a = ra + (-12 * ga + ba) / 11;
    let b = (ra + ga - 2 * ba) / 9;
    let h_rad = (atan2(b, a) % TAU + TAU) % TAU;
    let et = 0.25 * (cos(h_rad + 2) + 3.8);
    let t = 5e4 / 13 * e.nc * e.ncb * zdiv(et * sqrt(a * a + b * b), ra + ga + 1.05 * ba + 0.305);
    let alpha = spow(t, 0.9) * e.ak;
    let aa = e.nbb * (2 * ra + ga + 0.05 * ba);
    let j_root = spow(aa / e.a_w, 0.5 * e.c * e.z);
    return 100 * spow(j_root, 2), alpha * j_root, hue360(h_rad * (180 / PI));
}

let HCT = Env { fl: 0.3884814537800353, fl_root: 0.7894826179304937, n: 0.18418651851244416, z: 1.909169568483652,
                nbb: 1.0169191804458755, ncb: 1.0169191804458755, c: 0.69, nc: 1.0, a_w: 29.980990887425254,
                d_r: 1.0211931250282207, d_g: 0.98629630699647, d_b: 0.9338046211456175,
                d_ri: 0.9792467022066614, d_gi: 1.0138940933939633, d_bi: 1.0708878253067244,
                ak: 0.8834525670408592, aki: 1.1319226830134397, uk: 666201.197723509 };

fn xyz_hct(x: f64, y: f64, z: f64) -> f64, f64, f64 {
    let t = 116 * lab_f(y / 100) - 16;
    if t == 0 { return 0.0, 0.0, 0.0; }
    let j, c, h = to_cam16(x, y, z, HCT);
    return hue360(h), c, t;
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
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = xyz_hct(buf[j], buf[j + 1], buf[j + 2]); }
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

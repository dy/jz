// jzazbz.goose: Goose port of jzazbz.js (same colors, runs and checksum): the
// color-space library's rgb to Jzazbz conversion (sRGB decode, linear rgb to
// XYZ, XYZ to Jzazbz through the PQ transfer), three in-place passes over a
// buffer of colors. Each conversion returns its three channels as results.

import bench from "../_lib";
import math;

let N_COLORS = 150000;
let N_RUNS = 11;
let N_WARMUP = 2;

let YW_JZ = 203.0;
let B_PARAM = 1.15;
let G_PARAM = 0.66;
let D = -0.56;
let D0 = 1.6295499532821566e-11;
let N_VAL = 2610.0 / 16384.0;
let C1 = 3424.0 / 4096.0;
let C2 = 2413.0 / 128.0;
let C3 = 2392.0 / 128.0;
let P = 1.7 * 2523 / 32;
let XC00 = 0.41478972;  let XC01 = 0.579999;   let XC02 = 0.0146480;
let XC10 = -0.2015100;  let XC11 = 1.120649;   let XC12 = 0.0531008;
let XC20 = -0.0166008;  let XC21 = 0.264800;   let XC22 = 0.6684799;
let CI00 = 0.5;         let CI01 = 0.5;        let CI02 = 0.0;
let CI10 = 3.524000;    let CI11 = -4.066708;  let CI12 = 0.542708;
let CI20 = 0.199076;    let CI21 = 1.096799;   let CI22 = -1.295875;

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

// The PQ transfer of one cone response.
fn pq(v: f64) -> f64 { spow((C1 + C2 * spow(v / 10000, N_VAL)) / (1 + C3 * spow(v / 10000, N_VAL)), P) }

fn xyz_jzazbz(x: f64, y: f64, z: f64) -> f64, f64, f64 {
    let xa = x / 100 * YW_JZ;
    let ya = y / 100 * YW_JZ;
    let za = z / 100 * YW_JZ;
    let xm = B_PARAM * xa - (B_PARAM - 1) * za;
    let ym = G_PARAM * ya - (G_PARAM - 1) * xa;
    let l = XC00 * xm + XC01 * ym + XC02 * za;
    let m = XC10 * xm + XC11 * ym + XC12 * za;
    let s = XC20 * xm + XC21 * ym + XC22 * za;
    let pl = pq(l);
    let pm = pq(m);
    let ps = pq(s);
    let iz = CI00 * pl + CI01 * pm + CI02 * ps;
    return (1 + D) * iz / (1 + D * iz) - D0, CI10 * pl + CI11 * pm + CI12 * ps, CI20 * pl + CI21 * pm + CI22 * ps;
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
    for i in n { let j = 3 * i; buf[j], buf[j + 1], buf[j + 2] = xyz_jzazbz(buf[j], buf[j + 1], buf[j + 2]); }
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

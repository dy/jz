// hct.rs – rgb to HCT (hue, chroma, tone) over a batch of colors: color-space's
// wasm batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// hct.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_hct and their helpers (labF, spow, sgn,
// srgbDec, copySign, zdiv, hue360, camAdapt, toCam16) are ported as written,
// each a Rust fn; an edge returns its three results as a [f64; 3] destructured
// at once, as the JS returns an [a, b, c] array. The JS's viewing-conditions
// object becomes a const struct that to_cam16 reads by reference; it holds the
// fields the forward reads (the library's object also carries flRoot, n, dRi,
// dGi, dBi, aki and uk, which xyz_hct never reads). sign is the JS's
// Math.sign, not f64::signum: it is 0 at 0. JS `%` on doubles is Rust's `%`
// (fmod). convert copies the sRGB input into the buffer and runs one in-place
// pass per edge over its triples, as the JS does (the copy is inside the timed
// region there too). `**` is powf (libm pow), and Math.cbrt, atan2, cos and
// sqrt are libm's.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near), which tolerates last-bit pow,
// cbrt and trig differences between libms.
use std::f64::consts::PI;
use std::time::Instant;

const N_COLORS: usize = 75_000;
const N_RUNS: usize = 11;
const N_WARMUP: usize = 2;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over every value rounded to f32 (benchlib checksumF64Near)
fn checksum_f64_near(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &x in out {
        h = mix(h, (x as f32).to_bits());
    }
    h
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// CIE 1976 companding (shared by lab/luv/hct)
const EPS: f64 = 216.0 / 24389.0;
const KAPPA: f64 = 24389.0 / 27.0;
fn lab_f(t: f64) -> f64 { if t > EPS { t.cbrt() } else { (KAPPA * t + 16.0) / 116.0 } }

// sign-extended power (shared by jzazbz, ipt, a98rgb, cam16); out-of-gamut safe
fn spow(a: f64, e: f64) -> f64 { let (s, av) = if a < 0.0 { (-1.0, -a) } else { (1.0, a) }; s * av.powf(e) }

fn sgn(v: f64) -> f64 { if v < 0.0 { -1.0 } else { 1.0 } }

// sRGB / IEC 61966-2-1 (also Display P3)
fn srgb_dec(v: f64) -> f64 { let a = v.abs(); sgn(v) * (if a > 0.04045 { ((a + 0.055) / 1.055).powf(2.4) } else { a / 12.92 }) }

// ---- rgb / lrgb / xyz / oklab / oklrab (hub: lrgb, xyz) ----

fn rgb_lrgb(r: f64, g: f64, b: f64) -> [f64; 3] { [srgb_dec(r / 255.0), srgb_dec(g / 255.0), srgb_dec(b / 255.0)] }

fn lrgb_xyz(r: f64, g: f64, b: f64) -> [f64; 3] {
    [
        100.0 * (0.41239079926595 * r + 0.35758433938387 * g + 0.18048078840183 * b),
        100.0 * (0.21263900587151 * r + 0.71516867876775 * g + 0.072192315360733 * b),
        100.0 * (0.019330818715591 * r + 0.11919477979462 * g + 0.95053215224966 * b),
    ]
}

// ---- xyz <-> cam16 (J, M, h) / hct (Li et al. 2017; spaces/cam16.js, spaces/hct.js) ----
// Viewing conditions are the library's environment() values: HCT = precise D65,
// La = 200/π·Y(L*50), Yb = Y(L*50). ak = (1.64 − 0.29^n)^0.73.
struct Env { fl: f64, z: f64, nbb: f64, ncb: f64, c: f64, nc: f64, a_w: f64, d_r: f64, d_g: f64, d_b: f64, ak: f64 }

const HCT: Env = Env { fl: 0.3884814537800353, z: 1.909169568483652, nbb: 1.0169191804458755, ncb: 1.0169191804458755, c: 0.69, nc: 1.0, a_w: 29.980990887425254, d_r: 1.0211931250282207, d_g: 0.98629630699647, d_b: 0.9338046211456175, ak: 0.8834525670408592 };

const TAU: f64 = 2.0 * PI;

// Math.sign: ±1, or the argument itself at ±0
fn sign(x: f64) -> f64 { if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x } }
fn copy_sign(a: f64, b: f64) -> f64 { sign(b) * a.abs() }
fn zdiv(a: f64, b: f64) -> f64 { if b == 0.0 { 0.0 } else { a / b } }
fn hue360(h: f64) -> f64 { let r = h % 360.0; if r < 0.0 { r + 360.0 } else { r } }
fn cam_adapt(c: f64, fl: f64) -> f64 { let x = spow(fl * c.abs() * 0.01, 0.42); (400.0 * copy_sign(x, c)) / (x + 27.13) }

// XYZ (0-100) → [J, C, h°] under viewing conditions e (toCam16)
fn to_cam16(x: f64, y: f64, z: f64, e: &Env) -> [f64; 3] {
    let ra = cam_adapt((0.401288 * x + 0.650173 * y - 0.051461 * z) * e.d_r, e.fl);
    let ga = cam_adapt((-0.250268 * x + 1.204414 * y + 0.045854 * z) * e.d_g, e.fl);
    let ba = cam_adapt((-0.002079 * x + 0.048952 * y + 0.953127 * z) * e.d_b, e.fl);
    let (a, b) = (ra + (-12.0 * ga + ba) / 11.0, (ra + ga - 2.0 * ba) / 9.0);
    let h_rad = ((b.atan2(a) % TAU) + TAU) % TAU;
    let et = 0.25 * ((h_rad + 2.0).cos() + 3.8);
    let t = (5e4 / 13.0) * e.nc * e.ncb * zdiv(et * (a * a + b * b).sqrt(), ra + ga + 1.05 * ba + 0.305);
    let alpha = spow(t, 0.9) * e.ak;
    let big_a = e.nbb * (2.0 * ra + ga + 0.05 * ba);
    let j_root = spow(big_a / e.a_w, 0.5 * e.c * e.z);
    [100.0 * spow(j_root, 2.0), alpha * j_root, hue360(h_rad * (180.0 / PI))]
}

// HCT: CAM16 hue and chroma, CIELAB L* as tone; the inverse Newton-solves J for the tone
fn xyz_hct(x: f64, y: f64, z: f64) -> [f64; 3] {
    let t = 116.0 * lab_f(y / 100.0) - 16.0;
    if t == 0.0 { return [0.0, 0.0, 0.0]; }
    let [_j, c, h] = to_cam16(x, y, z, &HCT);
    [hue360(h), c, t]
}

// deterministic sRGB 0-255 (XorShift32), as the batch API takes it
fn mk_input(n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * 3];
    let mut s = 0x1234abcdu32;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = 255.0 * (s as f64 / 4294967296.0);
    }
    out
}

fn convert(src: &[f64], buf: &mut [f64]) {
    buf.copy_from_slice(src);
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = rgb_lrgb(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = lrgb_xyz(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = xyz_hct(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
}

fn main() {
    let src = mk_input(N_COLORS);
    let mut dst = vec![0.0; N_COLORS * 3];

    for _ in 0..N_WARMUP { convert(&src, &mut dst); }

    let mut samples = [0.0; N_RUNS];
    for sample in samples.iter_mut() {
        let t0 = Instant::now();
        convert(&src, &mut dst);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_f64_near(&dst),
        N_COLORS,
        1,
        N_RUNS
    );
}

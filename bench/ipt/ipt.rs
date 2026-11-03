// ipt.rs – rgb to IPT (Ebner & Fairchild 1998) over a batch of colors:
// color-space's wasm batch kernel (github.com/colorjs/color-space,
// wasm/batch.js) ported from ipt.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_ipt and their helpers (spow, sgn,
// srgbDec) are ported as written, each a Rust fn; an edge returns its three
// results as a [f64; 3] destructured at once, as the JS returns an [a, b, c]
// array. The IPT matrices stay named consts, one per element, as the JS
// declares them. convert copies the sRGB input into the buffer and runs one
// in-place pass per edge over its triples, as the JS does (the copy is inside
// the timed region there too). `**` is powf (libm pow).
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near), which tolerates last-bit pow
// differences between libms.
use std::time::Instant;

const N_COLORS: usize = 250_000;
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

// ---- xyz <-> ipt (Ebner & Fairchild 1998) ----
const M1_00: f64 = 0.4002; const M1_01: f64 = 0.7075; const M1_02: f64 = -0.0807;
const M1_10: f64 = -0.228; const M1_11: f64 = 1.15; const M1_12: f64 = 0.0612;
const M1_20: f64 = 0.0; const M1_21: f64 = 0.0; const M1_22: f64 = 0.9184;
const M2_00: f64 = 0.4; const M2_01: f64 = 0.4; const M2_02: f64 = 0.2;
const M2_10: f64 = 4.455; const M2_11: f64 = -4.851; const M2_12: f64 = 0.396;
const M2_20: f64 = 0.8056; const M2_21: f64 = 0.3572; const M2_22: f64 = -1.1628;

fn xyz_ipt(x: f64, y: f64, z: f64) -> [f64; 3] {
    let (xn, yn, zn) = (x / 100.0, y / 100.0, z / 100.0);
    let lp = spow(M1_00 * xn + M1_01 * yn + M1_02 * zn, 0.43);
    let mp = spow(M1_10 * xn + M1_11 * yn + M1_12 * zn, 0.43);
    let sp = spow(M1_20 * xn + M1_21 * yn + M1_22 * zn, 0.43);
    [M2_00 * lp + M2_01 * mp + M2_02 * sp, M2_10 * lp + M2_11 * mp + M2_12 * sp, M2_20 * lp + M2_21 * mp + M2_22 * sp]
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
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = xyz_ipt(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
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

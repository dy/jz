// jzczhz.rs – rgb to JzCzhz over a batch of colors: color-space's wasm batch
// kernel (github.com/colorjs/color-space, wasm/batch.js) ported from jzczhz.js.
//
// The edges rgb_lrgb, lrgb_xyz, xyz_jzazbz and polar_fwd and their helpers
// (spow, sgn, srgbDec) are ported as written, each a Rust fn; an edge returns
// its three results as a [f64; 3] destructured at once, as the JS returns an
// [a, b, c] array. The Jzazbz constants stay named consts as the JS declares
// them (the inverse's ninv and pinv, which the forward never reads, are left
// out). convert copies the sRGB input into the buffer and runs one in-place
// pass per edge over its triples, as the JS does (the copy is inside the timed
// region there too). `**` is powf (libm pow), Math.atan2 libm atan2.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near), which tolerates last-bit pow
// and atan2 differences between libms.
use std::f64::consts::PI;
use std::time::Instant;

const N_COLORS: usize = 120_000;
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

// ---- generic cartesian <-> cylindrical (serves every LCh-family space) ----
fn polar_fwd(l: f64, a: f64, b: f64) -> [f64; 3] {
    let c = (a * a + b * b).sqrt();
    let hr = b.atan2(a) * 180.0 / PI;
    [l, c, if c < 1e-8 { 0.0 } else if hr < 0.0 { hr + 360.0 } else { hr }]
}

// ---- xyz <-> jzazbz (HDR; modified ST 2084 PQ, p = 1.7·m2) ----
const YW_JZ: f64 = 203.0;
const B_PARAM: f64 = 1.15;
const G_PARAM: f64 = 0.66;
const D: f64 = -0.56;
const D0: f64 = 1.6295499532821566e-11;

const N_VAL: f64 = 2610.0 / 16384.0;
const C1: f64 = 3424.0 / 4096.0;
const C2: f64 = 2413.0 / 128.0;
const C3: f64 = 2392.0 / 128.0;

const P: f64 = 1.7 * 2523.0 / 32.0;

const XC00: f64 = 0.41478972; const XC01: f64 = 0.579999; const XC02: f64 = 0.0146480;
const XC10: f64 = -0.2015100; const XC11: f64 = 1.120649; const XC12: f64 = 0.0531008;
const XC20: f64 = -0.0166008; const XC21: f64 = 0.264800; const XC22: f64 = 0.6684799;

const CI00: f64 = 0.5; const CI01: f64 = 0.5; const CI02: f64 = 0.0;
const CI10: f64 = 3.524000; const CI11: f64 = -4.066708; const CI12: f64 = 0.542708;
const CI20: f64 = 0.199076; const CI21: f64 = 1.096799; const CI22: f64 = -1.295875;

fn xyz_jzazbz(x: f64, y: f64, z: f64) -> [f64; 3] {
    let (xa, ya, za) = (x / 100.0 * YW_JZ, y / 100.0 * YW_JZ, z / 100.0 * YW_JZ);
    let (xm, ym) = (B_PARAM * xa - (B_PARAM - 1.0) * za, G_PARAM * ya - (G_PARAM - 1.0) * xa);
    let l = XC00 * xm + XC01 * ym + XC02 * za;
    let m = XC10 * xm + XC11 * ym + XC12 * za;
    let s = XC20 * xm + XC21 * ym + XC22 * za;
    let pl = spow((C1 + C2 * spow(l / 10000.0, N_VAL)) / (1.0 + C3 * spow(l / 10000.0, N_VAL)), P);
    let pm = spow((C1 + C2 * spow(m / 10000.0, N_VAL)) / (1.0 + C3 * spow(m / 10000.0, N_VAL)), P);
    let ps = spow((C1 + C2 * spow(s / 10000.0, N_VAL)) / (1.0 + C3 * spow(s / 10000.0, N_VAL)), P);
    let iz = CI00 * pl + CI01 * pm + CI02 * ps;
    [((1.0 + D) * iz) / (1.0 + D * iz) - D0, CI10 * pl + CI11 * pm + CI12 * ps, CI20 * pl + CI21 * pm + CI22 * ps]
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
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = xyz_jzazbz(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = polar_fwd(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
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

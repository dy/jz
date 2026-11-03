// a98rgb.rs – rgb to Adobe RGB (1998) over a batch of colors: color-space's
// wasm batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// a98rgb.js.
//
// The edges rgb_lrgb, lrgb_xyz and xyz_a98rgb (with xyz_a98rgblinear) and
// their helpers (spow, sgn, srgbDec) are ported as written, each a Rust fn; an
// edge returns its three results as a [f64; 3] destructured at once, as the JS
// returns an [a, b, c] array. The matrices stay inline literals, as the JS
// writes them. convert copies the sRGB input into the buffer and runs one
// in-place pass per edge over its triples, as the JS does (the copy is inside
// the timed region there too). `**` is powf (libm pow).
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near), which tolerates last-bit pow
// differences between libms.
use std::time::Instant;

const N_COLORS: usize = 300_000;
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

fn xyz_a98rgblinear(x0: f64, y0: f64, z0: f64) -> [f64; 3] {
    let (x, y, z) = (x0 / 100.0, y0 / 100.0, z0 / 100.0);
    [
        2.0415879038107465 * x - 0.5650069742788597 * y - 0.34473135077832956 * z,
        -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
        0.013444280632031149 * x - 0.11836239223101837 * y + 1.0151749943912054 * z,
    ]
}

fn xyz_a98rgb(x: f64, y: f64, z: f64) -> [f64; 3] {
    let [r, g, b] = xyz_a98rgblinear(x, y, z);
    [spow(r, 256.0 / 563.0), spow(g, 256.0 / 563.0), spow(b, 256.0 / 563.0)]
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
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = xyz_a98rgb(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
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

// hsl.rs – rgb to HSL over a batch of colors: color-space's wasm batch kernel
// (github.com/colorjs/color-space, wasm/batch.js) ported from hsl.js.
//
// The edge rgb_hsl and its helper rgbHue are ported as written, each a Rust
// fn; the edge returns its three results as a [f64; 3] destructured at once, as
// the JS returns an [a, b, c] array. convert copies the sRGB input into the
// buffer and runs one in-place pass of the edge over its triples, as the JS
// does (the copy is inside the timed region there too). Math.min and Math.max
// become plain comparisons: no value is ever NaN.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near).
use std::time::Instant;

const N_COLORS: usize = 1_500_000;
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

fn min2(a: f64, b: f64) -> f64 { if a < b { a } else { b } }
fn max2(a: f64, b: f64) -> f64 { if a > b { a } else { b } }

// hue of an rgb triple (0-1), shared by rgb→hsl and rgb→hsv
fn rgb_hue(r: f64, g: f64, b: f64, min: f64, max: f64, delta: f64) -> f64 {
    let mut h = 0.0;
    if max == min { h = 0.0; }
    else if r == max { h = (g - b) / delta; }
    else if g == max { h = 2.0 + (b - r) / delta; }
    else if b == max { h = 4.0 + (r - g) / delta; }
    h = min2(h / 6.0, 1.0);
    if h < 0.0 { h + 1.0 } else { h }
}

fn rgb_hsl(r0: f64, g0: f64, b0: f64) -> [f64; 3] {
    let (r, g, b) = (r0 / 255.0, g0 / 255.0, b0 / 255.0);
    let (min, max) = (min2(min2(r, g), b), max2(max2(r, g), b));
    let delta = max - min;
    let (h, l) = (rgb_hue(r, g, b, min, max, delta), (min + max) / 2.0);
    let s = if max == min { 0.0 } else if l <= 0.5 { delta / (max + min) } else { delta / (2.0 - max - min) };
    [h * 360.0, s * 100.0, l * 100.0]
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
    for p in buf.chunks_exact_mut(3) { let [a, b, c] = rgb_hsl(p[0], p[1], p[2]); p[0] = a; p[1] = b; p[2] = c; }
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

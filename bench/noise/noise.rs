// noise.rs — 2-D Perlin gradient noise summed over several octaves (fractal
// Brownian motion), the canonical procedural-generation kernel (terrain heights,
// textures, clouds, displacement). A permutation-table hash feeds gradient dot
// products blended by a quintic smoothstep — integer table lookups interleaved
// with loop-carried f64 interpolation, an ALU/memory mix distinct from the
// suite's other loops.
//
// Transcendental-free (+,-,*; no trig/pow), and the sample coordinates stay
// non-negative so Math.floor never straddles zero, so the field is bit-identical
// across engines and native targets. Go's arm64 auto-FMA of the lerp chains gives
// the documented `fma` parity class, like fft/synth.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array,
// Math.floor, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum over
// the generated field.
use std::time::Instant;

const W: usize = 256;
const H: usize = 256;
const OCT: usize = 5;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
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

fn build_perm(perm: &mut [i32; 512]) {
    for i in 0..256 {
        perm[i] = i as i32;
    }
    let mut s: i32 = 0x1234abcdu32 as i32;
    for i in (1..=255usize).rev() {
        s ^= s << 13;
        s ^= (s as u32 >> 17) as i32;
        s ^= s << 5;
        let j = (s as u32) % (i as u32 + 1);
        let t = perm[i];
        perm[i] = perm[j as usize];
        perm[j as usize] = t;
    }
    for i in 0..256 {
        perm[256 + i] = perm[i];
    }
}

#[inline(always)]
fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline(always)]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + t * (b - a)
}

#[inline(always)]
fn grad(hash: i32, x: f64, y: f64) -> f64 {
    let h = hash & 3;
    let u = if (h & 1) == 0 { x } else { -x };
    let v = if (h & 2) == 0 { y } else { -y };
    u + v
}

#[inline(always)]
fn perlin(perm: &[i32; 512], x: f64, y: f64) -> f64 {
    let xi = x.floor();
    let yi = y.floor();
    let xf = x - xi;
    let yf = y - yi;
    let big_x = (xi as i32) & 255;
    let big_y = (yi as i32) & 255;
    let u = fade(xf);
    let v = fade(yf);
    let aa = perm[(perm[big_x as usize] + big_y) as usize];
    let ab = perm[(perm[big_x as usize] + big_y + 1) as usize];
    let ba = perm[(perm[(big_x + 1) as usize] + big_y) as usize];
    let bb = perm[(perm[(big_x + 1) as usize] + big_y + 1) as usize];
    let x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u);
    let x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
    lerp(x1, x2, v)
}

fn fbm(perm: &[i32; 512], x: f64, y: f64) -> f64 {
    let mut sum = 0.0f64;
    let mut amp = 0.5f64;
    let mut freq = 1.0f64;
    for _ in 0..OCT {
        sum = sum + amp * perlin(perm, x * freq, y * freq);
        freq = freq * 2.0;
        amp = amp * 0.5;
    }
    sum
}

fn render(perm: &[i32; 512], field: &mut [f64]) {
    for py in 0..H {
        let y = py as f64 * 0.03125;
        for px in 0..W {
            let x = px as f64 * 0.03125;
            field[py * W + px] = fbm(perm, x, y);
        }
    }
}

fn checksum_f64(field: &[f64]) -> u32 {
    // View as u32 pairs (little-endian bytes of f64), stride 256
    let mut h: u32 = 0x811c_9dc5;
    let stride = 256usize;
    let n = field.len() * 2; // number of u32 words
    let mut i = 0usize;
    while i < n {
        // Extract u32 word i from the f64 array
        let f_idx = i / 2;
        let bits = field[f_idx].to_bits();
        let word = if (i & 1) == 0 {
            bits as u32
        } else {
            (bits >> 32) as u32
        };
        h = mix(h, word);
        i += stride;
    }
    h
}

fn main() {
    let mut perm = [0i32; 512];
    build_perm(&mut perm);
    let mut field = vec![0.0f64; W * H];

    for _ in 0..N_WARMUP {
        render(&perm, &mut field);
    }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        render(&perm, &mut field);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let cs = checksum_f64(&field);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, W * H, OCT, N_RUNS
    );
}

// alpha.rs — alpha compositing (constant-opacity blend). Bit-identical to alpha.js.
use std::time::Instant;

const W: usize = 512;
const H: usize = 512;
const N: usize = W * H * 4;
const A: i32 = 160;
const IA: i32 = 255 - A;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn checksum_u8(out: &[u8]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &b in out {
        h = mix(h, b as u32);
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

fn mk_image(out: &mut [u8], seed: u32) {
    let mut s = seed;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s & 255) as u8;
    }
}

fn blend(src: &[u8], dst: &[u8], out: &mut [u8]) {
    for i in 0..N {
        out[i] = (((src[i] as i32) * A + (dst[i] as i32) * IA + 127) >> 8) as u8;
    }
}

fn main() {
    let mut src = vec![0u8; N];
    let mut dst = vec![0u8; N];
    let mut out = vec![0u8; N];
    mk_image(&mut src, 0x1234abcd);
    mk_image(&mut dst, 0x7e1f93b5);

    for _ in 0..N_WARMUP {
        blend(&src, &dst, &mut out);
    }
    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        blend(&src, &dst, &mut out);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_u8(&out),
        N,
        1,
        N_RUNS
    );
}

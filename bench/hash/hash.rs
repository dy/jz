use std::time::Instant;

const N: usize = 16384;
const N_ITERS: usize = 700;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const C1: u32 = 0xcc9e2d51;
const C2: u32 = 0x1b873593;

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

fn init_buf(buf: &mut [u8]) {
    let mut x: i32 = 0x1234_5678;
    for b in buf.iter_mut() {
        x = x.wrapping_mul(1103515245_i32).wrapping_add(12345);
        *b = ((x as u32 >> 16) & 0xff) as u8;
    }
}

fn murmur3(buf: &[u8], n: usize, seed: u32) -> u32 {
    let mut h = seed as i32;
    let mut i = 0;
    while i + 4 <= n {
        let mut k = (buf[i] as u32
            | ((buf[i + 1] as u32) << 8)
            | ((buf[i + 2] as u32) << 16)
            | ((buf[i + 3] as u32) << 24)) as i32;
        k = (k as u32).wrapping_mul(C1) as i32;
        k = ((k as u32) << 15 | (k as u32) >> 17) as i32;
        k = (k as u32).wrapping_mul(C2) as i32;
        h ^= k;
        h = ((h as u32) << 13 | (h as u32) >> 19) as i32;
        h = ((h as u32).wrapping_mul(5).wrapping_add(0xe6546b64)) as i32;
        i += 4;
    }
    h ^= n as i32;
    let mut uh = h as u32;
    uh ^= uh >> 16;
    uh = uh.wrapping_mul(0x85ebca6b);
    uh ^= uh >> 13;
    uh = uh.wrapping_mul(0xc2b2ae35);
    uh ^= uh >> 16;
    uh
}

fn run_kernel(buf: &mut [u8]) -> u32 {
    let mut h: u32 = 0;
    for it in 0..N_ITERS {
        let mr = murmur3(buf, N, 0x9747b28c);
        h = mix(h, mr);
        let j = it % N;
        buf[j] = buf[j].wrapping_add(1);
    }
    h
}

fn main() {
    let mut buf = vec![0u8; N];
    init_buf(&mut buf);
    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut buf);
    }
    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut buf);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        N * N_ITERS,
        1,
        N_RUNS
    );
}

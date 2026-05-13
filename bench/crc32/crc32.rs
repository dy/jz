use std::time::Instant;

const N: usize = 16384;
const N_ITERS: usize = 220;
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

fn build_table(table: &mut [u32; 256]) {
    for n in 0..256 {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        table[n] = c;
    }
}

fn init_buf(buf: &mut [u8]) {
    let mut x = 0x1234_5678u32;
    for b in buf {
        x = x.wrapping_mul(1103515245).wrapping_add(12345);
        *b = ((x >> 16) & 0xff) as u8;
    }
}

fn crc32_kernel(buf: &[u8], table: &[u32; 256]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in buf {
        c = table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

fn run_kernel(buf: &mut [u8], table: &[u32; 256]) -> u32 {
    let mut h = 0u32;
    for it in 0..N_ITERS {
        h = mix(h, crc32_kernel(buf, table));
        let j = it % N;
        buf[j] = buf[j].wrapping_add(1);
    }
    h
}

fn main() {
    let mut buf = vec![0; N];
    let mut table = [0u32; 256];
    build_table(&mut table);
    init_buf(&mut buf);
    let mut cs = 0;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut buf, &table);
    }
    let mut samples = [0.0; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut buf, &table);
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

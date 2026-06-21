use std::time::Instant;

const N: usize = 131072;
const SR: u32 = 44100;
const HDR: usize = 44;
const BYTES: usize = HDR + N * 2;
const N_ITERS: usize = 16;
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

fn mk_samples(s: &mut [f64]) {
    let mut x = 0x1234abcdi32;
    for i in 0..N {
        x ^= x << 13;
        x ^= (x as u32 >> 17) as i32;
        x ^= x << 5;
        s[i] = (((x as u32) as f64 / 4294967296.0) * 2.0 - 1.0) * 1.2;
    }
}

fn write_u32(b: &mut [u8], off: usize, v: u32) {
    b[off]     = (v & 0xff) as u8;
    b[off + 1] = ((v >> 8)  & 0xff) as u8;
    b[off + 2] = ((v >> 16) & 0xff) as u8;
    b[off + 3] = ((v >> 24) & 0xff) as u8;
}

fn write_u16(b: &mut [u8], off: usize, v: u32) {
    b[off]     = (v & 0xff) as u8;
    b[off + 1] = ((v >> 8) & 0xff) as u8;
}

fn encode(s: &[f64], n: usize, out: &mut [u8]) {
    let data_bytes = (n * 2) as u32;
    out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70;
    write_u32(out, 4, 36 + data_bytes);
    out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69;
    out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32;
    write_u32(out, 16, 16);
    write_u16(out, 20, 1);
    write_u16(out, 22, 1);
    write_u32(out, 24, SR);
    write_u32(out, 28, SR * 2);
    write_u16(out, 32, 2);
    write_u16(out, 34, 16);
    out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97;
    write_u32(out, 40, data_bytes);
    let mut op = HDR;
    for i in 0..n {
        let mut v = s[i] * 32767.0;
        if      v >  32767.0 { v =  32767.0; }
        else if v < -32768.0 { v = -32768.0; }
        let u = (v as i32 & 0xffff) as u32;
        out[op]     = (u & 0xff) as u8;
        out[op + 1] = ((u >> 8) & 0xff) as u8;
        op += 2;
    }
}

fn run_kernel(s: &mut [f64], out: &mut [u8]) -> u32 {
    let mut h = 0u32;
    for it in 0..N_ITERS {
        encode(s, N, out);
        h = mix(h, checksum_u8(out));
        let j = it % N;
        s[j] = -s[j];
    }
    h
}

fn main() {
    let mut s = vec![0.0f64; N];
    let mut out = vec![0u8; BYTES];
    mk_samples(&mut s);
    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut s, &mut out);
    }
    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut s, &mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
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

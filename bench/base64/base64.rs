use std::time::Instant;

const N: usize = 24576;
const ENC_LEN: usize = (N / 3) * 4;
const N_ITERS: usize = 64;
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

fn build_enc(enc: &mut [u8; 64]) {
    let mut i = 0usize;
    for c in 65u8..=90  { enc[i] = c; i += 1; }  // A-Z
    for c in 97u8..=122 { enc[i] = c; i += 1; }  // a-z
    for c in 48u8..=57  { enc[i] = c; i += 1; }  // 0-9
    enc[i] = 43; i += 1;  // +
    enc[i] = 47;           // /
}

fn build_dec(enc: &[u8; 64], dec: &mut [u8; 256]) {
    for d in dec.iter_mut() { *d = 0; }
    for i in 0..64 { dec[enc[i] as usize] = i as u8; }
}

fn init_buf(buf: &mut [u8; N]) {
    let mut x = 0x1234_5678i32;
    for b in buf.iter_mut() {
        x = (x as i32).wrapping_mul(1103515245i32).wrapping_add(12345);
        *b = ((x as u32 >> 16) & 0xff) as u8;
    }
}

fn checksum_u8(xs: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in xs {
        h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    }
    h
}

fn encode(src: &[u8; N], enc: &[u8; 64], out: &mut [u8; ENC_LEN]) -> usize {
    let mut op = 0usize;
    let mut i = 0usize;
    while i + 3 <= N {
        let a = src[i]; let b = src[i + 1]; let c = src[i + 2];
        out[op]     = enc[(a >> 2) as usize];
        out[op + 1] = enc[(((a & 3) << 4) | (b >> 4)) as usize];
        out[op + 2] = enc[(((b & 15) << 2) | (c >> 6)) as usize];
        out[op + 3] = enc[(c & 63) as usize];
        op += 4;
        i += 3;
    }
    op
}

fn decode(src: &[u8; ENC_LEN], dec: &[u8; 256], out: &mut [u8; N]) -> usize {
    let mut op = 0usize;
    let mut i = 0usize;
    while i + 4 <= ENC_LEN {
        let a = dec[src[i] as usize];
        let b = dec[src[i + 1] as usize];
        let c = dec[src[i + 2] as usize];
        let d = dec[src[i + 3] as usize];
        out[op]     = (((a << 2) | (b >> 4)) & 0xff) as u8;
        out[op + 1] = ((((b & 15) << 4) | (c >> 2)) & 0xff) as u8;
        out[op + 2] = ((((c & 3) << 6) | d) & 0xff) as u8;
        op += 3;
        i += 4;
    }
    op
}

fn run_kernel(
    src: &mut [u8; N],
    enc: &[u8; 64],
    dec: &[u8; 256],
    b64: &mut [u8; ENC_LEN],
    back: &mut [u8; N],
) -> u32 {
    let mut h = 0u32;
    for it in 0..N_ITERS {
        encode(src, enc, b64);
        decode(b64, dec, back);
        let mut ok: u32 = 1;
        for i in 0..N {
            if back[i] != src[i] { ok = 0; }
        }
        let cs_b64 = checksum_u8(b64.as_ref());
        h = mix(mix(h, cs_b64), ok);
        let j = it % N;
        src[j] = src[j].wrapping_add(1) & 0xff;
    }
    h
}

fn main() {
    let mut src = Box::new([0u8; N]);
    let mut enc = [0u8; 64];
    let mut dec = [0u8; 256];
    let mut b64 = Box::new([0u8; ENC_LEN]);
    let mut back = Box::new([0u8; N]);

    build_enc(&mut enc);
    build_dec(&enc, &mut dec);
    init_buf(&mut src);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut src, &enc, &dec, &mut b64, &mut back);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut src, &enc, &dec, &mut b64, &mut back);
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

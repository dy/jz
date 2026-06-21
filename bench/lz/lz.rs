use std::time::Instant;

const N: usize = 4096;
const WINDOW: usize = 1024;
const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 18;
const CAP: usize = N * 2 + 64;
const N_ITERS: usize = 5;
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

fn init_buf(buf: &mut [u8; N]) {
    let mut x: i32 = 0x12345678;
    for i in 0..N {
        x = x.wrapping_mul(1103515245i32).wrapping_add(12345);
        if i > 64 && (x & 0x70) == 0 {
            let back = 1 + ((x as u32 >> 8) & 63) as usize;
            buf[i] = buf[i - back];
        } else {
            buf[i] = ((x as u32 >> 16) & 0xff) as u8;
        }
    }
}

fn compress(src: &[u8; N], n: usize, out: &mut [u8; CAP]) -> usize {
    let mut op: usize = 0;
    let mut ip: usize = 0;
    while ip < n {
        let ctrl_pos = op;
        op += 1;
        let mut ctrl: u8 = 0;
        let mut b = 0;
        while b < 8 && ip < n {
            let start = if ip >= WINDOW { ip - WINDOW } else { 0 };
            let max_len = (n - ip).min(MAX_MATCH);
            let mut best_len: usize = 0;
            let mut best_dist: usize = 0;
            let mut j = ip;
            while j > start {
                j -= 1;
                let mut len = 0;
                while len < max_len && src[j + len] == src[ip + len] {
                    len += 1;
                }
                if len > best_len {
                    best_len = len;
                    best_dist = ip - j;
                    if len >= max_len { break; }
                }
            }
            if best_len >= MIN_MATCH {
                ctrl |= 1 << b;
                let code = ((best_dist - 1) << 4) | (best_len - MIN_MATCH);
                out[op]     = ((code >> 8) & 0xff) as u8;
                out[op + 1] = (code & 0xff) as u8;
                op += 2;
                ip += best_len;
            } else {
                out[op] = src[ip];
                op += 1;
                ip += 1;
            }
            b += 1;
        }
        out[ctrl_pos] = ctrl;
    }
    op
}

fn inflate(inp: &[u8; CAP], clen: usize, dst: &mut [u8; N]) -> usize {
    let mut ip: usize = 0;
    let mut op: usize = 0;
    while ip < clen {
        let ctrl = inp[ip];
        ip += 1;
        let mut b = 0;
        while b < 8 && ip < clen {
            if ctrl & (1 << b) != 0 {
                let code = ((inp[ip] as u32) << 8) | inp[ip + 1] as u32;
                ip += 2;
                let dist = (code >> 4) as usize + 1;
                let len  = (code & 0x0f) as usize + MIN_MATCH;
                for _ in 0..len {
                    dst[op] = dst[op - dist];
                    op += 1;
                }
            } else {
                dst[op] = inp[ip];
                op += 1;
                ip += 1;
            }
            b += 1;
        }
    }
    op
}

fn run_kernel(src: &mut [u8; N], comp: &mut [u8; CAP], dec: &mut [u8; N]) -> u32 {
    let mut h: u32 = 0;
    for it in 0..N_ITERS {
        let clen = compress(src, N, comp);
        let dlen = inflate(comp, clen, dec);
        let mut ok: u32 = if dlen == N { 1 } else { 0 };
        for i in 0..N {
            if dec[i] != src[i] { ok = 0; }
        }
        h = mix(h, clen as u32);
        for i in 0..clen {
            h = mix(h, comp[i] as u32);
        }
        h = mix(h, ok);
        let j = it % N;
        src[j] = src[j].wrapping_add(1);
    }
    h
}

fn main() {
    let mut src = Box::new([0u8; N]);
    let mut comp = Box::new([0u8; CAP]);
    let mut dec = Box::new([0u8; N]);
    init_buf(&mut src);
    let mut cs: u32 = 0;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut src, &mut comp, &mut dec);
    }
    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut src, &mut comp, &mut dec);
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

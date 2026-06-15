use std::time::Instant;

const W: i32 = 512;
const H: i32 = 512;
const R: i32 = 4;
const WIN: i32 = 2 * R + 1;
const N: usize = (W * H * 4) as usize;
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

fn mk_image(out: &mut [u8]) {
    let mut s = 0x1234abcdu32;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s & 255) as u8;
    }
}

fn hblur(src: &[u8], dst: &mut [u8], w: i32, h: i32, r: i32) {
    let win = 2 * r + 1;
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let (mut sr, mut sg, mut sb, mut sa) = (0i32, 0i32, 0i32, 0i32);
            for k in -r..=r {
                let mut xi = x + k;
                if xi < 0 {
                    xi = 0;
                } else if xi >= w {
                    xi = w - 1;
                }
                let p = ((row + xi) << 2) as usize;
                sr += src[p] as i32;
                sg += src[p + 1] as i32;
                sb += src[p + 2] as i32;
                sa += src[p + 3] as i32;
            }
            let o = ((row + x) << 2) as usize;
            dst[o] = (sr / win) as u8;
            dst[o + 1] = (sg / win) as u8;
            dst[o + 2] = (sb / win) as u8;
            dst[o + 3] = (sa / win) as u8;
        }
    }
}

fn vblur(src: &[u8], dst: &mut [u8], w: i32, h: i32, r: i32) {
    let win = 2 * r + 1;
    for y in 0..h {
        for x in 0..w {
            let (mut sr, mut sg, mut sb, mut sa) = (0i32, 0i32, 0i32, 0i32);
            for k in -r..=r {
                let mut yi = y + k;
                if yi < 0 {
                    yi = 0;
                } else if yi >= h {
                    yi = h - 1;
                }
                let p = ((yi * w + x) << 2) as usize;
                sr += src[p] as i32;
                sg += src[p + 1] as i32;
                sb += src[p + 2] as i32;
                sa += src[p + 3] as i32;
            }
            let o = ((y * w + x) << 2) as usize;
            dst[o] = (sr / win) as u8;
            dst[o + 1] = (sg / win) as u8;
            dst[o + 2] = (sb / win) as u8;
            dst[o + 3] = (sa / win) as u8;
        }
    }
}

fn main() {
    let mut img = vec![0u8; N];
    let mut tmp = vec![0u8; N];
    let mut out = vec![0u8; N];
    mk_image(&mut img);
    for _ in 0..N_WARMUP {
        hblur(&img, &mut tmp, W, H, R);
        vblur(&tmp, &mut out, W, H, R);
    }
    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        hblur(&img, &mut tmp, W, H, R);
        vblur(&tmp, &mut out, W, H, R);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }
    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_u8(&out),
        W * H,
        WIN,
        N_RUNS
    );
}

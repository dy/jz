use std::time::Instant;

const NPIX: usize = 256 * 256;
const IMG_LEN: usize = NPIX * 4;
const CAP: usize = NPIX * 5 + 64;
const N_ITERS: usize = 10;
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

fn mk_image(img: &mut [u8; IMG_LEN]) {
    let mut x: i32 = 0x12345678;
    let mut r: u8 = 128;
    let mut g: u8 = 128;
    let mut b: u8 = 128;
    let mut a: u8 = 255;
    for p in 0..NPIX {
        x = (x as u32).wrapping_mul(1103515245).wrapping_add(12345) as i32;
        let ux = x as u32;
        let roll = (ux >> 28) & 7;
        if roll < 3 {
            // keep previous pixel - run-length
        } else if roll < 6 {
            r = (r as i32 + (((ux >> 4) & 3) as i32 - 1)) as u8;
            g = (g as i32 + (((ux >> 6) & 3) as i32 - 1)) as u8;
            b = (b as i32 + (((ux >> 8) & 3) as i32 - 1)) as u8;
        } else if roll == 6 {
            r = ((ux >> 10) & 255) as u8;
            g = ((ux >> 16) & 255) as u8;
            b = ((ux >> 20) & 255) as u8;
        } else {
            a = ((ux >> 12) & 255) as u8;
        }
        let o = p << 2;
        img[o] = r; img[o+1] = g; img[o+2] = b; img[o+3] = a;
    }
}

fn encode(
    img: &[u8; IMG_LEN],
    ir: &mut [u8; 64], ig: &mut [u8; 64], ib: &mut [u8; 64], ia: &mut [u8; 64],
    comp: &mut [u8; CAP],
) -> usize {
    for i in 0..64 { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
    let mut pr: u8 = 0; let mut pg: u8 = 0; let mut pb: u8 = 0; let mut pa: u8 = 255;
    let mut run: i32 = 0;
    let mut op: usize = 0;
    for p in 0..NPIX {
        let o = p << 2;
        let r = img[o]; let g = img[o+1]; let b = img[o+2]; let a = img[o+3];
        if r == pr && g == pg && b == pb && a == pa {
            run += 1;
            if run == 62 || p == NPIX - 1 {
                comp[op] = 0xc0 | (run - 1) as u8; op += 1; run = 0;
            }
        } else {
            if run > 0 { comp[op] = 0xc0 | (run - 1) as u8; op += 1; run = 0; }
            let h = ((r as u32 * 3 + g as u32 * 5 + b as u32 * 7 + a as u32 * 11) & 63) as usize;
            if ir[h] == r && ig[h] == g && ib[h] == b && ia[h] == a {
                comp[op] = h as u8; op += 1;
            } else {
                ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a;
                if a == pa {
                    // signed-8-bit wraparound: (r as i8).wrapping_sub(pr as i8) as i32
                    let vr = (r as i8).wrapping_sub(pr as i8) as i32;
                    let vg = (g as i8).wrapping_sub(pg as i8) as i32;
                    let vb = (b as i8).wrapping_sub(pb as i8) as i32;
                    let vgr = vr - vg;
                    let vgb = vb - vg;
                    if vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1 {
                        comp[op] = (0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)) as u8;
                        op += 1;
                    } else if vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7 {
                        comp[op] = (0x80 | (vg + 32)) as u8; op += 1;
                        comp[op] = (((vgr + 8) << 4) | (vgb + 8)) as u8; op += 1;
                    } else {
                        comp[op] = 0xfe; op += 1;
                        comp[op] = r; op += 1;
                        comp[op] = g; op += 1;
                        comp[op] = b; op += 1;
                    }
                } else {
                    comp[op] = 0xff; op += 1;
                    comp[op] = r; op += 1;
                    comp[op] = g; op += 1;
                    comp[op] = b; op += 1;
                    comp[op] = a; op += 1;
                }
            }
        }
        pr = r; pg = g; pb = b; pa = a;
    }
    op
}

fn decode(
    comp: &[u8; CAP], clen: usize,
    ir: &mut [u8; 64], ig: &mut [u8; 64], ib: &mut [u8; 64], ia: &mut [u8; 64],
    dec: &mut [u8; IMG_LEN],
) {
    for i in 0..64 { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
    let mut pr: u8 = 0; let mut pg: u8 = 0; let mut pb: u8 = 0; let mut pa: u8 = 255;
    let mut run: i32 = 0;
    let mut ip: usize = 0;
    for p in 0..NPIX {
        if run > 0 {
            run -= 1;
        } else if ip < clen {
            let b0 = comp[ip] as i32; ip += 1;
            if b0 == 0xfe {
                pr = comp[ip]; ip += 1;
                pg = comp[ip]; ip += 1;
                pb = comp[ip]; ip += 1;
            } else if b0 == 0xff {
                pr = comp[ip]; ip += 1;
                pg = comp[ip]; ip += 1;
                pb = comp[ip]; ip += 1;
                pa = comp[ip]; ip += 1;
            } else if (b0 & 0xc0) == 0x00 {
                let idx = b0 as usize;
                pr = ir[idx]; pg = ig[idx]; pb = ib[idx]; pa = ia[idx];
            } else if (b0 & 0xc0) == 0x40 {
                pr = ((pr as i32) + ((b0 >> 4) & 3) - 2) as u8;
                pg = ((pg as i32) + ((b0 >> 2) & 3) - 2) as u8;
                pb = ((pb as i32) + (b0 & 3) - 2) as u8;
            } else if (b0 & 0xc0) == 0x80 {
                let b1 = comp[ip] as i32; ip += 1;
                let vg = (b0 & 63) - 32;
                pr = ((pr as i32) + vg + ((b1 >> 4) & 15) - 8) as u8;
                pg = ((pg as i32) + vg) as u8;
                pb = ((pb as i32) + vg + (b1 & 15) - 8) as u8;
            } else {
                run = b0 & 63;
            }
            let h = ((pr as u32 * 3 + pg as u32 * 5 + pb as u32 * 7 + pa as u32 * 11) & 63) as usize;
            ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa;
        }
        let o = p << 2;
        dec[o] = pr; dec[o+1] = pg; dec[o+2] = pb; dec[o+3] = pa;
    }
}

fn run_kernel(
    img: &mut [u8; IMG_LEN],
    ir: &mut [u8; 64], ig: &mut [u8; 64], ib: &mut [u8; 64], ia: &mut [u8; 64],
    comp: &mut [u8; CAP],
    dec: &mut [u8; IMG_LEN],
) -> u32 {
    let mut h: u32 = 0;
    for it in 0..N_ITERS {
        let clen = encode(img, ir, ig, ib, ia, comp);
        decode(comp, clen, ir, ig, ib, ia, dec);
        let mut ok: u32 = 1;
        for i in 0..IMG_LEN { if dec[i] != img[i] { ok = 0; } }
        h = mix(h, clen as u32);
        for i in 0..clen { h = mix(h, comp[i] as u32); }
        h = mix(h, ok);
        let j = (it % NPIX) << 2;
        img[j] = img[j].wrapping_add(1);
    }
    h
}

fn main() {
    let mut img = Box::new([0u8; IMG_LEN]);
    let mut ir = Box::new([0u8; 64]);
    let mut ig = Box::new([0u8; 64]);
    let mut ib = Box::new([0u8; 64]);
    let mut ia = Box::new([0u8; 64]);
    let mut comp = Box::new([0u8; CAP]);
    let mut dec = Box::new([0u8; IMG_LEN]);
    mk_image(&mut img);
    let mut cs: u32 = 0;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut img, &mut ir, &mut ig, &mut ib, &mut ia, &mut comp, &mut dec);
    }
    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut img, &mut ir, &mut ig, &mut ib, &mut ia, &mut comp, &mut dec);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        NPIX * N_ITERS,
        1,
        N_RUNS
    );
}

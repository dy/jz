use std::time::Instant;

const CIN: usize = 4;
const COUT: usize = 16;
const H: usize = 34;
const W: usize = 34;
const K: usize = 3;
const OH: usize = H - K + 1; // 32
const OW: usize = W - K + 1; // 32
const IN_LEN: usize = CIN * H * W;
const WT_LEN: usize = COUT * CIN * K * K;
const OUT_LEN: usize = COUT * OH * OW;
const SHIFT: u32 = 11;
const N_ITERS: usize = 24;
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

fn fill_i8(arr: &mut [i8], seed: i32) {
    let mut x = seed;
    for a in arr.iter_mut() {
        x = (x as u32).wrapping_mul(1103515245).wrapping_add(12345) as i32;
        *a = (x >> 24) as i8;
    }
}

fn fill_bias(arr: &mut [i32], seed: i32) {
    let mut x = seed;
    for a in arr.iter_mut() {
        x = (x as u32).wrapping_mul(1103515245).wrapping_add(12345) as i32;
        *a = (x >> 20) & 1023;
    }
}

fn conv(inp: &[i8], wt: &[i8], bias: &[i32], out: &mut [u8]) {
    for oc in 0..COUT {
        let b = bias[oc];
        let oc_base = oc * OH * OW;
        for oy in 0..OH {
            for ox in 0..OW {
                let mut acc: i32 = b;
                for ic in 0..CIN {
                    let in_ch = ic * H * W;
                    let w_ch = ((oc * CIN) + ic) * K * K;
                    for ky in 0..K {
                        let irow = in_ch + (oy + ky) * W + ox;
                        let wrow = w_ch + ky * K;
                        for kx in 0..K {
                            acc += inp[irow + kx] as i32 * wt[wrow + kx] as i32;
                        }
                    }
                }
                let mut q = acc >> SHIFT;
                if q < 0   { q = 0; }
                if q > 127 { q = 127; }
                out[oc_base + oy * OW + ox] = q as u8;
            }
        }
    }
}

fn run_kernel(inp: &mut [i8], wt: &[i8], bias: &[i32], out: &mut [u8]) -> u32 {
    let mut h = 0u32;
    for it in 0..N_ITERS {
        conv(inp, wt, bias, out);
        h = mix(h, checksum_u8(out));
        let j = it % IN_LEN;
        inp[j] = inp[j].wrapping_add(1);
    }
    h
}

fn main() {
    let mut inp = vec![0i8; IN_LEN];
    let mut wt  = vec![0i8; WT_LEN];
    let mut bias = vec![0i32; COUT];
    let mut out  = vec![0u8; OUT_LEN];
    fill_i8(&mut inp, 0x12345678u32 as i32);
    fill_i8(&mut wt,  0x2bb3c1f7u32 as i32);
    fill_bias(&mut bias, 0x51e3a9d1u32 as i32);
    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut inp, &wt, &bias, &mut out);
    }
    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut inp, &wt, &bias, &mut out);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        COUT * OH * OW * CIN * K * K * N_ITERS,
        1,
        N_RUNS
    );
}

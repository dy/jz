use std::time::Instant;

const N: usize = 1 << 16;
const LOG2N: usize = 16;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
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

fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))))
}
fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))))
}

fn build_twiddles(wre: &mut [f64], wim: &mut [f64], n: usize) {
    let dt = -6.283185307179586 / n as f64;
    let c1 = cos_poly(dt);
    let s1 = sin_poly(dt);
    let mut cr = 1.0f64;
    let mut ci = 0.0f64;
    for k in 0..(n >> 1) {
        wre[k] = cr;
        wim[k] = ci;
        let nr = cr * c1 - ci * s1;
        let ni = cr * s1 + ci * c1;
        cr = nr;
        ci = ni;
    }
}

fn fft(re: &mut [f64], im: &mut [f64], wre: &[f64], wim: &[f64], n: usize) {
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let step = n / len;
        let mut i = 0usize;
        while i < n {
            let mut k = 0usize;
            for jj in 0..half {
                let wr = wre[k];
                let wi = wim[k];
                let a = i + jj;
                let b = a + half;
                let xr = re[b];
                let xi = im[b];
                let tr = wr * xr - wi * xi;
                let ti = wr * xi + wi * xr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                k += step;
            }
            i += len;
        }
        len <<= 1;
    }
}

fn mk_signal(out: &mut [f64]) {
    let mut s = 0x1234abcdu32;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4294967296.0) * 2.0 - 1.0;
    }
}

fn main() {
    let mut sig = vec![0.0f64; N];
    let mut re = vec![0.0f64; N];
    let mut im = vec![0.0f64; N];
    let mut wre = vec![0.0f64; N >> 1];
    let mut wim = vec![0.0f64; N >> 1];
    mk_signal(&mut sig);
    build_twiddles(&mut wre, &mut wim, N);

    let reset = |re: &mut [f64], im: &mut [f64]| {
        for i in 0..N {
            re[i] = sig[i];
            im[i] = 0.0;
        }
    };

    for _ in 0..N_WARMUP {
        reset(&mut re, &mut im);
        fft(&mut re, &mut im, &wre, &wim, N);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        reset(&mut re, &mut im);
        let t0 = Instant::now();
        fft(&mut re, &mut im, &wre, &wim, N);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&re),
        (N * LOG2N) >> 1,
        LOG2N,
        N_RUNS
    );
}

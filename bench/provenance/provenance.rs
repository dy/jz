// provenance.rs – one radix-2 FFT kernel (N = 2048) run over four bit-identical
// twiddle tables that differ only in how they reach it.
//
// Ports provenance.js as written. The four provenances are where the table
// slices come from:
//   ret    mk_tw_re / mk_tw_im each return an owned Vec<f64>
//   field  mk_tw_pair returns a TwPair struct; the kernel reads its fields
//   map    get_cached returns a reference into a HashMap<usize, TwPair> keyed
//          by size, the JS's module-level Map, held in main
//   memo   Memo::get returns the last-plan TwPair it owns, replaced when the
//          size changes, the JS's module-global memo, held in main (it is
//          mutable state, so neither a static nor a OnceLock)
// Each maker builds both tables, as the JS does, and drops the one it does not
// return. The tables come from an in-source Taylor sin/cos of the base angle
// and a complex recurrence (no libm), and the butterflies are +/−/× in the JS's
// order, so the output is bit-identical everywhere. The JS's edge closure is a
// function taking the buffers it captures; runAll stays a closure.
//
// Reports: median µs across N_RUNS, an FNV-1a hash of re[7] (scaled by 2^20,
// truncated to int32) after every transform of every edge.
use std::collections::HashMap;
use std::time::Instant;

const N: usize = 2048;
const LOG2N: usize = 11;
const FRAMES: usize = 24; // transforms per edge per timed sample
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

fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))))
}
fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))))
}

// Fill wre/wim with W_k = exp(-i·2πk/N) for k in [0, N/2): recurrence, no libm.
fn fill_tw(wre: &mut [f64], wim: &mut [f64], n: usize) {
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

// --- the four provenance edges (identical table content) --------------------
fn mk_tw_re(n: usize) -> Vec<f64> {
    let mut wre = vec![0.0f64; n >> 1];
    let mut wim = vec![0.0f64; n >> 1];
    fill_tw(&mut wre, &mut wim, n);
    wre
}

fn mk_tw_im(n: usize) -> Vec<f64> {
    let mut wre = vec![0.0f64; n >> 1];
    let mut wim = vec![0.0f64; n >> 1];
    fill_tw(&mut wre, &mut wim, n);
    wim
}

struct TwPair {
    wre: Vec<f64>,
    wim: Vec<f64>,
}

fn mk_tw_pair(n: usize) -> TwPair {
    let mut wre = vec![0.0f64; n >> 1];
    let mut wim = vec![0.0f64; n >> 1];
    fill_tw(&mut wre, &mut wim, n);
    TwPair { wre, wim }
}

fn get_cached(cache: &mut HashMap<usize, TwPair>, n: usize) -> &TwPair {
    cache.entry(n).or_insert_with(|| mk_tw_pair(n))
}

struct Memo {
    last_n: usize,
    last_plan: Option<TwPair>,
}

impl Memo {
    fn get(&mut self, n: usize) -> &TwPair {
        if n != self.last_n {
            self.last_plan = Some(mk_tw_pair(n));
            self.last_n = n;
        }
        self.last_plan.as_ref().unwrap()
    }
}

// --- hot kernel: same butterflies as the fft case ---------------------------
fn transform(re: &mut [f64], im: &mut [f64], wre: &[f64], wim: &[f64], n: usize) {
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
                let t2 = wr * xi + wi * xr;
                re[b] = re[a] - tr;
                im[b] = im[a] - t2;
                re[a] += tr;
                im[a] += t2;
                k += step;
            }
            i += len;
        }
        len <<= 1;
    }
}

// Deterministic real input in [-1, 1): XorShift32, bit-identical per target.
fn mk_signal(out: &mut [f64]) {
    let mut s = 0x1234abcdu32;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4294967296.0) * 2.0 - 1.0;
    }
}

fn edge(re: &mut [f64], im: &mut [f64], sig: &[f64], wre: &[f64], wim: &[f64], mut h: u32) -> u32 {
    for _ in 0..FRAMES {
        for i in 0..N {
            re[i] = sig[i];
            im[i] = 0.0;
        }
        transform(re, im, wre, wim, N);
        h = mix(h, (re[7] * 1048576.0) as i32 as u32);
    }
    h
}

fn main() {
    let mut sig = vec![0.0f64; N];
    let mut re = vec![0.0f64; N];
    let mut im = vec![0.0f64; N];
    mk_signal(&mut sig);

    // edge 1: direct returns
    let wre_ret = mk_tw_re(N);
    let wim_ret = mk_tw_im(N);
    // edge 2: returned-struct fields
    let pair = mk_tw_pair(N);
    // edge 3: map-cached plan fields
    let mut cache = HashMap::new();
    let cached = get_cached(&mut cache, N);
    // edge 4: memo fields
    let mut memo = Memo { last_n: 0, last_plan: None };
    let memoed = memo.get(N);

    let mut run_all = || -> u32 {
        let mut h = 0x811c_9dc5u32;
        h = edge(&mut re, &mut im, &sig, &wre_ret, &wim_ret, h);
        h = edge(&mut re, &mut im, &sig, &pair.wre, &pair.wim, h);
        h = edge(&mut re, &mut im, &sig, &cached.wre, &cached.wim, h);
        h = edge(&mut re, &mut im, &sig, &memoed.wre, &memoed.wim, h);
        h
    };

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_all();
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = run_all();
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        cs,
        4 * FRAMES * ((N * LOG2N) >> 1),
        4,
        N_RUNS
    );
}

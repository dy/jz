// fftplan.rs – cached-plan FFT: forward and inverse radix-2 transforms of an
// audio frame (N = 2048) through a plan built once per size, the way DSP
// libraries ship FFT.
//
// Ports fftplan.js as written. A plan is a struct owning its bit-reversal table
// (Vec<u32>, the JS Uint32Array) and three packed per-stage twiddle tables (the
// shared cosines, the forward and the inverse sines). make_plan builds them from
// a transcendental-free base table (an in-source Taylor sin/cos of 2π/n and a
// complex recurrence). The JS's module-level Map cache and last-plan memo are a
// Planner held in main and passed down: plans are Rc<Plan> in a
// HashMap<usize, _>, shared with the memo that answers a repeated size before
// the map lookup, as the JS does. The kernel receives the plan's tables as slice
// parameters; its butterflies are +/−/× in the JS's order, so the output is
// bit-identical everywhere.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over the final frame's real
// part (benchlib checksumF64), with the per-frame accumulator folded into re[0]
// so no frame is dead code.
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

const N: usize = 2048; // transform size: an audio frame (pvoc hop grain)
const LOG2N: usize = 11;
const FRAMES: usize = 64; // fwd + inv round trips per timed sample
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

struct Plan {
    perm: Vec<u32>,
    tw_re: Vec<f64>,
    tw_fwd: Vec<f64>,
    tw_inv: Vec<f64>,
}

fn make_plan(n: usize) -> Plan {
    let bits = n.ilog2();
    let mut perm = vec![0u32; n];
    for i in 0..n {
        let mut rev = 0u32;
        let mut v = i as u32;
        for _ in 0..bits {
            rev = (rev << 1) | (v & 1);
            v >>= 1;
        }
        perm[i] = rev;
    }
    // base table: cos/sin of 2π k/n for k in [0, n/2) via recurrence from 2π/n
    let half = n >> 1;
    let mut base_c = vec![0.0f64; half];
    let mut base_s = vec![0.0f64; half];
    let dt = 6.283185307179586 / n as f64;
    let c1 = cos_poly(dt);
    let s1 = sin_poly(dt);
    let mut cr = 1.0f64;
    let mut ci = 0.0f64;
    for k in 0..half {
        base_c[k] = cr;
        base_s[k] = ci;
        let nr = cr * c1 - ci * s1;
        let ni = cr * s1 + ci * c1;
        cr = nr;
        ci = ni;
    }
    // packed per-stage tables: stage len keeps its half twiddles at [ti, ti+half);
    // entry j is the base entry j·(n/len)
    let mut tw_re = vec![0.0f64; n];
    let mut tw_fwd = vec![0.0f64; n];
    let mut tw_inv = vec![0.0f64; n];
    let mut ti = 0usize;
    let mut len = 2usize;
    while len <= n {
        let h = len >> 1;
        let stride = n / len;
        for j in 0..h {
            let c = base_c[j * stride];
            let s = base_s[j * stride];
            tw_re[ti] = c;
            tw_fwd[ti] = -s;
            tw_inv[ti] = s;
            ti += 1;
        }
        len <<= 1;
    }
    Plan { perm, tw_re, tw_fwd, tw_inv }
}

struct Planner {
    cache: HashMap<usize, Rc<Plan>>,
    last: Option<(usize, Rc<Plan>)>,
}

impl Planner {
    fn new() -> Planner {
        Planner { cache: HashMap::new(), last: None }
    }

    fn get(&mut self, n: usize) -> Rc<Plan> {
        if let Some((last_n, plan)) = &self.last {
            if *last_n == n {
                return Rc::clone(plan);
            }
        }
        let plan = Rc::clone(self.cache.entry(n).or_insert_with(|| Rc::new(make_plan(n))));
        self.last = Some((n, Rc::clone(&plan)));
        plan
    }
}

// hot kernel: the tables arrive as parameters from the plan
fn transform(re: &mut [f64], im: &mut [f64], perm: &[u32], tw_re: &[f64], tw_im: &[f64], n: usize) {
    for i in 0..n {
        let j = perm[i] as usize;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut ti = 0usize;
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let mut i = 0usize;
        while i < n {
            for j in 0..half {
                let wr = tw_re[ti + j];
                let wi = tw_im[ti + j];
                let a = i + j;
                let b = a + half;
                let xr = re[b];
                let xi = im[b];
                let tr = wr * xr - wi * xi;
                let t2 = wr * xi + wi * xr;
                re[b] = re[a] - tr;
                im[b] = im[a] - t2;
                re[a] += tr;
                im[a] += t2;
            }
            i += len;
        }
        ti += half;
        len <<= 1;
    }
}

fn cfft(planner: &mut Planner, re: &mut [f64], im: &mut [f64], n: usize) {
    let plan = planner.get(n);
    transform(re, im, &plan.perm, &plan.tw_re, &plan.tw_fwd, n);
}

fn cifft(planner: &mut Planner, re: &mut [f64], im: &mut [f64], n: usize) {
    let plan = planner.get(n);
    transform(re, im, &plan.perm, &plan.tw_re, &plan.tw_inv, n);
    let inv = 1.0 / n as f64;
    for i in 0..n {
        re[i] *= inv;
        im[i] *= inv;
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

fn frames(planner: &mut Planner, re: &mut [f64], im: &mut [f64], sig: &[f64]) -> f64 {
    let mut acc = 0.0f64;
    for f in 0..FRAMES {
        for i in 0..N {
            re[i] = sig[i];
            im[i] = 0.0;
        }
        cfft(planner, re, im, N);
        cifft(planner, re, im, N);
        acc += re[f & (N - 1)];
    }
    acc
}

fn main() {
    let mut sig = vec![0.0f64; N];
    let mut re = vec![0.0f64; N];
    let mut im = vec![0.0f64; N];
    let mut planner = Planner::new();
    mk_signal(&mut sig);

    for _ in 0..N_WARMUP {
        frames(&mut planner, &mut re, &mut im, &sig);
    }

    let mut samples = [0.0; N_RUNS];
    let mut acc = 0.0f64;
    for sample in &mut samples {
        let t0 = Instant::now();
        acc = frames(&mut planner, &mut re, &mut im, &sig);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }
    re[0] = acc; // fold the per-frame accumulator in: no frame is dead code

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&re),
        FRAMES * 2 * ((N * LOG2N) >> 1),
        LOG2N,
        N_RUNS
    );
}

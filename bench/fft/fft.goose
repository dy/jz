// fft.goose: Goose port of fft.js (same signal, twiddles and checksum):
// in-place radix-2 Cooley-Tukey FFT over a transcendental-free twiddle table.

import bench from "../_lib";

let N = 1 << 16;            // transform size (power of two): 65536
let LOG2N = 16;
let N_RUNS = 21;
let N_WARMUP = 5;

// Transcendental-free trig (Taylor, Horner form, no libm): the same sequence
// of f64 + and * in every language.
fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))));
}

fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    return 1 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))));
}

// Twiddles W_k = exp(-i·2πk/N) for k in [0, N/2), by complex recurrence from W_1.
fn build_twiddles(wre: f64[:], wim: f64[:], n: i64) {
    let dt = -6.283185307179586 / n;      // -2π/N (forward transform)
    let c1 = cos_poly(dt);
    let s1 = sin_poly(dt);
    var cr = 1.0;
    var ci = 0.0;
    for k in n >> 1 {
        wre[k] = cr;
        wim[k] = ci;
        let nr = cr * c1 - ci * s1;
        let ni = cr * s1 + ci * c1;
        cr = nr;
        ci = ni;
    }
}

fn fft(re: f64[:], im: f64[:], wre: f64[:], wim: f64[:], n: i64) {
    // in-place bit-reversal permutation
    var j = 0;
    for i in 1..n {
        var bit = n >> 1;
        while j & bit != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j {
            let tr = re[i]; re[i] = re[j]; re[j] = tr;
            let ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    // log2(n) butterfly passes
    var len = 2;
    while len <= n {
        let half = len >> 1;
        let step = n / len;
        var i = 0;
        while i < n {
            var k = 0;
            for j in half {
                let wr = wre[k];
                let wi = wim[k];
                let a = i + j;
                let b = a + half;
                let xr = re[b];
                let xi = im[b];
                let tr = wr * xr - wi * xi;
                let ti = wr * xi + wi * xr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] = re[a] + tr;
                im[a] = im[a] + ti;
                k += step;
            }
            i += len;
        }
        len <<= 1;
    }
}

// Deterministic real input in [-1, 1): XorShift32, bit-identical per target.
fn mk_signal(n: i64) -> f64[>..] {
    var out: f64[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push(s / 4294967296.0 * 2 - 1);
    }
    return out;
}

fn main() {
    let sig = mk_signal(N);
    var re: f64[>..] = [];
    var im: f64[>..] = [];
    var wre: f64[>..] = [];
    var wim: f64[>..] = [];
    re.resize(N, 0.0);
    im.resize(N, 0.0);
    wre.resize(N >> 1, 0.0);
    wim.resize(N >> 1, 0.0);
    build_twiddles(wre, wim, N);

    fn reset() {
        for i in N { re[i] = sig[i]; im[i] = 0.0; }
    }

    for i in N_WARMUP { reset(); fft(re, im, wre, wim, N); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        reset();
        let t0 = now_ms();
        fft(re, im, wre, wim, N);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(re), (N * LOG2N) >> 1, LOG2N, N_RUNS);
}

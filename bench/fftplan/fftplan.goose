// fftplan.goose: Goose port of fftplan.js (same signal, plan and checksum):
// forward and inverse radix-2 FFTs through a cached plan, as JS DSP libraries
// ship them. A plan is one record holding its permutation and twiddle tables
// inline; plans live in a grow-only pool, cached by size in the standard
// library's dictionary, with the last plan memoized in a global reference.

import bench from "../_lib";
import dictionary;

let N = 2048;               // transform size: audio frame (pvoc hop grain)
let LOG2N = 11;
let FRAMES = 64;            // fwd + inv round trips per timed sample
let N_RUNS = 21;
let N_WARMUP = 5;

struct Plan { perm: u32[], tw_re: f64[], tw_fwd: f64[], tw_inv: f64[] }

fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))));
}

fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    return 1 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))));
}

var plans: Plan[>..];
var cache = dictionary<i64, Plan?> {};
var last_n = 0;
var last_plan: Plan?;

fn make_plan(n: i64) -> Plan {
    let bits = 63 - clz(n as u64);
    var perm: u32[>..] = [];
    for i in n {
        var rev: u32 = 0;
        var v = i;
        for j in bits { rev = (rev << 1) | (v & 1) as u32; v >>= 1; }
        perm.push(rev);
    }
    let half = n >> 1;
    var base_c: f64[>..] = [];
    var base_s: f64[>..] = [];
    let dt = 6.283185307179586 / n;
    let c1 = cos_poly(dt);
    let s1 = sin_poly(dt);
    var cr = 1.0;
    var ci = 0.0;
    for k in half {
        base_c.push(cr);
        base_s.push(ci);
        let nr = cr * c1 - ci * s1;
        let ni = cr * s1 + ci * c1;
        cr = nr;
        ci = ni;
    }
    var tw_re: f64[>..] = [];
    var tw_fwd: f64[>..] = [];
    var tw_inv: f64[>..] = [];
    var len = 2;
    while len <= n {
        let h = len >> 1;
        let stride = n / len;
        for j in h {
            let c = base_c[j * stride];
            let s = base_s[j * stride];
            tw_re.push(c);
            tw_fwd.push(-s);
            tw_inv.push(s);
        }
        len <<= 1;
    }
    return Plan { perm: copy(perm), tw_re: copy(tw_re), tw_fwd: copy(tw_fwd), tw_inv: copy(tw_inv) };
}

fn get_plan(n: i64) -> Plan& {
    if n == last_n {
        let l = last_plan;
        if l { return l; }
    }
    var p = cache.get(n);
    if !p {
        let made .= plans.push(make_plan(n));
        cache.insert(n, made);
        p .= made;
    }
    guard p else { abort("no plan"); }
    last_n = n;
    last_plan .= p;
    return p;
}

fn transform(re: f64[:], im: f64[:], perm: u32[:], tw_re: f64[:], tw_im: f64[:], n: i64) {
    for i in n {
        let j = perm[i];
        if i < j {
            let tr = re[i]; re[i] = re[j]; re[j] = tr;
            let t2 = im[i]; im[i] = im[j]; im[j] = t2;
        }
    }
    var ti = 0;
    var len = 2;
    while len <= n {
        let half = len >> 1;
        var i = 0;
        while i < n {
            for j in half {
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
                re[a] = re[a] + tr;
                im[a] = im[a] + t2;
            }
            i += len;
        }
        ti += half;
        len <<= 1;
    }
}

fn cfft(re: f64[:], im: f64[:], n: i64) {
    let plan .= get_plan(n);
    transform(re, im, plan.perm, plan.tw_re, plan.tw_fwd, n);
}

fn cifft(re: f64[:], im: f64[:], n: i64) {
    let plan .= get_plan(n);
    transform(re, im, plan.perm, plan.tw_re, plan.tw_inv, n);
    let inv = 1.0 / n;
    for i in n { re[i] *= inv; im[i] *= inv; }
}

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
    re.resize(N, 0.0);
    im.resize(N, 0.0);
    fn frames() -> f64 {
        var acc = 0.0;
        for f in FRAMES {
            for i in N { re[i] = sig[i]; im[i] = 0.0; }
            cfft(re, im, N);
            cifft(re, im, N);
            acc += re[f & (N - 1)];
        }
        return acc;
    }
    for i in N_WARMUP { frames(); }

    var samples = [0.0; N_RUNS];
    var acc = 0.0;
    for &t in samples {
        let t0 = now_ms();
        acc = frames();
        t = now_ms() - t0;
    }
    re[0] = acc;        // fold the per-frame accumulator in: no frame is dead code
    print_result(median_us(samples), checksum_f64(re), FRAMES * 2 * ((N * LOG2N) >> 1), LOG2N, N_RUNS);
}

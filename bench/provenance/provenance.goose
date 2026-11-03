// provenance.goose: Goose port of provenance.js (same signal, tables and
// checksum): one FFT kernel over four bit-identical twiddle tables reached
// four ways: returned directly, a field of a returned record, a field of a
// record cached by size in the standard library's dictionary, and a
// module-level memo. Goose's types are static, so every way reaches the same
// kernel; the case keeps the four ways and their work.

import bench from "../_lib";
import dictionary;

let N = 2048;
let LOG2N = 11;
let FRAMES = 24;            // transforms per edge per timed sample
let N_RUNS = 21;
let N_WARMUP = 5;

struct Pair { wre: f64[], wim: f64[] }

fn sin_poly(x: f64) -> f64 {
    let x2 = x * x;
    return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))));
}

fn cos_poly(x: f64) -> f64 {
    let x2 = x * x;
    return 1 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))));
}

fn fill_tw(wre: f64[:], wim: f64[:], n: i64) {
    let dt = -6.283185307179586 / n;
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

fn zeros(n: i64) -> f64[>..] {
    var b: f64[>..] = [];
    b.resize(n, 0.0);
    return b;
}

fn mk_tw_re(n: i64) -> f64[>..] {
    var wre = zeros(n >> 1);
    var wim = zeros(n >> 1);
    fill_tw(wre, wim, n);
    return wre;
}

fn mk_tw_im(n: i64) -> f64[>..] {
    var wre = zeros(n >> 1);
    var wim = zeros(n >> 1);
    fill_tw(wre, wim, n);
    return wim;
}

fn mk_tw_pair(n: i64) -> Pair {
    var p = Pair { wre: zeros(n >> 1), wim: zeros(n >> 1) };
    fill_tw(p.wre, p.wim, n);
    return p;
}

var pairs: Pair[>..];
var cache = dictionary<i64, Pair?> {};

fn get_cached(n: i64) -> Pair& {
    var p = cache.get(n);
    if !p {
        let made .= pairs.push(mk_tw_pair(n));
        cache.insert(n, made);
        p .= made;
    }
    guard p else { abort("no tables"); }
    return p;
}

var memos: Pair[>..];
var last_n = 0;
var last_plan: Pair?;

fn get_memo(n: i64) -> Pair& {
    if n == last_n {
        let l = last_plan;
        if l { return l; }
    }
    let made .= memos.push(mk_tw_pair(n));
    last_plan .= made;
    last_n = n;
    return made;
}

fn transform(re: f64[:], im: f64[:], wre: f64[:], wim: f64[:], n: i64) {
    var j = 0;
    for i in 1..n {
        var bit = n >> 1;
        while j & bit != 0 { j ^= bit; bit >>= 1; }
        j ^= bit;
        if i < j {
            let tr = re[i]; re[i] = re[j]; re[j] = tr;
            let t2 = im[i]; im[i] = im[j]; im[j] = t2;
        }
    }
    var len = 2;
    while len <= n {
        let half = len >> 1;
        let step = n / len;
        var i = 0;
        while i < n {
            var k = 0;
            for jj in half {
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
                re[a] = re[a] + tr;
                im[a] = im[a] + t2;
                k += step;
            }
            i += len;
        }
        len <<= 1;
    }
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
    let wre_ret = mk_tw_re(N);
    let wim_ret = mk_tw_im(N);
    let pair = mk_tw_pair(N);
    let cached .= get_cached(N);
    let memo .= get_memo(N);
    fn edge(wre: f64[:], wim: f64[:], h0: u32) -> u32 {
        var h = h0;
        for f in FRAMES {
            for i in N { re[i] = sig[i]; im[i] = 0.0; }
            transform(re, im, wre, wim, N);
            h = mix(h, (re[7] * 1048576) as i64 as! u32);
        }
        return h;
    }
    fn run_all() -> u32 {
        var h: u32 = 0x811c9dc5;
        h = edge(wre_ret, wim_ret, h);
        h = edge(pair.wre, pair.wim, h);
        h = edge(cached.wre, cached.wim, h);
        h = edge(memo.wre, memo.wim, h);
        return h;
    }
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_all(); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        cs = run_all();
        t = now_ms() - t0;
    }
    print_result(median_us(samples), cs, 4 * FRAMES * ((N * LOG2N) >> 1), 4, N_RUNS);
}

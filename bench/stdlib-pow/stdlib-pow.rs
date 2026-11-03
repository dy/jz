// stdlib-pow.rs – x^y swept over 2^20 argument pairs through @stdlib/math/base/special/pow
// from stdlib 0.4.1 (Apache-2.0; Copyright (c) The Stdlib Authors), FreeBSD
// msun's pow by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-pow.js holds: every function pow
// reaches is a Rust fn named after its stdlib package (pow, ldexp, normalize,
// exponent, copysign, is_odd, is_even, is_integer, is_nan, is_infinite, abs,
// uint32_to_int32, the float64 word accessors) or, for pow's private modules,
// after the module (x_is_zero, y_is_huge, y_is_infinite, log2ax, logx, pow2,
// and the generated polyval_l, polyval_w, polyval_p), with the constants, the
// Horner evaluators and every branch unchanged. Constants that two of pow's
// modules each define with one value are defined once. The float64 word
// accessors, which the JavaScript performs through a Float64Array and a
// Uint32Array over one buffer, are f64::to_bits/from_bits; the two-element
// arrays the JavaScript fills (toWords, log2ax, logx, normalize) are returned
// tuples. Words are u32 and the JavaScript's `| 0` values i32; where the
// JavaScript adds or subtracts words past 32 bits and reads the result back
// through ToInt32 or ToUint32 (pow2's high word, the underflow test), the Rust
// wraps in u32.
//
// The sweep follows the package's benchmark: 4096 bases uniform in [0, 100]
// (XorShift32 from 0x1234abcd) paired with 4096 exponents uniform in [-50, 50]
// (from 0x9e3779b9), 2^20 evaluations per run cycling through the pairs, 5
// warmup runs, the median of 21 timed. Checksum: benchlib checksumF64 over the
// 2^20 results.
use std::time::Instant;

const N_IN: usize = 4096;
const N_EVAL: usize = 1 << 20;
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

// @stdlib/constants/float64/*
const FLOAT64_PINF: f64 = f64::INFINITY;
const FLOAT64_NINF: f64 = f64::NEG_INFINITY;
const FLOAT64_SMALLEST_NORMAL: f64 = 2.2250738585072014e-308;
const LN2: f64 = 0.6931471805599453;
const FLOAT64_EXPONENT_BIAS: i32 = 1023;
const FLOAT64_MAX_BASE2_EXPONENT: i32 = 1023;
const FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL: i32 = -1023;
const FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL: i32 = -1074;
const FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS: i32 = 20;
const FLOAT64_HIGH_WORD_SIGN_MASK: u32 = 0x8000_0000;
const FLOAT64_HIGH_WORD_ABS_MASK: u32 = 0x7fff_ffff;
const FLOAT64_HIGH_WORD_EXPONENT_MASK: u32 = 0x7ff0_0000;
const FLOAT64_HIGH_WORD_SIGNIFICAND_MASK: u32 = 0x000f_ffff;

// @stdlib/math/base/assert/is-nan
fn is_nan(x: f64) -> bool {
    x != x
}

// @stdlib/math/base/assert/is-integer
fn is_integer(x: f64) -> bool {
    x.floor() == x
}

// @stdlib/math/base/assert/is-even
fn is_even(x: f64) -> bool {
    is_integer(x / 2.0)
}

// @stdlib/math/base/assert/is-odd
fn is_odd(x: f64) -> bool {
    if x > 0.0 {
        return is_even(x - 1.0);
    }
    is_even(x + 1.0)
}

// @stdlib/math/base/assert/is-infinite
fn is_infinite(x: f64) -> bool {
    x == FLOAT64_PINF || x == FLOAT64_NINF
}

// @stdlib/math/base/special/abs
fn abs(x: f64) -> f64 {
    x.abs()
}

// @stdlib/number/float64/base/to-words
fn to_words(x: f64) -> (u32, u32) {
    let w = x.to_bits();
    ((w >> 32) as u32, w as u32)
}

// @stdlib/number/float64/base/get-high-word
fn get_high_word(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

// @stdlib/number/float64/base/from-words
fn from_words(high: u32, low: u32) -> f64 {
    f64::from_bits(((high as u64) << 32) | low as u64)
}

// @stdlib/number/float64/base/set-low-word
fn set_low_word(x: f64, low: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xffff_ffff_0000_0000) | low as u64)
}

// @stdlib/number/float64/base/set-high-word
fn set_high_word(x: f64, high: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0x0000_0000_ffff_ffff) | ((high as u64) << 32))
}

// @stdlib/number/uint32/base/to-int32
fn uint32_to_int32(x: u32) -> i32 {
    x as i32
}

// @stdlib/math/base/special/copysign
fn copysign(x: f64, y: f64) -> f64 {
    let (mut hx, lx) = to_words(x);
    hx &= FLOAT64_HIGH_WORD_ABS_MASK;
    let mut hy = get_high_word(y);
    hy &= FLOAT64_HIGH_WORD_SIGN_MASK;
    hx |= hy;
    from_words(hx, lx)
}

// @stdlib/number/float64/base/exponent
fn exponent(x: f64) -> i32 {
    let mut high = get_high_word(x);
    high = (high & FLOAT64_HIGH_WORD_EXPONENT_MASK) >> 20;
    high as i32 - FLOAT64_EXPONENT_BIAS
}

// @stdlib/number/float64/base/normalize
const SCALAR: f64 = 4503599627370496.0;

fn normalize(x: f64) -> (f64, i32) {
    if is_nan(x) || is_infinite(x) {
        return (x, 0);
    }
    if x != 0.0 && abs(x) < FLOAT64_SMALLEST_NORMAL {
        return (x * SCALAR, -52);
    }
    (x, 0)
}

// @stdlib/math/base/special/ldexp
const TWO52_INV: f64 = 2.220446049250313e-16;
const CLEAR_EXP_MASK: u32 = 0x800f_ffff;

fn ldexp(frac: f64, exp: i32) -> f64 {
    if exp == 0 || frac == 0.0 || is_nan(frac) || is_infinite(frac) {
        return frac;
    }
    let (frac, e) = normalize(frac);
    let mut exp = exp + e;
    exp += exponent(frac);
    if exp < FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL {
        return copysign(0.0, frac);
    }
    if exp > FLOAT64_MAX_BASE2_EXPONENT {
        if frac < 0.0 {
            return FLOAT64_NINF;
        }
        return FLOAT64_PINF;
    }
    let m;
    if exp <= FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL {
        exp += 52;
        m = TWO52_INV;
    } else {
        m = 1.0;
    }
    let (mut high, low) = to_words(frac);
    high &= CLEAR_EXP_MASK;
    high |= ((exp + FLOAT64_EXPONENT_BIAS) as u32) << 20;
    m * from_words(high, low)
}

// @stdlib/math/base/special/pow: lib/x_is_zero.js
fn x_is_zero(x: f64, y: f64) -> f64 {
    if y == FLOAT64_NINF {
        return FLOAT64_PINF;
    }
    if y == FLOAT64_PINF {
        return 0.0;
    }
    if y > 0.0 {
        if is_odd(y) {
            return x;
        }
        return 0.0;
    }
    if is_odd(y) {
        return copysign(FLOAT64_PINF, x);
    }
    FLOAT64_PINF
}

// @stdlib/math/base/special/pow: lib/y_is_huge.js
const HIGH_MAX_NEAR_UNITY: i32 = 0x3fef_ffff;
const HUGE: f64 = 1e300;
const TINY: f64 = 1e-300;

fn y_is_huge(x: f64, y: f64) -> f64 {
    let hx = get_high_word(x);
    let ahx = (hx & FLOAT64_HIGH_WORD_ABS_MASK) as i32;
    if ahx <= HIGH_MAX_NEAR_UNITY {
        if y < 0.0 {
            return HUGE * HUGE;
        }
        return TINY * TINY;
    }
    if y > 0.0 {
        return HUGE * HUGE;
    }
    TINY * TINY
}

// @stdlib/math/base/special/pow: lib/y_is_infinite.js
fn y_is_infinite(x: f64, y: f64) -> f64 {
    if x == -1.0 {
        return (x - x) / (x - x);
    }
    if x == 1.0 {
        return 1.0;
    }
    if (abs(x) < 1.0) == (y == FLOAT64_PINF) {
        return 0.0;
    }
    FLOAT64_PINF
}

// @stdlib/math/base/special/pow: lib/polyval_l.js
fn polyval_l(x: f64) -> f64 {
    if x == 0.0 {
        return 0.5999999999999946;
    }
    0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))))
}

// @stdlib/math/base/special/pow: lib/log2ax.js
const HIGH_SIGNIFICAND_MASK: i32 = 0x000f_ffff;
const HIGH_MIN_NORMAL_EXP: i32 = 0x0010_0000;
const HIGH_BIASED_EXP_0: i32 = 0x3ff0_0000;
const HIGH_BIASED_EXP_NEG_512: i32 = 0x2000_0000;
const HIGH_SIGNIFICAND_HALF: i32 = 0x0008_0000;
const TWO53: f64 = 9007199254740992.0;
const CP: f64 = 0.9617966939259756;
const CP_HI: f64 = 0.9617967009544373;
const CP_LO: f64 = -7.028461650952758e-9;
const BP: [f64; 2] = [1.0, 1.5];
const DP_HI: [f64; 2] = [0.0, 0.5849624872207642];
const DP_LO: [f64; 2] = [0.0, 1.350039202129749e-8];

fn log2ax(ax: f64, ahx: i32) -> (f64, f64) {
    let mut ax = ax;
    let mut ahx = ahx;
    let mut n: i32 = 0;
    if ahx < HIGH_MIN_NORMAL_EXP {
        ax *= TWO53;
        n -= 53;
        ahx = get_high_word(ax) as i32;
    }
    n += (ahx >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) - FLOAT64_EXPONENT_BIAS;
    let j = ahx & HIGH_SIGNIFICAND_MASK;
    ahx = j | HIGH_BIASED_EXP_0;
    let k: usize;
    if j <= 235662 {
        k = 0;
    } else if j < 767610 {
        k = 1;
    } else {
        k = 0;
        n += 1;
        ahx -= HIGH_MIN_NORMAL_EXP;
    }
    ax = set_high_word(ax, ahx as u32);
    let bp = BP[k];
    let mut u = ax - bp;
    let mut v = 1.0 / (ax + bp);
    let ss = u * v;
    let hs = set_low_word(ss, 0);
    let mut tmp = ((ahx >> 1) | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
    tmp += (k as i32) << 18;
    let mut ht = set_high_word(0.0, tmp as u32);
    let mut lt = ax - (ht - bp);
    let ls = v * (u - hs * ht - hs * lt);
    let mut s2 = ss * ss;
    let mut r = s2 * s2 * polyval_l(s2);
    r += ls * (hs + ss);
    s2 = hs * hs;
    ht = 3.0 + s2 + r;
    ht = set_low_word(ht, 0);
    lt = r - (ht - 3.0 - s2);
    u = hs * ht;
    v = ls * ht + lt * ss;
    let mut hp = u + v;
    hp = set_low_word(hp, 0);
    let lp = v - (hp - u);
    let hz = CP_HI * hp;
    let lz = CP_LO * hp + lp * CP + DP_LO[k];
    let dp = DP_HI[k];
    let t = n as f64;
    let mut t1 = hz + lz + dp + t;
    t1 = set_low_word(t1, 0);
    let t2 = lz - (t1 - t - dp - hz);
    (t1, t2)
}

// @stdlib/math/base/special/pow: lib/polyval_w.js
fn polyval_w(x: f64) -> f64 {
    if x == 0.0 {
        return 0.5;
    }
    0.5 + x * (-0.3333333333333333 + x * 0.25)
}

// @stdlib/math/base/special/pow: lib/logx.js
const INV_LN2: f64 = 1.4426950408889634;
const INV_LN2_HI: f64 = 1.4426950216293335;
const INV_LN2_LO: f64 = 1.9259629911266175e-8;

fn logx(ax: f64) -> (f64, f64) {
    let t = ax - 1.0;
    let w = t * t * polyval_w(t);
    let u = INV_LN2_HI * t;
    let v = t * INV_LN2_LO - w * INV_LN2;
    let mut t1 = u + v;
    t1 = set_low_word(t1, 0);
    let t2 = v - (t1 - u);
    (t1, t2)
}

// @stdlib/math/base/special/pow: lib/polyval_p.js
fn polyval_p(x: f64) -> f64 {
    if x == 0.0 {
        return 0.16666666666666602;
    }
    0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-5 + x * (-1.6533902205465252e-6 + x * 4.1381367970572385e-8)))
}

// @stdlib/math/base/special/pow: lib/pow2.js
const HIGH_BIASED_EXP_NEG_1: i32 = 0x3fe0_0000;
const LN2_HI: f64 = 0.6931471824645996;
const LN2_LO: f64 = -1.904654299957768e-9;

fn pow2(j: i32, hp: f64, lp: f64) -> f64 {
    let mut hp = hp;
    let i = ((j as u32) & FLOAT64_HIGH_WORD_ABS_MASK) as i32;
    let mut k = (i >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) - FLOAT64_EXPONENT_BIAS;
    let mut n: i32 = 0;
    if i > HIGH_BIASED_EXP_NEG_1 {
        n = (j as u32).wrapping_add((HIGH_MIN_NORMAL_EXP >> (k + 1)) as u32) as i32;
        k = (((n as u32) & FLOAT64_HIGH_WORD_ABS_MASK) >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) as i32 - FLOAT64_EXPONENT_BIAS;
        let tmp = (n as u32) & !(FLOAT64_HIGH_WORD_SIGNIFICAND_MASK >> k);
        let t = set_high_word(0.0, tmp);
        n = ((((n as u32) & FLOAT64_HIGH_WORD_SIGNIFICAND_MASK) | HIGH_MIN_NORMAL_EXP as u32) >> (FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS - k)) as i32;
        if j < 0 {
            n = -n;
        }
        hp -= t;
    }
    let mut t = lp + hp;
    t = set_low_word(t, 0);
    let u = t * LN2_HI;
    let v = (lp - (t - hp)) * LN2 + t * LN2_LO;
    let mut z = u + v;
    let w = v - (z - u);
    t = z * z;
    let t1 = z - t * polyval_p(t);
    let r = z * t1 / (t1 - 2.0) - (w + z * w);
    z = 1.0 - (r - z);
    let mut j = uint32_to_int32(get_high_word(z));
    j = (j as u32).wrapping_add((n as u32) << FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) as i32;
    if (j >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) <= 0 {
        z = ldexp(z, n);
    } else {
        z = set_high_word(z, j as u32);
    }
    z
}

// @stdlib/math/base/special/pow
const HIGH_BIASED_EXP_31: i32 = 0x41e0_0000;
const HIGH_BIASED_EXP_64: i32 = 0x43f0_0000;
const HIGH_BIASED_EXP_10: i32 = 0x4090_0000;
const HIGH_1075: i32 = 0x4090_cc00;
const HIGH_NEG_1075: u32 = 0xc090_cc00;
const HIGH_NUM_NONSIGN_BITS: i32 = 31;
const OVT: f64 = 8.008566259537294e-17;

fn pow(x: f64, y: f64) -> f64 {
    let mut x = x;
    if is_nan(x) || is_nan(y) {
        return f64::NAN;
    }
    let (hy, ly) = to_words(y);
    if ly == 0 {
        if y == 0.0 {
            return 1.0;
        }
        if y == 1.0 {
            return x;
        }
        if y == -1.0 {
            return 1.0 / x;
        }
        if y == 0.5 {
            return x.sqrt();
        }
        if y == -0.5 {
            return 1.0 / x.sqrt();
        }
        if y == 2.0 {
            return x * x;
        }
        if y == 3.0 {
            return x * x * x;
        }
        if y == 4.0 {
            x *= x;
            return x * x;
        }
        if is_infinite(y) {
            return y_is_infinite(x, y);
        }
    }
    let (hx, lx) = to_words(x);
    if lx == 0 {
        if hx == 0 {
            return x_is_zero(x, y);
        }
        if x == 1.0 {
            return 1.0;
        }
        if x == -1.0 && is_odd(y) {
            return -1.0;
        }
        if is_infinite(x) {
            if x == FLOAT64_NINF {
                return pow(-0.0, -y);
            }
            if y < 0.0 {
                return 0.0;
            }
            return FLOAT64_PINF;
        }
    }
    if x < 0.0 && !is_integer(y) {
        return (x - x) / (x - x);
    }
    let ax = abs(x);
    let ahx = (hx & FLOAT64_HIGH_WORD_ABS_MASK) as i32;
    let ahy = (hy & FLOAT64_HIGH_WORD_ABS_MASK) as i32;
    let mut sx = (hx >> HIGH_NUM_NONSIGN_BITS) as i32;
    let sy = (hy >> HIGH_NUM_NONSIGN_BITS) as i32;
    if sx != 0 && is_odd(y) {
        sx = -1;
    } else {
        sx = 1;
    }
    let sx = sx as f64;
    let t;
    if ahy > HIGH_BIASED_EXP_31 {
        if ahy > HIGH_BIASED_EXP_64 {
            return y_is_huge(x, y);
        }
        if ahx < HIGH_MAX_NEAR_UNITY {
            if sy == 1 {
                return sx * HUGE * HUGE;
            }
            return sx * TINY * TINY;
        }
        if ahx > HIGH_BIASED_EXP_0 {
            if sy == 0 {
                return sx * HUGE * HUGE;
            }
            return sx * TINY * TINY;
        }
        t = logx(ax);
    } else {
        t = log2ax(ax, ahx);
    }
    let y1 = set_low_word(y, 0);
    let lp = (y - y1) * t.0 + y * t.1;
    let hp = y1 * t.0;
    let z = lp + hp;
    let (hz, lz) = to_words(z);
    let j = uint32_to_int32(hz);
    let i = uint32_to_int32(lz);
    if j >= HIGH_BIASED_EXP_10 {
        if ((j - HIGH_BIASED_EXP_10) | i) != 0 {
            return sx * HUGE * HUGE;
        }
        if lp + OVT > z - hp {
            return sx * HUGE * HUGE;
        }
    } else if (((j as u32) & FLOAT64_HIGH_WORD_ABS_MASK) as i32) >= HIGH_1075 {
        if ((j as u32).wrapping_sub(HIGH_NEG_1075) | i as u32) != 0 {
            return sx * TINY * TINY;
        }
        if lp <= z - hp {
            return sx * TINY * TINY;
        }
    }
    sx * pow2(j, hp, lp)
}

// XorShift32, uniform in [lo, hi): deterministic per target.
fn uniform(n: usize, lo: f64, hi: f64, seed: u32) -> Vec<f64> {
    let mut out = vec![0.0f64; n];
    let mut s = seed;
    for v in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *v = lo + (s as f64 / 4294967296.0) * (hi - lo);
    }
    out
}

fn sweep(x: &[f64], y: &[f64], out: &mut [f64]) {
    for i in 0..N_EVAL {
        out[i] = pow(x[i & (N_IN - 1)], y[i & (N_IN - 1)]);
    }
}

fn main() {
    let x = uniform(N_IN, 0.0, 100.0, 0x1234abcd);
    let y = uniform(N_IN, -50.0, 50.0, 0x9e3779b9);
    let mut out = vec![0.0f64; N_EVAL];

    for _ in 0..N_WARMUP {
        sweep(&x, &y, &mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        sweep(&x, &y, &mut out);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&out),
        N_EVAL,
        1,
        N_RUNS
    );
}

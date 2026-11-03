// stdlib-erf.rs – the error function swept over 2^20 arguments through
// @stdlib/math/base/special/erf from stdlib 0.4.1 (Apache-2.0; Copyright (c)
// The Stdlib Authors), FreeBSD msun's s_erf.c by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-erf.js holds: every function erf
// reaches is a Rust fn named after its stdlib package (erf, exp, ldexp,
// normalize, exponent, copysign, trunc, is_nan, is_infinite, the float64 word
// accessors) or, for a package's private modules, after the module
// (polyval_*, expmulti), with the constants, the Horner evaluators and every
// branch unchanged. erf's tail for |x| >= 1.25 calls exp, so exp's whole chain
// is here, though this sweep never reaches it. The float64 word accessors,
// which the JavaScript performs through a Float64Array and a Uint32Array over
// one buffer, are f64::to_bits/from_bits; the two-element arrays the
// JavaScript fills (toWords, normalize) are returned tuples. trunc is ceil or
// floor as stdlib writes it.
//
// The sweep follows the package's benchmark: 4096 arguments uniform in
// [-1, 1] (XorShift32 from 0x1234abcd), 2^20 evaluations per run cycling
// through them, 5 warmup runs, the median of 21 timed. Checksum: benchlib
// checksumF64 over the 2^20 results.
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
const FLOAT64_EXPONENT_BIAS: i32 = 1023;
const FLOAT64_MAX_BASE2_EXPONENT: i32 = 1023;
const FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL: i32 = -1023;
const FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL: i32 = -1074;
const FLOAT64_HIGH_WORD_SIGN_MASK: u32 = 0x8000_0000;
const FLOAT64_HIGH_WORD_ABS_MASK: u32 = 0x7fff_ffff;
const FLOAT64_HIGH_WORD_EXPONENT_MASK: u32 = 0x7ff0_0000;

// @stdlib/math/base/assert/is-nan
fn is_nan(x: f64) -> bool {
    x != x
}

// @stdlib/math/base/assert/is-infinite
fn is_infinite(x: f64) -> bool {
    x == FLOAT64_PINF || x == FLOAT64_NINF
}

// @stdlib/math/base/special/abs
fn abs(x: f64) -> f64 {
    x.abs()
}

// @stdlib/math/base/special/trunc
fn trunc(x: f64) -> f64 {
    if x < 0.0 {
        return x.ceil();
    }
    x.floor()
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

// @stdlib/math/base/special/exp: lib/polyval_p.js
fn polyval_p(x: f64) -> f64 {
    if x == 0.0 {
        return 0.16666666666666602;
    }
    0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-05 + x * (-1.6533902205465252e-06 + x * 4.1381367970572385e-08)))
}

// @stdlib/math/base/special/exp: lib/expmulti.js
fn expmulti(hi: f64, lo: f64, k: i32) -> f64 {
    let r = hi - lo;
    let t = r * r;
    let c = r - t * polyval_p(t);
    let y = 1.0 - (lo - r * c / (2.0 - c) - hi);
    ldexp(y, k)
}

// @stdlib/math/base/special/exp
const LN2_HI: f64 = 0.6931471803691238;
const LN2_LO: f64 = 1.9082149292705877e-10;
const LOG2_E: f64 = 1.4426950408889634;
const OVERFLOW: f64 = 709.782712893384;
const UNDERFLOW: f64 = -745.1332191019411;
const NEARZERO: f64 = 1.0 / (1 << 28) as f64;
const NEG_NEARZERO: f64 = -NEARZERO;

fn exp(x: f64) -> f64 {
    if is_nan(x) || x == FLOAT64_PINF {
        return x;
    }
    if x == FLOAT64_NINF {
        return 0.0;
    }
    if x > OVERFLOW {
        return FLOAT64_PINF;
    }
    if x < UNDERFLOW {
        return 0.0;
    }
    if x > NEG_NEARZERO && x < NEARZERO {
        return 1.0 + x;
    }
    let k = if x < 0.0 {
        trunc(LOG2_E * x - 0.5)
    } else {
        trunc(LOG2_E * x + 0.5)
    };
    let hi = x - k * LN2_HI;
    let lo = k * LN2_LO;
    expmulti(hi, lo, k as i32)
}

// @stdlib/math/base/special/erf: lib/polyval_*.js
fn polyval_pp(x: f64) -> f64 {
    if x == 0.0 {
        return -0.3250421072470015;
    }
    -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -2.3763016656650163e-5))
}

fn polyval_qq(x: f64) -> f64 {
    if x == 0.0 {
        return 0.39791722395915535;
    }
    0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (1.3249473800432164e-4 + x * -3.960228278775368e-6)))
}

fn polyval_pa(x: f64) -> f64 {
    if x == 0.0 {
        return 0.41485611868374833;
    }
    0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))))
}

fn polyval_qa(x: f64) -> f64 {
    if x == 0.0 {
        return 0.10642088040084423;
    }
    0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))))
}

fn polyval_ra(x: f64) -> f64 {
    if x == 0.0 {
        return -0.6938585727071818;
    }
    -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))))
}

fn polyval_sa(x: f64) -> f64 {
    if x == 0.0 {
        return 19.651271667439257;
    }
    19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))))
}

fn polyval_rb(x: f64) -> f64 {
    if x == 0.0 {
        return -0.799283237680523;
    }
    -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))))
}

fn polyval_sb(x: f64) -> f64 {
    if x == 0.0 {
        return 30.33806074348246;
    }
    30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))))
}

// @stdlib/math/base/special/erf
const TINY: f64 = 1e-300;
const VERY_TINY: f64 = 2.848094538889218e-306;
const SMALL: f64 = 3.725290298461914e-9;
const ERX: f64 = 0.8450629115104675;
const EFX: f64 = 0.1283791670955126;
const EFX8: f64 = 1.0270333367641007;
const PPC: f64 = 0.12837916709551256;
const QQC: f64 = 1.0;
const PAC: f64 = -0.0023621185607526594;
const QAC: f64 = 1.0;
const RAC: f64 = -0.009864944034847148;
const SAC: f64 = 1.0;
const RBC: f64 = -0.0098649429247001;
const SBC: f64 = 1.0;

fn erf(x: f64) -> f64 {
    if is_nan(x) {
        return f64::NAN;
    }
    if x == FLOAT64_PINF {
        return 1.0;
    }
    if x == FLOAT64_NINF {
        return -1.0;
    }
    if x == 0.0 {
        return x;
    }
    let sign;
    let ax;
    if x < 0.0 {
        sign = true;
        ax = -x;
    } else {
        sign = false;
        ax = x;
    }
    if ax < 0.84375 {
        if ax < SMALL {
            if ax < VERY_TINY {
                return 0.125 * (8.0 * x + EFX8 * x);
            }
            return x + EFX * x;
        }
        let z = x * x;
        let r = PPC + z * polyval_pp(z);
        let s = QQC + z * polyval_qq(z);
        let y = r / s;
        return x + x * y;
    }
    if ax < 1.25 {
        let s = ax - 1.0;
        let p = PAC + s * polyval_pa(s);
        let q = QAC + s * polyval_qa(s);
        if sign {
            return -ERX - p / q;
        }
        return ERX + p / q;
    }
    if ax >= 6.0 {
        if sign {
            return TINY - 1.0;
        }
        return 1.0 - TINY;
    }
    let mut s = 1.0 / (ax * ax);
    let mut r;
    if ax < 2.857142857142857 {
        r = RAC + s * polyval_ra(s);
        s = SAC + s * polyval_sa(s);
    } else {
        r = RBC + s * polyval_rb(s);
        s = SBC + s * polyval_sb(s);
    }
    let z = set_low_word(ax, 0);
    r = exp(-(z * z) - 0.5625) * exp((z - ax) * (z + ax) + r / s);
    if sign {
        return r / ax - 1.0;
    }
    1.0 - r / ax
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

fn sweep(x: &[f64], out: &mut [f64]) {
    for i in 0..N_EVAL {
        out[i] = erf(x[i & (N_IN - 1)]);
    }
}

fn main() {
    let x = uniform(N_IN, -1.0, 1.0, 0x1234abcd);
    let mut out = vec![0.0f64; N_EVAL];

    for _ in 0..N_WARMUP {
        sweep(&x, &mut out);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        sweep(&x, &mut out);
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

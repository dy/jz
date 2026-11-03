// stdlib-gamma.rs – the gamma function swept over 2^20 arguments through
// @stdlib/math/base/special/gamma from stdlib 0.4.1 (Apache-2.0; Copyright (c)
// The Stdlib Authors), Cephes' gamma by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-gamma.js holds: every function gamma
// reaches is a Rust fn named after its stdlib package (gamma, pow, exp, sin,
// rempio2, kernel_rempio2, kernel_sin, kernel_cos, ldexp, round, ...) or, for
// a package's private modules, after the module (stirling_approximation,
// small_approximation, rational_pq, polyval_*, log2ax, logx, pow2, expmulti,
// rempio2_medium, compute), with the constants, the generated evaluators and
// every branch unchanged. That is gamma's Stirling series, which calls exp and
// pow, its recurrence and rational approximation, and its reflection for
// x < -33, which calls sin and through it rempio2 and kernel_rempio2
// (Payne-Hanek); this sweep reaches neither the reflection nor sin's argument
// reduction, but the JavaScript carries them, and so does the port. Where two
// packages each define a private name, it takes its package as a prefix
// (exp_polyval_p, pow_polyval_p, EXP_LN2_HI, POW_LN2_HI, ...); constants that
// two modules define with one value are defined once.
//
// The float64 word accessors, which the JavaScript performs through a
// Float64Array and a Uint32Array over one buffer, are f64::to_bits/from_bits;
// the two-element arrays the JavaScript fills (toWords, log2ax, logx,
// normalize) are returned tuples, rempio2's y a `&mut [f64; 2]`, and the work
// arrays it keeps at module level (kernel-rempio2's F, Q, FQ, IQ, rempio2's
// TX, TY, sin's Y) are local arrays of the function that fills them. Words are
// u32 and the JavaScript's `| 0` values i32; where the JavaScript adds,
// subtracts or shifts words past 32 bits and reads the result back through
// ToInt32 or ToUint32, the Rust wraps in u32. kernel_rempio2's array indices
// are usize. round is JavaScript's Math.round, written as stdlib's C writes it
// (f64::round breaks ties away from zero).
//
// The sweep follows the package's benchmark: 4096 arguments uniform in
// [0, 171] (XorShift32 from 0x1234abcd), 2^20 evaluations per run cycling
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
const LN2: f64 = 0.6931471805599453;
const PI: f64 = 3.141592653589793;
const SQRT_TWO_PI: f64 = 2.5066282746310007;
const EULERGAMMA: f64 = 0.5772156649015329;
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

// @stdlib/math/base/assert/is-negative-zero
fn is_negative_zero(x: f64) -> bool {
    x == 0.0 && 1.0 / x == FLOAT64_NINF
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

// @stdlib/math/base/special/round: Math.round, as stdlib's C writes it
fn round(x: f64) -> f64 {
    if is_nan(x) {
        return f64::NAN;
    }
    if is_negative_zero(x) || (x >= -0.5 && x < 0.0) {
        return -0.0;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if x >= 4503599627370496.0 || x <= -4503599627370496.0 {
        return x;
    }
    (x + 0.5).floor()
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

// @stdlib/number/float64/base/get-low-word
fn get_low_word(x: f64) -> u32 {
    x.to_bits() as u32
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

// @stdlib/math/base/special/kernel-cos: lib/polyval_c13.js, lib/polyval_c46.js
fn polyval_c13(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0416666666666666;
    }
    0.0416666666666666 + x * (-0.001388888888887411 + x * 2.480158728947673e-5)
}

fn polyval_c46(x: f64) -> f64 {
    if x == 0.0 {
        return -2.7557314351390663e-7;
    }
    -2.7557314351390663e-7 + x * (2.087572321298175e-9 + x * -1.1359647557788195e-11)
}

// @stdlib/math/base/special/kernel-cos
fn kernel_cos(x: f64, y: f64) -> f64 {
    let z = x * x;
    let mut w = z * z;
    let mut r = z * polyval_c13(z);
    r += w * w * polyval_c46(z);
    let hz = 0.5 * z;
    w = 1.0 - hz;
    w + (1.0 - w - hz + (z * r - x * y))
}

// @stdlib/math/base/special/kernel-sin
const S1: f64 = -0.16666666666666632;
const S2: f64 = 0.00833333333332249;
const S3: f64 = -1.984126982985795e-4;
const S4: f64 = 2.7557313707070068e-6;
const S5: f64 = -2.5050760253406863e-8;
const S6: f64 = 1.58969099521155e-10;

fn kernel_sin(x: f64, y: f64) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    let v = z * x;
    if y == 0.0 {
        return x + v * (S1 + z * r);
    }
    x - (z * (0.5 * y - v * r) - y - v * S1)
}

// @stdlib/math/base/special/kernel-rempio2
const IPIO2: [i32; 66] = [
    10680707, 7228996, 1387004, 2578385, 16069853, 12639074,
    9804092, 4427841, 16666979, 11263675, 12935607, 2387514,
    4345298, 14681673, 3074569, 13734428, 16653803, 1880361,
    10960616, 8533493, 3062596, 8710556, 7349940, 6258241,
    3772886, 3769171, 3798172, 8675211, 12450088, 3874808,
    9961438, 366607, 15675153, 9132554, 7151469, 3571407,
    2607881, 12013382, 4155038, 6285869, 7677882, 13102053,
    15825725, 473591, 9065106, 15363067, 6271263, 9264392,
    5636912, 4652155, 7056368, 13614112, 10155062, 1944035,
    9527646, 15080200, 6658437, 6231200, 6832269, 16767104,
    5075751, 3212806, 1398474, 7579849, 6349435, 12618859,
];
const PIO2: [f64; 8] = [
    1.570796251296997,
    7.549789415861596e-8,
    5.390302529957765e-15,
    3.282003415807913e-22,
    1.270655753080676e-29,
    1.2293330898111133e-36,
    2.7337005381646456e-44,
    2.1674168387780482e-51,
];
const TWO24: f64 = 16777216.0;
const TWON24: f64 = 5.960464477539063e-8;

fn compute(x: &[f64; 3], y: &mut [f64; 2], jz: usize, q: &mut [f64; 20], q0: i32, jk: usize, jv: usize, jx: usize, f: &mut [f64; 20]) -> i32 {
    let mut iq = [0i32; 20];
    let mut fq = [0.0f64; 20];
    let mut jz = jz;
    let mut q0 = q0;
    let jp = jk;
    let mut z = q[jz];
    let mut j = jz;
    let mut i = 0;
    while j > 0 {
        let fw = (TWON24 * z) as i32 as f64;
        iq[i] = (z - TWO24 * fw) as i32;
        z = q[j - 1] + fw;
        j -= 1;
        i += 1;
    }
    z = ldexp(z, q0);
    z -= 8.0 * (z * 0.125).floor();
    let mut n = z as i32;
    z -= n as f64;
    let mut ih = 0;
    if q0 > 0 {
        let i = iq[jz - 1] >> (24 - q0);
        n += i;
        iq[jz - 1] -= i << (24 - q0);
        ih = iq[jz - 1] >> (23 - q0);
    } else if q0 == 0 {
        ih = iq[jz - 1] >> 23;
    } else if z >= 0.5 {
        ih = 2;
    }
    if ih > 0 {
        n += 1;
        let mut carry = 0;
        for i in 0..jz {
            let j = iq[i];
            if carry == 0 {
                if j != 0 {
                    carry = 1;
                    iq[i] = 16777216 - j;
                }
            } else {
                iq[i] = 16777215 - j;
            }
        }
        if q0 > 0 {
            match q0 {
                1 => iq[jz - 1] &= 8388607,
                2 => iq[jz - 1] &= 4194303,
                _ => {}
            }
        }
        if ih == 2 {
            z = 1.0 - z;
            if carry != 0 {
                z -= ldexp(1.0, q0);
            }
        }
    }
    if z == 0.0 {
        let mut j = 0;
        for i in (jk..jz).rev() {
            j |= iq[i];
        }
        if j == 0 {
            let mut k = 1;
            while iq[jk - k] == 0 {
                k += 1;
            }
            for i in (jz + 1)..=(jz + k) {
                f[jx + i] = IPIO2[jv + i] as f64;
                let mut fw = 0.0;
                for j in 0..=jx {
                    fw += x[j] * f[jx + (i - j)];
                }
                q[i] = fw;
            }
            jz += k;
            return compute(x, y, jz, q, q0, jk, jv, jx, f);
        }
        jz -= 1;
        q0 -= 24;
        while iq[jz] == 0 {
            jz -= 1;
            q0 -= 24;
        }
    } else {
        z = ldexp(z, -q0);
        if z >= TWO24 {
            let fw = (TWON24 * z) as i32 as f64;
            iq[jz] = (z - TWO24 * fw) as i32;
            jz += 1;
            q0 += 24;
            iq[jz] = fw as i32;
        } else {
            iq[jz] = z as i32;
        }
    }
    let mut fw = ldexp(1.0, q0);
    for i in (0..=jz).rev() {
        q[i] = fw * iq[i] as f64;
        fw *= TWON24;
    }
    for i in (0..=jz).rev() {
        fw = 0.0;
        let mut k = 0;
        while k <= jp && k <= jz - i {
            fw += PIO2[k] * q[i + k];
            k += 1;
        }
        fq[jz - i] = fw;
    }
    fw = 0.0;
    for i in (0..=jz).rev() {
        fw += fq[i];
    }
    if ih == 0 {
        y[0] = fw;
    } else {
        y[0] = -fw;
    }
    fw = fq[0] - fw;
    for i in 1..=jz {
        fw += fq[i];
    }
    if ih == 0 {
        y[1] = fw;
    } else {
        y[1] = -fw;
    }
    n & 7
}

fn kernel_rempio2(x: &[f64; 3], y: &mut [f64; 2], e0: i32, nx: usize) -> i32 {
    let mut f = [0.0f64; 20];
    let mut q = [0.0f64; 20];
    let jk: usize = 4;
    let jx = nx - 1;
    let mut jv = (e0 - 3) / 24;
    if jv < 0 {
        jv = 0;
    }
    let q0 = e0 - 24 * (jv + 1);
    let mut j = jv - jx as i32;
    let m = jx + jk;
    for i in 0..=m {
        if j < 0 {
            f[i] = 0.0;
        } else {
            f[i] = IPIO2[j as usize] as f64;
        }
        j += 1;
    }
    for i in 0..=jk {
        let mut fw = 0.0;
        for j in 0..=jx {
            fw += x[j] * f[jx + i - j];
        }
        q[i] = fw;
    }
    let jz = jk;
    compute(x, y, jz, &mut q, q0, jk, jv as usize, jx, &mut f)
}

// @stdlib/math/base/special/rempio2: lib/rempio2_medium.js
const INVPIO2: f64 = 0.6366197723675814;
const PIO2_1: f64 = 1.5707963267341256;
const PIO2_1T: f64 = 6.077100506506192e-11;
const PIO2_2: f64 = 6.077100506303966e-11;
const PIO2_2T: f64 = 2.0222662487959506e-21;
const PIO2_3: f64 = 2.0222662487111665e-21;
const PIO2_3T: f64 = 8.4784276603689e-32;
const EXPONENT_MASK: i32 = 0x7ff;

fn rempio2_medium(x: f64, ix: i32, y: &mut [f64; 2]) -> i32 {
    let n = round(x * INVPIO2);
    let mut r = x - n * PIO2_1;
    let mut w = n * PIO2_1T;
    let j = ix >> 20;
    y[0] = r - w;
    let mut high = get_high_word(y[0]);
    let mut i = j - ((high >> 20) & EXPONENT_MASK as u32) as i32;
    if i > 16 {
        let mut t = r;
        w = n * PIO2_2;
        r = t - w;
        w = n * PIO2_2T - (t - r - w);
        y[0] = r - w;
        high = get_high_word(y[0]);
        i = j - ((high >> 20) & EXPONENT_MASK as u32) as i32;
        if i > 49 {
            t = r;
            w = n * PIO2_3;
            r = t - w;
            w = n * PIO2_3T - (t - r - w);
            y[0] = r - w;
        }
    }
    y[1] = r - y[0] - w;
    n as i32
}

// @stdlib/math/base/special/rempio2
const ZERO: f64 = 0.0;
const TWO_PIO2_1T: f64 = 2.0 * PIO2_1T;
const THREE_PIO2_1T: f64 = 3.0 * PIO2_1T;
const FOUR_PIO2_1T: f64 = 4.0 * PIO2_1T;
const PI_HIGH_WORD_SIGNIFICAND: i32 = 0x921fb;
const PIO4_HIGH_WORD: i32 = 0x3fe9_21fb;
const THREE_PIO4_HIGH_WORD: i32 = 0x4002_d97c;
const FIVE_PIO4_HIGH_WORD: i32 = 0x400f_6a7a;
const THREE_PIO2_HIGH_WORD: i32 = 0x4012_d97c;
const SEVEN_PIO4_HIGH_WORD: i32 = 0x4015_fdbc;
const TWO_PI_HIGH_WORD: i32 = 0x4019_21fb;
const NINE_PIO4_HIGH_WORD: i32 = 0x401c_463b;
const MEDIUM: i32 = 0x4139_21fb;

fn rempio2(x: f64, y: &mut [f64; 2]) -> i32 {
    let mut tx = [0.0f64; 3];
    let mut ty = [0.0f64; 2];
    let hx = get_high_word(x) as i32;
    let ix = ((hx as u32) & FLOAT64_HIGH_WORD_ABS_MASK) as i32;
    if ix <= PIO4_HIGH_WORD {
        y[0] = x;
        y[1] = 0.0;
        return 0;
    }
    if ix <= FIVE_PIO4_HIGH_WORD {
        if (ix & FLOAT64_HIGH_WORD_SIGNIFICAND_MASK as i32) == PI_HIGH_WORD_SIGNIFICAND {
            return rempio2_medium(x, ix, y);
        }
        if ix <= THREE_PIO4_HIGH_WORD {
            if hx > 0 {
                let z = x - PIO2_1;
                y[0] = z - PIO2_1T;
                y[1] = z - y[0] - PIO2_1T;
                return 1;
            }
            let z = x + PIO2_1;
            y[0] = z + PIO2_1T;
            y[1] = z - y[0] + PIO2_1T;
            return -1;
        }
        if hx > 0 {
            let z = x - 2.0 * PIO2_1;
            y[0] = z - TWO_PIO2_1T;
            y[1] = z - y[0] - TWO_PIO2_1T;
            return 2;
        }
        let z = x + 2.0 * PIO2_1;
        y[0] = z + TWO_PIO2_1T;
        y[1] = z - y[0] + TWO_PIO2_1T;
        return -2;
    }
    if ix <= NINE_PIO4_HIGH_WORD {
        if ix <= SEVEN_PIO4_HIGH_WORD {
            if ix == THREE_PIO2_HIGH_WORD {
                return rempio2_medium(x, ix, y);
            }
            if hx > 0 {
                let z = x - 3.0 * PIO2_1;
                y[0] = z - THREE_PIO2_1T;
                y[1] = z - y[0] - THREE_PIO2_1T;
                return 3;
            }
            let z = x + 3.0 * PIO2_1;
            y[0] = z + THREE_PIO2_1T;
            y[1] = z - y[0] + THREE_PIO2_1T;
            return -3;
        }
        if ix == TWO_PI_HIGH_WORD {
            return rempio2_medium(x, ix, y);
        }
        if hx > 0 {
            let z = x - 4.0 * PIO2_1;
            y[0] = z - FOUR_PIO2_1T;
            y[1] = z - y[0] - FOUR_PIO2_1T;
            return 4;
        }
        let z = x + 4.0 * PIO2_1;
        y[0] = z + FOUR_PIO2_1T;
        y[1] = z - y[0] + FOUR_PIO2_1T;
        return -4;
    }
    if ix < MEDIUM {
        return rempio2_medium(x, ix, y);
    }
    if ix >= FLOAT64_HIGH_WORD_EXPONENT_MASK as i32 {
        y[0] = f64::NAN;
        y[1] = f64::NAN;
        return 0;
    }
    let low = get_low_word(x);
    let e0 = (ix >> 20) - 1046;
    let mut z = from_words((ix - (e0 << 20)) as u32, low);
    for i in 0..2 {
        tx[i] = (z as i32) as f64;
        z = (z - tx[i]) * TWO24;
    }
    tx[2] = z;
    let mut nx = 3;
    while tx[nx - 1] == ZERO {
        nx -= 1;
    }
    let n = kernel_rempio2(&tx, &mut ty, e0, nx);
    if hx < 0 {
        y[0] = -ty[0];
        y[1] = -ty[1];
        return -n;
    }
    y[0] = ty[0];
    y[1] = ty[1];
    n
}

// @stdlib/math/base/special/sin
const SMALL_HIGH_WORD: i32 = 0x3e50_0000;

fn sin(x: f64) -> f64 {
    let mut y = [0.0f64; 2];
    let mut ix = get_high_word(x) as i32;
    ix &= FLOAT64_HIGH_WORD_ABS_MASK as i32;
    if ix <= PIO4_HIGH_WORD {
        if ix < SMALL_HIGH_WORD {
            return x;
        }
        return kernel_sin(x, 0.0);
    }
    if ix >= FLOAT64_HIGH_WORD_EXPONENT_MASK as i32 {
        return f64::NAN;
    }
    let n = rempio2(x, &mut y);
    match n & 3 {
        0 => kernel_sin(y[0], y[1]),
        1 => kernel_cos(y[0], y[1]),
        2 => -kernel_sin(y[0], y[1]),
        _ => -kernel_cos(y[0], y[1]),
    }
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
fn pow_polyval_p(x: f64) -> f64 {
    if x == 0.0 {
        return 0.16666666666666602;
    }
    0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-5 + x * (-1.6533902205465252e-6 + x * 4.1381367970572385e-8)))
}

// @stdlib/math/base/special/pow: lib/pow2.js
const HIGH_BIASED_EXP_NEG_1: i32 = 0x3fe0_0000;
const POW_LN2_HI: f64 = 0.6931471824645996;
const POW_LN2_LO: f64 = -1.904654299957768e-9;

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
    let u = t * POW_LN2_HI;
    let v = (lp - (t - hp)) * LN2 + t * POW_LN2_LO;
    let mut z = u + v;
    let w = v - (z - u);
    t = z * z;
    let t1 = z - t * pow_polyval_p(t);
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

// @stdlib/math/base/special/exp: lib/polyval_p.js
fn exp_polyval_p(x: f64) -> f64 {
    if x == 0.0 {
        return 0.16666666666666602;
    }
    0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-05 + x * (-1.6533902205465252e-06 + x * 4.1381367970572385e-08)))
}

// @stdlib/math/base/special/exp: lib/expmulti.js
fn expmulti(hi: f64, lo: f64, k: i32) -> f64 {
    let r = hi - lo;
    let t = r * r;
    let c = r - t * exp_polyval_p(t);
    let y = 1.0 - (lo - r * c / (2.0 - c) - hi);
    ldexp(y, k)
}

// @stdlib/math/base/special/exp
const EXP_LN2_HI: f64 = 0.6931471803691238;
const EXP_LN2_LO: f64 = 1.9082149292705877e-10;
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
    let hi = x - k * EXP_LN2_HI;
    let lo = k * EXP_LN2_LO;
    expmulti(hi, lo, k as i32)
}

// @stdlib/math/base/special/gamma: lib/polyval_s.js
fn polyval_s(x: f64) -> f64 {
    if x == 0.0 {
        return 0.08333333333334822;
    }
    0.08333333333334822 + x * (0.0034722222160545866 + x * (-0.0026813261780578124 + x * (-2.2954996161337813e-4 + x * 7.873113957930937e-4)))
}

// @stdlib/math/base/special/gamma: lib/stirling_approximation.js
const MAX_STIRLING: f64 = 143.01608;

fn stirling_approximation(x: f64) -> f64 {
    let mut w = 1.0 / x;
    w = 1.0 + w * polyval_s(w);
    let mut y = exp(x);
    if x > MAX_STIRLING {
        let v = pow(x, 0.5 * x - 0.25);
        y = v * (v / y);
    } else {
        y = pow(x, x - 0.5) / y;
    }
    SQRT_TWO_PI * y * w
}

// @stdlib/math/base/special/gamma: lib/small_approximation.js
fn small_approximation(x: f64, z: f64) -> f64 {
    z / ((1.0 + EULERGAMMA * x) * x)
}

// @stdlib/math/base/special/gamma: lib/rational_pq.js
fn rational_pq(x: f64) -> f64 {
    let mut x = x;
    if x == 0.0 {
        return 1.0;
    }
    let ax = if x < 0.0 { -x } else { x };
    let s1;
    let s2;
    if ax <= 1.0 {
        s1 = 1.0 + x * (0.4942148268014971 + x * (0.20744822764843598 + x * (0.04763678004571372 + x * (0.010421379756176158 + x * (0.0011913514700658638 + x * (1.6011952247675185e-4 + x * 0.0))))));
        s2 = 1.0 + x * (0.0714304917030273 + x * (-0.23459179571824335 + x * (0.035823639860549865 + x * (0.011813978522206043 + x * (-0.004456419138517973 + x * (5.396055804933034e-4 + x * -2.3158187332412014e-5))))));
    } else {
        x = 1.0 / x;
        s1 = 0.0 + x * (1.6011952247675185e-4 + x * (0.0011913514700658638 + x * (0.010421379756176158 + x * (0.04763678004571372 + x * (0.20744822764843598 + x * (0.4942148268014971 + x * 1.0))))));
        s2 = -2.3158187332412014e-5 + x * (5.396055804933034e-4 + x * (-0.004456419138517973 + x * (0.011813978522206043 + x * (0.035823639860549865 + x * (-0.23459179571824335 + x * (0.0714304917030273 + x * 1.0))))));
    }
    s1 / s2
}

// @stdlib/math/base/special/gamma
fn gamma(x: f64) -> f64 {
    let mut x = x;
    if (is_integer(x) && x < 0.0) || x == FLOAT64_NINF || is_nan(x) {
        return f64::NAN;
    }
    if x == 0.0 {
        if is_negative_zero(x) {
            return FLOAT64_NINF;
        }
        return FLOAT64_PINF;
    }
    if x > 171.61447887182297 {
        return FLOAT64_PINF;
    }
    if x < -170.5674972726612 {
        return 0.0;
    }
    let q = abs(x);
    if q > 33.0 {
        if x >= 0.0 {
            return stirling_approximation(x);
        }
        let mut p = q.floor();
        let sign = if (p as i32 & 1) == 0 { -1.0 } else { 1.0 };
        let mut z = q - p;
        if z > 0.5 {
            p += 1.0;
            z = q - p;
        }
        z = q * sin(PI * z);
        return sign * PI / (abs(z) * stirling_approximation(q));
    }
    let mut z = 1.0;
    while x >= 3.0 {
        x -= 1.0;
        z *= x;
    }
    while x < 0.0 {
        if x > -1e-9 {
            return small_approximation(x, z);
        }
        z /= x;
        x += 1.0;
    }
    while x < 2.0 {
        if x < 1e-9 {
            return small_approximation(x, z);
        }
        z /= x;
        x += 1.0;
    }
    if x == 2.0 {
        return z;
    }
    x -= 2.0;
    z * rational_pq(x)
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
        out[i] = gamma(x[i & (N_IN - 1)]);
    }
}

fn main() {
    let x = uniform(N_IN, 0.0, 171.0, 0x1234abcd);
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

/**
 * Integer powers, correctly rounded. $math.powi(x, y) takes every integer exponent
 * |y| ≤ POWI_MAX ($math.pow's, a constant exponent's, a constant base's): Kornerup, Lefèvre
 * and Muller's double-double ladder (module/math/trig-tables.js POWI_MAX has the reference
 * and the error bound), returning its high part where the rounding test proves it the
 * correctly rounded x^y, else $math.powi_x's decision on the exact power. $math.powi_v runs
 * two lanes through the same operations. src/prepare/math-kernel.js's powi is the same
 * operations in JS, so constant folds, the scalar and the two-wide paths agree bit for bit.
 *
 * @module math/powi
 */
import { wat, deps } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import { POWI_MAX, POWI_TOL } from './trig-tables.js'

// The exact decision's digits: x's 53-bit significand to the |y|-th power, times a 55-bit
// multiplier, on 24-bit limbs (i32 each). All zero bytes, which the data segment's
// trailing-zero trim drops when the table is the last one.
export const POWI_LIMBS = Math.ceil((53 * POWI_MAX + 56) / 24) + 3

// The ladder's operations over named locals, in f64 or f64x2: the scalar and two-wide
// ladders are one sequence of IEEE operations.
const ops = (T) => {
  const k = (c) => T === 'f64' ? `(f64.const ${c})` : `(f64x2.splat (f64.const ${c}))`
  const $ = (n) => `(local.get $${n})`, set = (n, v) => `(local.set $${n} ${v})`
  const add = (a, b) => `(${T}.add ${a} ${b})`, sub = (a, b) => `(${T}.sub ${a} ${b})`, mul = (a, b) => `(${T}.mul ${a} ${b})`
  // a·b = $p + $q exactly: Dekker's product on Veltkamp's 27-bit split (wasm has no fma).
  // The pair is unique, so any exact way to it gives the same bits: a square takes 2·ah·al once.
  const twoProd = (a, b) => [
    set('p', mul($(a), $(b))),
    set('c', mul(k(134217729), $(a))), set('ah', sub($('c'), sub($('c'), $(a)))), set('al', sub($(a), $('ah'))),
    ...(a === b
      ? [set('q', add(add(sub(mul($('ah'), $('ah')), $('p')), mul(add($('ah'), $('ah')), $('al'))), mul($('al'), $('al'))))]
      : [set('c', mul(k(134217729), $(b))), set('bh', sub($('c'), sub($('c'), $(b)))), set('bl', sub($(b), $('bh'))),
        set('q', add(add(add(sub(mul($('ah'), $('bh')), $('p')), mul($('ah'), $('bl'))), mul($('al'), $('bh'))), mul($('al'), $('bl'))))]),
  ].join('\n    ')
  // Algorithm 3 (DblMult): (ah + al)·(bh + bl) into (oh, ol), normalized by two Fast2Sums
  const dblMult = (ah, al, bh, bl, oh, ol) => [
    set('t', mul($(al), $(bh))),
    set('s', add(mul($(ah), $(bl)), $('t'))),
    twoProd(ah, bh),
    set('x2', add($('p'), $('s'))), set('v', sub($('s'), sub($('x2'), $('p')))),
    set('y1', add($('q'), $('v'))),
    set(oh, add($('x2'), $('y1'))), set(ol, sub($('y1'), sub($(oh), $('x2')))),
  ].join('\n    ')
  // 1/(hh + hl): qa = RN(1/hh) and one correction on the exact residual 1 − qa·(hh + hl)
  const recip = [
    set('qa', `(${T}.div ${k(1)} ${$('hh')})`),
    twoProd('qa', 'hh'),
    set('r', sub(sub(sub(k(1), $('p')), $('q')), mul($('qa'), $('hl')))),
    set('qq', mul($('qa'), $('r'))),
    set('hh', add($('qa'), $('qq'))), set('hl', sub($('qq'), sub($('hh'), $('qa')))),
  ].join('\n    ')
  // Algorithm 5 (LogPower) on (m, 0), exponent bits least significant first, unrolled over
  // POWI_MAX's bits so a constant exponent folds to its own straight line. Its first product,
  // by (1, 0), is exact, so the lowest set bit copies; its first square, of (m, 0), is m·m
  // exactly; a square no higher bit uses is skipped.
  const B = 32 - Math.clz32(POWI_MAX)
  const logPower = (a) => {
    const bit = (k) => `(i32.and ${a} (i32.const ${1 << k}))`
    let w = `
    (if ${bit(0)} (then (local.set $hh (local.get $m)) (local.set $hl ${k(0)})))
    ${twoProd('m', 'm')}
    (local.set $uh (local.get $p))
    (local.set $ul (local.get $q))`
    for (let j = 1; j < B; j++) {
      w += `
    (if ${bit(j)}
      (then (if (i32.and ${a} (i32.const ${(1 << j) - 1}))
        (then ${dblMult('hh', 'hl', 'uh', 'ul', 'hh', 'hl')})
        (else (local.set $hh (local.get $uh)) (local.set $hl (local.get $ul))))))`
      if (j < B - 1) w += `
    (if (i32.ge_u ${a} (i32.const ${2 << j})) (then ${dblMult('uh', 'ul', 'uh', 'ul', 'uh', 'ul')}))`
    }
    return w
  }
  const locals = ['p', 'q', 'c', 'ah', 'al', 'bh', 'bl', 't', 's', 'x2', 'v', 'y1', 'uh', 'ul', 'hh', 'hl', 'qa', 'r', 'qq', 'm']
    .map(n => `(local $${n} ${T === 'f64' ? 'f64' : 'v128'})`).join(' ')
  return { logPower, recip, locals }
}

export const registerPowi = () => {
  deps({ 'math.powi': ['math.powi_x'], 'math.powi_x': [], 'math.powi_v': ['math.powi'] })
  const S = ops('f64')
  const sign = (r) => `(select (f64.neg ${r}) ${r} (local.get $neg))`

  // x^y for an integer-valued y, |y| ≤ POWI_MAX, any x: y = 0 is 1, 1 is x, 2 is x·x (V8's
  // own) and −1 is 1/x (one correctly rounded division); a NaN x stays; ±0 and ±∞ are the
  // C library's values for an integer power (C99 F.9.4.4), negative for an odd y and a
  // negative x. Else x = ±m·2^e, m ∈ [1, 2): m^|y| on the ladder, its reciprocal for y < 0,
  // and the result h·2^(e·y) where the test proves h the rounding of the exact power.
  wat('math.powi', `(func $math.powi (param $x f64) (param $y f64) (result f64)
    (local $n i32) (local $a i32) (local $e i32) (local $k i32) (local $eh i32) (local $neg i32)
    (local $half f64) (local $bits i64)
    ${S.locals}
    (local.set $n (i32.trunc_sat_f64_s (local.get $y)))
    (if (i32.eqz (local.get $n)) (then (return (f64.const 1))))
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (i32.eq (local.get $n) (i32.const 1)) (then (return (local.get $x))))
    (if (i32.eq (local.get $n) (i32.const 2)) (then (return (f64.mul (local.get $x) (local.get $x)))))
    (if (i32.eq (local.get $n) (i32.const -1)) (then (return (f64.div (f64.const 1) (local.get $x)))))
    (local.set $neg (i32.and (i32.and (local.get $n) (i32.const 1)) (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $x)) (i64.const 63)))))
    (local.set $bits (i64.and (i64.reinterpret_f64 (local.get $x)) (i64.const 0x7fffffffffffffff)))
    ;; ±0, a subnormal, ±∞
    (if (i64.ge_u (i64.sub (local.get $bits) (i64.const 0x0010000000000000)) (i64.const 0x7fe0000000000000))
      (then
        (if (i64.eq (local.get $bits) (i64.const 0x7ff0000000000000))
          (then (return ${sign('(select (f64.const inf) (f64.const 0) (i32.gt_s (local.get $n) (i32.const 0)))')})))
        (if (i64.eqz (local.get $bits))
          (then (return ${sign('(select (f64.const 0) (f64.const inf) (i32.gt_s (local.get $n) (i32.const 0)))')})))
        ;; a subnormal first scaled by 2^64 (exact)
        (local.set $bits (i64.reinterpret_f64 (f64.mul (f64.reinterpret_i64 (local.get $bits)) (f64.const 0x1p64))))
        (local.set $e (i32.const -64))))
    (local.set $e (i32.add (local.get $e) (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 52))) (i32.const 1023))))
    (local.set $m (f64.reinterpret_i64 (i64.or (i64.and (local.get $bits) (i64.const 0x000fffffffffffff)) (i64.const 0x3ff0000000000000))))
    (local.set $a (select (i32.sub (i32.const 0) (local.get $n)) (local.get $n) (i32.lt_s (local.get $n) (i32.const 0))))
    ${S.logPower('(local.get $a)')}
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then ${S.recip}))
    ;; hh + hl ≈ m^y within POWI_TOL; the result's exponent eh + k
    (local.set $k (i32.mul (local.get $e) (local.get $n)))
    (local.set $bits (i64.reinterpret_f64 (local.get $hh)))
    (local.set $eh (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 52))) (i32.const 1023)))
    ;; a normal result: hh when hh + hl is farther than POWI_TOL·hh from the midpoint on hl's
    ;; side (a quarter ulp below a power of two, where the doubles below are twice as dense)
    (if (i32.le_u (i32.add (i32.add (local.get $eh) (local.get $k)) (i32.const 1021)) (i32.const 2044))
      (then
        (local.set $half (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (local.get $eh) (i32.const 970))) (i64.const 52))))
        (if (f64.gt
              (select (f64.sub (local.get $half) (local.get $hl))
                (f64.add (select (f64.mul (local.get $half) (f64.const 0.5)) (local.get $half)
                  (i64.eqz (i64.and (local.get $bits) (i64.const 0x000fffffffffffff)))) (local.get $hl))
                (f64.ge (local.get $hl) (f64.const 0)))
              (f64.mul (f64.const ${POWI_TOL}) (local.get $hh)))
          (then (return ${sign('(f64.reinterpret_i64 (i64.add (local.get $bits) (i64.shl (i64.extend_i32_s (local.get $k)) (i64.const 52))))')})))))
    (call $math.powi_x (local.get $x) (local.get $n) (local.get $hh) (local.get $hl)))`)

  // The rounding the test left open, or out of the normal range: hh + hl on the result's grid
  // (the doubles of its binade, 2^-1074 below 2^-1022) as grid point c and the fraction past
  // it, rounded by the fraction where it is farther than POWI_TOL·hh from half a step, else
  // by the exact comparison of x^n with the midpoint (2c + 1)·g/2. Overflow is ±∞, a result
  // below a quarter of 2^-1074 is ±0.
  wat('math.powi_x', `(func $math.powi_x (param $x f64) (param $n i32) (param $hh f64) (param $hl f64) (result f64)
    (local $neg i32) (local $a i32) (local $e i32) (local $k i32) (local $eh i32) (local $ev i32) (local $gexp i32) (local $cmp i32) (local $t i32)
    (local $ax f64) (local $g f64) (local $kf f64) (local $hr f64) (local $d f64) (local $r f64)
    (local $bits i64) (local $c i64) (local $kk i64) (local $mant i64)
    (local.set $neg (i32.and (i32.and (local.get $n) (i32.const 1)) (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $x)) (i64.const 63)))))
    (local.set $a (select (i32.sub (i32.const 0) (local.get $n)) (local.get $n) (i32.lt_s (local.get $n) (i32.const 0))))
    (local.set $ax (f64.abs (local.get $x)))
    (if (f64.lt (local.get $ax) (f64.const 0x1p-1022))
      (then (local.set $ax (f64.mul (local.get $ax) (f64.const 0x1p64))) (local.set $e (i32.const -64))))
    (local.set $bits (i64.reinterpret_f64 (local.get $ax)))
    (local.set $e (i32.add (local.get $e) (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 52))) (i32.const 1023))))
    (local.set $mant (i64.or (i64.and (local.get $bits) (i64.const 0x000fffffffffffff)) (i64.const 0x0010000000000000)))
    (local.set $k (i32.mul (local.get $e) (local.get $n)))
    (local.set $bits (i64.reinterpret_f64 (local.get $hh)))
    (local.set $eh (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 52))) (i32.const 1023)))
    ;; the binade of hh + hl: one below a power of two with hl < 0
    (local.set $ev (i32.sub (local.get $eh)
      (i32.and (i64.eqz (i64.and (local.get $bits) (i64.const 0x000fffffffffffff))) (f64.lt (local.get $hl) (f64.const 0)))))
    (if (i32.ge_s (i32.add (local.get $ev) (local.get $k)) (i32.const 1024))
      (then (return (select (f64.const -inf) (f64.const inf) (local.get $neg)))))
    (local.set $gexp (i32.sub (local.get $ev) (i32.const 52)))
    (if (i32.gt_s (i32.sub (i32.const -1074) (local.get $k)) (local.get $gexp))
      (then (local.set $gexp (i32.sub (i32.const -1074) (local.get $k)))))
    (if (i32.ge_s (local.get $gexp) (i32.add (local.get $ev) (i32.const 3)))
      (then (return (select (f64.const -0) (f64.const 0) (local.get $neg)))))
    (local.set $g (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (local.get $gexp) (i32.const 1023))) (i64.const 52))))
    ;; c = ⌊(hh + hl)/g⌋ from k = ⌊hh/g⌋ and hr = hh − k·g (both exact)
    (local.set $hr (local.get $hh))
    (if (i32.le_s (local.get $gexp) (local.get $eh))
      (then
        (local.set $kf (f64.trunc (f64.div (local.get $hh) (local.get $g))))
        (local.set $kk (i64.trunc_f64_s (local.get $kf)))
        (local.set $hr (f64.sub (local.get $hh) (f64.mul (local.get $kf) (local.get $g))))))
    (local.set $c (local.get $kk))
    (if (f64.lt (local.get $hl) (f64.neg (local.get $hr)))
      (then (local.set $c (i64.sub (local.get $kk) (i64.const 1))))
      (else (if (i32.and (i32.le_s (local.get $gexp) (local.get $eh)) (f64.ge (local.get $hl) (f64.sub (local.get $g) (local.get $hr))))
        (then (local.set $c (i64.add (local.get $kk) (i64.const 1)))))))
    (local.set $d (f64.add (f64.sub (f64.sub (local.get $hr) (f64.mul (f64.convert_i64_s (i64.sub (local.get $c) (local.get $kk))) (local.get $g)))
      (f64.mul (local.get $g) (f64.const 0.5))) (local.get $hl)))
    (if (f64.gt (f64.abs (local.get $d)) (f64.mul (f64.const ${POWI_TOL}) (local.get $hh)))
      (then (local.set $c (i64.add (local.get $c) (i64.extend_i32_u (f64.gt (local.get $d) (f64.const 0))))))
      (else
        (local.set $cmp (call $math.powi_cmp (local.get $mant) (local.get $n) (local.get $c) (i32.sub (local.get $gexp) (i32.const 1))))
        (local.set $c (i64.add (local.get $c) (i64.extend_i32_u
          (i32.or (i32.gt_s (local.get $cmp) (i32.const 0))
            (i32.and (i32.eqz (local.get $cmp)) (i32.wrap_i64 (i64.and (local.get $c) (i64.const 1))))))))))
    ;; c·2^(gexp + k), exact on the result's grid (or ∞), in two scalings
    (local.set $t (i32.add (local.get $gexp) (local.get $k)))
    (local.set $r (f64.mul (f64.mul (f64.convert_i64_s (local.get $c))
        (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (i32.shr_s (local.get $t) (i32.const 1)) (i32.const 1023))) (i64.const 52))))
      (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (i32.sub (local.get $t) (i32.shr_s (local.get $t) (i32.const 1))) (i32.const 1023))) (i64.const 52)))))
    (select (f64.neg (local.get $r)) (local.get $r) (local.get $neg)))`, ['math.powi_cmp'])

  // sign(m^n − (2c + 1)·2^b), m = mant·2^-52: P = mant^|n| on the limbs, then for n > 0
  // P against (2c + 1)·2^(b + 52n), for n < 0 2^(52|n| − b) against (2c + 1)·P
  wat('math.powi_cmp', `(func $math.powi_cmp (param $mant i64) (param $n i32) (param $c i64) (param $b i32) (result i32)
    (local $a i32) (local $i i32) (local $len i32) (local $s i32) (local $odd i64)
    (local.set $a (select (i32.sub (i32.const 0) (local.get $n)) (local.get $n) (i32.lt_s (local.get $n) (i32.const 0))))
    (i32.store (global.get $math.powi_tbl) (i32.const 1))
    (local.set $len (i32.const 1))
    (loop $pow
      (local.set $len (call $math.powi_mul (local.get $len) (local.get $mant)))
      (br_if $pow (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $a))))
    (local.set $odd (i64.or (i64.shl (local.get $c) (i64.const 1)) (i64.const 1)))
    (if (i32.gt_s (local.get $n) (i32.const 0))
      (then
        (local.set $s (i32.add (local.get $b) (i32.mul (i32.const 52) (local.get $a))))
        (return (select
          (call $math.powi_cmpc (local.get $len) (i32.const 0) (local.get $odd) (local.get $s))
          (call $math.powi_cmpc (local.get $len) (i32.sub (i32.const 0) (local.get $s)) (local.get $odd) (i32.const 0))
          (i32.ge_s (local.get $s) (i32.const 0))))))
    (local.set $len (call $math.powi_mul (local.get $len) (local.get $odd)))
    (i32.sub (i32.const 0) (call $math.powi_cmpc (local.get $len) (i32.const 0) (i64.const 1)
      (i32.sub (i32.mul (i32.const 52) (local.get $a)) (local.get $b)))))`, ['math.powi_mul', 'math.powi_cmpc'])

  // the limbs times c < 2^72 in place (24-bit digits c0 c1 c2; each partial sum below 2^51), the new length
  wat('math.powi_mul', `(func $math.powi_mul (param $len i32) (param $cv i64) (result i32)
    (local $tb i32) (local $i i32) (local $end i32) (local $c0 i64) (local $c1 i64) (local $c2 i64)
    (local $cur i64) (local $p1 i64) (local $p2 i64) (local $t i64) (local $carry i64)
    (local.set $tb (global.get $math.powi_tbl))
    (local.set $c0 (i64.and (local.get $cv) (i64.const 0xffffff)))
    (local.set $c1 (i64.and (i64.shr_u (local.get $cv) (i64.const 24)) (i64.const 0xffffff)))
    (local.set $c2 (i64.shr_u (local.get $cv) (i64.const 48)))
    (local.set $end (i32.add (local.get $len) (i32.const 3)))
    (loop $each
      (local.set $cur (select (i64.extend_i32_u (i32.load (i32.add (local.get $tb) (i32.shl (local.get $i) (i32.const 2))))) (i64.const 0)
        (i32.lt_u (local.get $i) (local.get $len))))
      (local.set $t (i64.add (i64.add (i64.add (i64.mul (local.get $cur) (local.get $c0)) (i64.mul (local.get $p1) (local.get $c1)))
        (i64.mul (local.get $p2) (local.get $c2))) (local.get $carry)))
      (i32.store (i32.add (local.get $tb) (i32.shl (local.get $i) (i32.const 2))) (i32.wrap_i64 (i64.and (local.get $t) (i64.const 0xffffff))))
      (local.set $carry (i64.shr_u (local.get $t) (i64.const 24)))
      (local.set $p2 (local.get $p1))
      (local.set $p1 (local.get $cur))
      (br_if $each (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $end))))
    (loop $trim
      (if (i32.and (i32.gt_u (local.get $end) (i32.const 1))
            (i32.eqz (i32.load (i32.add (local.get $tb) (i32.shl (i32.sub (local.get $end) (i32.const 1)) (i32.const 2))))))
        (then (local.set $end (i32.sub (local.get $end) (i32.const 1))) (br $trim))))
    (local.get $end))`)

  // sign(L·2^sa − c·2^sc) for the limbs L (len of them) and 0 < c < 2^56: by bit lengths, then
  // c's bits against L's top bits, then any bit of L below them
  wat('math.powi_cmpc', `(func $math.powi_cmpc (param $len i32) (param $sa i32) (param $cv i64) (param $sc i32) (result i32)
    (local $tb i32) (local $la i32) (local $wc i32) (local $base i32) (local $j i32) (local $pos i32) (local $ab i32) (local $cb i32)
    (local.set $tb (global.get $math.powi_tbl))
    (local.set $la (i32.add (i32.add (i32.mul (i32.const 24) (i32.sub (local.get $len) (i32.const 1)))
      (i32.sub (i32.const 32) (i32.clz (i32.load (i32.add (local.get $tb) (i32.shl (i32.sub (local.get $len) (i32.const 1)) (i32.const 2)))))))
      (local.get $sa)))
    (local.set $wc (i32.wrap_i64 (i64.sub (i64.const 64) (i64.clz (local.get $cv)))))
    (if (i32.ne (local.get $la) (i32.add (local.get $wc) (local.get $sc)))
      (then (return (select (i32.const 1) (i32.const -1) (i32.gt_s (local.get $la) (i32.add (local.get $wc) (local.get $sc)))))))
    ;; L's bit base + j faces c's bit j
    (local.set $base (i32.sub (local.get $sc) (local.get $sa)))
    (local.set $j (local.get $wc))
    (block $done (loop $bit
      (br_if $done (i32.eqz (local.get $j)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (local.set $pos (i32.add (local.get $base) (local.get $j)))
      (local.set $ab (if (result i32) (i32.ge_s (local.get $pos) (i32.const 0))
        (then (i32.and (i32.shr_u (i32.load (i32.add (local.get $tb) (i32.shl (i32.div_u (local.get $pos) (i32.const 24)) (i32.const 2))))
          (i32.rem_u (local.get $pos) (i32.const 24))) (i32.const 1)))
        (else (i32.const 0))))
      (local.set $cb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $cv) (i64.extend_i32_u (local.get $j))) (i64.const 1))))
      (if (i32.ne (local.get $ab) (local.get $cb)) (then (return (select (i32.const 1) (i32.const -1) (local.get $ab)))))
      (br $bit)))
    ;; any bit of L below position base
    (local.set $pos (local.get $base))
    (block $zero (loop $low
      (br_if $zero (i32.le_s (local.get $pos) (i32.const 0)))
      (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
      (if (i32.and (i32.shr_u (i32.load (i32.add (local.get $tb) (i32.shl (i32.div_u (local.get $pos) (i32.const 24)) (i32.const 2))))
            (i32.rem_u (local.get $pos) (i32.const 24))) (i32.const 1))
        (then (return (i32.const 1))))
      (br $low)))
    (i32.const 0))`)

  // two lanes on one exponent y (both lanes' y equal, as a constant exponent's are, and not
  // 0, ±1 or 2), both x normal and finite: the ladder and the test on both lanes at once, each
  // lane's operations the scalar's; any other pair, or a lane the test leaves open, lane by lane
  const V = ops('f64x2')
  const splat = (c) => `(f64x2.splat (f64.const ${c}))`, i64s = (c) => `(i64x2.splat (i64.const ${c}))`
  const lanes = `(f64x2.replace_lane 1
      (f64x2.splat (call $math.powi (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.powi (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y))))`
  wat('math.powi_v', `(func $math.powi_v (param $x v128) (param $y v128) (result v128)
    (local $n i32) (local $a i32)
    (local $bits v128) (local $k v128) (local $eh v128) (local $er v128) (local $half v128)
    ${V.locals}
    (local.set $n (i32.trunc_sat_f64_s (f64x2.extract_lane 0 (local.get $y))))
    (local.set $bits (v128.and (local.get $x) ${i64s('0x7fffffffffffffff')}))
    (if (i32.eqz (i32.and (i32.and
          (f64.eq (f64x2.extract_lane 0 (local.get $y)) (f64x2.extract_lane 1 (local.get $y)))
          (i32.gt_u (i32.add (local.get $n) (i32.const 1)) (i32.const 3)))
        (i64x2.all_true (v128.and (i64x2.ge_s (local.get $bits) ${i64s('0x0010000000000000')})
          (i64x2.lt_s (local.get $bits) ${i64s('0x7ff0000000000000')})))))
      (then (return ${lanes})))
    (local.set $m (v128.or (v128.and (local.get $bits) ${i64s('0x000fffffffffffff')}) ${i64s('0x3ff0000000000000')}))
    (local.set $a (select (i32.sub (i32.const 0) (local.get $n)) (local.get $n) (i32.lt_s (local.get $n) (i32.const 0))))
    ${V.logPower('(local.get $a)')}
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then ${V.recip}))
    (local.set $k (i64x2.mul (i64x2.sub (i64x2.shr_u (local.get $bits) (i32.const 52)) ${i64s(1023)}) (i64x2.splat (i64.extend_i32_s (local.get $n)))))
    (local.set $eh (i64x2.sub (i64x2.shr_u (local.get $hh) (i32.const 52)) ${i64s(1023)}))
    (local.set $er (i64x2.add (local.get $eh) (local.get $k)))
    (local.set $half (i64x2.shl (i64x2.add (local.get $eh) ${i64s(970)}) (i32.const 52)))
    (if (i32.eqz (i64x2.all_true (v128.and (v128.and (i64x2.ge_s (local.get $er) ${i64s(-1021)}) (i64x2.le_s (local.get $er) ${i64s(1023)}))
          (f64x2.gt
            (v128.bitselect (f64x2.sub (local.get $half) (local.get $hl))
              (f64x2.add (v128.bitselect (f64x2.mul (local.get $half) ${splat(0.5)}) (local.get $half)
                (i64x2.eq (v128.and (local.get $hh) ${i64s('0x000fffffffffffff')}) (v128.const i64x2 0 0))) (local.get $hl))
              (f64x2.ge (local.get $hl) ${splat(0)}))
            (f64x2.mul ${splat(POWI_TOL)} (local.get $hh))))))
      (then (return ${lanes})))
    ;; hh·2^k, negative where y is odd and x negative
    (v128.xor (i64x2.add (local.get $hh) (i64x2.shl (local.get $k) (i32.const 52)))
      (v128.and (local.get $x) (i64x2.splat (i64.shl (i64.extend_i32_u (i32.and (local.get $n) (i32.const 1))) (i64.const 63))))))`)

  ctx.runtime.powiTable = new Uint8Array(4 * POWI_LIMBS)
}

// What each lowering of a number's integer word costs on this machine: the
// forms jz chooses among for `x | 0` and for an element key. They answer alike
// on the values timed (fractions within ±2^20) and differ by engine and
// architecture: V8 runs `i64.trunc_sat_f64_s` at several times
// `i32.trunc_sat_f64_s` on x64 and lowers the narrow form through extra
// checks on arm64. The examples-perf workflow prints this on each target.
// `fresh` times a number made for its conversion. `outliving` times one the
// loop reads again, a phase whose fraction a polynomial then evaluates: x64's
// `roundsd` keeps its destination's upper half, so where V8 gives it the
// register the loop's last result sits in, the next index waits for that
// result (optimize/to-int32.js). Where V8 allocates that register depends on
// the loop: on a Xeon 8370C this one ran the exponent-tested add 14.9 ns
// outliving against 2.4 fresh, the same on the negation's truncation 3.3; on an
// EPYC 7763 it showed nothing, where bench/resample ran 2.4× slower. `fresh`
// cannot show it anywhere. `loaded` times a word read off memory into a loop
// whose only carried chain is integer, a hash of the words (bench/callback's
// shape, ir/numeric.js memoryWord): its numbers are integers, which the sum
// takes with no truncation at all (the last row, that column alone). On x64 the
// 32-bit truncation there ran callback 2.24× slower than the float code it
// replaced (Xeon 6975P-C, 636 µs against 286); on the M4 every form there
// runs at the chain's 1.2 to 1.4 ns an element.
//
//   node bench/lowering.mjs
import { compile } from 'watr'

const tested = (sum, x) => `(if (result i32) (i64.eq (i64.shr_u (local.tee $b (i64.reinterpret_f64 ${sum})) (i64.const 52)) (i64.const 0x433))
    (then (i32.wrap_i64 (local.get $b)))
    (else (i32.wrap_i64 (i64.trunc_sat_f64_s ${x}))))`
const FORMS = {
  'i32.trunc_sat_f64_s': x => `(i32.trunc_sat_f64_s ${x})`,
  'i64.trunc_sat_f64_s, wrapped': x => `(i32.wrap_i64 (i64.trunc_sat_f64_s ${x}))`,
  'ToInt32 select (unproven)': x => `(select (i32.wrap_i64 (i64.trunc_sat_f64_s ${x})) (i32.const 0) (f64.ne ${x} (f64.const inf)))`,
  'f64.trunc + 1.5·2^52, low word': x => `(i32.wrap_i64 (i64.reinterpret_f64 (f64.add (f64.trunc ${x}) (f64.const 6755399441055744))))`,
  'the same under |x| < 2^51, else wide': x => `(if (result i32) (f64.lt (f64.abs ${x}) (f64.const 2251799813685248))
    (then (i32.wrap_i64 (i64.reinterpret_f64 (f64.add (f64.trunc ${x}) (f64.const 6755399441055744)))))
    (else (i32.wrap_i64 (i64.trunc_sat_f64_s ${x}))))`,
  'the same, the sum\'s exponent tested': x => tested(`(f64.add (f64.trunc ${x}) (f64.const 6755399441055744))`, x),
  'the same, on the negation\'s truncation': x => tested(`(f64.sub (f64.const 6755399441055744) (f64.trunc (f64.neg ${x})))`, x),
}

const module = wat => new WebAssembly.Instance(new WebAssembly.Module(compile(wat))).exports.f
// a loop whose word keys a byte read, so the conversion sits on the critical path
const fresh = (conv) => module(`(module (memory 1)
  (func (export "f") (param $n i32) (result i32) (local $i i32) (local $x f64) (local $s i32) (local $b i64)
    (loop $l
      (local.set $x (f64.mul (f64.convert_i32_s (i32.sub (i32.and (local.get $i) (i32.const 0xfffff)) (i32.const 0x7ffff))) (f64.const 1.25)))
      (local.set $s (i32.add (local.get $s) (i32.load8_u (i32.and ${conv('(local.get $x)')} (i32.const 0xffff)))))
      (br_if $l (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (local.get $s)))`)
// a phase and its word: the word reads a sample and the fraction a polynomial of it, stored
// last, as a resampler's loop does (bench/resample)
const outliving = (conv) => module(`(module (memory 32)
  (func (export "f") (param $n i32) (result i32) (local $k i32) (local $i i32) (local $x f64) (local $t f64) (local $y f64) (local $b i64)
    (local.set $x (f64.const 1))
    (loop $l
      (local.set $i ${conv('(local.get $x)')})
      (local.set $t (f64.sub (local.get $x) (f64.convert_i32_s (local.get $i))))
      (local.set $y (f64.load (i32.shl (i32.and (local.get $i) (i32.const 0xffff)) (i32.const 3))))
      (local.set $x (f64.add (local.get $x) (f64.const 0.7317314443021356)))
      (f64.store (i32.add (i32.const 0x80000) (i32.shl (i32.and (local.get $k) (i32.const 0xffff)) (i32.const 3)))
        (f64.add (f64.mul (f64.add (f64.mul (f64.add (f64.mul (local.get $y) (local.get $t)) (f64.const 0.5)) (local.get $t)) (f64.const 1.5)) (local.get $t)) (local.get $y)))
      (br_if $l (i32.lt_s (local.tee $k (i32.add (local.get $k) (i32.const 1))) (local.get $n))))
    (local.get $i)))`)
// a word read off memory (integers from -48 to 48, filled at start) into a hash: the
// loop carries nothing but the integer it multiplies
const loaded = (conv) => module(`(module (memory 1)
  (func $fill (local $i i32)
    (loop $l
      (f64.store (i32.shl (local.get $i) (i32.const 3)) (f64.convert_i32_s (i32.sub (i32.rem_u (local.get $i) (i32.const 97)) (i32.const 48))))
      (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 4096)))))
  (start $fill)
  (func (export "f") (param $n i32) (result i32) (local $i i32) (local $x f64) (local $h i32) (local $b i64)
    (loop $l
      (local.set $x (f64.load (i32.shl (i32.and (local.get $i) (i32.const 0xfff)) (i32.const 3))))
      (local.set $h (i32.mul (i32.xor (local.get $h) (i32.add (i32.shl ${conv('(local.get $x)')} (i32.const 1)) (local.get $i))) (i32.const 16777619)))
      (br_if $l (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (local.get $h)))`)
const SUM = x => `(i32.wrap_i64 (i64.reinterpret_f64 (f64.add ${x} (f64.const 6755399441055744))))`

const N = 1e7
const answers = new Set(), kept = new Set(), read = new Set()
const ns = (f, seen) => {
  seen.add(f(1 << 20)); f(N)
  const t = []
  for (let r = 0; r < 9; r++) { const a = performance.now(); f(N); t.push(performance.now() - a) }
  return (t.sort((a, b) => a - b)[4] * 1e6 / N).toFixed(2).padStart(6)
}
console.log(`${''.padEnd(40)}  fresh  outliving  loaded`)
for (const [name, conv] of Object.entries(FORMS))
  console.log(`${name.padEnd(40)} ${ns(fresh(conv), answers)} ${ns(outliving(conv), kept)}    ${ns(loaded(conv), read)} ns`)
console.log(`${'1.5·2^52 added, low word (integers)'.padEnd(40)} ${'-'.padStart(6)} ${'-'.padStart(6)}    ${ns(loaded(SUM), read)} ns`)
if (answers.size !== 1 || kept.size !== 1 || read.size !== 1) { console.error('✗ the forms disagree'); process.exit(1) }

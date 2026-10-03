// What each lowering of a number's integer word costs on this machine: the
// forms jz chooses among for `x | 0` and for an element key. They answer alike
// on the values timed (fractions within ±2^20) and differ by engine and
// architecture: V8 runs `i64.trunc_sat_f64_s` at several times
// `i32.trunc_sat_f64_s` on x64 and lowers the narrow form through extra
// checks on arm64. The examples-perf workflow prints this on each target.
//
//   node bench/lowering.mjs
import { compile } from 'watr'

const FORMS = {
  'i32.trunc_sat_f64_s': x => `(i32.trunc_sat_f64_s ${x})`,
  'i64.trunc_sat_f64_s, wrapped': x => `(i32.wrap_i64 (i64.trunc_sat_f64_s ${x}))`,
  'ToInt32 select (unproven)': x => `(select (i32.wrap_i64 (i64.trunc_sat_f64_s ${x})) (i32.const 0) (f64.ne ${x} (f64.const inf)))`,
  'f64.trunc + 1.5·2^52, low word': x => `(i32.wrap_i64 (i64.reinterpret_f64 (f64.add (f64.trunc ${x}) (f64.const 6755399441055744))))`,
}

// a loop whose word keys a byte read, so the conversion sits on the critical path
const loop = (conv) => new WebAssembly.Instance(new WebAssembly.Module(compile(`(module (memory 1)
  (func (export "f") (param $n i32) (result i32) (local $i i32) (local $x f64) (local $s i32)
    (loop $l
      (local.set $x (f64.mul (f64.convert_i32_s (i32.sub (i32.and (local.get $i) (i32.const 0xfffff)) (i32.const 0x7ffff))) (f64.const 1.25)))
      (local.set $s (i32.add (local.get $s) (i32.load8_u (i32.and ${conv('(local.get $x)')} (i32.const 0xffff)))))
      (br_if $l (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (local.get $s))))`))).exports.f

const N = 1e7, answers = new Set()
for (const [name, conv] of Object.entries(FORMS)) {
  const f = loop(conv)
  answers.add(f(1 << 20)); f(N)
  const t = []
  for (let r = 0; r < 9; r++) { const a = performance.now(); f(N); t.push(performance.now() - a) }
  console.log(`${name.padEnd(32)} ${(t.sort((a, b) => a - b)[4] * 1e6 / N).toFixed(2)} ns`)
}
if (answers.size !== 1) { console.error('✗ the forms disagree'); process.exit(1) }

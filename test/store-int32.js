// An integer element store converts its value with exact ToInt32 (src/ir/numeric.js
// toInt32). The range query sees through the emitter's value block, so a checked element
// read copied to another array converts inline (optimize/peephole.js, f64Range's block
// case); a loop-carried local every write of which has a range of its own has their
// hull (boundedFloatLocal); and the unknown tail converts inline below 2^63, calling the
// kernel only for the infinities and the values beyond. Every value is a differential
// against the host: a missing element stores 0, a huge value its low word.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat, oracle, run } from './util.js'
import { belowOpt, levels } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { fusedRewrite } from '../src/optimize/peephole.js'

// The kernel is the module's only user code: the counts are over the module. The
// shapes hold once the optimizer ran; every leg runs the differentials.
const calls = (text, name) => (text.match(new RegExp(`\\(call \\$${name}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }

test('store-int32: a checked element read stored to an integer array', () => {
  const src = `function copy(dst, src, n) {
  let k = 0
  for (let i = 0; i < n; i++) { dst[k * 3] = src[i * 3]; dst[k * 3 + 1] = src[i * 3 + 1]; k++ }
  return k
}
export function f(n, m) {
  const src = new Int32Array(n * 3), dst = new Int32Array(m * 3)
  for (let i = 0; i < src.length; i++) src[i] = i * 7 - 40
  dst.fill(-1)
  copy(dst, src, m)
  let s = 0
  for (let i = 0; i < dst.length; i++) s = (s * 31 + dst[i]) | 0
  return s
}`
  shapes(src, w => is(calls(w, '__to_int32'), 0, 'the store converts inline'))
  // m > n reads past src: undefined stores 0
  for (const [n, m] of [[0, 0], [1, 1], [5, 5], [5, 8], [3, 0]]) agree(src, 'f', [n, m])
})

test('store-int32: a loop-carried local stepped by element reads', () => {
  const src = `function walk(next, out, n) {
  for (let e = 0; e < n; e++) {
    let last = e
    for (let other = next[e]; other !== -1; other = next[other]) last = other
    out[e] = last - last % 3
  }
}
export function f(n) {
  const next = new Int32Array(n), out = new Int32Array(n)
  for (let i = 0; i < n; i++) next[i] = i > 5 ? i - 5 : -1
  walk(next, out, n)
  let s = 0
  for (let i = 0; i < n; i++) s = (s * 31 + out[i]) | 0
  return s
}`
  shapes(src, w => is(calls(w, '__to_int32'), 0, 'the stores convert inline: the local has the hull of its element kind'))
  for (const n of [0, 1, 2, 5, 20]) agree(src, 'f', [n])
})

test('store-int32: finite constant steps have a floating magnitude enclosure', () => {
  const literal = n => Object.is(n, -0) ? '-0' : Number.isNaN(n) ? 'nan' : n === Infinity ? 'inf' : n === -Infinity ? '-inf' : String(n)
  const operand = n => n === null ? '(local.get $other)' : `(f64.const ${literal(n)})`
  const cases = [
    [0, 1, true], [0, -1, true], [-0, 0, true], [-0, -0, true],
    [0, 0.1, true], [0, Number.MIN_VALUE, true], [0, -Number.MIN_VALUE, true],
    [2 ** 53 - 1, 1, true], [2 ** 53, 1, true], [-(2 ** 53), -1, true],
    [2 ** 62, 1, true], [-(2 ** 62), -1, true], [2 ** 63, 1, false],
    [NaN, 1, true], [Infinity, 1, false], [-Infinity, -1, false],
    [Number.MAX_VALUE, Number.MAX_VALUE, false], [0, 1e300, false],
    [null, 1, false], [0, null, false], [0, 1, false, true],
  ]
  for (const [seed, step, folded, changed] of cases) for (const cancel of [false, true]) {
    const ir = parseWat(`(module
      (import "env" "convert" (func $__to_int32 (param f64) (result i32)))
      (func $f (export "f") (param $n i32) (param $other f64) (result f64 i32) (local $v f64) (local $i i32)
        (local.set $v ${operand(seed)})
        (block $done (loop $again
          (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
          ${changed ? '(if (local.get $i) (then (local.set $v (local.get $other))))' : ''}
          (local.set $v (f64.add (local.get $v) ${operand(step)}))
          ${cancel ? `(local.set $v (f64.sub (local.get $v) ${operand(step)}))` : ''}
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
        (local.get $v) (call $__to_int32 (local.get $v))))`)
    const instantiate = () => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir)), { env: { convert: x => x | 0 } }).exports.f
    const before = instantiate(), fn = ir.find(n => n[0] === 'func')
    const numbers = n => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'i32.const' || n[0] === 'f64.const') && Number.isFinite(Number(n[1]))) n[1] = Number(n[1])
      for (let i = 1; i < n.length; i++) numbers(n[i])
    }
    numbers(fn)
    fusedRewrite(fn)
    is(!JSON.stringify(fn).includes('"call","$__to_int32"'), folded, `${seed}, step ${step}, cancellation ${cancel}: only a finite sub-2^63 enclosure removes the helper`)
    ok(fn.some(n => n[0] === 'local' && n[1] === '$v' && n[2] === 'f64'), 'magnitude never authorizes word storage')
    const after = instantiate()
    for (const n of [0, 1, 2, 7, 7, 0, 3]) for (const other of [0, -0, 1e100, Infinity, NaN]) {
      const want = before(n, other), got = after(n, other)
      ok(got.every((x, i) => Object.is(x, want[i])), `${seed}, step ${step}, cancellation ${cancel}, n=${n}: exact value, zero sign and low word`)
    }
  }
})

test('store-int32: unknown steps and other writes keep the conversion fallback', () => {
  const sources = [
    `export function f(n, x) { const a = new Int32Array(1); let v = x; for (let i=0;i<n;i++) v++; a[0]=v; return [v,a[0]] }`,
    `export function f(n, x) { const a = new Int32Array(1); let v = 0; for (let i=0;i<n;i++) v+=x; a[0]=v; return [v,a[0]] }`,
    `export function f(n, x) { const a = new Int32Array(1); let v = 0; for (let i=0;i<n;i++) {v++;if(i===1)v=x} a[0]=v; return [v,a[0]] }`,
    `export function f(n, x) { const a = new Int32Array(1); let v = 0; const set=()=>{v=x}; for (let i=0;i<n;i++) {v++;if(i===1)set()} a[0]=v; return [v,a[0]] }`,
  ]
  for (const src of sources) {
    const host = oracle(src).f
    for (const level of levels(0, 1, 2, 3, 'size')) {
      const compiled = run(src, { optimize: { level, sourceInline: false } }).f
      for (const n of [0, 1, 2, 3, 3, 0]) for (const value of [0, -0, 0.25, Number.MIN_VALUE, 2 ** 63, Number.MAX_VALUE, Infinity, NaN]) {
        const want = host(n, value), got = compiled(n, value)
        ok(got.every((x, i) => Object.is(x, want[i])), `O${level}, n=${n}, x=${value}: every write keeps its full value`)
      }
    }
  }
})

test('store-int32: an unknown value converts inline below 2^63 and through the kernel beyond', () => {
  const src = `export function f(v) { const a = new Int32Array(2); a[0] = v; a[1] = -v; return a[0] * 3 + a[1] }`
  // The emitter puts the fast arm first; late lowering puts the slow arm first.
  shapes(src, w => ok(/\(f64\.(?:lt|ge)\s*\(f64\.abs/.test(w) && calls(w, '__to_int32') >= 1, 'the kernel stays behind the magnitude guard'))
  const VALUES = [0, 1, -1, 1.5, -1.5, 2147483647, 2147483648, -2147483649, 4294967296.5, 1e20, -1e20,
    2 ** 53 + 2, 2 ** 63 - 1024, -(2 ** 63 - 1024), 2 ** 63, -(2 ** 63), 2 ** 63 + 4096, 2 ** 84, 2 ** 84 + 2 ** 40, NaN, Infinity, -Infinity, -0]
  for (const v of VALUES) agree(src, 'f', [v])
})

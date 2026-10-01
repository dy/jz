// An f64 local that holds integers is carried in an integer register
// (src/optimize/int-narrow.js), by the intervals src/optimize/int-range.js reads off
// the control flow: below 2^53 the integers are exact in f64, so their sums, products,
// remainders and truncated quotients are the integers' own. Every value is a
// differential against the host; the WAT shows where the arithmetic runs.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { agree, oracle, run, wat } from './util.js'
import { belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { narrowInts } from '../src/optimize/int-narrow.js'
import { intRanges } from '../src/optimize/int-range.js'
import { guardDefinitions } from '../src/optimize/guard-defs.js'

const count = (text, op) => (text.match(new RegExp(`\\(${op.replace('.', '\\.')}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }
const ARGS = [0, 1, 2, 3, 5, 7, -1, -3, 16, 100, 2147483647, -2147483648, 0.5, NaN]

test('int-narrow: short-circuit conditions retain path bounds and current values', () => {
  for (const truth of [false, true]) for (const saved of [false, true]) for (const changed of [false, true]) {
    const range = changed
      ? '(f64.lt (local.get $x) (local.tee $x (f64.const 100)))'
      : '(i32.and (f64.ge (local.get $x) (f64.const -8)) (f64.le (local.get $x) (f64.const 7)))'
    const selected = truth ? range : `(i32.eqz ${range})`
    const other = saved ? '(local.get $gate)' : `(i32.const ${truth ? 0 : 1})`
    const ir = parseWat(`(module (func $f (export "f") (param $x f64) (param $mode i32) (result f64)
      (local $gate i32)
      (if (result f64)
        (if (result i32) (local.tee $gate (local.get $mode))
          (then ${truth ? selected : other}) (else ${truth ? other : selected}))
        (then ${truth ? '(local.get $x)' : '(f64.const nan)'})
        (else ${truth ? '(f64.const nan)' : '(local.get $x)'}))))`)
    const fn = ir[1], outer = fn.at(-1), read = outer[truth ? 3 : 4][1]
    const facts = intRanges(fn, fn.indexOf(outer)).av.get(read)
    if (changed) ok(!facts || facts.lo <= 100 && facts.hi >= 100, 'a selected-arm write cannot donate bounds for the earlier value')
    else is([facts.lo, facts.hi], [-8, 7], 'the selected short-circuit arm supplies its magnitude bounds')
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(fn)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const mode of [0, 1, -1]) for (const x of [0, 0, 2, -0, NaN, -8, 7, 7.5, -8.5, 100, 2147483648, -(2 ** 32), 2 ** 52, Infinity, -Infinity, 0])
      ok(Object.is(after(x, mode), before(x, mode)), 'short-circuit values, zero signs and repeated calls agree')
  }
})

test('int-narrow: entry assumptions retain established magnitude and zero facts', () => {
  const wide = { lo: -(2 ** 51), hi: 2 ** 51, int: true, nz: false, nan: false }
  for (const [value, assumption, expected] of [
    ['(f64.convert_i32_s (local.get $arg))', wide, [-2147483648, 2147483647, false, false]],
    ['(f64.const 0)', wide, [0, 0, false, false]],
    ['(f64.const -0)', { ...wide, nz: true }, [-0, -0, true, false]],
    ['(f64.const nan)', { ...wide, nan: true }, [Infinity, -Infinity, false, true]],
    ['(f64.const 7)', null, null],
    ['(f64.const 7)', undefined, null],
  ]) {
    const ir = parseWat(`(module (func $f (export "f") (param $arg i32) (result f64) (local $x f64)
      (local.set $x ${value}) (block $assume (result f64) (local.get $x))))`)
    const fn = ir[1], region = fn.at(-1), read = region.at(-1), assume = new Map([[region, new Map([['$x', assumption]])]])
    const v = intRanges(fn, fn.indexOf(region) - 1, assume).av.get(read)
    is(v ? [v.lo, v.hi, v.nz, v.nan] : null, expected, 'the entry certificate intersects the live numeric fact')
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(fn, assume)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const arg of [0, 0, 1, -1, 2147483647, -2147483648, 0])
      ok(Object.is(after(arg), before(arg)), 'intersected assumptions preserve boundary values across reuse')
  }
})

test('int-narrow: nested fast loops reuse the established Number bound', () => {
  const source = `export function f(n) { let s=0
    for(let i=0;i<n;i++) for(let j=0;j<n;j++) s=(s+i)|0
    return s }`
  shapes(source, text => {
    const loops = []
    const walk = n => { if (!Array.isArray(n)) return; if (n[0] === 'loop') loops.push(n); n.forEach(walk) }
    walk(parseWat(text))
    const nested = n => Array.isArray(n) && (n[0] === 'loop' || n.some(nested))
    ok(loops.some(loop => loop.some(nested) && !/"(?:f64\.(?:lt|le|gt|ge)|i64\.(?:lt|le|gt|ge)_s)"/.test(JSON.stringify(loop))),
      'a nested integer fast path repeats no Number or wide-integer bound guards')
  })
  const actual = run(source), expected = oracle(source)
  for (const n of [0, 0, 1, 4, 3.5, -0, -1, NaN, 7, 0, 4])
    is(actual.f(n), expected.f(n), `the guarded path and Number fallback agree for ${n}`)
})

test('int-narrow: nested guarded loops retain wide bounds and final counter values', () => {
  const source = `export function f(n) { let i=0,j=0,sum=0,steps=0
    for(;i<n;i++) {
      for(j=0;j<n;j++) { sum=(sum+i+j)|0; steps++; if(j===2)break }
      if(i===2)break
    }
    return [sum,steps,i,j,n]
  }`
  const expected = oracle(source)
  for (const optimize of [0, 1, 2, 3, 'size']) {
    const actual = run(source, { optimize })
    for (const n of [0,0,4,3.5,0.5,-0,-1,NaN,2147483647,2147483648,2 ** 32 + 0.5,2 ** 52,Infinity,-Infinity,4,0])
      is(actual.f(n), expected.f(n), `O${optimize}: A → A → changed bound → A, ${n}`)
  }
})

test('int-narrow: removing selected bits closes a signed-word recurrence', () => {
  for (const saved of [false, true]) for (const commuted of [false, true]) {
    const word = '(i32.trunc_sat_f64_s (local.get $v))'
    const mask = `(i32.and ${commuted ? '(local.get $mask)' : word} ${commuted ? word : '(local.get $mask)'})`
    const ir = parseWat(`(module (func $f (export "f") (param $x i32) (param $mask i32) (param $n i32)
      (result f64) (local $v f64) (local $bits i32) (local $i i32)
      (local.set $v (f64.convert_i32_s (local.get $x)))
      (block $done (loop $again
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        ${saved ? `(local.set $bits ${mask})` : ''}
        (local.set $v (f64.sub (local.get $v) (f64.convert_i32_s ${saved ? '(local.get $bits)' : mask})))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again))) (local.get $v)))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    const fn = ir.find(n => n[0] === 'func')
    narrowInts(fn)
    ok(fn.some(n => n[0] === 'local' && n[1] === '$v' && n[2] === 'i32'), 'the recurrence has a proved complete signed-word hull')
    ok(!JSON.stringify(fn).includes('f64.sub'), 'bit removal computes in an integer register')
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [0, 0, 1, -1, 2147483647, -2147483648, -2147483647, 0x55555555])
      for (const mask of [0, 1, -1, -2147483648, 0x55555555]) for (const n of [0, 1, 3])
        is(after(x, mask, n), before(x, mask, n), `saved=${saved}, commuted=${commuted}: ${x}, ${mask}, ${n}`)
  }
})

test('int-narrow: bit removal preserves wide inputs, zero signs and changed reads', () => {
  const sources = [
    `export function f(x,m) { return x - (x & m) }`,
    `export function f(x,m) { const b = x & -x; return x - b }`,
    `export function f(k,m) { let x=k|0; return [x - ((x=7) & x), x] }`,
    `export function f(k,m) { let x=k|0; const b=x&(x=7); x=x-b; return x }`,
    `export function f(k,m) { let x=k|0; const b=x&((x=-2147483648),1); x=x-b; return x }`,
    `export function f(k,m) { let x=k|0, b=x&m; x=2147483647; x=x-b; return x }`,
    `export function f(k,m) { let x=k|0, b=0; if(m) b=x&m; x=x-b; return x }`,
    `export function f(k,m) { let x=k|0, events=0; const mask=()=>{events++;x=7;return m};
      const b=x&mask(); return [x-b, events, x] }`,
  ]
  for (const src of sources) {
    const host = oracle(src).f
    for (const optimize of [0, 1, 2, 3, 'size']) {
      const f = run(src, { optimize: { level: optimize, sourceInline: false } }).f
      for (const [x, mask] of [[0,0], [0,0], [-0,-1], [1,-1], [-1,1], [2147483647,-1], [-2147483648,7],
        [2147483648,-1], [-2147483649,1], [4294967296,-1], [0.5,1], [NaN,1], [Infinity,1], [-Infinity,-1], [0,0]])
        is(f(x,mask), host(x,mask), `O${optimize}: ${x}, ${mask}`)
    }
  }
})

test('int-narrow: a shared subtraction node does not acquire another occurrence\'s mask', () => {
  const ir = parseWat(`(module (func $f (export "f") (param $x i32) (result f64) (local $v f64) (local $bits i32)
    (local.set $v (f64.convert_i32_s (local.get $x)))
    (block (result f64)
      (local.set $bits (i32.and (i32.trunc_sat_f64_s (local.get $v)) (i32.const 1)))
      (local.set $v (f64.sub (local.get $v) (f64.convert_i32_s (local.get $bits))))
      (local.set $v (f64.const -2147483648)) (local.set $bits (i32.const 1))
      (local.set $v (f64.sub (local.get $v) (f64.convert_i32_s (local.get $bits))))
      (local.get $v))))`)
  const fn = ir.find(n => n[0] === 'func'), block = fn.find(n => n[0] === 'block')
  block[6] = block[3] // identical node, distinct occurrences with different preceding writes
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(fn)
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const x of [0,0,1,-1,2147483647,-2147483648,0])
    is(after(x), before(x), 'the later occurrence preserves -2147483649')
})

test('int-narrow: low-bit scans retain exact iteration counts and source effects', () => {
  const src = `function scan(k) {
    let x=k|0, count=0, checksum=0
    while(x!==0) { const b=x&-x; x=x-b; count++; checksum=(checksum^b)|0 }
    return [count, checksum, x]
  }
  export function f(k) { return scan(k) }`
  const host = oracle(src).f
  for (const optimize of [0, 1, 2, 3, 'size']) {
    const f = run(src, { optimize: { level: optimize, sourceInline: false } }).f
    for (const k of [0,0,1,7,-1,-2147483648,2147483647,0x55555555,0xaaaaaaaa,0])
      is(f(k), host(k), `O${optimize}: zero-work / A → A → B → A, ${k}`)
  }
})

test('int-narrow: decided readback guards retain saved values and operand order', () => {
  const comparisons = [
    '(f64.eq (f64.convert_i32_s (local.tee $saved (call $tick (local.get $x)))) (f64.convert_i32_s (local.get $saved)))',
    '(f64.ne (f64.convert_i32_u (local.tee $saved (call $tick (local.get $x)))) (f64.convert_i32_u (local.get $saved)))',
    '(i32.eq (local.tee $saved (call $tick (local.get $x))) (local.get $saved))',
    '(i32.lt_s (i32.and (call $tick (i32.const 1)) (i32.const 255)) (i32.add (i32.and (call $tick (i32.const 2)) (i32.const 255)) (i32.const 512)))',
  ]
  for (const cmp of comparisons) {
    const ir = parseWat(`(module (global $events (mut i32) (i32.const 0))
      (func $tick (param $v i32) (result i32)
        (global.set $events (i32.add (i32.mul (global.get $events) (i32.const 10)) (local.get $v))) (local.get $v))
      (func $f (export "f") (param $x i32) (result i32) (local $saved i32) (local $answer i32)
        (global.set $events (i32.const 0)) (local.set $answer ${cmp})
        (i32.add (i32.mul (local.get $answer) (i32.const 10)) (local.get $saved)))
      (func (export "events") (result i32) (global.get $events)))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports
    const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
    narrowInts(fn)
    ok(!JSON.stringify(fn).includes(cmp.slice(1, cmp.indexOf(' '))), 'the decided comparison is removed')
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports
    for (const x of [0, 0, 1, -1, 2147483647, -2147483648, 0]) {
      is(after.f(x), before.f(x), 'saved tee value survives A → A → B → A')
      is(after.events(), before.events(), 'each operand executes once in order')
    }
  }
})

test('int-narrow: reciprocal guards distinguish positive, negative and unknown zero', () => {
  const denominators = [
    ['i32', '(f64.convert_i32_s (i32.and (local.get $x) (i32.const 7)))', true],
    ['f64', '(local.get $x)', false],
    ['f64', '(local.tee $copy (local.get $x))', false],
    ['f64', '(f64.neg (f64.abs (local.get $x)))', false],
  ]
  for (const [type, denominator, decided] of denominators) {
    const ir = parseWat(`(module (func $f (export "f") (param $x ${type}) (result i32) (local $copy f64)
      (f64.gt (f64.div (f64.const 1) ${denominator}) (f64.const 0))))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    const fn = ir.find(n => n[0] === 'func')
    narrowInts(fn)
    is(JSON.stringify(fn).includes('f64.gt'), !decided, 'only a proved positive reciprocal loses its predicate')
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [0, 0, -0, 1, -1, 0.25, -0.25, Number.MIN_VALUE, -Number.MIN_VALUE, 2147483647, -2147483648, Infinity, -Infinity, NaN, 0])
      is(after(x), before(x), `zero sign, finite boundary and nonfinite input: ${x}`)
  }
})

test('int-narrow: interval division retains an interior zero divided by zero', () => {
  const ir = parseWat(`(module (func $f (export "f") (param $x i32) (param $y i32) (result i32) (local $v f64)
    (f64.eq (local.tee $v (f64.div (f64.convert_i32_s (local.get $x))
      (f64.convert_i32_s (i32.and (local.get $y) (i32.const 7))))) (local.get $v))))`)
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(ir.find(n => n[0] === 'func'))
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const [x, y] of [[0, 0], [0, 0], [-1, 0], [1, 0], [0, 1], [-1, 7], [1, 7], [2147483647, 1], [-2147483648, 0], [0, 0]])
    is(after(x, y), before(x, y), `interior zero, endpoints and reuse: ${x}/${y & 7}`)
})

test('int-narrow: an interior quotient may underflow to negative zero', () => {
  const ir = parseWat(`(module (memory 1) (func $f (export "f") (param $x f64) (result f64)
    (i32.store8 (i32.const 0) (i32.const 0)) (i32.store8 (i32.const 1) (i32.const -1))
    (if (result f64) (i32.and (f64.ge (local.get $x) (f64.const 0)) (f64.le (local.get $x) (f64.const 2)))
      (then (f64.add (f64.mul (f64.convert_i32_s (i32.load8_s (i32.const 0)))
        (f64.convert_i32_s (i32.load8_s (i32.const 1))))
        (f64.div (f64.sub (local.get $x) (f64.const 1)) (f64.const 1e308))))
      (else (local.get $x)))))`)
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(ir.find(n => n[0] === 'func'))
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const x of [1 - Number.EPSILON / 2, 1 - Number.EPSILON / 2, 0, 1, 2, 1 + Number.EPSILON, NaN, -0])
    ok(Object.is(after(x), before(x)), `the sum retains its zero sign: ${x}`)
})

test('int-narrow: finite word guards reject special exponents without rejecting floats', () => {
  for (const type of ['i32', 'f64']) for (const mask of [null, '0x7FF0000000000000', '0xFFF0000000000000']) {
    const value = type === 'i32' ? '(f64.convert_i32_s (local.get $x))' : '(local.get $x)'
    const bits = `(i64.reinterpret_f64 ${value})`
    const ir = parseWat(`(module (func $f (export "f") (param $x ${type}) (result i32)
      (i64.eq ${mask ? `(i64.and ${bits} (i64.const ${mask}))` : bits}
        (i64.const ${mask ?? '0x7FF8000000000000'}))))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    const fn = ir.find(n => n[0] === 'func')
    narrowInts(fn)
    is(JSON.stringify(fn).includes('i64.eq'), type !== 'i32', 'only the finite word excludes every special exponent')
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [0, 0, -0, 1, -1, 2147483647, -2147483648, Infinity, -Infinity, NaN, 0])
      is(after(x), before(x), `special bits, type ${type}, mask ${mask}, value ${x}`)
  }
})

test('int-narrow: late word guards preserve recursive values across reuse', () => {
  const src = `function count(n) {
    if (n <= 0) return 1
    let s = 0, i = 0
    while (i < n) { s += count(n - 1 - i); i++ }
    return s & 0x3ffffff
  }
  export function value(k) { return count(k & 7) }`
  const host = oracle(src).value
  for (const optimize of [0, 1, 2, 3, 'size']) {
    const f = run(src, { optimize: { level: optimize, sourceInline: false } }).value
    for (const x of [0, 0, 1, 7, 3, -1, 2147483647, -2147483648, 0])
      is(f(x), host(x), `O${optimize}: recursive zero-work / A → A → B → A, ${x}`)
  }
})

test('int-narrow: constant comparisons retain traps and later operand writes', () => {
  for (const value of [
    '(i32.load8_u (local.get $x))',
    '(i32.and (i32.div_s (i32.const 1) (local.get $x)) (i32.const 255))',
    '(i32.and (i32.rem_s (i32.const 1) (local.get $x)) (i32.const 255))',
    '(i32.and (i32.trunc_f64_s (f64.div (f64.const 1) (f64.convert_i32_s (local.get $x)))) (i32.const 255))',
  ]) {
    const ir = parseWat(`(module (memory 1) (func $f (export "f") (param $x i32) (result i32)
      (i32.eq ${value} (i32.const 256))))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir.find(n => n[0] === 'func'))
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    const bad = value.includes('load') ? 65536 : 0
    throws(() => before(bad), WebAssembly.RuntimeError, 'original traps')
    throws(() => after(bad), WebAssembly.RuntimeError, 'decided comparison retains the trap')
    is(after(1), before(1), 'successful call after trap')
  }
  const conditional = parseWat(`(module (memory 1) (func $f (export "f") (param $x i32) (result i32)
    (i32.eq (if (result i32) (local.get $x)
      (then (i32.load8_u (i32.const 65536))) (else (i32.const 0))) (i32.const 256))))`)
  narrowInts(conditional.find(n => n[0] === 'func'))
  const f = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(conditional))).exports.f
  is(f(0), 0, 'untaken conditional load does not trap')
  throws(() => f(1), WebAssembly.RuntimeError, 'taken conditional load still traps')
  is(f(0), 0, 'zero-work call after trap')
  for (const type of ['i32', 'f64']) {
    const cv = x => type === 'i32' ? `(f64.convert_i32_s ${x})` : x
    const ir = parseWat(`(module (func $f (export "f") (param $x ${type}) (param $y ${type}) (result i32)
      (f64.eq ${cv('(local.get $x)')} ${cv('(local.tee $x (local.get $y))')})))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir.find(n => n[0] === 'func'))
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [-0, 0], [NaN, NaN], [Infinity, Infinity], [2147483647, -2147483648]])
      is(after(x, y), before(x, y), 'a later assignment is not a read of the saved value')
  }
})

test('int-narrow: bounded products narrow only when their sum erases zero sign', () => {
  for (const [loadA, loadB, fits] of [['8_s', '8_s', true], ['16_s', '16_u', true], ['16_u', '16_u', false]]) {
    const product = `(f64.mul (f64.convert_i32_s (i32.load${loadA} (i32.const 0)))
      (f64.convert_i32_s (i32.load${loadB} (i32.const 4))))`
    for (const [other, safe] of [['(f64.const 0)', true], ['(f64.const -0)', false],
      ['(local.get $z)', false], ['(f64.abs (local.get $z))', false],
      ['(f64.abs (f64.convert_i32_s (local.get $x)))', true]]) for (const left of [false, true]) {
      const src = `(module (memory 1)
        (func $f (export "f") (param $x i32) (param $y i32) (param $z f64) (result f64)
          (i32.store (i32.const 0) (local.get $x)) (i32.store (i32.const 4) (local.get $y))
          (f64.add ${left ? other : product} ${left ? product : other})))`
      const ir = parseWat(src), fn = ir.find(n => n[0] === 'func')
      const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
      narrowInts(fn)
      is(JSON.stringify(fn).includes('i32.mul'), fits && safe, `${loadA}/${loadB}, ${other}, left=${left}`)
      const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
      for (const [x, y] of [[0, -1], [-1, 0], [0, 0], [-128, 127], [-32768, 65535], [65535, 65535]])
        for (const z of [-0, 0, -1, 1, NaN, Infinity, -Infinity])
          ok(Object.is(after(x, y, z), before(x, y, z)), 'exact Number result, including both zero signs')
    }
    const ir = parseWat(`(module (memory 1) (func $f (export "f") (result f64) ${product}))`)
    narrowInts(ir.find(n => n[0] === 'func'))
    ok(!JSON.stringify(ir).includes('i32.mul'), 'a bare product retains its potentially observable zero sign or wide magnitude')
  }
})

test('int-narrow: a narrowed sum evaluates its operands once in order', () => {
  for (const left of [false, true]) {
    const other = '(f64.convert_i32_s (call $tick (i32.const 3)))'
    const product = `(f64.mul
      (f64.convert_i32_s (i32.load8_s (call $tick (i32.const 1))))
      (f64.convert_i32_s (i32.load8_s (call $tick (i32.const 2)))))`
    const ir = parseWat(`(module (memory 1) (global $events (mut i32) (i32.const 0))
      (func $tick (param $v i32) (result i32)
        (global.set $events (i32.add (i32.mul (global.get $events) (i32.const 10)) (local.get $v))) (local.get $v))
      (func $f (export "f") (param $x i32) (param $y i32) (result f64)
        (global.set $events (i32.const 0))
        (i32.store8 (i32.const 1) (local.get $x)) (i32.store8 (i32.const 2) (local.get $y))
        (f64.add ${left ? other : product} ${left ? product : other}))
      (func (export "events") (result i32) (global.get $events)))`)
    const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
    narrowInts(fn)
    ok(JSON.stringify(fn).includes('i32.mul'), 'the product narrows even with effectful addresses')
    const run = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports
    for (const [x, y] of [[0, -1], [0, -1], [-3, 7], [127, -128], [0, -1]]) {
      is(run.f(x, y), 3 + x * y, 'A → A → B → A values')
      is(run.events(), left ? 312 : 123, 'each operand executes once, in source order')
    }
  }
})

test('int-narrow: an index made of an element, its remainders and its quotient', () => {
  const src = `export function f(n) {
  const table = new Int32Array(64)
  for (let i = 0; i < 64; i++) table[i] = i % 5 ? (i * 7 + n) | 0 : 0
  let s = 0
  for (let slot = 0; slot < 64; slot++) {
    if (table[slot]) {
      const edge = table[slot] - 1
      const edgeEnd = edge - edge % 3 + (edge + 1) % 3
      s += edgeEnd * 3 + (edge / 3 | 0) + (edge / -7 | 0)
    }
  }
  return s
}`
  shapes(src, w => {
    ok(count(w, 'i32.rem_s') + count(w, 'i64.rem_s') >= 2, 'the remainders are the integers\'')
    ok(count(w, 'i32.div_s') + count(w, 'i64.div_s') >= 2, 'the quotients are the integers\'')
    ok(count(w, 'f64.div') === 0, 'no division is left in f64')
  })
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a product of an element past the i32 range', () => {
  const src = `export function f(n) {
  const a = new Int32Array(4), v = new Int32Array(16)
  a[0] = 2147483647; a[1] = -2147483648; a[2] = n; a[3] = 65536
  for (let i = 0; i < 16; i++) v[i] = i * i - 40
  let s = 0
  for (let i = 0; i < 4; i++) {
    const f = a[i], base = f * 3, corner = base + 2
    s = s * 3 + (corner > 4294967296 ? 1 : 0) + (base === f + f + f ? 2 : 0) + v[(corner % 16 + 16) % 16]
  }
  return s
}`
  shapes(src, w => ok(count(w, 'i64.mul') + count(w, 'i64.add') >= 1, 'the product is carried in i64'))
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: the zero of a negative remainder keeps its sign where a division reads it', () => {
  const src = `export function f(n) {
  const a = new Int32Array(8)
  for (let i = 0; i < 8; i++) a[i] = i * 3 - n
  let s = 0, m = 0
  for (let i = 0; i < 8; i++) {
    const b = a[i] * 3 + 3, r = b % 3
    const q = 1 / r
    s += q === -Infinity ? 1 : q === Infinity ? 100 : 10000
    m += (b + 7) % 5
  }
  return s * 1000 + m
}`
  for (const n of [0, 1, 3, 4, 9, 12, 21, 100, -6]) agree(src, 'f', [n])
})

test('int-narrow: minimum, maximum, magnitude and negation of integers', () => {
  const src = `export function f(n) {
  const a = new Int32Array(6)
  a[0] = n; a[1] = -2147483648; a[2] = 2147483647; a[3] = 0; a[4] = -n; a[5] = 7
  let h = 0
  for (let i = 0; i < 5; i++) {
    const lo = Math.min(a[i], a[i + 1]), hi = Math.max(a[i], a[i + 1])
    h = Math.imul(h ^ lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)
    h = (h + Math.abs(lo) - -hi) | 0
  }
  return h
}`
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a value that may pass 2^53 stays a number', () => {
  const src = `export function f(n) {
  const a = new Int32Array(2)
  a[0] = n
  let x = a[0] + 9007199254740000, s = 0
  for (let k = 0; k < 8; k++) {
    const y = x + 1
    s = s * 4 + (y === x ? 1 : 0) + (y - x)
    x = x + 300
  }
  return s + x % 1024
}`
  for (const n of [0, 1, -1, 7, 991, 992, 993, 1000, -100000, 2147483647, -2147483648]) agree(src, 'f', [n])
})

test('int-narrow: a fraction truncated where it is read', () => {
  const src = `export function f(n) {
  const a = new Int32Array(8)
  for (let i = 0; i < 8; i++) a[i] = i * 5 - n
  let s = 0
  for (let i = 0; i < 8; i++) { const e = a[i] - 1, t = e / 3, k = t | 0; s = (s * 31 + k + (t * 2 | 0)) | 0 }
  return s
}`
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a value that may be missing stays as it is', () => {
  const src = `export function f(n) {
  const a = new Int32Array(4)
  a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4
  let s = 0
  for (let i = 0; i < 6; i++) { const e = a[i + n] - 1; s += e % 3 === 0 ? 1 : e !== e ? 100 : 10 }
  return s
}`
  for (const n of [0, 1, 2, 3, 5, 7, -1, -3, 16, 100]) agree(src, 'f', [n])
})

test('int-narrow: a slot that holds any value is no number', () => {
  const src = `export let f = (n) => {
  let [x, y] = [, 7]
  let row = [n, undefined, null, 'a']
  let s = (x == null) + y
  for (let i = 0; i < 4; i++) s = s * 3 + (row[i] == null ? 1 : row[i] === n ? 2 : 0)
  return s
}`
  for (const n of [0, 1, -1, 0.5]) agree(src, 'f', [n])
})

test('int-narrow: a word of flags stays a word', () => {
  const src = `export function f(n) {
  const flags = new Uint8Array(8), area = new Float32Array(8)
  for (let i = 0; i < 8; i++) area[i] = (i - n) / 4
  let s = 0
  for (let i = 0; i < 8; i++) {
    flags[i] = 4 | (area[i] > 0 ? 8 : 0)
    if (area[i] * area[i] > 0.2) flags[i] &= ~4
    s = s * 16 + flags[i]
  }
  return s
}`
  for (const n of [0, 1, 3, 5, 9]) agree(src, 'f', [n])
})

// Two values the emitter could not type compare through the runtime; two
// numbers compare as numbers do: -0 equals 0, NaN equals nothing, and a miss
// (undefined) equals another miss.
test('int-narrow: strict equality of values that are numbers where they are read', () => {
  const src = `export function f(n, at, other) {
  const a = new Float64Array(8), b = new Int32Array(8), c = new Float64Array(8)
  for (let i = 0; i < 8; i++) { a[i] = i % 3 === 0 ? -0 : i % 3 === 1 ? NaN : i * 0.5; b[i] = i % 3 === 0 ? 0 : i; c[i] = i % 3 === 2 ? i * 0.5 : i % 3 === 1 ? NaN : 0 }
  let same = 0, differ = 0
  for (let i = 0; i < n; i++) {
    const x = a[(i + at) & 15], y = c[(i + other) & 15], z = b[(i + at) & 15]
    if (x === y) same++
    else differ++
    if (z === x) same += 10
    if (y !== z) differ += 100
    if (x === undefined) same += 1000
  }
  return same * 1e6 + differ
}`
  for (const n of [0, 1, 8, 16, 40]) for (const at of [0, 1, 5, 8]) for (const other of [0, 3, 9]) agree(src, 'f', [n, at, other])
})

// A shift by a count that is not known leaves anything from the value down to
// zero; an assignment inside an operand is made before the operand after it.
test('int-narrow: a shift by a count the intervals do not know', () => {
  const src = `export function f(n, k) {
  let s = 0
  for (let i = 0; i < n; i++) {
    let x = i & 7
    const a = (x = 5) >>> x, b = x >>> (x = (i & 3)), c = (i + 40) >>> (k & 31), d = (x = 9) >> x, e = (x = 2) << x
    s = (s * 31 + a + b * 3 + c * 5 + d * 7 + e * 11 + x) | 0
    if ((x = 1) >>> x !== 0) s += 1000
    if ((i + 1000) >>> k > 3) s += 7
  }
  return s
}`
  for (const n of [0, 5, 9, 20]) for (const k of [0, 1, 3, 33, -1]) agree(src, 'f', [n, k])
})

// A number the intervals know is truthy where it is not zero: no call to the
// runtime's kind chain for a flag carried as an integer.
test('int-narrow: the truthiness of a number the intervals know', () => {
  const src = `export function f(n) {
  let split = false, total = 0
  for (let g = 0; g < n; g++) {
    for (let i = 0; i < 4 && !split; i++) if ((g + i) % 7 === 3) split = true
    const size = split ? 0 : 8
    for (let j = 0; split && j < 8; j++) total += j
    total += size + (g % 5 ? 1 : 2)
    split = false
  }
  return total
}`
  shapes(src, w => ok(!w.includes('$__is_truthy'), 'no truthiness through the runtime'))
  for (const n of [0, 1, 5, 20, 100]) agree(src, 'f', [n])
})

// A typed array the function makes and keeps to itself holds what the function
// stores into it: an index read from one is bounded by those stores, and its
// arithmetic stays in i32 where the bound says so.
test('int-narrow: elements bounded by what the function stores', () => {
  const src = `export function f(n) {
  const stack = new Int32Array(n + 1), seen = new Int32Array(n)
  let top = 0, s = 0
  stack[top++] = 0
  while (top > 0) {
    const f = stack[--top]
    const base = f * 3
    s += base
    if (f < n && seen[f] === 0) { seen[f] = 1; stack[top++] = (f * 7 + 1) & 0xffff; if (top < n) stack[top++] = (f + 1) & 0xffff }
  }
  return s
}`
  shapes(src, w => { const copy = w.slice(w.search(/\(loop \$[^\s)]*\.f\d+[\s)]/)); ok(!/i64\.mul/.test(copy.slice(0, copy.indexOf('(br $'))), 'the product of an element the stores bound is an i32') })
  for (const n of [0, 1, 2, 5, 16, 100]) agree(src, 'f', [n])
})

test('int-narrow: i64 comparisons retain bits beyond exact Number integers', () => {
  const pairs = [
    ['9007199254740992', '9007199254740993'],
    ['-9007199254740992', '-9007199254740993'],
    ['9223372036854775806', '9223372036854775807'],
    ['-9223372036854775808', '-9223372036854775807'],
    ['0x7ff8000000000000', '0x7ff8000000000001'],
  ]
  for (const [a, b] of pairs) for (const op of ['eq', 'ne', 'lt_s', 'le_s', 'gt_s', 'ge_s']) {
    const src = `(module (func $f (export "f") (param $c i32) (result i32) (local $x i64)
      (local.set $x (select (i64.const ${a}) (i64.const ${b}) (local.get $c)))
      (if (result i32) (i64.${op} (local.get $x) (i64.const ${a})) (then (i32.const 7)) (else (i32.const 9)))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const c of [0, 0, 1, 0]) is(after(c), before(c), `${a}, ${b}, ${op}, c=${c}`)
  }
})

test('int-narrow: saturating i64 conversions keep their actual magnitude', () => {
  for (const n of ['1e30', '-1e30', 'inf', '-inf', 'nan', '4503599627370496', '-4503599627370496', '0']) {
    const src = `(module (func $f (export "f") (result i32)
      (f64.gt (f64.abs (f64.convert_i64_s (i64.trunc_sat_f64_s (f64.const ${n})))) (f64.const 1e25))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    is(after(), before(), `saturated magnitude, ${n}`)
  }
  const src = `(module (func $f (export "f") (param $c i32) (result i32) (local $x f64)
    (local.set $x (select (f64.const 1e30) (f64.const -1e30) (local.get $c)))
    (f64.gt (f64.abs (f64.convert_i64_s (i64.trunc_sat_f64_s (local.get $x)))) (f64.const 1e25))))`
  const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(ir[1])
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const c of [0, 0, 1, 0]) is(after(c), before(c), `saturated magnitude, c=${c}`)
})

test('int-narrow: wide integer indices saturate without a floating round trip', () => {
  for (const [op, by] of [['add', 1], ['sub', 1], ['mul', 3], ['add', 4294967296]]) {
    const src = `(module (global $calls (mut i32) (i32.const 0))
      (func $f (export "f") (param $n i32) (result i32)
        (i32.trunc_sat_f64_s (block (result f64)
          (global.set $calls (i32.add (global.get $calls) (i32.const 1)))
          (f64.${op} (f64.convert_i32_s (local.get $n)) (f64.const ${by})))))
      (func (export "calls") (result i32) (global.get $calls)))`
    for (const expand of [true, false]) {
      const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports
      const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
      narrowInts(fn, null, expand)
      is(JSON.stringify(fn).includes('trunc_sat_f64'), !expand, `${op} ${by}: compact saturation retained only without expansion`)
      const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports
      for (const n of [0, 0, 1, -1, 2, -2, 715827882, 715827883, -715827882, -715827883, 2147483646, 2147483647, -2147483647, -2147483648]) {
        is(after.f(n), before.f(n), `${op} ${by}, n=${n}, expand=${expand}`)
        is(after.calls(), before.calls(), `${op} ${by}, n=${n}, expand=${expand}: operand evaluated once`)
      }
    }
  }
})

test('int-narrow: guard refinements follow later operand writes', () => {
  const bodies = [
    'if (x < (x = (n + 1) & 7)) return x === 7; return 3',
    'return x < (x = (n + 1) & 7) ? x === 7 : 3',
    'if (x > (x = (n - 1) & 7)) return x === 0; return 3',
    'if (!((x < 3) & (x = (n + 5) & 7))) return x; return x === 7',
    'if ((x > 3) | (x = (n + 2) & 7)) return x; return x === 0',
    'if ((x = (n + 1) & 7) < 7) return x === 7; return x',
  ]
  for (const body of bodies) {
    const src = `export function f(n) { let x = n & 7; ${body} }`, host = oracle(src).f
    for (const optimize of [0, 1, 2, 3, 'size']) {
      const f = run(src, { optimize }).f
      for (const n of [6, 6, 0, 6, -1, 1, 2, 7, 8, 14, 2147483647, -2147483648])
        is(f(n), host(n), `${body}, ${optimize}, ${n}`)
    }
  }
})

test('int-narrow: eager compound guards keep refinements on current reads', () => {
  const guards = [
    '(i32.lt_s (local.get $x) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 1)) (i32.const 7))))',
    '(i32.and (i32.lt_s (local.get $x) (i32.const 3)) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 5)) (i32.const 7))))',
    '(i32.eqz (i32.or (i32.gt_s (local.get $x) (i32.const 3)) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 2)) (i32.const 7)))))',
  ]
  for (const guard of guards) {
    const src = `(module (func $f (export "f") (param $n i32) (result i32) (local $x i32)
      (local.set $x (i32.and (local.get $n) (i32.const 7)))
      (if (result i32) ${guard}
        (then (i32.eq (local.get $x) (i32.const 7)))
        (else (i32.eq (local.get $x) (i32.const 0))))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const n of [6, 6, 0, 6, -1, 1, 2, 3, 4, 5, 7, 8, 14]) is(after(n), before(n), `${guard}, n=${n}`)
  }
})

test('int-narrow: saved checked indices close the fast counter recurrence', () => {
  for (const change of ['', 'value', 'word', 'choice']) {
    const ir = parseWat(`(module
      (func $f (export "f") (param $seed i32) (param $n i32) (param $other f64) (result f64 i32)
        (local $v f64) (local $ix f64) (local $word i32) (local $valid i32)
        (local $choice i32) (local $address i32) (local $present i32) (local $i i32) (local $sum i32)
        (local.set $v ${change ? '(f64.convert_i32_s (local.get $seed))' : '(f64.const 1)'})
        (block $done (loop $again
          (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
          (br_if $done (f64.eq (local.get $v) (f64.const 0)))
          (local.set $ix (local.tee $v (f64.sub (local.get $v) (f64.const 1))))
          (local.set $valid (f64.eq (f64.convert_i32_s (local.tee $word
            (i32.wrap_i64 (i64.trunc_sat_f64_s (local.get $ix))))) (local.get $ix)))
          ${change === 'value' ? '(local.set $v (local.get $other))' : ''}
          ${change === 'word' ? '(local.set $word (i32.const 0))' : ''}
          (local.set $choice ${change === 'choice' ? '(i32.const 0)' : '(local.get $valid)'})
          (local.set $address (select (local.get $word) (i32.const ${change === 'choice' ? '0' : '-1'}) (local.get $${change === 'choice' ? 'choice' : 'valid'})))
          ${change === 'choice' ? '(local.set $choice (i32.const 1))' : ''}
          (local.set $present (i32.and (local.get $valid) (i32.lt_u (local.get $address) (i32.const 16))))
          (br_if $done (i32.eqz (local.get $present)))
          (local.set $sum (i32.add (local.get $sum) (i32.wrap_i64 (i64.trunc_sat_f64_s (local.get $v)))))
          (local.set $v (f64.add (local.get $v) (f64.const 2)))
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
        (local.get $v) (local.get $sum)))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    const fn = ir[1]
    narrowInts(fn)
    if (!change) ok(fn.some(n => n[0] === 'local' && n[1] === '$v' && n[2] === 'i32'), 'the guarded recurrence has complete word storage')
    else ok(!fn.some(n => n[0] === 'local' && n[1] === '$v' && n[2] === 'i32'), `${change}: stale bounds cannot narrow the counter`)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const seed of [0, 1, -1, 16, 2147483647, -2147483648]) for (const n of [0, 1, 2, 7, 7, 0, 30])
      for (const other of [0, -0, 0.25, 2 ** 32, Infinity, NaN])
        ok(after(seed, n, other).every((value, i) => Object.is(value, before(seed, n, other)[i])), `${change || 'stable'}, seed=${seed}, n=${n}, other=${other}`)
  }
})

test('int-narrow: saved guards do not refine overwritten or conditional values', () => {
  const patterns = [
    ['(local.set $saved (f64.eq (local.get $v) (local.get $v))) (local.set $v (local.get $other))', '(local.get $saved)'],
    ['(local.set $saved (f64.eq (local.get $v) (local.get $v))) (if (local.get $n) (then (local.set $v (local.get $other))))', '(local.get $saved)'],
    ['(local.set $saved (f64.eq (local.get $v) (local.get $v)))', '(local.tee $saved (i32.const 1))'],
    ['(local.set $saved (f64.eq (local.get $v) (local.get $v)))', '(i32.and (local.get $saved) (i32.eqz (i32.trunc_sat_f64_s (local.tee $v (local.get $other)))))'],
    ['(local.set $saved (f64.eq (local.get $v) (local.get $v))) (block $done (loop $again (br_if $done (i32.eqz (local.get $n))) (local.set $v (local.get $other)) (local.set $n (i32.sub (local.get $n) (i32.const 1))) (br $again)))', '(local.get $saved)'],
  ]
  for (const [setup, guard] of patterns) {
    const ir = parseWat(`(module (func $f (export "f") (param $x f64) (param $other f64) (param $n i32) (result f64)
      (local $v f64) (local $saved i32)
      (local.set $v (local.get $x)) ${setup}
      (if (result f64) ${guard}
        (then (f64.div (f64.const 1) (local.get $v))) (else (f64.const 7)))))`)
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [0, -0, 1, -1, 2147483648, Infinity, NaN]) for (const other of [0, -0, 0.5, -1, Infinity, NaN])
      for (const n of [0, 1, 2, 2, 0]) ok(Object.is(after(x, other, n), before(x, other, n)), `${setup}, ${x}, ${other}, ${n}`)
  }
})

test('int-narrow: saved predicate lookup tolerates shared IR and bounded exhaustion', () => {
  for (const shared of [false, true]) {
    const steps = Array.from({ length: 300 }, (_, i) => `(local.set $p${i} (local.get $${i ? 'p' + (i - 1) : 'saved'}))`).join('\n')
    const locals = Array.from({ length: 300 }, (_, i) => `(local $p${i} i32)`).join(' ')
    const ir = parseWat(`(module (func $f (export "f") (param $x f64) (param $other f64) (result f64)
      (local $v f64) (local $saved i32) ${locals}
      (local.set $v (local.get $x))
      (local.set $saved (f64.eq (local.get $v) (local.get $v)))
      ${steps}
      (if (local.get $saved) (then (local.set $v (local.get $other))))
      (if (result f64) (local.get $p299)
        (then (f64.div (f64.const 1) (local.get $v))) (else (f64.const 7)))))`)
    if (shared) {
      const value = ['local.get', '$v']
      const visit = n => {
        if (!Array.isArray(n)) return
        for (let i = 1; i < n.length; i++) {
          if (n[i]?.[0] === 'local.get' && n[i][1] === '$v') n[i] = value
          else visit(n[i])
        }
      }
      visit(ir)
    }
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const x of [0, -0, 1, NaN, Infinity]) for (const other of [0, -0, 1, -1, NaN, Infinity])
      ok(Object.is(after(x, other), before(x, other)), `shared=${shared}, x=${x}, other=${other}`)
  }
})

test('int-narrow: a shared write has distinct reaching occurrences', () => {
  for (const sameParent of [false, true]) {
    const ir = parseWat(`(module (func $f (export "f") (param $n f64) (result i32)
      (local $arg f64) (local $x f64) (local $copy f64) (local $saved i32)
      (local.set $arg (f64.const 1))
      (drop (local.tee $x (local.get $arg)))
      (local.set $saved (f64.lt (local.get $x) (f64.const 10)))
      (local.set $arg (local.get $n))
      (local.set $copy (local.tee $x (local.get $arg)))
      (if (result i32) (local.get $saved)
        (then (f64.eq (local.get $x) (f64.const 20))) (else (i32.const 0)))))`)
    const fn = ir[1], first = fn.find(n => n[0] === 'drop')
    const at = fn.findIndex(n => n[0] === 'local.set' && n[1] === '$copy')
    if (sameParent) fn[at] = first
    else fn[at][2] = first[1]
    const branch = fn[fn.length - 1]
    is(guardDefinitions().saved('$saved', [fn, branch], branch[2]), null, 'the saved predicate cannot describe a different execution of the shared writer')
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(fn)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const n of [0, -0, 1, 20, 20, -1, 0.5, Infinity, NaN, 2147483648]) is(after(n), before(n), `shared writer, same parent=${sameParent}, n=${n}`)
  }
})


test('int-narrow: a saved select condition can be negative or zero', () => {
  const ir = parseWat(`(module (func $f (export "f") (param $n i32) (param $v i32) (result i32)
    (local $choice i32) (local $value i32) (local $saved i32)
    (block (result i32)
      (local.set $choice (select (i32.const -1) (i32.const 0) (local.get $n)))
      (local.set $value (select (i32.const 0) (local.get $v) (local.get $choice)))
      (local.set $saved (i32.lt_s (local.get $value) (i32.const 10)))
      (if (result i32) (local.get $saved)
        (then (local.get $v)) (else (i32.const 30))))))`)
  const fn = ir[1], start = fn.findIndex(n => n[0] === 'block')
  const read = fn[start].at(-1).find(n => n[0] === 'then')[1]
  is(intRanges(fn, start).av.get(read).hi, 2147483647, '[-1, 0] does not establish the false arm')
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(fn)
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const n of [0, 1, -1]) for (const v of [-2147483648, -1, 0, 9, 10, 20, 2147483647])
    is(after(n, v), before(n, v), `n=${n}, v=${v}`)
})

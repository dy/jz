// Number methods (toString/toFixed/toExponential/toPrecision), numeric coercion
// (Number()/parseFloat/unary +/String()), and template-literal interpolation.
// String-method tests (charAt/charCodeAt/at/search/match) live in strings.js.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, cases, wat, funcWat, oracle } from './util.js'
import { levels, onWasi, onKernel } from './_matrix.js'
import jz from '../index.js'
import encodeWat from 'watr/compile'
import { numberNanIR, truthyIR } from '../src/ir/sentinels.js'

test('numeric NaN carrier predicate rejects infinities and preserves non-box payloads', () => {
  const binary=encodeWat(['module', ['func', '$f', ['param', '$v', 'i64'], ['result', 'i32'],
    numberNanIR(['f64.reinterpret_i64', ['local.get', '$v']])], ['export', '"f"', ['func', '$f']]])
  const {f}=new WebAssembly.Instance(new WebAssembly.Module(binary)).exports
  for(const bits of [0n,0x8000000000000000n,0x3ff0000000000000n,0x7ff0000000000000n,0xfff0000000000000n,
    0x7ff8000100000000n,0x7ff8000200000000n,0x7ff8000400000000n,0x7ff8000500000000n,
    0x7ff8001000000000n,0x7ff87fffffffffffn])is(f(bits),0,`non-NaN or atom ${bits.toString(16)}`)
  for(let tag=0;tag<16;tag++){
    const shift=BigInt(tag)<<47n
    is(f(0x7ff0000012345678n|shift),1,`signaling payload ${tag}`)
    is(f(0xfff8000012345678n|shift),1,`negative payload ${tag}`)
    if(tag)is(f(0x7ff8000012345678n|shift),0,`actual positive quiet box ${tag}`)
  }
  for(const low of [0n,1n,0xffffffffn])is(f(0x7ff8000000000000n|low),1,'ATOM aux0 is numeric with any low payload')
  const literals=[0n,0x8000000000000000n,0x3ff0000000000000n,0x7ff0000000000000n,0xfff0000000000000n,
    0x7ff0000012345678n,0xfffa800012345678n,0x7ff8000000000001n,0x7ff8001000000000n]
  const funcs=literals.map((bits,i)=>['func', `$f${i}`, ['export', `"f${i}"`], ['result','i32'],
    truthyIR(['f64.reinterpret_i64', ['i64.const', '0x'+bits.toString(16)]])])
  const literalExports=new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module',...funcs]))).exports
  for(let i=0;i<literals.length;i++)is(literalExports[`f${i}`](),[0,0,1,1,1,0,0,0,1][i],`literal carrier truthiness ${i}`)
})

test('generic numeric NaNs retain classification, conversion and equality', () => {
  const src=`function value(hi,mode){if(mode===1)return '12';if(mode===2)return null;if(mode===3)return undefined;
    if(mode===4)return true;if(mode===5)return 7n;if(mode===6)return Symbol.for('nan control');
    const raw=new Uint32Array([305419896,hi]);return new Float64Array(raw.buffer)[0]}
    export function f(hi,mode){const v=value(hi,mode);let number,bigint,text;
      try{number=Number(v)}catch(e){number=e.name}
      try{bigint=BigInt(v)}catch(e){bigint=e.name}
      try{text=typeof v==='symbol'?'symbol':String(v)}catch(e){text=e.name}
      return[typeof v,Number.isNaN(v),Number.isFinite(v),Boolean(v),v===v,v==v,number,bigint,text,v===7,v==7n,
        typeof v==='number',typeof v==='string',typeof v==='object',typeof v==='function',typeof v==='bigint',v==='12',v=='12']}
    export function effects(hi,fail){const v=value(hi,0);let trace='';const obj={valueOf(){trace+='v';if(fail)throw 17;return 3}};
      try{return[v==obj,obj==v,trace]}catch(e){return[e,trace]}}
    export function parse(hi){const v=value(hi,0);return[parseFloat(v),parseInt(v),+v]}`
  const want=oracle(src)
  const words=[0x3ff00000,0x7ff00000,0x7ff08000,0x7ff28000,0x7ff30000,0x7ff80000,0xfff80000,0xfffa8000]
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const hi of [...words,...words.slice(0,2)]){
      for(const mode of [0,0,1,2,3,4,5,6,0])is(got.f(hi,mode),want.f(hi,mode),`generic payload ${hi.toString(16)}, mode${mode} O${optimize}`)
      for(const fail of [false,true,false])is(got.effects(hi,fail),want.effects(hi,fail),`loose equality effects O${optimize}`)
      is(got.parse(hi),want.parse(hi),`numeric parsing O${optimize}`)
    }
  }
})

test('typed includes tests the needle for NaN and keeps infinity unequal', () => {
  for(const Ctor of ['Float64Array','Float32Array']){
    const src=`export function f(x){const a=new ${Ctor}([NaN,3,-0]);return[a.includes(x),a.indexOf(x),a.lastIndexOf(x)]}
      export function empty(x){const a=new ${Ctor}(0);return[a.includes(x),a.indexOf(x),a.lastIndexOf(x)]}`
    const want=oracle(src)
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize}).exports
      for(const x of [NaN,NaN,-Infinity,Infinity,3,0,-0,undefined,null,'3',NaN]){
        is(got.f(x),want.f(x),`${Ctor} needle ${String(x)} O${optimize}`)
        is(got.empty(x),want.empty(x),`${Ctor} empty ${String(x)} O${optimize}`)
      }
    }
  }
})

test("number formatting: shared modules preserve each other's retained strings", () => {
  if (onWasi() || onKernel()) return
  const src = `let saved = []
    export function save(x) { saved.push(String(x)); return saved.length }
    export function read() { return saved.join('|') }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const one = jz(src, { optimize, memory: jz.memory() })
    const two = jz(src, { optimize, memory: one.memory })
    const a = [], b = []
    for (const [x, y] of [[0, -0], [999999, 1000000], [12.5, 12.5], [1e21, -1e-7], [7, Number.MAX_VALUE], [7, 0]]) {
      a.push(String(x)); b.push(String(y))
      is(one.exports.save(x), a.length)
      is(two.exports.save(y), b.length)
      is(one.exports.read(), a.join('|'), "the second module preserves the first module's strings")
      is(two.exports.read(), b.join('|'), 'both modules keep independent formatting history')
    }
  }
})

test('number formatting: scratch reuse preserves retained strings and error recovery', () => {
  const src = `let saved = []
    export function save(x) {
      const a = [String(x), String(x | 0), BigInt(x | 0).toString(16), x.toString(16)]
      saved.push(a); return a.join('|')
    }
    export function decimal(x) { const s = String(x); saved.push([s]); return s }
    export function read() { return JSON.stringify(saved) }
    export function bad(x, radix) { try { return x.toString(radix) } catch (e) { return e.name } }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const ex = run(src, { optimize }), js = oracle(src)
    is(ex.read(), '[]', 'zero formatting leaves an empty result list')
    for (const value of [0, -0, 1, 999999, 1000000, -99999, -100000, 12.5, 12.5, 0.125, 12.5]) {
      is(ex.save(value), js.save(value), 'short, long, repeated and changed values match JS')
      is(ex.read(), js.read(), 'later scratch reuse leaves every retained result intact')
    }
    for (const value of [Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 1e-7, 1e21, NaN, Infinity, -Infinity, 0])
      is(ex.decimal(value), js.decimal(value), 'decimal boundary and non-finite values remain exact')
    for (const radix of [1, 37, 0]) is(ex.bad(10, radix), 'RangeError', 'invalid radix fails before scratch allocation')
    is(ex.save(12.5), js.save(12.5), 'formatting resumes after an error')
    is(ex.read(), js.read(), 'old long strings survive short results, errors and recovery')
  }
})

// === toString ===

test('integer formatting: exact UTF-16 writes at decimal and memory boundaries', () => {
  const text = wat(`export let f = (i, v) => 'x' + (i|0) + ',' + (v|0) + '!'`,
    { optimize: { level: 2, watr: false } })
  // Isolate the actual helpers so a wrong width cannot hide in spare heap space.
  const names = ['__itoa', '__itoa_s', '__ilen']
  const { memory, __itoa, __itoa_s, __ilen } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(`(module
    (memory (export "memory") 1)
    ${names.map(name => funcWat(text, name) + `(export "${name}" (func $${name}))`).join('\n')}
  )`))).exports
  const units = new Uint16Array(memory.buffer)
  const edges = [0, 0, 1, 2147483647, 2147483648, 4294967295]
  for (let n = 10; n <= 1e9; n *= 10) edges.push(n - 1, n, n + 1)
  edges.push(42, 42, 4294967295, 42)
  for (const signed of [false, true]) for (const edge of edges) {
    const value = signed ? edge | 0 : edge
    const expected = String(value)
    if (signed) is(__ilen(value), expected.length, `width of ${value}`)
    for (const start of [8, units.length - expected.length]) {
      units.fill(0xcafe)
      const length = (signed ? __itoa_s : __itoa)(value, start * 2)
      is(length, expected.length, `written length of ${value}`)
      is(String.fromCharCode(...units.subarray(start, start + length)), expected, `digits of ${value}`)
      is(units[start - 1], 0xcafe, 'prefix untouched')
      if (start + length < units.length) is(units[start + length], 0xcafe, 'suffix untouched')
    }
  }
})

test('Number: toString', () => {
  cases([
    ['integer', '() => { let n = 42; return n.toString().length }', 2],
    ['zero', '() => { let n = 0; return n.toString().length }', 1],
    ['negative', '() => { let n = -7; return n.toString().length }', 2],
    ['float', '() => { let n = 1.5; return n.toString().length }', 3],
    ['large', '() => { let n = 123456; return n.toString().length }', 6],
    ['NaN', '() => (0/0).toString().length', 3],
    ['Infinity', '() => (1/0).toString().length', 8],
    ['-Infinity', '() => (-1/0).toString().length', 9],
    ['large int', '() => { let n = 9999999999; return n.toString().length }', 10],
    ['1e15', '() => { let n = 1000000000000000; return n.toString().length }', 16],
    // __ftoa was stripping trailing zeros from the integer part when prec=0 (auto-fit
    // reduces prec because scaled value won't fit i32). Repro: 1079623680 → "107962368".
    // Found via biquad bench when `(s >>> 0) / 4294967296` style PRNG output got
    // stringified via template literal. Fix: gate strip-trailing-zeros on prec>0.
    ['preserves trailing zero in integer', '() => { let n = 1079623680; return n.toString().length }', 10],
    ['preserves multiple trailing zeros in integer', '() => { let n = 1234567000; return n.toString().length }', 10],
    // The original bench bug surfaced via template-literal interpolation of an
    // i32-spec'd value. Compute a value with trailing zero so it can't fold,
    // then stringify. Without the fix, "1079623680" became "107962368" (length 9).
    ['preserves trailing zero through computed value', '() => { let n = 539811840 + 539811840; return n.toString().length }', 10],
  ])
})

// === toString(radix) — spec-compliant range validation ===
// Per 21.1.3.6: radix coerces to integer in [2, 36]; otherwise RangeError.
// Pre-fix: radix=1 hung the digit loop, radix=0 trapped 'remainder by zero',
// radix=37 / -1 silently returned wrong digit strings.

test('Number: toString(radix)', () => {
  cases([
    ['toString(2) binary', '() => (15).toString(2).length', 4],  // "1111"
    ['toString(16) hex', '() => (255).toString(16).length', 2],  // "ff"
    ['toString(36) max', '() => (35).toString(36).length', 1],  // "z"
    ['toString(1) throws (caught)', '() => { try { (15).toString(1); return 0 } catch (e) { return 1 } }', 1],
    ['toString(37) throws (caught)', '() => { try { (15).toString(37); return 0 } catch (e) { return 1 } }', 1],
    ['toString(0) throws (caught)', '() => { try { (15).toString(0); return 0 } catch (e) { return 1 } }', 1],
    ['toString(-1) throws (caught)', '() => { try { (15).toString(-1); return 0 } catch (e) { return 1 } }', 1],
    ['toString(dyn-radix) ok', '(r) => { try { return (255).toString(r).length } catch (e) { return -1 } }', 2, 16],
    ['toString(dyn-radix) bad', '(r) => { try { return (255).toString(r).length } catch (e) { return -1 } }', -1, 50],
  ])
})

test('Number: radix digits and sign survive reversal', () => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { f } = run('export let f = (n, r) => n.toString(r)', { optimize })
    for (const radix of [2, 8, 16, 36])
      for (const n of [0, 1, -1, 17, -255, 1024, 2147483647, -2147483648, 4294967295, 1.5, -15.5])
        is(f(n, radix), n.toString(radix), `O${optimize}: ${n} in base ${radix}`)
  }
})

test('number formatting: scratch becomes the result without retaining temporary storage', () => {
  const src = `
    export function dec(n) { return n.toString() }
    export function int(n) { return String(n|0) }
    export function radix(n, r) { return n.toString(r) }
    export function big(n, r) { return BigInt(n).toString(r) }
    let saved = ''
    export function hold(n, r) { saved = n.toString(r) }
    export function held() { return saved }
    export function invalid(r) { try { return (17).toString(r) } catch (e) { return e.name } }
  `
  const rows = [
    ...[0, -0, 42, 42, 999999, 1000000, -2147483648, 0.125, 1.23456789,
      Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity].map(n => ['dec', [n], String(n)]),
    ...[0, 42, 999999, 1000000, -2147483648, 2147483647].map(n => ['int', [n], String(n)]),
    ...[2, 8, 16, 36].flatMap(r => [0, -1, 123456789, -2147483648, 1.5, -15.5]
      .map(n => ['radix', [n, r], n.toString(r)])),
    ...[2, 10, 16, 36].flatMap(r => [0, 42, -2147483648, -(2 ** 63)]
      .map(n => ['big', [n, r], BigInt(n).toString(r)]))
  ]
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const alloc of [true, false]) {
    const r = jz(src, { optimize, alloc })
    // The raw ABI deliberately hides its private heap cursor. Its alias and
    // value checks still run; measure allocation where the counter is exposed.
    const heap = r.instance.exports.__heap
    if (alloc) ok(heap, 'the owned allocator exposes its counter')
    for (let round = 0; round < 2; round++) {
      r.exports.hold(123456789, 2)
      for (const [name, args, expected] of rows) {
        const before = heap ? heap.value >>> 0 : 0
        is(r.exports[name](...args), expected, `${name} ${args} O${optimize}`)
        const resultBytes = expected.length <= 6 ? 0 : (4 + expected.length * 2 + 7) & ~7
        if (heap) ok((heap.value >>> 0) - before <= resultBytes + 16, 'only the result and possible BigInt box remain')
        is(r.exports.held(), (123456789).toString(2), 'later formatting preserves retained digits')
      }
      is(r.exports.invalid(1), 'RangeError')
      is(r.exports.invalid(37), 'RangeError')
      is(r.exports.radix(17, 2), '10001', 'formatting still works after a rejected radix')
      if (alloc) r.instance.exports._clear()
    }
  }
})

test('number formatting: shared memories retain independent results across instances', () => {
  if (onKernel()) return // Host memory wiring is outside the single-source kernel API.
  for (const shared of [false, true]) {
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 128, shared })
    const src = `let saved = ''; export function hold(n, r) { saved = n.toString(r) }
      export function held() { return saved }
      export function dec(n) { return n.toString() }
      export function big(n) { return BigInt(n).toString(2) }`
    const a = jz(src, { memory, sharedMemory: shared }), b = jz(src, { memory, sharedMemory: shared })
    a.exports.hold(123456789, 2)
    b.exports.hold(-123456789, 16)
    for (const n of [0, 0, 123456789.125, Number.MIN_VALUE, -42]) {
      is(a.exports.dec(n), String(n))
      is(b.exports.dec(n), String(n))
      is(a.exports.held(), (123456789).toString(2))
      is(b.exports.held(), (-123456789).toString(16))
    }
    is(a.exports.big(-2147483648), (-2147483648n).toString(2))
    is(b.exports.held(), (-123456789).toString(16))
  }
})

// === toFixed ===

test('Number: toFixed', () => {
  cases([
    ['toFixed(2)', '() => { let n = 3.14159; return n.toFixed(2).length }', 4],
    ['toFixed(0) rounds', '() => { let n = 3.7; return n.toFixed(0).length }', 1],
    ['toFixed(3) pads', '() => { let n = 1; return n.toFixed(3).length }', 5],
  ])
})

// === toExponential ===

test('Number: toExponential', () => {
  cases([
    ['toExponential(2)', '() => { let n = 123; return n.toExponential(2).length }', 7],
    ['toExponential(0)', '() => { let n = 5; return n.toExponential(0).length }', 4],
    ['toExponential small', '() => { let n = 0.0042; return n.toExponential(1).length }', 6],
  ])
})

// === toPrecision ===

test('Number: toPrecision', () => {
  cases([
    ['toPrecision(5) fixed', '() => { let n = 123; return n.toPrecision(5).length }', 6],
    ['toPrecision(2) exponential', '() => { let n = 123; return n.toPrecision(2).length }', 6],
    ['toPrecision(3) float', '() => { let n = 1.5; return n.toPrecision(3).length }', 4],
  ])
})

// === String() / expression toString ===

test('Number: String() / expression toString', () => {
  cases([
    ['String(42)', '() => String(42).length', 2],
    ['no argument returns empty string', "() => String() === ''", true],
    ['nullish, string, and number coercion', "() => (String(null) === 'null') + (String(undefined) === 'undefined') + (String('x') === 'x') + (String(3) === '3')", 4],
    ['unary plus string coerces', '() => +"0"', 0],
    ['unary plus variable string coerces', '() => { let s = "12"; return +s + 1 }', 13],
    ['Number(string) coerces', '() => Number("7.5")', 7.5],
    ['parseFloat common decimal parity', `() =>
    (parseFloat("6.28318530717958623") === 6.283185307179586) +
    (parseFloat("0.1") === 0.1) +
    (parseFloat("1e2") === 100) +
    (parseFloat("1e-2") === 0.01) +
    (parseFloat("1e") === 1) +
    (parseFloat("1e-") === 1) +
    (parseFloat(".5") === 0.5) +
    (parseFloat("000.00000123456789012345") === 0.00000123456789012345) +
    (parseFloat("123456789012345678901") === 123456789012345680000) +
    isNaN(parseFloat("."))`, 10],
    // Per JS spec, parseFloat(x) calls ToString(x) first. Array → "4", number → "12.5".
    ['parseFloat coerces non-string via ToString (array)', '() => parseFloat([4])', 4],
    ['parseFloat coerces non-string via ToString (number)', '() => parseFloat(12.5)', 12.5],
    ['String(0)', '() => String(0).length', 1],
    ['(1+2).toString()', '() => (1+2).toString().length', 1],
  ])
})

// === Template literal coercion ===

test('Template:', () => {
  cases([
    ['number interpolation', '() => `n=${42}`.length', 4],
    ['multiple interpolations', '() => `${1}+${2}=${1+2}`.length', 5],
    ['string var interpolation', '() => { let s = "world"; return `hello ${s}`.length }', 11],
    ['float interpolation', '() => `pi=${3.14}`.length', 7],
  ])
})

// Documented divergence: subscript parses the leading-zero form as decimal, so a
// legacy octal literal is its decimal digits (not octal, and not the SyntaxError a
// JS module/strict mode raises). Use 0o377 for octal.
test('Number: legacy octal literal is decimal (documented divergence)', () => {
  cases([
    ['0377', '() => 0377', 377],    // not 255
    ['0o377', '() => 0o377', 255],  // explicit octal is correct
  ])
})

test('Number: a bound `>>> 0` uint32 reads and computes as its unsigned value', () => {
  // `let u = expr >>> 0` holds the full uint32 (can exceed signed i32). The binding is typed f64,
  // so reads, arithmetic, and the return all match JS — not the old signed-i32 wrap. (0 - 1 = -1.)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u }').f(), 4294967295)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u + 1 }').f(), 4294967296)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u * 2 }').f(), 8589934590)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u / 4294967296 }').f(), (4294967295) / 4294967296)
  // A ToUint32 hash accumulator (literal init, every use `>>> 0`-sunk) keeps the fast i32 path.
  is(run('export let f = () => { let h = 0; for (let i = 0; i < 5; i++) { h = (h * 31 + 7) >>> 0 } return h }').f(),
     (() => { let h = 0; for (let i = 0; i < 5; i++) { h = (h * 31 + 7) >>> 0 } return h })())
})

test('Number: a bound `>>> k` (k≥1) keeps the fast signed-i32 path and stays correct', () => {
  // `expr >>> k` for a constant k with (k & 31) ≥ 1 lands in [0, 2³¹−1] — it fits a *signed*
  // i32, so the binding stays i32 (the FFT index path: `nn >>> 1`), unlike the `>>> 0` above
  // which must widen to f64. The unsigned-shift semantics still hold: a value negative as a
  // signed i32 before the shift (−1 ≡ 0xFFFFFFFF) reads as uint32 >>> k, never the signed >>.
  is(run('export let f = () => { let u = (0 - 1) >>> 1; return u }').f(), 2147483647)   // 0xFFFFFFFF >>> 1
  is(run('export let f = () => { let u = (0 - 2) >>> 1; return u }').f(), 2147483647)   // 0xFFFFFFFE >>> 1
  is(run('export let f = () => { let u = (0 - 1) >>> 4; return u }').f(), 268435455)    // 0xFFFFFFFF >>> 4
  is(run('export let f = () => { let u = (0 - 1) >>> 31; return u }').f(), 1)
  // `>>> 32` ≡ `>>> 0` (shift count is mod 32) → full uint32, so it must still widen to f64.
  is(run('export let f = () => { let u = (0 - 1) >>> 32; return u }').f(), 4294967295)
})

// === Regression: String() large-value fraction-drop + trap ===
// Pre-fix, the __ftoa fit loop reduced precision until the scaled integer fit i32, which
// (a) dropped the fractional part once floor(val) exceeded ~2^31, and (b) trapped on the
// large-integer digit-extraction path for values just below the 1e21 exponential threshold
// (a per-digit subtraction could go slightly negative under f64 rounding → i32.trunc_f64_u trap).
test('Number: String() large-value fraction-drop + trap', () => {
  cases([
    ['preserves the fraction: 1073741824.5', '() => String(1073741824.5)', String(1073741824.5)],  // '1073741824.5'
    ['preserves the fraction: 4294967295.5', '() => String(4294967295.5)', String(4294967295.5)],  // '4294967295.5'
    ['does not trap for large values below 1e21', '() => String(999999900000000000000)', String(999999900000000000000)],
  ])
})

// ---- platform-NaN const folding (the linux-x64 self-compile OOB) ----------------
// x64 wasm arithmetic produces SIGN-SET qNaNs where arm64 produces canonical
// ones. A folded NaN (Math.sqrt(-1) on the narrowed path) must normalize to
// the canonical atom before it rides a kind-erased const-node slot — and the
// detector must be Number.isNaN, not `v !== v`: in-kernel `!==` goes through
// __eq's bit-equality, where a sign-set qNaN equals itself (the arm that keeps
// negative i64-carrier BigInts working), so the !== guard missed exactly the
// payload that traps. Byte-identical kernels passed on arm64 and OOB'd on
// linux-x64 until this.

test('NaN const fold: sqrt(-1) through reductions stays canonical', () => {
  const r = run(`
    export const main = () => {
      const N = 64
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i + 1
      a[13] = Math.sqrt(-1)
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.max(m, a[i])
      return (m !== m) | 0
    }
  `, { optimize: 2 })
  is(r.main(), 1)
})

// ---- Eisel-Lemire mul64 carry fix (1-ULP misparse) --------------------------
// The __dec_to_f64 WASM implementation used a 3-way 64-bit addition to compute
// the 128-bit product's middle limb (mid = t01 + t10 + (t00>>32)). For certain
// inputs the addition overflows 64 bits, silently dropping a carry bit into the
// high 64-bit product word. This produced a result 1 ULP low for values like
// 2505210838544172e-23.  Fix: split into two sequential additions, detecting
// overflow from each step and propagating the carry into p1hi.

test('Number: unary + / Number() correctly-rounded hard cases (EL carry fix)', () => {
  // 2505210838544172e-23: triggers the mul64 carry overflow in __dec_to_f64.
  // The 3-way mid accumulation (t01 + t10 + t00>>32) overflowed 64 bits, dropping
  // a carry bit into p1hi, producing a result 1 ULP too low.
  is(run(`export let f = () => +"2505210838544172e-23"`).f(), 2.505210838544172e-8)
  is(run(`export let f = () => +"2.505210838544172e-8"`).f(), 2.505210838544172e-8)
  // More cases inside the trimmed table range (exp10 ∈ [-65,65]) — the realistic
  // span every source / JSON constant lives in (fft/synth's coefficients are ~10^-23).
  is(run(`export let f = () => +"1e-23"`).f(), 1e-23)
  is(run(`export let f = () => +"9007199254740992"`).f(), 9007199254740992) // 2^53 exact
  is(run(`export let f = () => +"1.23456789012345678e-40"`).f(), 1.23456789012345678e-40)
  is(run(`export let f = () => +"6.022140857e23"`).f(), 6.022140857e23)
  // f64-EXTREME exponents (|10^e| > 10^65 — denormals / near-MAX) intentionally fall
  // back to POW10_SCALE (the EL table is trimmed for size, see module/number.js).
  // No real-world literal reaches them; Number.MIN_VALUE / Number.MAX_VALUE are still
  // exact (emitted as f64.const, not parsed). The mul64 carry fix is exercised by the
  // 2505210838544172e-23 case above (exp10 -23, inside the table).
})

// ---- parseInt/parseFloat spec edges (test262 builtins gate, 2026-07-10) -----
// parseInt: StrWhiteSpace is UTF-8-decoded __skipws (NBSP/LS/PS/Zs — was ASCII-
// only), invalid radix (≠0 and outside 2..36 after ToInt32) is NaN before any
// input inspection, and a number input takes ToString like any other value —
// the trunc fast path is valid only in the plain-decimal range (no exponent in
// ToString): parseInt(1e21) is 1, parseInt(1e-7) is 1, parseInt(Infinity) NaN,
// parseInt(-0) +0.

test('Number: parseInt whitespace / radix / numeric-arg spec edges', () => {
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // NBSP
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // LS
  is(run(`export let f = () => parseInt(" 7", 10)`).f(), 7)      // PS, explicit radix
  is(run(`export let f = () => isNaN(parseInt("0", 1))`).f(), true)   // radix < 2 (isNaN exports as real boolean)
  is(run(`export let f = () => isNaN(parseInt("0", 37))`).f(), true)  // radix > 36
  is(run(`export let f = () => isNaN(parseInt("11", -2147483650))`).f(), true) // ToInt32-wrapped radix
  is(run(`export let f = () => isNaN(parseInt(Infinity))`).f(), true) // "Infinity" has no digits
  is(run(`export let f = () => parseInt(1e21)`).f(), 1)               // "1e+21" → 1
  is(run(`export let f = () => parseInt(1e-7)`).f(), 1)               // "1e-7" → 1
  is(run(`export let f = () => 1 / parseInt(-0)`).f(), Infinity)      // ToString(-0)="0" → +0
  is(run(`export let f = () => 1 / parseInt(-0.5)`).f(), -Infinity)   // "-0.5" → -0
  is(run(`export let f = () => parseInt(123.9)`).f(), 123)            // plain-decimal fast path
  is(run(`export let f = () => parseFloat(" 1.5")`).f(), 1.5)    // parseFloat same skip
})

// Ryū shortest round-trip String(number) (2026-07-11, Ring 2): reference values
// verified against live V8 (node) String() — spec Number::toString, incl.
// notation boundaries (1e21 / 1e-7), subnormals, ties, and -0.
test('Number: String() shortest round-trip (Ryū)', () => {
  const f = run(`export let f = (x) => String(x)`).f
  is(f(0.1), '0.1')
  is(f(0.3), '0.3')
  is(f(0.1 + 0.2), '0.30000000000000004')
  is(f(Math.PI), '3.141592653589793')
  is(f(1 / 3), '0.3333333333333333')
  is(f(100), '100')
  is(f(1024), '1024')
  is(f(-0), '0')
  is(f(1.0000000000000002), '1.0000000000000002')
  is(f(5e-324), '5e-324')                                  // min subnormal
  is(f(1.7976931348623157e308), '1.7976931348623157e+308') // MAX_VALUE
  is(f(1e21), '1e+21')                                     // notation boundary
  is(f(999999999999999900000), '999999999999999900000')    // last plain integer form
  is(f(1e-6), '0.000001')
  is(f(1e-7), '1e-7')
  is(f(123456.789), '123456.789')
  is(f(-123456.789), '-123456.789')
  is(f(2 ** 53), '9007199254740992')
  is(f(4.35), '4.35')
  is(f(999999999.9), '999999999.9')
})

// The fifteen-digit path (a value whose shortest form has at most 15 significant
// digits skips the Ryū core): differential against V8's String(), the spec's
// Number::toString (ECMA-262 §6.1.6.1.20), across the path's edges and a seeded
// sweep of short decimals, integers and full-precision doubles.
test('Number: String() of short decimals agrees with Number::toString', () => {
  const f = run(`export let f = (x) => String(x)`).f
  const edges = [31.5, 0.25, 16000, 48000, 1e15 - 1, 1e15, 1e15 + 1, 999999999999999.9, 99999999999999.98, 2 ** 53 - 1, 2 ** 53 + 2,
    1e-7, 9.999999999999999e-8, 1.2e-7, 5e-7, 123456789012345e-7, 1234567890123456e-7, 0.1 + 0.7, 1.005, 0.035, 4503599627370495.5, 1e14 + 0.5]
  let r = 0x2545f491
  const rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296
  const gen = [() => +(rnd() * 10 ** (rnd() * 20 - 8)).toPrecision(1 + Math.floor(rnd() * 17)), () => Math.round(rnd() * 1e6) / 10 ** Math.floor(rnd() * 9),
    () => Math.floor(rnd() * 2 ** Math.floor(rnd() * 60)), () => rnd() * 10 ** (rnd() * 30 - 10)]
  const vals = [...edges, ...Array.from({ length: 8000 }, (_, i) => gen[i % 4]())]
  let bad = 0
  for (const v of vals) for (const x of [v, -v]) if (f(x) !== String(x) && bad++ < 5) is(f(x), String(x), `String(${x})`)
  is(bad, 0, `${bad} of ${vals.length * 2} disagree`)
})


test('Number/parseFloat: saturated exponents and a single exponent sign', () => {
  const { n, p } = run(`export function n(s) { return Number(s) }
    export function p(s) { return parseFloat(s) }`)
  for (const s of ['1e4294967296', '1e-4294967296', '0e9999', '1e-+2', '1e+-2', '1e+', '5e-324', '100000000000000000000e2147483647', '0.' + '0'.repeat(20000) + '1e20001']) {
    is(Object.is(n(s), Number(s)), true, 'Number ' + s)
    is(Object.is(p(s), parseFloat(s)), true, 'parseFloat ' + s)
  }
})


test('Number/parseFloat: full decimal exponent range and high-product carries', () => {
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const { num, parse } = run('export const num=s=>Number(s); export const parse=s=>parseFloat(s)', { optimize })
    for (let q = -342; q <= 308; q++) for (const mant of ['1', '2505210838544172', '9007199254740991']) {
      const input = `${mant}e${q}`, expected = Number(input)
      is(num(input), expected, `Number(${input})`)
      is(parse(input), expected, `parseFloat(${input})`)
    }
    for (const mant of ['3', '9007199254740991', '9007199254740992', '9007199254740993', '9007199254740995'])
      for (const q of [-23, -22, -1, 0, 1, 22, 23]) {
        const input = `${mant}e${q}`
        is(num(input), Number(input), `exact-operand boundary: Number(${input})`)
        is(parse(input), parseFloat(input), `exact-operand boundary: parseFloat(${input})`)
      }
    is(num(''), 0, 'empty input')
    is(parse(''), NaN, 'empty parseFloat input')
    is(num('invalid'), NaN, 'invalid input')
    is(num('5e-324'), 5e-324, 'minimum subnormal after invalid input')
  }
})

test('Number.isNaN retains the numeric proof across a nullable helper result', () => {
  const src = `function maybe(k) {
    if (k === 0) return null
    if (k === -1) return undefined
    if (k === 2) return 7
    const b = new ArrayBuffer(8), u = new Uint32Array(b), f = new Float64Array(b)
    u[1] = k === 3 ? 0xfffa0000 : 0x7ffa0000
    u[0] = 32
    return f[0]
  }
  export function f(k) {
    const n = maybe(k), v = n != null ? n : 1
    const record = {value: Number.isNaN(v) ? NaN : v}
    return [Number.isNaN(n), Number.isNaN(v), String(record.value)]
  }`
  const native = new Function(src.replace('export ', '') + ';return f')()
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0, 0, -1, 1, 1, 2, 3, 0]) is(f(k), native(k), `O${optimize}, input ${k}`)
  }
})

// An integer below 2^53 renders as its digits (module/number.js __ftoa_shortest's
// integer path); the boundary and beyond keep the shortest representation.
test('number formatting: integers render as their digits, the 2^53 edge included', () => {
  const src = `export let s = (x) => String(x)
    export let key = (a, b) => a + ',' + b`
  const host = oracle(src)
  const vals = [0, -0, 1, -1, 9, 10, -10, 99, 12345, -987654321, 2147483647, -2147483648, 4294967296,
    9007199254740991, -9007199254740991, 9007199254740992, 9007199254740993, 1e15, 1e16, 1e20, 1e21,
    123456789012345680000, 2 ** 60, 1.5, -0.5, 1e-7]
  for (const optimize of levels(0, 2, 3)) {
    const got = run(src, { optimize })
    for (const v of vals) is(got.s(v), host.s(v), `String(${v}) at ${optimize}`)
    is(got.key(-3, 2), host.key(-3, 2), `key at ${optimize}`)
  }
})

test('Number generic boundaries canonicalize box-looking NaNs without changing numeric transport', () => {
  const src=`function raw(hi,lo){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[0]=lo;w[1]=hi;return a[0]}
    function see(v){let big;try{big=BigInt(v)}catch(e){big=e.name}
      return[typeof v,Number.isNaN(v),typeof v==='number',typeof v==='bigint',typeof v==='undefined',Boolean(v),String(v),v===v,big]}
    function result(hi,lo,mode){if(mode)return 'text';return raw(hi,lo)}
    function defaulted(v=4){return v}
    function numeric(v){return[typeof v,typeof v==='number',typeof v==='bigint',Number.isNaN(v),Boolean(v),String(v),String(v??1),v?.toString(),v==null,v===undefined]}
    let saved='initial';
    export function f(hi,lo,mode){const v=raw(hi,lo), a=[mode?'text':v],o={v:mode?'text':v};
      let local='text';if(!mode)local=v;saved=local;
      const bool=mode?true:v,big=mode?7n:v,missing=mode?undefined:v,nil=mode?null:v;
      return[see(a[0]),see(o.v),see(local),see(saved),see(bool),see(big),see(missing),see(nil),see(result(hi,lo,mode))]}
    export function direct(hi,lo,mode){if(mode)return see('text');return see(raw(hi,lo))}
    export function plain(hi,lo){return numeric(raw(hi,lo))}
    export function defaults(hi,lo){const v=raw(hi,lo),arrow=(x=5)=>x;return[defaulted(),defaulted(v),arrow(),arrow(v)]}
    export function copy(hi,lo){const a=new Float64Array(1);a[0]=raw(hi,lo);return Array.from(new Uint32Array(a.buffer))}
    export function joinedCopy(hi,lo,yes){const a=new Float64Array(1),v=raw(hi,lo);a[0]=yes?v:(raw(hi,lo)??0);return Array.from(new Uint32Array(a.buffer))}`
  const want=oracle(src)
  const words=[[0,0],[0x80000000,0],[0x3ff00000,0],[0x7ff00000,0],[0xfff00000,0],
    [0x7ff00000,1],[0xfffa8000,0x12345678],...[1,2,4,5,16].map(aux=>[0x7ff80000+aux,0]),
    ...Array.from({length:16},(_,tag)=>[0x7ff80000+tag*0x8000,0x12345678])]
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const [hi,lo]of [...words,...words.slice(0,3)]){
      for(const mode of [0,0,1,0]){
        is(got.f(hi,lo,mode),want.f(hi,lo,mode),`generic ${hi.toString(16)}:${lo.toString(16)} mode${mode} O${optimize}`)
        is(got.direct(hi,lo,mode),want.direct(hi,lo,mode),`direct mixed argument O${optimize}`)
      }
      is(got.plain(hi,lo),want.plain(hi,lo),`uniform Number observations O${optimize}`)
      is(got.defaults(hi,lo),want.defaults(hi,lo),`numeric defaults accept missing values but not NaN payloads O${optimize}`)
      is(got.copy(hi,lo),[lo,hi],`uniform Number return and typed store retain every bit O${optimize}`)
      for(const yes of [false,true])is(got.joinedCopy(hi,lo,yes),[lo,hi],`uniform Number joins retain every bit O${optimize}`)
    }
  }
})

test('Number nullable boundaries retain missing arms and evaluate reads once', () => {
  const src=`let reads=0;
    function see(v){return[typeof v,Number.isNaN(v),typeof v==='number',typeof v==='undefined',Boolean(v),String(v)]}
    export function f(hi,lo,k,mode){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[0]=lo;w[1]=hi;
      const v=a[+k];let local=mode?'text':v;const o=mode?null:{v};
      return[see(a[+k]),see(v),see(local),see(o?.v),see(v??'missing'),see(v||'falsey'),see(v&&'truthy')]}
    function value(a,k,fail){reads++;if(fail)throw 17;return a[k]}
    export function effects(hi,lo,k,fail){reads=0;const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[0]=lo;w[1]=hi;
      try{return[see(value(a,+k,fail)),reads]}catch(e){return[e,reads]}}`
  const want=oracle(src)
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const hi of [0x7ff80002,0x7ff88000,0x7ffa8000,0x80000000,0x3ff00000]){
      for(const k of [0,0,1,-1,.5,0])for(const mode of [0,1,0])
        is(got.f(hi,0,k,mode),want.f(hi,0,k,mode),`nullable payload ${hi.toString(16)} key${k} mode${mode} O${optimize}`)
      for(const [k,fail]of [[0,false],[0,false],[0,true],[1,false],[0,false]])
        is(got.effects(hi,0,k,fail),want.effects(hi,0,k,fail),`read effects/error recovery O${optimize}`)
    }
  }
})

test('Number container and closure boundaries preserve identity across retained calls', () => {
  const src=`function raw(hi,lo){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[0]=lo;w[1]=hi;return a[0]}
    function see(v){return[typeof v,Number.isNaN(v),Boolean(v),String(v)]}
    function returned(hi,lo,mode){return mode?'text':raw(hi,lo)}
    const kept=[],map=new Map();let cell='initial';
    export function save(hi,lo,mode){let captured=mode?'text':raw(hi,lo);const read=()=>captured;
      kept.push(read);cell=captured;map.set('value',captured);const a=[];a.push(captured);const o={};o['value']=captured;
      const arrow=()=>mode?'text':raw(hi,lo);return[see(read()),see(cell),see(map.get('value')),see(a[0]),see(o.value),see(arrow()),see(returned(hi,lo,mode))]}
    export function read(i){return see(kept[i]())}`
  for(const optimize of levels(0,1,2,3,'size')){
    const want=oracle(src),got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    const inputs=[[0x7ffa8000,0x12345678,0],[0x7ffa8000,0x12345678,0],[0,0,1],[0x7ff80002,0,0],[0x80000000,0,0]]
    for(let i=0;i<inputs.length;i++){
      is(got.save(...inputs[i]),want.save(...inputs[i]),`container/closure save${i} O${optimize}`)
      for(let j=0;j<=i;j++)is(got.read(j),want.read(j),`retained closure ${j} after${i} O${optimize}`)
    }
  }
})

test('Number schema reads canonicalize generic values and retain raw numeric slots', () => {
  const src=`function raw(hi,lo){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[0]=lo;w[1]=hi;return a[0]}
    function see(v){return[typeof v,Number.isNaN(v),String(v),Boolean(v)]}
    function read(o,k){return[see(o[k]),see(o.exact),see(o.exact)]}
    function values(o){return Object.values(o)}
    export function f(hi,lo,key){const o={exact:raw(hi,lo),label:'n'};
      return[values(o),Object.entries(o),JSON.stringify(o),read(o,String(key)),
        Object.values({...o}),Object.values(Object.assign({},o)),Object.values(structuredClone(o)),
        Object.getOwnPropertyDescriptor(o,'exact').value]}
    export function copy(hi,lo){const o={uniform:raw(hi,lo)},a=new Float64Array(3),p={...o},q={uniform:0};
      Object.assign(q,o);a[0]=o.uniform;a[1]=p.uniform;a[2]=q.uniform;return Array.from(new Uint32Array(a.buffer))}
    export function mixed(hi,lo,mode){const o={mixed:undefined};if(mode!==1)o.mixed=raw(hi,lo);if(mode===2)o.mixed='text';
      const p={...(mode?{maybe:raw(hi,lo)}:{})};return[Object.values(o),JSON.stringify(o),Object.values(p),JSON.stringify(p)]}`
  const words=[[0,0],[0x80000000,0],[0x3ff00000,0],[0x7ff00000,0],[0xfff00000,0],
    [0x7ff80001,0],[0x7ff80002,0],[0x7ff80005,0],[0x7ff80010,0],
    ...Array.from({length:16},(_,tag)=>[0x7ff80000+tag*0x8000,0x12345678])]
  for(const optimize of levels(0,1,2,3,'size')){
    const want=oracle(src),got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const [hi,lo]of [...words,...words.slice(0,2)]){
      for(const key of ['exact','exact','label','missing','exact'])
        is(got.f(hi,lo,key),want.f(hi,lo,key),`schema readers ${hi.toString(16)} key${key} O${optimize}`)
      is(got.copy(hi,lo),[lo,hi,lo,hi,lo,hi],`Number-only schema copies retain payload bits O${optimize}`)
      for(const mode of [0,1,2,0])is(got.mixed(hi,lo,mode),want.mixed(hi,lo,mode),`mixed schema slots mode${mode} O${optimize}`)
    }
  }
})

test('Number property receivers preserve primitive identity and evaluation order', () => {
  const src=`let log='';function raw(hi){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[1]=hi;return a[0]}
    function receiver(hi){log+='r';return raw(hi)}
    function key(fail){log+='k';return{toString(){log+='s';if(fail)throw 7;return 'missing'}}}
    export function f(hi,k){const v=raw(hi);return[v?.missing,v['missing'],v[String(k)],v?.[String(k)],v.length,v?.length]}
    export function effect(hi,fail){log='';try{return[receiver(hi)[key(fail)],log]}catch(e){return[e,log]}}`
  for(const optimize of levels(0,1,2,3,'size')){
    const want=oracle(src),got=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const hi of [0,0x80000000,0x3ff00000,0x7ff00000,0x7ff80001,0x7ff80002,0x7ff88000,0x7ffa8000]){
      for(const key of ['missing','missing','length','0','missing'])
        is(got.f(hi,key),want.f(hi,key),`primitive Number receiver ${hi.toString(16)} ${key} O${optimize}`)
      for(const fail of [false,false,true,false])is(got.effect(hi,fail),want.effect(hi,fail),`key conversion order and recovery O${optimize}`)
    }
  }
})

test('Number schema reader tables relocate and reset across compilations', () => {
  const raw=`function raw(){const a=new Float64Array(1),w=new Uint32Array(a.buffer);w[1]=2146959362;return a[0]}`
  const a=raw+`export function f(){return Object.values({n:raw(),label:'A'})}`
  const b=raw+`export function f(){const o={get label(){return 'B'},n:raw()};return [Object.values(o),JSON.stringify(o)]}`
  const empty=`export function f(){return Object.values({})}`
  for(const optimize of levels(0,1,2,3,'size')){
    const retained=[]
    for(const src of [a,a,empty,b,a]){
      const instance=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports,want=oracle(src).f()
      retained.push([instance,want]);is(instance.f(),want,`fresh schema table O${optimize}`)
      for(const [old,answer]of retained)is(old.f(),answer,`retained schema table O${optimize}`)
    }
    if(!onWasi()&&!onKernel())for(const opts of [
      {sharedMemory:true,memory:new WebAssembly.Memory({initial:16,maximum:64,shared:true})},
      {importMemory:true,memory:new WebAssembly.Memory({initial:16})}]){
      const got=jz(b,{...opts,optimize:{level:optimize,sourceInline:false}}).exports,want=oracle(b).f()
      is(got.f(),want,`relocated schema table O${optimize}`);is(got.f(),want,`relocated table reuse O${optimize}`)
    }
  }
})

test('Number schema dispatch fast paths preserve the generic carrier contract', async () => {
  if(onKernel())return
  const {ctx}=await import('../src/ctx.js'),{devirtSchemaReads}=await import('../src/optimize/devirt.js')
  const {NUMBER,STRING}=await import('../src/summary/kind.js'),{objectSchemaGuardHex}=await import('../layout.js')
  for(const form of ['single','dense','sparse','cache']){
    jz.compile('',{optimize:{level:1,watr:false}})
    const count=form==='single'?1:form==='cache'?30:form==='sparse'?12:3
    const schemas=[]
    for(let i=0;i<count;i++)schemas.push(form==='sparse'&&i%3?['other'+i]:
      i%2?['pad'+i,'value']:['value','tail'+i])
    for(const names of schemas)ctx.schema.register(names)
    ctx.summary={...ctx.summary,fieldKind:sid=>sid%2?STRING:NUMBER}
    ctx.core.includes.add('__ptr_type')
    const c=n=>['i32.const',n],get=n=>['local.get','$'+n]
    const normalize=['func','$__schema_value',['param','$obj','i64'],['param','$slot','i32'],['param','$v','i64'],['result','i64'],
      ['if',['result','i64'],['i32.and',['i32.eqz',['i32.and',['i32.wrap_i64',['i64.shr_u',get('obj'),['i64.const',32]]],c(1)]],
        ['f64.ne',['f64.reinterpret_i64',get('v')],['f64.reinterpret_i64',get('v')]]],
        ['then',['i64.const','0x7ff8000000000000']],['else',get('v')]]]
    const dyn=['func','$__dyn_get_test',['param','$obj','i64'],['result','i64'],
      ['global.set','$__ic_found_hi',['i64.and',get('obj'),['i64.const','0xffffffff00000000']]],
      ['global.set','$__ic_found_slot',c(0)],
      ['call','$__schema_value',get('obj'),c(0),['i64.load',c(128)]]]
    const read=['call','$__dyn_get_test',get('obj')];read.dvProp='value';read.dvObject=true
    const fn=['func','$f',['export','"f"'],['param','$obj','i64'],['result','i64'],read]
    devirtSchemaReads(fn)
    const globals=new Map([['$__ic_found_hi','i64'],['$__ic_found_slot','i32']])
    const scan=n=>{if(!Array.isArray(n))return;if((n[0]==='global.get'||n[0]==='global.set')&&n[1].startsWith('$__ic_'))
      globals.set(n[1],n[1].includes('_hi')?'i64':'i32');for(const child of n)scan(child)}
    scan(fn)
    const ast=['module',['memory',['export','"memory"'],1],
      ...[...globals].map(([name,type])=>['global',name,['mut',type],[type+'.const',type==='i64'?-1:0]]),normalize,dyn,fn]
    const ex=new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports,mem=new DataView(ex.memory.buffer)
    ok(JSON.stringify(fn).includes('$__schema_value'),`${form} direct load retains Number-domain conversion`)
    for(const sid of [...schemas.keys(),...schemas.keys()].filter(i=>schemas[i].includes('value')))
      for(const bits of [0x7ff8000200000000n,0x7ff8800012345678n,0x8000000000000000n,0x3ff0000000000000n]){
        for(let i=0;i<3;i++)mem.setBigUint64(128+i*8,bits,true)
        const want=sid%2===0&&((bits>>52n)&0x7ffn)===0x7ffn?0x7ff8000000000000n:bits
        const object=BigInt(objectSchemaGuardHex(sid))|128n
        is(BigInt.asUintN(64,ex.f(object)),want,`${form} sid${sid} payload${bits.toString(16)}`)
        is(BigInt.asUintN(64,ex.f(object)),want,`${form} repeated cache hit sid${sid}`)
      }
  }
})

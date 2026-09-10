/**
 * uint32 / `>>>` correctness — regression pins for the unsigned-i32-operand family.
 *
 * `x >>> 0` (and any function proven to return one) yields a uint32 in [0, 2^32):
 * a value that lives in a wasm i32 but whose magnitude can exceed signed i32 range.
 * jz tags such nodes `.unsigned` so the f64 boundary reboxes via `convert_i32_u`.
 * Every operation that consumes the value must respect that tag — otherwise a signed
 * i32 fast-path silently miscompiles (wrap, sign-flip, or trunc_sat saturation).
 *
 * These all assert *runtime values against the JS spec*, since the bug class is
 * silent wrong-answers, not a WAT-shape change. Each block targets one leak that
 * was found and fixed:
 *   • narrow.js  — unsignedResult propagates through (tail-)call chains; mixed-sign
 *                  tails do NOT narrow to unsigned (sign must be consistent).
 *   • emit.js    — `+`/`-`/`*`/`%` and relational `<`/`>`/`<=`/`>=` skip the signed
 *                  i32 fast-path when an operand is `.unsigned` (widen to f64).
 *   • emit.js    — `>>>` const-fold ≥ 2^31 keeps `.unsigned`; foldConst / cmpOp
 *                  const-fold bail on `.unsigned` operands.
 *   • ir.js      — asF64 of an `.unsigned` i32.const widens by its uint32 value.
 *   • emit.js    — the '?:' handler's i32-select join widens EACH arm by its OWN
 *                  sign when two plain arms disagree (falls to an f64 select/if,
 *                  still branchless), and propagates the agreed `.unsigned` flag
 *                  onto the joined node when they agree (keeps the single-select
 *                  fast path — a single downstream asF64 now converts correctly
 *                  either way, instead of always guessing signed).
 *   • emit.js    — the '&&'/'||' handlers' own i32 if-join, the confirmed sibling
 *                  of the '?:' fix above: '&&' propagates just the truthy arm's
 *                  (b's) sign, since its falsy arm is provably zero and so never
 *                  carries a magnitude either way; '||' — whose truthy arm returns
 *                  a's OWN value, so both arms genuinely disagree — needs the same
 *                  signedness-agreement gate as '?:', falling back to per-arm
 *                  widening (by each side's OWN sign, not a hardcoded signed
 *                  convert) on disagreement.
 */
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { run, evaluate, compileSrc, oracle } from './util.js'
import { scalarCase } from './_scalar-core-cases.js'
import { instantiate } from '../interop.js'
import { execFileSync } from 'node:child_process'
import { levels } from './_matrix.js'

// Checked BigInt reads return tagged values. A compound write must normalize
// its result just like a plain assignment, including a reassigned parameter.
for (const [op, rhs] of [
  ['|=', '0x7ff0000000000000n'], ['&=', '0xffffffffffffffffn'], ['^=', '0x8000000000000n'], ['>>=', '7n'], ['<<=', '-7n'],
  ['+=', '3n'], ['-=', '3n'], ['*=', '3n'], ['/=', '3n'], ['%=', '3n'],
]) for (const lhs of ['value', '((value))']) {
  test(`compound writes: checked producer → ${lhs} ${op} → typed storage`, () => {
    const source = `
      const buf = new ArrayBuffer(8)
      const ints = new BigInt64Array(buf)
      const floats = new Float64Array(buf)
      const bytes = new Uint8Array(buf)
      let calls = 0
      function parse(input) { calls++; ints[0] = BigInt(input); return ints[0] }
      function operand() { calls++; return ${rhs} }
      function encode(big, input, value) {
        if (big) {
          value = input === 'canonical' ? 0x8000000000000n : parse(input);
          ${lhs} ${op} operand()
          ints[0] = value
        } else { value = Number(input); floats[0] = value }
        return bytes.slice()
      }
      export const f = (big, input) => encode(big, input)
      export const count = () => calls
    `
    for (const optimize of levels(false, 1, 2, 3)) {
      const expected = oracle(source)
      const actual = run(source, { optimize })
      const retained = []
      for (const [big, input] of [[true, '0'], [true, '0x8000200000000'], [true, '0x8000200000000'], [false, '1'], [true, '-1'], [false, '-0'], [true, 'canonical'], [true, '0x1234567812345678']]) {
        const want = Array.from(expected.f(big, input)), got = actual.f(big, input)
        is(Array.from(got), want, `O${optimize || 0}: ${big}/${input}`)
        is(actual.count(), expected.count(), 'single producer and RHS evaluation')
        retained.push([got, want])
      }
      for (const [got, want] of retained) is(Array.from(got), want, 'later writes cannot mutate retained output')
    }
  })
}

test('compound writes: preserve the old value before RHS writes and return the new value', () => {
  for (const op of ['+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']) {
    const source = `
      export function f(initial, shift) {
        let value = initial, calls = 0
        function operand() { value = 99; calls++; return shift }
        const result = (value ${op} operand())
        return [result, value, calls]
      }`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, { optimize }).f
      const inputs = op === '**='
        ? [[2, 3], [-2, 3], [1.5, 2], [0, 0]]
        : [[2147483648, 1], [-1, 0], [4294967295, 31], [NaN, 3], [5e-324, -1], [-0, 0]]
      // Open arithmetic/nullish coercion has a separate red pin in data.js;
      // the bitwise family's ToInt32/ToUint32 boundary already handles it.
      if (['&=', '|=', '^=', '<<=', '>>=', '>>>='].includes(op))
        inputs.push([null, 0], [undefined, 0], [1, null], [1, undefined])
      for (const [initial, shift] of inputs)
        is(actual(initial, shift), expected(initial, shift), `${op} O${optimize || 0}: ${initial}/${shift}`)
    }
  }
})

for (const op of ['<<=', '>>=']) test(`BigInt ${op}: signed counts and the 64-bit boundary`, () => {
  const source = `const a = new BigInt64Array(1)
    export function f(input, count) {
      a[0] = BigInt(input); let value = a[0];
      ((value)) ${op} BigInt(count)
      a[0] = value; return a[0]
    }`
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    const expected = oracle(source).f
    for (const input of ['0', '1', '-1', '-9223372036854775808', '9223372036854775807']) {
      // The extreme count shifts right, so the JS oracle never allocates an enormous BigInt.
      const extreme = op === '<<=' ? '-9223372036854775808' : '9223372036854775807'
      for (const count of [0, 1, 63, 64, 65, -1, -63, -64, -65, extreme, 0])
        is(actual(input, count), expected(input, count), `${op} O${optimize || 0}: ${input}/${count}`)
    }
  }
})

test('BigInt shifts: read the left value before RHS writes, for binary and compound forms', () => {
  for (const op of ['<<', '>>']) for (const write of [`((value)) ${op}= (value=99n,1n)`, `value = value ${op} (value=99n,1n)`]) {
    const source = `export function f(){let value=6n; ${write}; return Number(value)}`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, {optimize}).f
      is(actual(), expected(), `${write} O${optimize || 0}`)
      is(actual(), expected(), 'repeat')
    }
  }
})

test('bitwise compounds: unsigned loop write widens unsigned, including zero iterations', () => {
  const source = `export function f(n, x) {
    let value = x
    for (let i = 0; i < n; i++) value >>>= i
    return value
  }`
  const expected = oracle(source).f
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, { optimize }).f
    for (const n of [0, 1, 2, 0, 1]) for (const x of [-1, 2147483648, -7, 4294967295])
      is(actual(n, x), expected(n, x), `O${optimize || 0}: ${n}/${x}`)
  }
})

for (const [family, ops] of [['bitwise', ['&=', '|=', '^=', '<<=', '>>=']], ['arithmetic', ['+=', '-=', '*=', '/=', '%=']]])
test(`${family} compounds: a Number/BigInt mismatch throws and permits a later call`, () => {
  for (const op of ops) {
    const source = `export function f(big) {
      let value = big ? new BigInt64Array([2n])[0] : 3
      value ${op} 4n
      return value
    }`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, { optimize }).f
      is(actual(true), expected(true), `${op} O${optimize || 0}: BigInt`)
      throws(() => actual(false), /Cannot mix BigInt/, 'Number is not a raw BigInt payload')
      is(actual(true), expected(true), 'success after a failed call')
    }
  }
})

test('compound writes: an abrupt RHS keeps its effects but does not write the operation result', () => {
  for (const op of ['+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']) {
    const source = `export function f(fail) {
      let value = 5, calls = 0
      function rhs() { calls++; value = 99; if (fail) throw 7; return 1 }
      try { ((value)) ${op} rhs() } catch (e) {}
      return [value, calls]
    }`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, { optimize }).f
      for (const fail of [false, false, true, false])
        is(actual(fail), expected(fail), `${op} O${optimize || 0}: fail=${fail}`)
    }
  }
})

test('compound writes: grouped string += keeps concatenation and RHS ordering', () => {
  const source = `export function f() {
    let value = 'a', calls = 0
    function rhs() { value = 'changed'; calls++; return 'b' }
    const result = (((value)) += rhs());
    ((value)) += 2n
    return [result, value, calls]
  }`
  const expected = oracle(source).f
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    is(actual(), expected(), `O${optimize || 0}`)
    is(actual(), expected(), 'repeat')
  }
})

test('compound writes: unsupported BigInt power and unsigned shift still reject grouped targets', () => {
  for (const op of ['**=', '>>>=']) for (const optimize of levels(false, 1, 2, 3))
    throws(() => compileSrc(`export function f(i) {
      let value = new BigInt64Array([2n])[i];
      ((value)) ${op} 1n; return value
    }`, {optimize}), /BigInt/)
})

for (const [family, ops] of [['bitwise', ['&=', '|=', '^=', '<<=', '>>=']], ['arithmetic', ['+=', '-=', '*=', '/=', '%=']]])
test(`${family} compounds: null and absent checked operands throw after one RHS evaluation`, () => {
  for (const op of ops) for (const count of op === '<<=' || op === '>>=' ? ['4n', '64n'] : ['4n']) {
    const source = `let calls = 0
      function rhs() { calls++; return ${count} }
      export function f(n, i, present) {
        const a = new BigInt64Array(n)
        if (n) a[0] = 2n
        let value = present ? a[i] : null;
        ((value)) ${op} rhs()
        return value
      }
      export const count = () => calls`
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, { optimize })
      const expected = oracle(source)
      for (const args of [[1, 0, true], [0, 0, true], [1, 1, true], [1, -1, true], [1, 0, false], [1, 0, true]]) {
        // JZ's documented i64 result wraps; wrap the JS oracle's successful
        // result too, without masking an operator's missing TypeError.
        if (args[0] === 1 && args[1] === 0 && args[2]) is(actual.f(...args), BigInt.asIntN(64, expected.f(...args)), `${op} ${count}: present`)
        else {
          throws(() => expected.f(...args), TypeError)
          throws(() => actual.f(...args), /Cannot mix BigInt/, `${op}: ${args}`)
        }
        is(actual.count(), expected.count(), 'RHS runs once, even before a TypeError')
      }
    }
  }
})

// Red semantic pins: the attempted member staging/default-local repair was
// reverted after a .subarray() regression. No staging implementation is retained.
for (const op of ['+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '||=', '&&=', '??=', 'pre++', 'post++', 'pre--', 'post--'])
test(`member reference ${op}: single evaluation, abrupt stages and recovery`, () => {
  for (const ref of ['get().value', 'get()[key()]', '((get()[key()]))']) {
    const write = op.startsWith('pre') ? `${op.slice(3)}${ref}`
      : op.startsWith('post') ? `${ref}${op.slice(4)}` : `${ref} ${op} rhs()`
    // Possible throws keep these helpers from disappearing through inlining.
    // State is observed outside the throwing function, without a catch-local phi.
    const source = `let trace=0; const obj={value:5}
      export function f(stage, initial) {
        trace=0; obj.value=initial
        function get(){trace=trace*10+1; if(stage===1) throw 1; return obj}
        function key(){trace=trace*10+2; if(stage===2) throw 2; return 'value'}
        function rhs(){trace=trace*10+3; obj.value=16; if(stage===3) throw 3; return 2}
        return (${write})
      }
      export const state=()=>[obj.value,trace]`
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, {optimize})
      const expected = oracle(source)
      for (const stage of [0, 0, 1, 0, 2, 0, 3, 0])
        for (const initial of ['||=', '&&=', '??='].includes(op) ? [5, 0, null, undefined] : [5]) {
          let want, got
          try { want = ['return', expected.f(stage, initial)] } catch (e) { want = ['throw', e] }
          // Only the ordinary Error wrapper transports primitive throws.
          try { got = ['return', actual.f(stage, initial)] }
          catch (e) { got = ['throw', e?.name === 'Error' && Object.hasOwn(e, 'thrown') ? e.thrown : e?.name ?? e] }
          is(got, want, `${write} O${optimize || 0}: stage=${stage}, initial=${initial}`)
          is(actual.state(), expected.state(), 'stored value and receiver→key→RHS trace')
        }
    }
  }
})

test('member reference: a key may reassign the receiver binding without retargeting the write', () => {
  const source = `let obj={value:5}; const original=obj
    function key(){obj={value:9}; return 'value'}
    export function f(){obj[key()]+=1; return [original.value,obj.value]}`
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    const expected = oracle(source).f
    for (let i=0; i<3; i++) is(actual(), expected(), `O${optimize || 0}: call ${i}`)
  }
})

test('member reference: simple names retain the pre-RHS receiver and key', () => {
  for (const op of ['+=', '|=', '<<=', '||=', '&&=', '??=']) {
    const initial = op === '||=' ? '0' : op === '??=' ? 'null' : '5'
    const source = `export function f(){
      const a={value:${initial},other:20},b={value:9,other:30}
      let obj=a,key='value'
      const result=(obj[key] ${op} (obj=b,key='other',2))
      return [result,a.value,a.other,b.value,b.other]
    }`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, {optimize}).f
      is(actual(), expected(), `${op} O${optimize || 0}`)
      is(actual(), expected(), 'repeat')
    }
  }
})

test('member reference: expression-bodied closures analyze generated locals', () => {
  const source = `function make(){
      const holder={a:[1]}
      return i=>(holder.a[i+0]+=2,holder.a[i])
    }
    export function f(){const update=make(); return [update(0),update(0)]}`
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    is(actual(), [3,5], `O${optimize || 0}`)
    is(actual(), [3,5], 'new closure after earlier calls')
  }
})

for (const closure of [false, true]) test(`member reference: ${closure ? 'closure' : 'named'} default temporaries belong to the callee`, () => {
  const source = `let calls=0; const obj={value:5}
    function get(){calls++; return obj}
    ${closure
      ? 'function make(){return (x=(get().value+=1))=>[x,obj.value,calls]} const inner=make()'
      : 'function inner(x=(get().value+=1)){return [x,obj.value,calls]}'}
    export const f=x=>inner(x)`
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    const expected = oracle(source).f
    for (const arg of [100, undefined, 0, null, undefined, 100])
      is(actual(arg), expected(arg), `O${optimize || 0}: ${arg}`)
  }
})

test('member reference: imported initialization retains the staged reference and source order', () => {
  const init = `let trace=0; const obj={value:5}
    function get(){trace=trace*10+1; return obj}
    function key(){trace=trace*10+2; return 'value'}
    function rhs(){trace=trace*10+3; return 2}
    export const value=(get()[key()]+=rhs())
    export const state=()=>[obj.value,trace]`
  const source = `import {value,state} from './init.js'; export const f=()=>[value,state()]`
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize, modules:{'./init.js':init}}).f
    is(actual(), [7,[7,123]], `O${optimize || 0}`)
    is(actual(), [7,[7,123]], 'initializers do not run again')
  }
})

test('compound writes: grouped targets do not bypass readonly or invalid-target checks', () => {
  for (const op of ['+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']) {
    for (const optimize of levels(false, 1, 2, 3)) {
      throws(() => compileSrc(`export function f(){const value=1; ((value)) ${op} 1; return value}`, {optimize}), /const/, `${op}: grouped const`)
      throws(() => compileSrc(`let target=Math.sin; export function f(){((target)) ${op} 1; return 0}`, {optimize}), /bound to builtin/, `${op}: grouped alias`)
      throws(() => compileSrc(`export function f(){if(false){(1+2) ${op} 1} return 0}`, {optimize}), /invalid assignment target/, `${op}: dead invalid target`)
      const shadow = `const value=1; export function f(){let value=4; ((value)) ${op} 1; return value}`
      is(run(shadow, {optimize}).f(), oracle(shadow).f(), 'a shadowing let remains writable')
    }
  }
})

test('grouped references: logical writes preserve short circuiting and abrupt RHS effects', () => {
  for (const op of ['||=', '&&=', '??=']) {
    const source = `export function f(initial, fail) {
      let value=initial, calls=0
      function rhs(){calls++; value=99; if(fail) throw 7; return 42}
      try { ((value)) ${op} rhs() } catch(e) {}
      return [value,calls]
    }`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, {optimize}).f
      for (const initial of [0, 5, null, undefined, 0]) for (const fail of [false, true, false])
        is(actual(initial, fail), expected(initial, fail), `${op} O${optimize || 0}: ${initial}/${fail}`)
      const init = op === '||=' ? '0' : op === '??=' ? 'null' : '1'
      throws(() => compileSrc(`export function f(){const value=${init}; ((value)) ${op} 2; return value}`, {optimize}), /const/)
      throws(() => compileSrc(`const value=${init}; ((value)) ${op} 2; export {value}`, {optimize}), /const/, 'module-level const')
    }
  }
})

test('grouped expressions: empty calls and nested comma arguments retain arity and order', () => {
  const source = `export function f() {
    let trace=0
    function zero(){trace=trace*10+1; return 7}
    function next(n){trace=trace*10+n; return n}
    function pair(a,b){return [a,b,trace]}
    return [zero(),trace,pair((((next(2),next(3))))),pair((((next(4),next(5)))),next(6))]
  }`
  const expected = oracle(source).f
  for (const optimize of levels(false, 1, 2, 3)) {
    const actual = run(source, {optimize}).f
    is(actual(), expected(), `O${optimize || 0}: [7,1,[3,undefined,123],[5,6,123456]]`)
    is(actual(), expected(), 'repeat')
  }
})

test('grouped references: ordinary writes and updates also check readonly bindings', () => {
  for (const write of ['((value)) = 2', '++((value))', '--((value))', '((value))++', '((value))--']) {
    const source = `export function f(){let value=1; ${write}; return value}`
    const expected = oracle(source).f
    for (const optimize of levels(false, 1, 2, 3)) {
      throws(() => compileSrc(`export function f(){const value=1; ${write}; return value}`, {optimize}), /const/, write)
      is(run(source, {optimize}).f(), expected(), `${write}: writable O${optimize || 0}`)
    }
  }
})

test('compound writes: empty→empty→A→A→B→empty→truncated A→A preserves bytes and outputs', () => {
  const sources = [
    'export function f(x){let value=x; ((value)) >>>= 0; return value}',
    'export function f(x){let value=x; ((value)) *= 3; return value}',
  ]
  for (const optimize of levels(false, 1, 2, 3)) {
    const freshB = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import {compile} from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
      console.log(Buffer.from(compile(${JSON.stringify(sources[1])}, {optimize:${optimize}})).toString('base64'))
    `], {encoding:'utf8'}).trim()
    const retained = [], baselines = []
    let emptyBytes
    // EOF immediately before the final `}` rejects; adding that final character
    // (or an empty suffix at the completed boundary) restores the same program.
    for (const input of ['', '', 0, 0, 1, '', sources[0].slice(0, -1), 0]) {
      if (typeof input === 'string') {
        if (input) throws(() => compileSrc(input, {optimize}))
        else {
          const bytes = compileSrc(input, {optimize})
          is(typeof instantiate(bytes).exports.f, 'undefined', 'empty has no user entry')
          if (emptyBytes) is([...bytes], emptyBytes, 'empty is identical before and after other work')
          else emptyBytes = [...bytes]
        }
        continue
      }
      const bytes = compileSrc(sources[input] + '', {optimize})
      const snapshot = [...bytes]
      if (baselines[input]) is(snapshot, baselines[input], 'same input after other compilation work')
      else baselines[input] = snapshot
      if (input === 1) is(snapshot, [...Buffer.from(freshB, 'base64')], 'B after A equals fresh B')
      retained.push([bytes, snapshot, instantiate(bytes).exports.f, input])
    }
    for (const [bytes, snapshot, f, input] of retained) {
      is([...bytes], snapshot, 'later compiles cannot alter retained bytes')
      is(f(-1), input ? -3 : 4294967295, 'retained instance executes')
      is(instantiate(bytes).exports.f(-1), input ? -3 : 4294967295, 'retained bytes instantiate and execute')
    }
  }
})

// A captured Map read uses a tagged storage carrier even when the summary
// proves Number|undefined. The carrier must not invent a BigInt runtime arm.
for (const expression of ['value >>> 5', '2147483648 >>> value', '~value', '~~value', '+value', 'value & 31', 'value << 1']) {
  test(`numeric domains: captured Number/undefined stays numeric in ${expression}`, () => {
    const source = `
      export const big = () => 9221120245631025152n
      function create() {
        const values = new Map()
        values.set('present', 65)
        values.set('negative', -1)
        values.set('fractional', 3.75)
        values.set('tiny', 5e-324)
        values.set('null', null)
        values.set('undefined', undefined)
        values.set('zero', -0)
        values.set('large', 4294967295)
        values.set('nan', NaN)
        values.set('infinity', Infinity)
        let reads = 0
        return {
          get(key) { reads++; const value = values.get(key); return ${expression} },
          count() { return reads }
        }
      }
      const reader = create()
      export const f = key => reader.get(key)
      export const count = () => reader.count()
    `
    for (const optimize of levels(false, 1, 2, 3)) {
      const expected = oracle(source)
      const actual = run(source, { optimize })
      for (const key of ['missing', 'missing', 'present', 'present', 'negative', 'fractional', 'tiny', 'null', 'undefined', 'zero', 'large', 'nan', 'infinity', 'missing', 'present']) {
        is(actual.f(key), expected.f(key), `O${optimize || 0}: ${key}`)
        is(actual.count(), expected.count(), 'one producer evaluation per call')
      }
      is(actual.big(), expected.big(), 'the unrelated BigInt payload stays intact')
    }
  })
}

test('numeric domains: captured BigInt-capable operands reject unsigned shift at runtime, on the BigInt path alone', () => {
  // `>>>` has no BigInt form (ES2020 §6.1.6.2.11): a value that is a BigInt
  // only on some path throws when it is one; an absent or Number value
  // shifts as JS does (`undefined >>> 5` is 0).
  for (const initializer of [
    "const values = new Map([['present', 1n]])",
    "const values = new Map([['present', 65], ['big', 1n]])",
    "const values = new Map(); values.set('present', 65); values.set('big', 1n)",
  ]) for (const expression of ['value >>> 5', '5 >>> value']) {
    const source = `function create() {
      ${initializer}
      return { get(key) { const value = values.get(key); return ${expression} } }
    }
    const reader = create()
    export const f = key => reader.get(key)`
    const expected = oracle(source).f
    const outcome = (fn, key) => { try { return { value: fn(key) } } catch (e) { return { throws: e.constructor.name } } }
    for (const optimize of levels(false, 1, 2, 3)) {
      const actual = run(source, { optimize })
      for (const key of ['present', 'big', 'missing'])
        is(outcome(actual.f, key), outcome(expected, key), `O${optimize || 0}: ${expression} on ${key}`)
    }
  }
})

test('numeric domains: normalized postfix recovery retains its BigInt producer', () => {
  for (const update of ['++', '--']) for (const optimize of levels(false, 1, 2, 3)) {
    const source = `export const f = () => {
      let a = [4611686018427387903n]
      return a[0]${update} + 0n
    }`
    is(run(source, { optimize }).f(), 4611686018427387903n, `O${optimize || 0}: ${update} keeps the old value`)
  }
})

// ───────────────────────────────────────────────── canonical uint32 boundary

test('(x >>> 0) reboxes as uint32 across the export boundary', async () => {
  const { main } = run(scalarCase('unsigned-export-boundary').source)
  is(main(-1), 4294967295)
  is(main(-2147483648), 2147483648) // high-bit set
  is(main(0), 0)
  is(main(2147483647), 2147483647)
})

test('(x >>> 0) / 2^32 — canonical PRNG unit-interval idiom', () => {
  const { main } = run(scalarCase('unsigned-unit-interval').source)
  is(main(-1), 4294967295 / 4294967296) // 0.9999999997671694
  is(main(0), 0)
})

// ───────────────────────────────────────────── unsignedResult call-chain propagation

test('unsignedResult propagates through a tail-call helper', () => {
  const { main } = run(scalarCase('unsigned-tail-helper').source)
  is(main(-1), 4294967295)
})

test('unsignedResult propagates through a 2-deep call chain', () => {
  const { main } = run(scalarCase('unsigned-tail-chain').source)
  is(main(-1), 4294967295)
})

test('unsigned result used in arithmetic at the call site widens (no wrap)', () => {
  const { main } = run(scalarCase('unsigned-call-arithmetic').source)
  is(main(-1), 4294967296)
})

// ─────────────────────────────────────────────── mixed-tail sign consistency

test('mixed signed/unsigned return tails do NOT narrow to unsigned', () => {
  // One tail is `x | 0` (signed), the other `x >>> 0` (unsigned). Narrowing the
  // whole function to unsigned would corrupt the signed branch — so it must not.
  const { main } = run(scalarCase('unsigned-mixed-return').source)
  is(main(-1), -1)        // signed branch preserved
  is(main(5), 5)          // unsigned branch (small) unaffected
})

// ─────────────────────────────────────────── arithmetic with an unsigned operand

test('`+` / `-` with an unsigned operand widen to f64 (no i32 wrap)', () => {
  is(run('export let main = (x) => (x >>> 0) + 1').main(-1), 4294967296)
  is(run('export let main = (x) => (x >>> 0) - 1').main(0), -1)
  is(run('export let main = (x) => 1 + (x >>> 0)').main(-1), 4294967296)
})

test('`*` with an unsigned operand widens (product exceeds i32)', () => {
  is(run('export let main = (x) => (x >>> 0) * 2').main(-1), 8589934590)
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) * 2').main(-1), 8589934590)
})

test('`%` with an unsigned operand uses true uint32 value (not signed rem)', () => {
  is(run('export let main = (x) => (x >>> 0) % 7').main(-1), 4294967295 % 7) // 3
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) % 7').main(-1), 3)
})

// ────────────────────────────────────────── relational comparison with unsigned

test('relational comparisons treat an unsigned operand by its true magnitude', () => {
  is(run('export let main = (x) => (x >>> 0) < 5').main(-1), false)   // 4294967295 < 5 → false
  is(run('export let main = (x) => (x >>> 0) > 5').main(-1), true)
  is(run('export let main = (x) => (x >>> 0) <= 5').main(-1), false)
  is(run('export let main = (x) => (x >>> 0) >= 5').main(-1), true)
  is(run('export let main = (x) => 5 < (x >>> 0)').main(-1), true)   // unsigned on the right
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) < 5').main(-1), false)
})

test('relational comparisons on small unsigned values still correct', () => {
  is(run('export let main = (x) => (x >>> 0) < 5').main(3), true)
  is(run('export let main = (x) => (x >>> 0) > 5').main(3), false)
})

// ───────────────────────────────────────────── constant folding of unsigned

test('constant-folded `>>>` ≥ 2^31 keeps its uint32 value', async () => {
  is(await evaluate('(-1 >>> 0)'), 4294967295)
  is(await evaluate('(2147483648 >>> 0)'), 2147483648)
  is(await evaluate('(8 >>> 1)'), 4) // small value: ordinary signed const, still folds
})

test('arithmetic / comparison over a constant uint32 is spec-correct', async () => {
  is(await evaluate('(-1 >>> 0) + 1'), 4294967296)
  is(await evaluate('(-1 >>> 0) * 2'), 8589934590)
  is(await evaluate('(-1 >>> 0) % 7'), 3)
  is(await evaluate('(-1 >>> 0) < 5'), false)
  is(await evaluate('(-1 >>> 0) >= 4294967295'), true)
  is(await evaluate('(8 >>> 1) + 1'), 5) // small const folds normally
})

test('const-folded uint32 through an unsignedResult helper', () => {
  is(run('let u = (x) => x >>> 0; export let main = () => u(-1)').main(), 4294967295)
})

// ───────────────────────────────────────────── signed i32 fast-paths unaffected

test('signed i32 operands keep their fast-path semantics', async () => {
  // `| 0` produces a signed i32; none of the unsigned guards should perturb it.
  is(run('export let main = (x) => (x | 0) + 1').main(5), 6)
  is(run('export let main = (x) => (x | 0) * 2').main(5), 10)
  is(run('export let main = (x) => (x | 0) % 7').main(9), 2)
  is(run('export let main = (x) => (x | 0) < 5').main(3), true)
  is(await evaluate('3 < 5'), true)
  is(await evaluate('(-1 | 0) < 5'), true) // signed -1 < 5
})

// A Uint32Array element read is typed i32 (the 32-bit element) for fast integer/bitwise use, but
// its full 0..2^32-1 magnitude must survive EVERY use — bitwise (bits), comparison, integer and
// f64 arithmetic, and a raw value read. Unlike the `>>>`-result local below, the typed-array read
// carries its unsigned elem-aux to each use, so high values (≥ 2^31) don't sign-flip. (This is what
// lets the lorenz fade loop drop the i32→f64→i32 round-trip while staying numerically correct.)
test('uint32: Uint32Array element reads keep full unsigned range across all uses', () => {
  const e = run(`let a = new Uint32Array(2)
    export let setup = () => { a[0] = 4294967295; a[1] = 16 }
    export let raw  = () => a[0]
    export let cmp  = () => a[0] < 5 ? 1 : 0
    export let add  = () => a[0] + 1
    export let bits = () => (a[0] >>> 16) & 0xff
    export let div  = () => a[0] / 16`)
  e.setup()
  is(e.raw(), 4294967295)         // raw value read — unsigned, not -1
  is(e.cmp(), 0)                  // 4294967295 < 5 is false (unsigned compare)
  is(e.add(), 4294967296)         // value arithmetic carries the magnitude
  is(e.bits(), 255)               // bitwise on the top byte
  is(e.div(), 268435455.9375)     // f64 convert is unsigned
})

// ───────────────────────────────────────────── local-binding unsigned reads

test('unsignedness survives a local binding read outside a >>> sink', () => {
  // ROOT CAUSE (fixed): `narrowUint32` (src/compile/analyze-scans.js) proves a
  // local is a canonical uint32 accumulator from its WRITES alone — a uint32
  // literal initializer plus every reassignment shaped `name = (…) >>> k`.
  // ToUint32 is idempotent (re-masking an already-masked value is a no-op), so
  // that write invariant alone guarantees the stored bits always equal the true
  // [0, 2^32) value — independent of how the local is later READ. The old code
  // additionally required every READ to be re-sunk through its own `>>>`, which
  // wrongly dropped the `.unsigned` tag for a bare `return u`, `u + 1`, or
  // `u < 5`: the bits then reboxed SIGNED (-1 instead of 4294967295).
  //
  // A second leak in the same class: `narrowI32Results` (src/compile/narrow.js)
  // decides whether a whole function's narrowed i32 RESULT reboxes at the call/
  // export boundary via convert_i32_u or _s from its return tail's shape —
  // but only recognized a literal `>>>` or a call to an already-unsignedResult
  // function, not a bare read of the local narrowUint32 just proved unsigned.
  // A function whose only tail is `return h` (h a `>>> 0`-reassigned local)
  // narrowed to a SIGNED i32 result and reboxed -1294967296 instead of
  // 3000000000 — the exact "hashing/checksum" shape named atop this file,
  // returning the accumulator bare instead of re-masking it on the way out.
  is(run(scalarCase('unsigned-local-return').source).main(-1), 4294967295)
  is(run('export let main = (x) => { let u = x >>> 0; return u + 1 }').main(-1), 4294967296)
  is(run('export let main = (x) => { let u = x >>> 0; return u < 5 }').main(-1), false)
})

test('unsigned accumulator: magnitude-boundary pins (ECMA-262 §7.1.8 ToUint32)', () => {
  // ToUint32(k) = k modulo 2^32, mapped into [0, 2^32) — the exact semantics
  // `>>> 0` implements (ECMA-262 §7.1.8). A local reassigned `h = (…) >>> 0`
  // and read BARE (no further `>>>` sink on the read side) must reproduce that
  // magnitude exactly at every boundary, not just for values small enough to
  // also fit signed i32.
  const acc = (v) => run(`export let main = () => { let h = 0; h = (h + ${v}) >>> 0; return h }`).main()
  is(acc(2147483648), 2147483648)   // 2^31 — first value whose signed i32 reading goes negative
  is(acc(2147483649), 2147483649)   // 2^31 + 1
  is(acc(4294967295), 4294967295)   // 2^32 - 1 — max uint32
  // Wrap case: the accumulator crosses the 2^32 boundary through ordinary
  // addition, same as a running FNV/djb2 hash total — ToUint32 wraps it back
  // into [0, 2^32) rather than saturating or reading back negative.
  const wrapped = run(scalarCase('unsigned-accumulator-wrap').source).main()
  is(wrapped, 4)   // 4294967290 + 10 = 4294967300 ≡ 4 (mod 2^32)
})

// ───────────────────────────────────── identity-preserving tail positions

test('unsignedness threads through `u+` and a same-arm `?:` tail (ECMA-262 §7.1.8 ToUint32)', () => {
  // ROOT CAUSE (fixed): narrowI32Results' isUnsignedTail (src/compile/narrow.js)
  // proved a tail unsigned via a SYNTACTIC allowlist that stopped at the
  // OUTERMOST node — top-level `>>>`, an unsignedResult call, or a bare
  // unsignedLocals name — while exprType (src/type.js) already treats `u+` as
  // type-preserving (ToNumber is identity on a number, its own `op === 'u+'`
  // comment) and a '?:' whose both branches are i32 as i32-representable. The
  // SAME semantic fact — this tail's runtime value is h, a narrowUint32-proven
  // [0, 2^32) magnitude — was proven once by exprType (as a STORAGE type) and
  // re-derived separately by isUnsignedTail (as a SIGN); for `+h` and
  // `c ? h : h` the latter's allowlist never looked past the outer `u+`/`?:`
  // node, so both narrowed to a SIGNED i32 result — the boundary reboxed via
  // f64.convert_i32_s and silently flipped h ≥ 2^31 negative (the exact bit
  // pattern ToUint32 reads as 3000000000, ToInt32 reads as -1294967296).
  const acc = (v) => `let h = 0; h = (h + ${v}) >>> 0;`
  is(run(`export let f = () => { ${acc(3000000000)} return +h }`).f(), 3000000000)
  is(run(`export let f = (c) => { ${acc(3000000000)} return c ? h : h }`).f(true), 3000000000)
  is(run(`export let f = (c) => { ${acc(3000000000)} return c ? h : h }`).f(false), 3000000000)
})

test('unsignedness threads through a same-arm `&&` / `||` tail', () => {
  // Same identity-preserving join as '?:', for the OTHER two AST shapes
  // exprType conciliates to i32 when both value-arms are i32 (src/type.js,
  // `op === '?:' || op === '&&' || op === '||'`). `&&`/`||`'s "branches" are
  // its own two operands (either can flow through as the result, per JS
  // short-circuit semantics) — not a condition/result pair like '?:'.
  is(run(`export let f = () => { let h = 0; h = (h + 3000000000) >>> 0; return h && h }`).f(), 3000000000)
  is(run(`export let f = () => { let h = 0; h = (h + 3000000000) >>> 0; return h || h }`).f(), 3000000000)
})

test('const-folded `+((… >>> 0))` still reboxes unsigned (no regression from the tail fix)', async () => {
  // Purely compile-time (`3000000000 >>> 0` folds to a literal before any
  // return-tail analysis runs), so this never touches narrowI32Results —
  // pinned to guard the SAME visible symptom (`+` of a uint32) via a
  // completely different mechanism (src/static.js's constant folder) from a
  // regression the tail fix above could plausibly cause.
  is(await evaluate('+((3000000000) >>> 0)'), 3000000000)
})

test('a mixed-sign `?:` tail must NOT claim unsigned (ECMA-262 §7.1.8 ToUint32 vs §7.1.5 ToInt32)', () => {
  // One arm is a narrowUint32-proven unsignedLocals name (h); the other is an
  // ordinary signed `x | 0`. exprType calls both branches i32, but they
  // disagree on SIGN — which arm's convention applies is a RUNTIME branch, so
  // no single sig.unsignedResult flag can rebox both correctly. narrow.js's
  // join must recognize the mismatch and refuse to commit unsignedResult —
  // proven here by the signed arm staying exactly `x` (committing unsigned
  // would instead read a negative `x`'s bits as a huge positive magnitude).
  //
  // The h arm itself was a SEPARATE gap this fix did not close (see the
  // '?:' select-join tests below, now fixed): with sig.unsignedResult
  // correctly left false, emit.js compiled the '?:' as a single wasm
  // `select` over i32 and widened the SELECTED value ONCE (f64.convert_i32_s)
  // — no per-arm sign through the select, so the h arm still misread. That
  // was a return-STATEMENT-level widening gap (src/compile/emit.js's '?:'
  // handler / src/ir.js's asF64), a different phase than the function-
  // RESULT-boundary narrowing this test targets — closed separately, now
  // asserted here too since both arms are correct.
  const { f } = run('export let f = (c, x) => { let h = 0; h = (h + 3000000000) >>> 0; return c ? h : (x | 0) }')
  is(f(false, -5), -5)
  is(f(false, 5), 5)
  is(f(true, -5), 3000000000)
  is(f(true, 5), 3000000000)
})

// ────────────────────────────────────── '?:' select-join per-arm sign (emit.js)

test('mixed-sign `?:` ternary: each arm widens by its OWN sign at O0/O2/O3 (regression for the select-join gap above)', () => {
  // The exact shape the mixed-sign-tail test above documented as a known,
  // separate gap: `h` is a narrowUint32-proven uint32 accumulator (the true
  // arm), `s` an ordinary negative signed local (the false arm). Both are
  // i32-representable, so emit.js's '?:' handler used to take the i32
  // `select` fast path and widen the JOINED result ONCE via f64.convert_i32_s
  // — correct for `s`, sign-flipping `h` (3000000000 read as a negative i32
  // bit pattern). Fixed by widening each arm with its own `.unsigned` BEFORE
  // the join when the two plain arms disagree. Pinned at all three optimize
  // tiers since O2/O3 inline `f` into its caller (different IR shape reaching
  // the same '?:' handler).
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(`export let f = (c) => { let h = 0; h = (h + 3000000000) >>> 0; let s = -5; return c ? h : s }`, { optimize })
    is(f(true), 3000000000, `O${optimize}: unsigned arm (h) reads its true uint32 magnitude`)
    is(f(false), -5, `O${optimize}: signed arm (s) is untouched by the unsigned sibling`)
  }
})

test('agreeing-unsigned `?:` arms: the joined select still needs its OWN `.unsigned` (both-agree half of the same fix)', () => {
  // The '?:' handler's fast path (single i32 select + single widen) previously
  // dropped `.unsigned` unconditionally, even when BOTH arms agreed unsigned —
  // the same root cause as the mixed-sign case above, just with the disagreement
  // gate never tripping. Isolated from the ternary's own return-tail position
  // (`picked + 0`, not `return c ? h : h2` directly) so this exercises the
  // '?:' handler's own select+asF64 join, not narrow.js's separate function-
  // result tailSign mechanism (which already had its own `h ? h : h` pin).
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(`export let f = (c) => {
      let h = 0; h = (h + 3000000000) >>> 0
      let h2 = 0; h2 = (h2 + 4000000000) >>> 0
      let picked = c ? h : h2
      return picked + 0
    }`, { optimize })
    is(f(true), 3000000000, `O${optimize}: true arm keeps its uint32 magnitude`)
    is(f(false), 4000000000, `O${optimize}: false arm keeps its uint32 magnitude`)
  }
})

test('agreeing-SIGNED `?:` arms keep the branchless i32-select fast path (no regression from the sign-join fix)', () => {
  // Control for the two tests above: two ordinary signed i32 arms (the
  // overwhelming common case) must still compile through the single
  // i32-select-then-single-widen fast path — the sign-disagreement check
  // must cost nothing when there's nothing to disagree about. Same
  // return-tail isolation as the agreeing-unsigned test (`picked + 0`)
  // so this hits the '?:' handler's own join, not a different narrowing path.
  const src = `export let f = (c, x, y) => { let a = x | 0; let b = y | 0; let picked = c ? a : b; return picked + 0 }`
  const w = compileSrc(src, { wat: true, optimize: 0 })
  // The ternary's OWN join (the $picked store) must be a single i32 select, not
  // an f64 select/if fallback — `|0`'s own coercion emits unrelated selects for
  // `a`/`b`, so this checks the $picked site specifically rather than counting
  // every `select` in the module.
  is(/local\.set \$picked\s*\(select/.test(w), true, 'ternary join is a single i32 select (fast path)')
  is(/local\.set \$picked\s*\(if/.test(w), false, 'ternary join did not fall back to if/else')
  is((w.match(/f64\.convert_i32_[su]/g) || []).length, 1, 'single widen at the return, not per-arm')
  is(/f64\.convert_i32_u/.test(w), false, 'signed arms convert signed, not unsigned')
  const { f } = run(src)
  is(f(1, 7, -9), 7)
  is(f(0, 7, -9), -9)
})

// ────────────────────── '&&'/'||' if-join per-arm sign (emit.js, confirmed sibling of the '?:' fix)

test('`(x|0) && h`: the i32 if-join keeps the TRUTHY arm\'s own sign at O0/O2/O3 (&& sibling of the select-join fix)', () => {
  // `&&`'s i32 if-join (src/compile/emit.js, the '&&' handler's i32 fast path) is
  // asymmetric, unlike '?:'/'||' below: the FALSY arm is provably `local.get $t`
  // === 0 — wasm's `if` cond IS the same bits later read back on that path, and 0
  // means the same thing signed or unsigned — so only the TRUTHY arm (b, returned
  // verbatim) can ever surface a real magnitude. Before this fix the joined node
  // never carried `.unsigned`, so a downstream asF64 always guessed signed:
  // `(x|0) && h` with h a narrowUint32-proven uint32 accumulator misread h's true
  // magnitude whenever the truthy (b) arm was taken.
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(`export let f = (x) => { let h = 0; h = (h + 3000000000) >>> 0; let picked = (x | 0) && h; return picked + 0 }`, { optimize })
    is(f(1), 3000000000, `O${optimize}: truthy arm (h) reads its true uint32 magnitude`)
    is(f(0), 0, `O${optimize}: falsy arm (x|0 === 0) is untouched — its own sign never mattered`)
  }
})

test('`h || (x|0)`: mixed-sign arms widen by their OWN sign at O0/O2/O3 (|| sibling of the select-join fix)', () => {
  // `||`'s i32 if-join is the true structural sibling of '?:': its THEN-arm returns
  // a's own value verbatim when truthy, so — unlike '&&' above — BOTH arms can
  // surface an independent real magnitude. h (a narrowUint32-proven uint32
  // accumulator, conditionally assigned so both the compile-time unsigned proof
  // and a runtime-falsy 0 stay reachable) beside an ordinary signed `x | 0` is the
  // exact mixed-sign shape 9c313e58 fixed for '?:': before this fix, a single
  // downstream asF64 guessed signed for the whole join, sign-flipping h whenever
  // the truthy (a) arm was taken. Fixed by gating the i32 fast path on sign
  // agreement, widening each arm by its own sign (still branchless, an `if` not a
  // `select`) on disagreement.
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(`export let f = (c, x) => { let h = 0; if (c) h = (h + 3000000000) >>> 0; let picked = h || (x | 0); return picked + 0 }`, { optimize })
    is(f(true, 5), 3000000000, `O${optimize}: truthy arm (h) reads its true uint32 magnitude`)
    is(f(false, -7), -7, `O${optimize}: falsy-h arm (x|0) stays exactly x, unperturbed by the unsigned sibling`)
  }
})

test('agreeing-unsigned `&&` / `||` arms: the joined if still needs its OWN `.unsigned` (both-agree half of the same fix)', () => {
  // Same both-agree half '?:' pinned above: two arms that both happen to be
  // proven unsigned must still propagate `.unsigned` onto the joined node — the
  // disagreement gate never trips, but the fast path must not silently default
  // to signed either.
  for (const optimize of levels(0, 2, 3)) {
    const { f: fAnd } = run(`export let f = (c) => {
      let h = 0; if (c) h = (h + 3000000000) >>> 0
      let h2 = 0; h2 = (h2 + 4000000000) >>> 0
      let anded = h && h2
      return anded + 0
    }`, { optimize })
    is(fAnd(true), 4000000000, `O${optimize}: && truthy arm (h2) keeps its uint32 magnitude`)
    is(fAnd(false), 0, `O${optimize}: && falsy arm (h===0) stays exactly zero`)

    const { f: fOr } = run(`export let f = (c) => {
      let h = 0; if (c) h = (h + 3000000000) >>> 0
      let h2 = 0; h2 = (h2 + 4000000000) >>> 0
      let ored = h || h2
      return ored + 0
    }`, { optimize })
    is(fOr(true), 3000000000, `O${optimize}: || truthy arm (h) keeps its uint32 magnitude`)
    is(fOr(false), 4000000000, `O${optimize}: || falsy-h arm (h2) keeps its uint32 magnitude`)
  }
})

test('agreeing-SIGNED `&&` / `||` arms keep the branchless i32-if fast path (no regression from the sign-join fix)', () => {
  // Control for the tests above: two ordinary signed i32 arms (the overwhelming
  // common case) must still compile through the single i32-if-then-single-widen
  // fast path for both handlers — the sign-agreement check must cost nothing when
  // there's nothing to disagree about. WAT-shape control, same style as the '?:'
  // control above.
  const srcAnd = `export let f = (x, y) => { let a = x | 0; let b = y | 0; let picked = a && b; return picked + 0 }`
  const wAnd = compileSrc(srcAnd, { wat: true, optimize: 0 })
  is(/local\.set \$picked\s*\(if/.test(wAnd), true, '&&: join is a single i32 if (fast path)')
  is((wAnd.match(/f64\.convert_i32_[su]/g) || []).length, 1, '&&: single widen at the return, not per-arm')
  is(/f64\.convert_i32_u/.test(wAnd), false, '&&: signed arms convert signed, not unsigned')
  const { f: fAnd } = run(srcAnd)
  is(fAnd(1, -9), -9)
  is(fAnd(0, -9), 0)

  const srcOr = `export let f = (x, y) => { let a = x | 0; let b = y | 0; let picked = a || b; return picked + 0 }`
  const wOr = compileSrc(srcOr, { wat: true, optimize: 0 })
  is(/local\.set \$picked\s*\(if/.test(wOr), true, '||: join is a single i32 if (fast path)')
  is((wOr.match(/f64\.convert_i32_[su]/g) || []).length, 1, '||: single widen at the return, not per-arm')
  is(/f64\.convert_i32_u/.test(wOr), false, '||: signed arms convert signed, not unsigned')
  const { f: fOr } = run(srcOr)
  is(fOr(1, -9), 1)
  is(fOr(0, -9), -9)
})

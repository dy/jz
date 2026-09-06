import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import jz, { compile, instantiate } from '../index.js'
import { onWasi, onKernel } from './_matrix.js'
import { VAL } from '../src/reps.js'
import { valTypeOf, valTypeOfWithLocals } from '../src/kind.js'

const levels = [false, 1, 2, 3]
const oracle = source => Function(source.replaceAll('export ', '') + ';return {f,state}')()
const observe = (f, args, wasm) => {
  try { return ['return', f(...args)] }
  catch (e) { return ['throw', wasm && e?.name === 'Error' && Object.hasOwn(e, 'thrown') ? e.thrown : e?.name ?? e] }
}
const prefix = `let trace=0
  function mark(n,stage){trace=trace*10+n;if(stage===n)throw n}
  export const state=()=>trace;`

// These rules are independent of an active function and of discarded operands.
test('sequence kinds: the last value owns the kind, including scoped names and absence', () => {
  const locals = new Map([['value', VAL.BIGINT], ['flag', VAL.BOOL]])
  const resolve = name => locals.get(name)
  is(valTypeOf([',', [null, 1], ['bigint', '6']]), VAL.BIGINT)
  is(valTypeOf([',', ['bigint', '6'], [null, 1]]), VAL.NUMBER)
  is(valTypeOf([',', ['bigint', '6'], [null, undefined]]), null)
  is(valTypeOfWithLocals([',', [null, 1], [',', 'flag', 'value']], resolve), VAL.BIGINT)
  is(valTypeOfWithLocals([',', 'value', 'flag'], resolve), VAL.BOOL)
  is(valTypeOfWithLocals([',', 'value', 'missing'], resolve), null)
  const nullable = [',', [null, 1], ['?:', 'flag', ['bigint', '6'], [null, null]]]
  is(valTypeOf(nullable), null, 'a receiver-oriented BigInt claim is not a presence proof')
  is(valTypeOfWithLocals(nullable, resolve), null, 'scoped forwarding also preserves absence')
})

for (const op of ['&', '|', '^', '<<', '>>', '+', '-', '*', '/', '%', '~'])
test(`sequence BigInt ${op}: local storage, exact bits, abrupt operands and recovery`, () => {
  const expr = op === '~' ? '~(mark(1,stage),a)'
    : `(mark(1,stage),a) ${op} (mark(2,stage),b)`
  const source = `${prefix}
    export function f(input,stage){trace=0;const a=BigInt(input),b=1n
      const value=${expr};return value}`
  const expected = oracle(source)
  const calls = [['6',0], ['0',0], ['-1',0], ['4611686018427387903',0],
    ['9221120245631025152',0], ['9221823924482867200',0],
    ['-9223372036854775808',0], ['6',1], ['6',0], ['6',2], ['6',0]]
  for (const optimize of levels) {
    const actual = jz(source, {optimize}).exports
    for (const args of calls) {
      const want = observe(expected.f, args, false)
      // JZ's documented signed-i64 lane wraps successful arithmetic, not errors.
      if (want[0] === 'return') want[1] = BigInt.asIntN(64, want[1])
      is(observe(actual.f, args, true), want, `${op} O${optimize || 0}: ${args}`)
      is(actual.state(), expected.state(), 'each preceding effect executes once, in order')
    }
  }
})

for (const tail of ['BigInt(input)', 'input === "1"', 'Boolean(input)'])
for (const nested of [false, true])
test(`typeof ${tail}, ${nested ? 'nested sequence' : 'direct producer'}: a known result still evaluates its operand`, () => {
  const operand = nested ? `(mark(1,stage),(mark(2,stage),${tail}))`
    : tail.replace('input', '(mark(1,stage),input)')
  const source = `${prefix}
    export function f(input,stage){trace=0;return typeof (${operand})}`
  const expected = oracle(source)
  for (const optimize of levels) {
    const actual = jz(source, {optimize}).exports
    for (const args of [['1',0], ['0',0], ['-1',0], ['bad',0], ['1',1], ['1',0], ['1',2], ['1',0]]) {
      is(observe(actual.f, args, true), observe(expected.f, args, false), `O${optimize || 0}: ${args}`)
      is(actual.state(), expected.state(), 'effects and throws survive the constant typeof result')
    }
  }
})

for (const type of ['number', 'bigint', 'boolean', 'string', 'undefined', 'object', 'function', 'symbol'])
test(`typeof comparisons: raw primitive sequences versus ${type}`, () => {
  for (const tail of ['BigInt(input)', 'Boolean(input)']) for (const cmp of ['===', '!==']) {
    const source = `${prefix} export function f(input,stage){trace=0;
      return typeof (mark(1,stage),${tail}) ${cmp} '${type}'}`
    const expected = oracle(source)
    for (const optimize of levels) {
      const actual = jz(source, {optimize}).exports
      // Wide decimal strings exercise BigInt payloads. The Boolean-only
      // module needs no memory and accepts only inline strings at its ABI.
      const payloads = tail.startsWith('BigInt')
        ? ['9221120245631025152', '9221823924482867200'] : [null, undefined]
      for (const args of [['0',0], ['-1',0], ['',0], ...payloads.map(x => [x,0]),
        ['bad',0], ['1',1], ['1',0]]) {
        is(observe(actual.f, args, true), observe(expected.f, args, false), `${tail} ${cmp} ${type} O${optimize || 0}: ${args}`)
        is(actual.state(), expected.state(), 'the folded comparison still evaluates once')
      }
    }
  }
})

test('typeof object comparisons: null, absence and boxed primitives stay distinct through storage', () => {
  for (const cmp of ['===', '!==']) {
    const source = `${prefix}
      const values=new Map(); values.set(0,6n); values.set(1,null); values.set(2,{a:1});
      values.set(3,true); values.set(4,undefined); values.set(5,'str'); values.set(6,0)
      export function f(index,stage){trace=0;return typeof (mark(1,stage),values.get(index)) ${cmp} 'object'}`
    const expected = oracle(source)
    for (const optimize of levels) {
      const actual = jz(source, {optimize}).exports
      for (const args of [[0,0], [1,0], [2,0], [3,0], [4,0], [5,0], [6,0], [7,0], [0,1], [0,0]]) {
        is(observe(actual.f, args, true), observe(expected.f, args, false), `${cmp} O${optimize || 0}: ${args}`)
        is(actual.state(), expected.state(), 'storage read follows the effect once')
      }
    }
  }
})

for (const consumer of ['VALUE', 'Number(VALUE)', 'String(VALUE)', 'typeof VALUE',
  'VALUE === null', 'VALUE === undefined', 'typeof VALUE === "bigint"',
  'typeof VALUE === "object"', '[VALUE]'])
test(`nullable sequence results: ${consumer} keeps presence and producer readiness`, () => {
  for (const absent of ['null', 'undefined']) {
    const value = `(mark(1,stage),(mark(2,stage),choose?BigInt(input):${absent}))`
    const source = `${prefix} export function f(input,choose,stage){trace=0;return ${consumer.replace('VALUE',value)}}`
    const expected = oracle(source)
    for (const optimize of levels) {
      const actual = jz(source, {optimize}).exports
      for (const args of [['6',true,0], ['9221823924482867200',true,0], ['bad',false,0],
        ['bad',true,0], ['bad',true,1], ['bad',true,2], ['6',true,0], ['6',false,0]]) {
        is(observe(actual.f, args, true), observe(expected.f, args, false), `${absent} O${optimize || 0}: ${args}`)
        is(actual.state(), expected.state(), 'nested prefixes run once, before the chosen tail')
      }
    }
  }
})

test('typeof object comparisons: nullable host values are not all atoms or all objects', () => {
  for (const cmp of ['===', '!==']) {
    const source = `${prefix} export function f(input,stage){trace=0;
      return typeof (mark(1,stage),input) ${cmp} 'object'}`
    const expected = oracle(source)
    for (const optimize of levels) {
      const actual = jz(source, {optimize}).exports
      for (const input of [null, undefined, false, true, 0, -0, NaN, 5e-324, 'str', null]) {
        is(observe(actual.f, [input,0], true), observe(expected.f, [input,0], false), `${cmp} O${optimize || 0}`)
        is(actual.state(), expected.state(), 'nullable operand evaluates once')
      }
    }
  }
})

for (const expr of ['Number((mark(1,stage),BigInt(input)))',
  'String((mark(1,stage),BigInt(input)))',
  'String((mark(1,stage),input === "1"))',
  'String((mark(1,stage),({value:input})))',
  '(BigInt(input),Number(input)) | 7'])
test(`sequence consumers: ${expr}`, () => {
  const source = `${prefix} export function f(input,stage){trace=0;return ${expr}}`
  const expected = oracle(source)
  for (const optimize of levels) {
    const actual = jz(source, {optimize}).exports
    for (const args of [['1',0], ['0',0], ['-1',0], ['bad',0], ['1',1], ['1',0]]) {
      is(observe(actual.f, args, true), observe(expected.f, args, false), `O${optimize || 0}: ${args}`)
      is(actual.state(), expected.state(), 'discarded values still evaluate')
    }
  }
})

if (!onWasi() && !onKernel()) test('sequence boundaries: empty decode, bare return and final source/binary byte', () => {
  const a = 'export function f(){}', b = 'export function f(){return (0,6n)}'
  for (const optimize of levels) {
    const options = {optimize}, empty = compile('', options)
    ok(WebAssembly.validate(empty), 'smallest input compiles to a valid module')
    is(instantiate(empty).exports.f, undefined, 'zero-work module has no user entry')
    const bytesA = compile(a, options).slice(), oldA = instantiate(bytesA).exports.f
    is(oldA(), undefined, 'bare return decodes as undefined')
    is(compile(a, options), bytesA, 'A to A')
    const bytesB = compile(b, options).slice(), oldB = instantiate(bytesB).exports.f
    is(oldB(), 6n, 'different B has an exact BigInt result')
    let rejected = false
    try { compile(b.slice(0,-1), options) } catch { rejected = true }
    ok(rejected, 'split immediately before final closing brace rejects')
    is(compile(b.slice(0,-1)+b.slice(-1), options), bytesB, 'completing final boundary restores B')
    is(compile(b+'', options), bytesB, 'zero-length suffix at final boundary changes nothing')
    ok(!WebAssembly.validate(bytesB.subarray(0,bytesB.length-1)), 'truncated binary is invalid')
    is(compile('', options), empty, 'empty after B and error is identical')
    is(compile(a, options), bytesA, 'error to A')
    is(oldA(), undefined, 'retained A still decodes undefined')
    is(oldB(), 6n, 'retained B still returns BigInt')
    is(instantiate(bytesB).exports.f(), 6n, 'complete retained binary reinstantiates')
  }
})

// This is native compile-state evidence, not a hosted bootstrap certificate.
if (!onWasi() && !onKernel()) test('sequence values: retained A/A/B outputs agree with fresh B after empty and error compiles', () => {
  const a = 'export const f=x=>{let n=BigInt(x);const r=(n,n) << (n,1n);return r}'
  const b = `export const f=x=>{let n=BigInt(x);const r=(n,n) | (n,3n);return r}
    export const g=choose=>typeof (choose,choose?1n:null)==='object'
    export const h=choose=>(choose,choose?1n:null)`
  const options = {optimize:false}
  const bytesA = compile(a, options), savedA = bytesA.slice()
  is(compile(a, options), savedA, 'A to A')
  const bytesB = compile(b, options), savedB = bytesB.slice()
  const fresh = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {compile} from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
     process.stdout.write(Buffer.from(compile(${JSON.stringify(b)},${JSON.stringify(options)})).toString('base64'))`], {encoding:'utf8', timeout:60000})
  is(fresh.error, undefined)
  is(fresh.signal, null)
  is(fresh.status, 0, fresh.stderr)
  is(bytesB, new Uint8Array(Buffer.from(fresh.stdout, 'base64')), 'immediate A to B equals fresh B')
  const oldA = instantiate(bytesA).exports, oldB = instantiate(bytesB).exports
  const empty = compile('', options)
  ok(WebAssembly.validate(empty))
  is(compile('', options), empty, 'empty to empty')
  let rejected = false
  try { compile('export function f(){', options) } catch { rejected = true }
  ok(rejected, 'invalid source rejects')
  is(compile(a, options), savedA, 'A after empty and error')
  is(bytesA, savedA, 'A bytes retained')
  is(bytesB, savedB, 'B bytes retained')
  is(oldA.f('6'), 12n, 'retained A executes')
  is(oldB.f('6'), 7n, 'retained B executes')
  is([oldB.g(0),oldB.g(1)], [true,false], 'retained nullable typeof executes')
  is([oldB.h(0),oldB.h(1)], [null,1n], 'retained nullable result executes')
  is(instantiate(bytesA).exports.f('6'), 12n, 'retained A reinstantiates')
  is(instantiate(bytesB).exports.h(0), null, 'retained nullable B reinstantiates')
})

import test from 'tst'
import { is } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { oracle } from './util.js'

// The same receiver crosses both the known-layout and generic coercion paths.
// Repeated calls also exercise helper state across successes and TypeErrors.
const check = (src, args, reference = src) => {
  for (const optimize of [0, 2, 3, 'size']) {
    const want = oracle(reference), got = jz(src, { optimize }).exports
    for (const a of args) is(got.f(a), want.f(a), `O${optimize}, input ${a}`)
  }
}

test('method positions: string ranges capture arguments and default only undefined', () => {
  for (const method of ['slice', 'substring']) check(`export function f(k) {
    let trace='', end=3
    const start={valueOf(){trace+='v';end=1;if(k===2)throw 1;return k===3?1n:1}}
    function extra(){trace+='e';return 9}
    try { return ['abcdef'.${method}(start,end,extra()), trace,
      'abcdef'.${method}(1,undefined),'abcdef'.${method}(1,null),
      'abcdef'.${method}(1,{valueOf(){return undefined}}),'abcdef'.${method}(-2,Infinity)] }
    catch(e){ return [e===1?'one':e.name,trace] }
  }`, [0,0,2,3,0])
})

test('method positions: array and typed at, slice and subarray coerce before clamping', () => {
  check(`
    function at(i) { try { return [7, 8].at(i) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function typedAt(i) { try { return new Int32Array([7, 8]).at(i) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function bigAt(i) { try { return new BigInt64Array([7n, 8n]).at(i) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function slice(i) { try { return Array.from(new Int32Array([7, 8]).slice(i)) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function bigSlice(i) { try { return Array.from(new BigInt64Array([7n, 8n]).slice(i)) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function view(i) { try { return Array.from(new Int32Array([7, 8]).subarray(i)) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function buffer(i) { try { return new ArrayBuffer(2).slice(i).byteLength } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    export function f(k) {
      const values = ['1', true, null, undefined, NaN, Infinity, -Infinity, -1.5, 4294967295, 1n]
      const i = values[k]
      return [at(i), typedAt(i), bigAt(i), slice(i), bigSlice(i), view(i), buffer(i)]
    }
  `, [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0])
  check(`export function f(k) {
    const i = k >>> 0, a = new Int32Array([7, 8]), b = new BigInt64Array([7n, 8n])
    return [a.at(i), [7, 8].at(i), a.slice(i).length, a.subarray(i).length,
      b.at(i), b.slice(i).length, 'ab'.at(i), 'ab'.slice(i)]
  }`, [0, 1, 2147483647, 2147483648, 4294967295, -1, 0])
  check(`export function f(k) {
    try {
      const a = new Int32Array(0)
      return k === 0 ? a.at(1n) : k === 1 ? a.slice(1n).length : a.subarray(0, 1n).length
    } catch(e) { return e instanceof TypeError }
  }`, [0, 1, 2, 0])
})

test('method positions: range arguments precede conversions, including unused arguments', () => {
  for (const method of ['slice', 'subarray']) check(`
    export function f(k) {
      let trace = '', end = 2
      const a = new Int32Array([7, 8, 9])
      const start = { valueOf() { trace += 'v'; end = 0; a[1] = 42; if(k === 1) throw 17; return k === 2 ? 1n : 1 } }
      function first() { trace += 'a'; return start }
      function second() { trace += 'b'; return end }
      function extra() { trace += 'c'; if(k === 3) throw 23; return 99 }
      try { const b = a.${method}(first(), second(), extra()); return [Array.from(b), trace, end] }
      catch(e) { return [e instanceof TypeError ? 'TypeError' : e, trace, end] }
    }
  `, [0, 0, 1, 2, 3, 0])
  check(`
    export function f(k) {
      let trace = ''
      const a = new Int32Array([7, 8, 9])
      const end = { valueOf() { trace += 'e'; return k ? undefined : 2 } }
      const missing = [undefined][0]
      return [Array.from(a.slice(1, end)), Array.from(a.subarray(1, end)),
        Array.from(a.slice(1, missing)), Array.from(a.subarray(1, missing)), trace]
    }
  `, [0, 1, 1, 0])
  check(`
    function copy(a, end) { return Array.from(a.slice('1', end)) }
    function view(a, end) { return Array.from(a.subarray('1', end)) }
    export function f(k) {
      const end = k ? undefined : 2
      return [copy(new Int32Array([7, 8, 9]), end), copy(new BigInt64Array([7n, 8n, 9n]), end),
        view(new Int32Array([7, 8, 9]), end), view(new Uint8Array([7, 8, 9]), end)]
    }
  `, [0, 1, 1, 0])
  check(`export function f(k) {
    let trace = ''
    const b = new ArrayBuffer(3), bytes = new Uint8Array(b)
    bytes[0] = 7; bytes[1] = 8; bytes[2] = 9
    const start = { valueOf() { trace += 'v'; if(k) throw 17; bytes[1] = 42; return 1 } }
    function end() { trace += 'e'; return 2 }
    function extra() { trace += 'x'; return 0 }
    try { return [Array.from(new Uint8Array(b.slice(start, end(), extra()))), trace] }
    catch(e) { return [e, trace] }
  }`, [0, 1, 1, 0])
})

test('method positions: at captures length after arguments and reads after conversion', () => {
  check(`
    export function f(k) {
      let trace = ''
      const a = [7, 8]
      const index = { valueOf() {
        trace += 'v'
        if(k === 0) a.length = 0
        if(k === 1) { for(let i=0;i<100;i++) a.push(i); a[1] = 42 }
        if(k === 2) return 1n
        if(k === 3) throw 17
        return -1
      } }
      function first() { trace += 'a'; return index }
      function extra() { trace += 'b'; return 3 }
      try { const v = a.at(first(), extra()); return [v, trace, a.length] }
      catch(e) { return [e instanceof TypeError ? 'TypeError' : e, trace, a.length] }
    }
  `, [0, 0, 1, 2, 3, 1, 0])
  check(`export function f(k) {
    const a = [7]
    function index() { a.push(8); return -1 }
    const b = new Int32Array(0)
    let calls = 0
    const i = { valueOf() { calls++; return k ? 1n : 0 } }
    let empty
    try { empty = b.at(i) } catch(e) { empty = e instanceof TypeError ? 'TypeError' : e }
    return [a.at(index()), empty, calls, a.at(...[-1])]
  }`, [0, 1, 1, 0])
})

test('method receivers: nullable builtins throw before evaluating arguments', () => {
  for (const [receivers, operation] of [
    ['[[7, 8], null]', 'a.at(pos())'],
    ['[new Int32Array([7, 8]), null]', 'a.at(pos())'],
    ['[new Int32Array([7, 8]), null]', 'Array.from(a.slice(pos()))'],
    ['[new Int32Array([7, 8]), null]', 'Array.from(a.subarray(pos()))'],
    ['[new Int32Array([7, 8]), null]', 'a.includes(pos())'],
    ['[new BigInt64Array([7n, 9221120245631025152n]).subarray(1), null]', 'a.at(pos())'],
    ["['ab', null]", 'a.slice(pos())'],
    ['[new ArrayBuffer(2)]', 'a.slice(pos()).byteLength'],
  ]) check(`export function f(k) {
    let trace = ''
    const xs = ${receivers}
    function recv() { trace += 'r'; return xs[k] }
    function pos() { trace += 'p'; return 0 }
    try { const a = recv(); return [${operation}, trace] }
    catch(e) { return [e.name, trace] }
  }`, [0, 0, 1, 2, -1, 0])
  check(`const a = new BigInt64Array([7n, 9221120237041090562n, 9221120245631025152n])
    export function f(i) {
      let calls = 0
      function radix() { calls++; return 10 }
      try { return [a[i].toString(radix()), calls] }
      catch(e) { return [e.name, calls] }
    }
  `, [0, 0, 1, 2, 3, -1, 0])
})

test('ToNumber: reject raw, boxed and converted BigInts at implicit boundaries', () => {
  check(`
    function split(v) { try { return 'a,b'.split(',', v).length } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function abs(v) { try { return Math.abs(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function store(v) { try { const a=new Float64Array(1); a[0]=v; return a[0] } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function raw() { try { return 'a,b'.split(',', 1n).length } catch(e) { return e instanceof TypeError } }
    export function f(mode) {
      let trace = ''
      const a = mode === 0 ? [] : [1n]
      const o = { valueOf() { trace += 'v'; if(mode === 3) throw 17; return mode === 1 ? 1n : mode === 2 ? o : 1 },
        toString() { trace += 's'; return 2n } }
      const out = [raw(), split(a[0]), split(mode ? 1n : 1), abs(mode ? 1n : -1),
        store(mode ? 1n : 1), split(o), store(o)]
      return [out, trace]
    }
  `, [0, 0, 1, 2, 3, 1, 0])
})

test('Number: explicit conversion retains BigInt payloads and nullable results', () => {
  check(`
    function number(v) { return Number(v) }
    export function f(mode) {
      let trace = ''
      const a = mode === 0 ? [] : [9221120245631025152n]
      const o = { valueOf() { trace += 'v'; if(mode === 3) throw 17; return mode === 1 ? 7n : mode === 2 ? o : 2 },
        toString() { trace += 's'; return 8n } }
      let converted
      try { converted = Number(o) } catch(e) { converted = 'throw:' + e }
      return [Number(7n), number(mode ? 7n : '2'), Number(mode ? true : 2),
        Number(a[0]), number(a[0]), Number(null), Number(undefined), converted, trace]
    }
  `, [0, 0, 1, 2, 3, 1, 0])
})

test('ToNumber: typed BigInt presence and payloads survive explicit conversion', () => {
  check(`
    const a = new BigInt64Array([1n, 9221120245631025152n, -1n])
    export function f(i) {
      i |= 0
      let checked, present
      try { checked = +a[i] } catch(e) { checked = e instanceof TypeError ? 'TypeError' : e }
      try { present = +a[0] } catch(e) { present = e instanceof TypeError ? 'TypeError' : e }
      return [Number(a[i]), Number(a[0]), checked, present]
    }
  `, [-1, 0, 0, 1, 2, 3, 0])
})

test('ToNumber: string positions reject BigInt and preserve conversion effects', () => {
  check(`
    function char(v) { try { return 'abc'.charAt(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function code(v) { try { return 'abc'.charCodeAt(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function point(v) { try { return 'abc'.codePointAt(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function at(v) { try { return 'abc'.at(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function slice(v) { try { return 'abc'.slice(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function sub(v) { try { return 'abc'.substring(v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function length(v) { try { return 'abc'.substr(0, v) } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    function plus(v) { try { return +v } catch(e) { return e instanceof TypeError ? 'TypeError' : e } }
    export function f(mode) {
      let calls = 0
      const o = { valueOf() { calls++; if(mode === 3) throw 17; return mode === 1 ? 1n : mode === 2 ? -0 : 1 } }
      const a = mode ? [1n] : []
      return [char(o), code(o), point(o), at(o), slice(o), sub(o), length(o), plus(o),
        plus(a[0]), char(mode ? 1n : 4294967296), char(1n), slice(1n), calls]
    }
  `, [0, 0, 1, 2, 3, 1, 0])
})

test('ToPrimitive: absent and non-callable own methods stay distinct', () => {
  check(`
    function str(o) { try { return String(o) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
    function num(o) { try { return '' + (o - 0) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
    export function f(k) {
      let o
      if (k === 0) o = {}
      else if (k === 1) o = { toString: null, valueOf() { return 7 } }
      else if (k === 2) o = { toString: undefined, valueOf() { return 8 } }
      else if (k === 3) o = { toString: 1, valueOf: null }
      else if (k === 4) o = { toString() { return {} }, valueOf() { return 9 } }
      else o = { toString() { return {} }, valueOf() { return {} } }
      return str(3) + '|' + str(o) + '|' + num(4) + '|' + num(o)
    }
  `, [0, 1, 2, 3, 4, 5, 5, 1, 0])
})

test('ToPrimitive: own properties shadow inherited class methods', () => {
  check(`
    class Base { toString() { return 'base' } valueOf() { return 2 } }
    class Child extends Base { toString() { return 'child' } }
    function str(o) { try { return String(o) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
    function num(o) { try { return '' + (o - 0) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
    export function f(k) {
      const o = new Child()
      if (k === 1) o.toString = null
      if (k === 2) { o.toString = undefined; o.valueOf = null }
      if (k === 3) o.toString = () => 'own'
      if (k === 4) { o.valueOf = () => 11; o.toString = null }
      if (k === 5) { o.toString = null; let key = k === 5 ? 'toString' : 'missing'; delete o[key] }
      let direct
      try { direct = String(o) + ':' + (o - 0) } catch (e) { direct = e instanceof TypeError ? 'TypeError' : 'other' }
      return direct + '|' + str(3) + '|' + str(o) + '|' + num(4) + '|' + num(o)
    }
  `, [0, 1, 2, 3, 4, 5, 2, 0])
})

test('ToPrimitive: evaluate once and look up the second method after the first call', () => {
  check(`
    export function f(k) {
      let calls = 0
      const o = { valueOf() { calls++; o.toString = () => 'changed'; return o }, toString() { return 'old' } }
      function get() { calls++; return o }
      const s = get() + 1
      return s + ':' + calls
    }
  `, [0, 0])
})

test('ToPrimitive: addition uses the default hint even beside a string', () => {
  check(`
    function add(a, b) { return a + b }
    export function f(k) {
      const o = { valueOf() { return 2 }, toString() { return 's' } }
      const n = { toString() { return 7 } }
      return (n + 1) + '|' + add(o, '') + '|' + add('', o) + '|' + add(1, 2)
    }
  `, [0, 0])
})

test('ToPrimitive: a throwing first method prevents fallback', () => {
  check(`
    export function f(k) {
      let calls = 0
      const o = { valueOf() { calls++; throw 23 }, toString() { calls += 10; return 'wrong' } }
      try { return o + 1 } catch (e) { return e + ':' + calls }
    }
  `, [0, 0])
})

test('ToPropertyKey: compound and update references coerce once', () => {
  const ops = ['+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '||=', '&&=', '??=']
  const exprs = [...ops.map(op => `base[key] ${op} 2`), 'base[key]++', 'base[key]--', '++base[key]', '--base[key]']
  const functions = exprs.map((expr, i) => `
    function apply${i}(base, key) { return ${expr} }
    function case${i}(k) {
      let calls = 0
      const base = { x: k ? 8 : 0 }
      const key = { toString() { calls++; return 'x' } }
      const result = apply${i}(base, key)
      const next = apply${i}(base, 'x')
      return result + ':' + next + ':' + base.x + ':' + calls
    }`).join('\n')
  const src = `${functions}
    export function f(k) { return ${exprs.map((_, i) => `case${i}(k)`).join(" + '|' + ")} }
  `
  // Node 25 coerces an update key twice, unlike Test262's once-only contract.
  // Explicitly capture the Reference's property key in the JS oracle.
  const reference = src.replaceAll('(base, key) { return', '(base, key) { key = String(key); return')
  check(src, [0, 1, 1, 0], reference)
})

test('ToPropertyKey: update and plain-store order retain the original receiver', () => {
  const src = `
    export function f(k) {
      let order = '', base = { x: 2 }
      const original = base
      const key = { toString() {
        order += 'K'; base = { x: 9 }
        if (k === 2) throw 23
        return 'x'
      } }
      function rhs() { order += 'R'; return 3 }
      let result
      try {
        if (k === 0) result = base[key] = rhs()
        else result = base[key] += rhs()
      } catch (e) { result = e }
      return result + ':' + original.x + ':' + base.x + ':' + order
    }
  `
  // GetValue retains an update's converted key; a plain PutValue converts
  // after the RHS. Node 25 still converts an update's key twice.
  const reference = src.replace('else result = base[key] += rhs()',
      "else { const ref = base, prop = String(key); result = ref[prop] += rhs() }")
  check(src, [0, 1, 2, 2, 0], reference)
})

test('ToPropertyKey: primitive keys retain their property identity', () => {
  check(`
    function set(base, key) { base[key] += 2; return base[key] }
    export function f(k) {
      const a = { '0': 1, '1': 2, true: 3, null: 4, undefined: 5 }
      return set(a, -0) + ':' + set(a, '1') + ':' + set(a, true) + ':' +
        set(a, null) + ':' + set(a, undefined) + ':' + set(a, 1n)
    }
  `, [0, 0])
})

test('member updates: RHS writes cannot retarget the saved reference', () => {
  check(`
    export function f(k) {
      let a = { x: 2 }, i = 0
      const original = a, values = [2, 9]
      a.x += (a = { x: 9 }, 3)
      values[i] += (i = 1, 3)
      return original.x + ':' + a.x + ':' + values.join(',')
    }
  `, [0, 0])
})

test('member updates: opaque array, typed array and dictionary retain their store semantics', () => {
  check(`
    function increment(a, key) { a[key] = (a[key] || 0) + 1; return a[key] }
    export function f(k) {
      const typed = new Uint8Array([7]), array = [7], dict = {}
      const x = increment(typed, k), y = k < 0 ? undefined : increment(array, k), z = increment(dict, k)
      return x + ':' + y + ':' + z + ':' + typed.length + ':' + array.length
    }
  `, [-1, 0, 1, 3, 0, -1])
})

test('ToPropertyKey: nullish update evaluates the key expression without coercing it', () => {
  check(`
    export function f(k) {
      let order = ''
      const base = k ? null : undefined
      function key() { order += 'K'; return { toString() { order += 'S'; return 'x' } } }
      try { base[key()] += 1 } catch (e) { return order + ':' + (e instanceof TypeError) }
      return 'missing throw'
    }
  `, [0, 1, 1, 0])
})

test('ToPrimitive: inherited generic methods are not Date-only aliases', () => {
  check(`
    export function f(k) {
      const fn = function() { return 1 }
      const map = new Map(), set = new Set(), buf = new ArrayBuffer(0)
      return (fn.toString() === String(fn)) + ':' + (fn.valueOf() === fn) + ':' +
        map.toString() + ':' + set.toString() + ':' + buf.toString() + ':' +
        new Date(0).getTime()
    }
  `, [0, 0])
})

test('relational coercion: object and closure carriers compare their primitives', () => {
  check(`
    function compare(a, b) { return [a < b, a <= b, a > b, a >= b].join(',') }
    export function f(k) {
      const fn = function() { return 1 }, o = {}
      const a = { valueOf() { return k ? '20' : 20 } }
      return compare(o, fn) + '|' + [o < fn, o <= fn, fn > o, fn >= o].join(',') + '|' +
        compare(a, '3') + '|' + compare('3', a) + '|' + compare([1], [2]) + '|' +
        compare(Infinity, Infinity) + '|' + compare(-Infinity, -Infinity) + '|' +
        compare(NaN, 0) + '|' + compare(-0, 0) + '|' + compare(new Date(0), 1)
    }
  `, [0, 1, 1, 0])
})

test('relational coercion: both expressions precede left-to-right conversion', () => {
  check(`
    export function f(k) {
      let order = ''
      function left() { order += 'L'; return { valueOf() { order += 'a'; return '20' } } }
      function right() { order += 'R'; return { valueOf() { order += 'b'; return '3' } } }
      function number() { order += 'N'; return 3 }
      const first = left() < right(), firstOrder = order
      order = ''
      const second = left() < number()
      return first + ':' + firstOrder + '|' + second + ':' + order
    }
  `, [0, 0])
})

test('ToPrimitive: shared member census covers defaults, modules and repeated compiles', () => {
  const src = `import { obj } from './dep.js';
    function render(o = { toString() { return 'default' } }) { return String(o) }
    export const f = () => render() + ':' + render(obj) + ':' + /(a)/.exec('a')[1]`
  const modules = { './dep.js': `export const obj = { toString() { return 'module' } }` }
  for (const optimize of [0, 2, 3, 'size']) {
    for (let i = 0; i < 2; i++) is(jz(src, { modules, optimize }).exports.f(), 'default:module:a')
    const plain = 'export const f = () => String({ a: 1 })'
    is(compile(plain, { optimize, wat: true }).includes('$__jz_tp_'), false, 'method-free compile has no coercion prelude')
    is(jz(plain, { optimize }).exports.f(), '[object Object]')
    is(jz(src, { modules, optimize }).exports.f(), 'default:module:a')
  }
})

test('ToPrimitive: dynamic addition preserves BigInt and rejects mixed domains', () => {
  const src = `export function f(a, b) {
    const values = {}
    values.big = 7n; values.neg = -7n; values.num = 3
    values.str = 'x'; values.nil = null; values.bool = true
    values.bits = 9221120245631025152n; values.negBits = -9221120245631025152n
    try { return values[a] + values[b] }
    catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' }
  }`
  const want = oracle(src)
  const pairs = [['big', 'big'], ['big', 'neg'], ['bits', 'negBits'],
    ['big', 'num'], ['num', 'big'], ['big', 'missing'], ['missing', 'big'],
    ['big', 'nil'], ['big', 'bool'], ['big', 'str'], ['str', 'big'],
    ['num', 'num'], ['nil', 'bool'], ['missing', 'missing'], ['big', 'big']]
  for (const optimize of [0, 2, 3, 'size']) {
    const got = jz(src, { optimize }).exports
    for (const [a, b] of pairs) is(got.f(a, b), want.f(a, b), `O${optimize}, ${a} + ${b}`)
  }
})

test('ToPrimitive: nullable numeric collection reads add without string dispatch', () => {
  const src = `export function f(k) {
    const m = new Map(); m.set('n', 7)
    return m.get(k) + 1
  }`
  check(src, ['n', 'missing', 'n', 'missing'])
  for (const optimize of [0, 2, 3, 'size']) {
    const wat = compile(src, { optimize, wat: true })
    is(wat.includes('$__str_concat'), false, 'Number or undefined cannot concatenate')
    is(wat.includes('$__add_slow'), false, 'numeric addition needs no generic helper')
  }
})

test('ToPrimitive: a boxed BigInt returned by a conversion method is primitive', () => {
  check(`export function f(k) {
    let order = ''
    const a = { valueOf() { order += 'a'; return 7n } }
    const b = { valueOf() { order += 'b'; return k ? 3 : 5n } }
    try { return String(a + b) + ':' + order }
    catch (e) { return (e instanceof TypeError ? 'TypeError:' : 'other:') + order }
  }`, [0, 1, 1, 0])
  check(`export function f(k) {
    const o = { toString() { return 8n }, valueOf() { return 7n } }
    return k ? String(o) : String(o + 0n)
  }`, [0, 1, 0])
})

test('ToPrimitive: loose BigInt equality converts known and dynamic objects', () => {
  check(`export function f(k) {
    let calls = 0
    const o = { valueOf() { calls++; return k ? 8n : 7n } }
    const result = (o == 7n) + ':' + (7n == o) + ':' + (o != 7n) + ':' +
      (7n != o) + ':' + (o === 7n) + ':' + (7n !== o)
    return result + ':' + calls + ':' + ([7] == 7n) + ':' + (0n == [])
  }`, [0, 1, 1, 0])
  check(`export function f(k) {
    let calls = 0
    const values = [7n, 7, '7', true, null, undefined, NaN, {}, [7], []]
    const o = { valueOf() { calls++; return values[k] } }
    const choices = [o, null]
    const value = choices[0]
    return (value == 7n) + ':' + (7n != value) + ':' + calls + ':' + (values[k] == 7n)
  }`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0])
})

test('ToPrimitive: BigInt equality evaluates both sides before conversion and preserves errors', () => {
  check(`export function f(k) {
    let order = ''
    const o = {
      valueOf() { order += 'v'; if (k === 1) throw 23; return {} },
      toString() { order += 's'; return k === 2 ? {} : '7' }
    }
    function left() { order += 'l'; return o }
    function right() { order += 'r'; return 7n }
    try {
      const eq = k === 3 ? right() == left() : left() == right()
      return eq + ':' + order
    } catch (e) { return (e instanceof TypeError ? 'TypeError' : e) + ':' + order }
  }`, [0, 1, 2, 3, 0])
})

test('ToPrimitive: dynamic BigInt equality distinguishes numeric bits from a payload', () => {
  check(`export function f(k) {
    const values = [7n, 7, 3.5e-323, -3.5e-323, 0, null, undefined]
    return (values[k] == 7n) + ':' + (7n == values[k]) + ':' + (values[k] != 7n) + ':' +
      (values[k] === 7n) + ':' + (7n !== values[k])
  }`, [0, 1, 2, 3, 4, 5, 6, 0])
  check(`export function f(k) {
    const values = Array.from(new BigInt64Array([7n, 0n, -7n]))
    return (values[k] == 7n) + ':' + (values[k] == 0n) + ':' + (values[k] == -7n)
  }`, [0, 1, 2, 3, 0])
  const src = `function clone(src) { return Array.from(src, v => v) }
  export function copy(k) {
    const src = new BigInt64Array([7n, 0n, -7n, 9221120245631025152n])
    if (k === 0) return Array.from(src)
    if (k === 1) return Array.from(src, v => v)
    if (k === 3) return Array.from(src.subarray(2, 2), v => { throw 23 })
    if (k === 4) return clone(src)
    if (k === 5) return clone([3.5e-323, 'x', true])
    return Array.from(src.subarray(1, 3), v => [v, typeof v])
  }`
  const want = oracle(src)
  for (const optimize of [0, 2, 3, 'size']) {
    const got = jz(src, { optimize }).exports
    for (const k of [0, 1, 2, 3, 4, 5, 0]) is(got.copy(k), want.copy(k), `O${optimize}, copy ${k}`)
  }
})

test('ToPrimitive: equality specializations preserve every primitive conversion domain', () => {
  const values = ['null', 'undefined', 'false', 'true', '0', '-0', '1', '7',
    '3.5e-323', 'NaN', '7n', '0n', "''", "'0'", "'7'", "'true'",
    '[]', '[7]', '({ valueOf() { return 7 } })',
    '({ valueOf() { return 7n } })', "({ valueOf() { return '7' } })"]
  const src = values.slice(0, 16).map((literal, n) => `export function f${n}(k) {
    const v = [${values.join(',')}]
    return [${literal} == v[k], v[k] == ${literal},
      ${literal} === v[k], v[k] === ${literal}, ${literal} != v[k], v[k] !== ${literal}]
  }`).join('\n')
  const want = oracle(src)
  for (const optimize of [0, 2, 3, 'size']) {
    const got = jz(src, { optimize }).exports
    for (let n = 0; n < 16; n++) for (let k = 0; k <= values.length; k++)
      is(got['f' + n](k), want['f' + n](k), `O${optimize}, ${values[n]} vs ${values[k]}`)
  }
  // Without any BigInt syntax, the old SSO shortcut also skipped object coercion.
  check(`export function f(k) {
    const values = [7, '7', { valueOf() { return 7 } }]
    return values[k] == '7'
  }`, [0, 1, 2, 3, 0])
})


test('size tier: shared coercion and length preserve values, forwarding and effects', () => {
  check(`
    let reads=0
    function read(x) { return [x.length, +x.length, reads] }
    function number(x) { return [+x, x*2, x-1] }
    export function f(k) {
      reads=0
      const a=[], alias=a
      for(let i=0;i<40;i++) a.push(i)
      const xs=[alias,'abc',new Uint8Array(5),{get length(){reads++;return '7'}},
        new Map(),null,undefined,3,new DataView(new ArrayBuffer(8))]
      let length
      try { length=read(xs[k]) } catch(e) { length=e.name }
      const ns=['7',true,null,undefined,NaN,-0,{valueOf(){reads++;return 4}},Infinity,-Infinity]
      return [length,number(ns[k]),reads]
    }
  `, [0,0,1,2,3,4,5,6,7,8,0])
})


test('ToNumber: numeric parameter uses do not move conversions before execution', () => {
  check(`
    let trace=''
    function sum(x,n){let s=0;for(let i=0;i<n;i++)s+=+x;return s}
    export function f(k){
      trace=''
      let count=0
      const x={valueOf(){trace+='v';if(++count===2)throw 7;return 2}}
      try { return [sum(k===3?1n:x,k===0||k===3?0:k),trace] }
      catch(e){ return [e===7?'seven':e.name,trace] }
    }
  `, [0,0,1,2,3,0,2])
})

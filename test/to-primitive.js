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

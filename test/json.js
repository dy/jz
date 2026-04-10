// JSON.stringify and JSON.parse tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'

// === JSON.stringify ===

test('JSON.stringify: number', () => {
  is(run(`export let f = () => JSON.stringify(42).length`).f(), 2)
})

test('JSON.stringify: string', () => {
  is(run(`export let f = () => JSON.stringify("hi").length`).f(), 4)
})

test('JSON.stringify: array', () => {
  is(run(`export let f = () => JSON.stringify([1,2,3]).length`).f(), 7)
})

test('JSON.stringify: NaN → null', () => {
  is(run(`export let f = () => JSON.stringify(0/0).length`).f(), 4)
})

test('JSON.stringify: Infinity → null', () => {
  is(run(`export let f = () => JSON.stringify(1/0).length`).f(), 4)
})

test('JSON.stringify: nested', () => {
  is(run(`export let f = () => JSON.stringify([[1],[2]]).length`).f(), 9)
})

test('JSON.stringify: empty array', () => {
  is(run(`export let f = () => JSON.stringify([]).length`).f(), 2)
})

// === JSON.parse ===

test('JSON.parse: number', () => {
  is(run(`export let f = () => JSON.parse("42")`).f(), 42)
})

test('JSON.parse: negative float', () => {
  is(run(`export let f = () => JSON.parse("-3.14")`).f(), -3.14)
})

test('JSON.parse: true', () => {
  is(run(`export let f = () => JSON.parse("true")`).f(), 1)
})

test('JSON.parse: array length', () => {
  is(run(`export let f = () => JSON.parse("[1,2,3]").length`).f(), 3)
})

test('JSON.parse: array element', () => {
  is(run(`export let f = () => JSON.parse("[10,20,30]")[1]`).f(), 20)
})

test('JSON.parse: string length', () => {
  is(run('export let f = () => JSON.parse(\'\"hello\"\').length').f(), 5)
})

test('JSON.parse: nested array', () => {
  is(run(`export let f = () => JSON.parse("[[1,2],[3]]")[0][1]`).f(), 2)
})

test('JSON.parse: roundtrip', () => {
  is(run(`export let f = () => JSON.stringify(JSON.parse("[1,2,3]")).length`).f(), 7)
})

// === JSON.parse objects (HASH type) ===

test('JSON.parse: object dot access', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":42}'); return o.x }`).f(), 42)
})

test('JSON.parse: object multiple keys', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"a":10,"b":20}'); return o.a + o.b }`).f(), 30)
})

test('JSON.parse: nested object', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"a":{"b":99}}'); return o.a.b }`).f(), 99)
})

test('JSON.parse: array of objects', () => {
  is(run(`export let f = () => { let a = JSON.parse('[{"x":1},{"x":2}]'); return a[0].x + a[1].x }`).f(), 3)
})

test('JSON.parse: many keys (grow)', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}')
    return o.a + o.i
  }`).f(), 10)
})

test('JSON.parse: missing key returns nullish', () => {
  const v = run(`export let f = () => { let o = JSON.parse('{"x":1}'); return o.z }`).f()
  ok(Number.isNaN(v))
})

test('JSON.parse: string value access', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"name":"jz"}'); return o.name.length }`).f(), 2)
})

test('JSON.parse: write property', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":1}'); o.x = 99; return o.x }`).f(), 99)
})

test('JSON.parse: add new property', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":1}'); o.y = 2; return o.x + o.y }`).f(), 3)
})

import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate, compile } from './util.js'

test('JSON.stringify: numbers', async () => {
  is(await evaluate('JSON.stringify(42)'), '42')
  is(await evaluate('JSON.stringify(3.14)'), '3.14')
  is(await evaluate('JSON.stringify(-5)'), '-5')
  is(await evaluate('JSON.stringify(0)'), '0')
})

test('JSON.stringify: special numbers', async () => {
  is(await evaluate('JSON.stringify(NaN)'), 'NaN')
  is(await evaluate('JSON.stringify(Infinity)'), 'Infinity')
  is(await evaluate('JSON.stringify(-Infinity)'), '-Infinity')
})

test('JSON.stringify: arrays', async () => {
  is(await evaluate('JSON.stringify([1, 2, 3])'), '[1,2,3]')
  is(await evaluate('JSON.stringify([])'), '[]')
  is(await evaluate('JSON.stringify([42])'), '[42]')
})

test('JSON.stringify: strings', async () => {
  is(await evaluate('JSON.stringify("hello")'), '"hello"')
  is(await evaluate('JSON.stringify("")'), '""')
})

test('JSON.stringify: string escaping', async () => {
  // These test escape characters
  is(await evaluate('JSON.stringify("a\\nb")'), '"a\\nb"')
  is(await evaluate('JSON.stringify("a\\tb")'), '"a\\tb"')
  is(await evaluate('JSON.stringify("a\\"b")'), '"a\\"b"')
})

test('JSON.stringify: objects', async () => {
  // Object with known schema
  const instance = await compile(`
    export function test() {
      let obj = { x: 1, y: 2 }
      return JSON.stringify(obj)
    }
  `)
  is(instance.test(), '{"x":1,"y":2}')
})

// JSON.parse tests

test('JSON.parse: numbers', async () => {
  is(await evaluate(`let j = '42'; JSON.parse(j)`), 42)
  is(await evaluate(`let j = '3.14'; JSON.parse(j)`), 3.14)
  is(await evaluate(`let j = '-5'; JSON.parse(j)`), -5)
  is(await evaluate(`let j = '0'; JSON.parse(j)`), 0)
  is(await evaluate(`let j = '1e3'; JSON.parse(j)`), 1000)
  is(await evaluate(`let j = '1E-2'; JSON.parse(j)`), 0.01)
})

test('JSON.parse: booleans and null', async () => {
  is(await evaluate(`let j = 'true'; JSON.parse(j)`), 1)
  is(await evaluate(`let j = 'false'; JSON.parse(j)`), 0)
  is(await evaluate(`let j = 'null'; JSON.parse(j)`), 0)
})

test('JSON.parse: arrays', async () => {
  const r1 = await evaluate(`let j = '[1,2,3]'; JSON.parse(j)`)
  is(r1[0], 1)
  is(r1[1], 2)
  is(r1[2], 3)

  const r2 = await evaluate(`let j = '[]'; JSON.parse(j)`)
  is(r2.length, 0)
})

test('JSON.parse: strings', async () => {
  is(await evaluate(`let j = '"hello"'; JSON.parse(j)`), 'hello')
  is(await evaluate(`let j = '""'; JSON.parse(j)`), '')
})

test('JSON.parse: objects', async () => {
  const r1 = await evaluate(`let j = '{"x":1}'; JSON.parse(j)`)
  is(r1.x, 1)

  const r2 = await evaluate(`let j = '{"x":1,"y":2}'; JSON.parse(j)`)
  is(r2.x, 1)
  is(r2.y, 2)

  const r3 = await evaluate(`let j = '{}'; JSON.parse(j)`)
  is(Object.keys(r3).length, 0)
})

test('JSON.parse: nested structures', async () => {
  // Nested arrays
  const r1 = await evaluate(`let j = '[[1,2],[3,4]]'; JSON.parse(j)`)
  is(r1[0][0], 1)
  is(r1[1][1], 4)

  // Nested object
  const r2 = await evaluate(`let j = '{"a":{"b":1}}'; JSON.parse(j)`)
  is(r2.a.b, 1)

  // Array of objects
  const r3 = await evaluate(`let j = '[{"x":1},{"y":2}]'; JSON.parse(j)`)
  is(r3[0].x, 1)
  is(r3[1].y, 2)

  // Object with array
  const r4 = await evaluate(`let j = '{"arr":[1,2,3]}'; JSON.parse(j)`)
  is(r4.arr[0], 1)
  is(r4.arr[2], 3)
})

test('JSON.parse: string values in objects', async () => {
  const r = await evaluate(`let j = '{"name":"hello"}'; JSON.parse(j)`)
  is(r.name, 'hello')
})

test('JSON.parse: whitespace handling', async () => {
  is(await evaluate(`let j = ' 42 '; JSON.parse(j)`), 42)
  const r = await evaluate(`let j = ' { "x" : 1 } '; JSON.parse(j)`)
  is(r.x, 1)
})

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

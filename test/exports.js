import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile, instantiate } from '../index.js'
import { gc } from './util.js'

// Export model tests

test('export const - function', async () => {
  const wasm = compile('export const add = (a, b) => a + b', { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.add(1, 2), 3)
  is(instance.exports.add(5, 7), 12)
})

test('export const - variable', async () => {
  const wasm = compile('export const x = 42', { gc })
  const instance = await instantiate(wasm)
  // Globals should be exported
  ok('x' in instance.exports || instance.exports.main() === 42)
})

test('export function', async () => {
  const wasm = compile('export function mul(a, b) { return a * b }', { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.mul(3, 4), 12)
  is(instance.exports.mul(6, 7), 42)
})

test('export { name } - function', async () => {
  const wasm = compile(`
    const sub = (a, b) => a - b
    export { sub }
  `, { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.sub(10, 3), 7)
})

test('export { name1, name2 }', async () => {
  const wasm = compile(`
    const add = (a, b) => a + b
    const mul = (a, b) => a * b
    export { add, mul }
  `, { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.add(2, 3), 5)
  is(instance.exports.mul(2, 3), 6)
})

test('non-exported function not in exports', async () => {
  const wasm = compile(`
    const internal = x => x * 2
    export const double = x => internal(x)
  `, { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.double(5), 10)
  ok(!('internal' in instance.exports), 'internal should not be exported')
})

test('multiple exports with internal helper', async () => {
  const wasm = compile(`
    const helper = x => x + 1
    export const inc = x => helper(x)
    export const inc2 = x => helper(helper(x))
  `, { gc })
  const instance = await instantiate(wasm)
  is(instance.exports.inc(5), 6)
  is(instance.exports.inc2(5), 7)
  ok(!('helper' in instance.exports))
})

import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile as jzCompile, instantiate } from '../index.js'
import { compile as watrCompile } from 'watr'

// Helper: compile JS to WASM binary
const compile = code => watrCompile(jzCompile(code))

// Export model tests
// Note: JZ's instantiate() returns exports at top level, not instance.exports

test('export const - function', async () => {
  const wasm = compile('export const add = (a, b) => a + b')
  const instance = await instantiate(wasm)
  is(instance.add(1, 2), 3)
  is(instance.add(5, 7), 12)
})

test('export const - variable', async () => {
  const wasm = compile('export const x = 42')
  const instance = await instantiate(wasm)
  // Globals should be exported
  ok('x' in instance || instance.main() === 42)
})

test('export function', async () => {
  const wasm = compile('export function mul(a, b) { return a * b }')
  const instance = await instantiate(wasm)
  is(instance.mul(3, 4), 12)
  is(instance.mul(6, 7), 42)
})

test('export { name } - function', async () => {
  const wasm = compile(`
    const sub = (a, b) => a - b
    export { sub }
  `)
  const instance = await instantiate(wasm)
  is(instance.sub(10, 3), 7)
})

test('export { name1, name2 }', async () => {
  const wasm = compile(`
    const add = (a, b) => a + b
    const mul = (a, b) => a * b
    export { add, mul }
  `)
  const instance = await instantiate(wasm)
  is(instance.add(2, 3), 5)
  is(instance.mul(2, 3), 6)
})

test('non-exported function not in exports', async () => {
  const wasm = compile(`
    const internal = x => x * 2
    export const double = x => internal(x)
  `)
  const instance = await instantiate(wasm)
  is(instance.double(5), 10)
  ok(!('internal' in instance), 'internal should not be exported')
})

test('multiple exports with internal helper', async () => {
  const wasm = compile(`
    const helper = x => x + 1
    export const inc = x => helper(x)
    export const inc2 = x => helper(helper(x))
  `)
  const instance = await instantiate(wasm)
  is(instance.inc(5), 6)
  is(instance.inc2(5), 7)
  ok(!('helper' in instance))
})

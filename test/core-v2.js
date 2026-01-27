// New core tests for jz v2
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import { compile } from '../index.js'

// Helper: compile and run
function run(code = {}, opts = {}) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  return inst.exports
}

// Test basic arithmetic
test('arithmetic: add', async () => {
  is(run('export let f = (a, b) => a + b').f(1, 2), 3)
  is(run('export let f = (a, b) => a + b').f(-1, 3), 2)
})

test('arithmetic: sub', async () => {
  is(run('export let f = (a, b) => a - b').f(5, 2), 3)
})

test('arithmetic: mul', async () => {
  is(run('export let f = (a, b) => a * b').f(3, 4), 12)
  is(run('export let f = x => x * 2').f(21), 42)
})

test('arithmetic: div', async () => {
  is(run('export let f = (a, b) => a / b').f(10, 2), 5)
})

test('unary: negation', async () => {
  is(run('export let f = x => -x').f(42), -42)
  is(run('export let f = x => -x').f(-5), 5)
})

test('multiple exports', async () => {
  const code = `
    export let add = (a, b) => a + b
    export let mul = (a, b) => a * b
  `
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  is(inst.exports.add(2, 3), 5)
  is(inst.exports.mul(2, 3), 6)
})

test('compound expressions', async () => {
  is(run('export let f = (a, b) => a * b + 1').f(6, 7), 43)
  is(run('export let f = (a, b) => a + b * 2').f(1, 3), 7) // 1 + 6 = 7
})

test('precedence', async () => {
  // Standard JS precedence: * binds tighter than +
  is(run('export let f = x => 1 + x * 2').f(3), 7)   // 1 + 6
  is(run('export let f = x => x * 2 + 1').f(3), 7)   // 6 + 1
})

test('math module: wasm ops', async () => {
  const opts = { modules: ['math'] }
  is(run('export let f = x => sqrt(x)', opts).f(16), 4)
  is(run('export let f = x => abs(x)', opts).f(-5), 5)
  is(run('export let f = x => floor(x)', opts).f(3.7), 3)
  is(run('export let f = x => ceil(x)', opts).f(3.2), 4)
  is(run('export let f = x => round(x)', opts).f(3.5), 4)
})

test('math module: constants', async () => {
  const opts = { modules: ['math'] }
  almost(run('export let f = () => PI', opts).f(), Math.PI)
  almost(run('export let f = () => E', opts).f(), Math.E)
})

test('math module: sin/cos (taylor)', async () => {
  const opts = { modules: ['math'] }
  const sin0 = run('export let f = () => sin(0)', opts).f()
  ok(Math.abs(sin0) < 1e-6)
  // Taylor series less accurate at PI/2
  const sinPi2 = run('export let f = () => sin(PI / 2)', opts).f()
  ok(Math.abs(sinPi2 - 1) < 0.01) // ~1% tolerance
})

test('wat output', () => {
  const wat = compile('export let f = x => x * 2', { wat: true })
  ok(typeof wat === 'string')
  ok(wat.includes('module'))
  ok(wat.includes('func'))
  ok(wat.includes('f64.mul'))
})

console.log('\n✓ All tests complete')

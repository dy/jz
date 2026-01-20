import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// let declaration
test('let - basic', async () => {
  is(await evaluate('let x = 5; x'), 5)
  is(await evaluate('let x = 1; let y = 2; x + y'), 3)
})

test('let - mutation', async () => {
  is(await evaluate('let x = 1; x = 5; x'), 5)
  is(await evaluate('let x = 1; x += 2; x'), 3)
})

// const declaration
test('const - basic', async () => {
  is(await evaluate('const x = 10; x'), 10)
  is(await evaluate('const x = 1; const y = 2; x + y'), 3)
})

test('const - reassign throws', async () => {
  // Error is thrown synchronously during compile, before await
  let error = null
  try {
    await evaluate('const x = 1; x = 2')
  } catch (e) {
    error = e
  }
  ok(error, 'should throw')
  ok(/constant/.test(error.message), 'should mention constant')
})

// var declaration
test('var - basic', async () => {
  is(await evaluate('var x = 5; x'), 5)
  is(await evaluate('var x = 1; x = 10; x'), 10)
})

// Block scoping
test('block scope - inner shadows outer', async () => {
  is(await evaluate('let x = 1; { let x = 2; x }'), 2)
  is(await evaluate('const a = 1; { const a = 99; a }'), 99)
})

test('block scope - outer preserved', async () => {
  is(await evaluate('let x = 1; { let y = 2 }; x'), 1)
})

test('block scope - nested', async () => {
  is(await evaluate('let x = 1; { let x = 2; { let x = 3; x } }'), 3)
})

test('block scope - modify outer from inner', async () => {
  is(await evaluate('let x = 1; { x = 5 }; x'), 5)
})

test('var - function scoped (no block shadow)', async () => {
  is(await evaluate('var x = 1; { x = 5 }; x'), 5)
})

// Mixed declarations
test('mixed - let and const', async () => {
  is(await evaluate('let x = 1; const y = 2; x + y'), 3)
})

test('mixed - var and let', async () => {
  is(await evaluate('var x = 1; let y = 2; x + y'), 3)
})

// In loops (using += instead of ++ since ++ not supported)
test('let in for loop', async () => {
  is(await evaluate('let sum = 0; for (let i = 0; i < 3; i += 1) { sum += i }; sum'), 3)
})

test('const in block', async () => {
  is(await evaluate('let sum = 0; for (let i = 0; i < 2; i += 1) { const x = 10; sum += x }; sum'), 20)
})

// Closure captures
test('closure - capture number', async () => {
  is(await evaluate('x = 5; f = () => x; f()'), 5)
  is(await evaluate('x = 1; y = 2; f = () => x + y; f()'), 3)
})

test('closure - capture array', async () => {
  is(await evaluate('arr = [1, 2, 3]; sum = () => arr[0] + arr[1] + arr[2]; sum()'), 6)
  is(await evaluate('arr = [10, 20]; f = () => arr[0]; f()'), 10)
})

test('closure - capture multiple arrays', async () => {
  is(await evaluate('a = [1, 2]; b = [10, 20]; sum = () => a[0] + b[1]; sum()'), 21)
})

test('closure - mutate captured array', async () => {
  is(await evaluate('arr = [1, 2, 3]; modify = () => (arr[0] = 100, arr[0]); modify()'), 100)
})

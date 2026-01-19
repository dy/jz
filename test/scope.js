import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate, isGcTrue, isGcFalse } from './util.js'

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

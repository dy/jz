import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate } from './util.js'

// typeof returns string type names (optimized comparison)
test('typeof - number', async () => {
  is(await evaluate('typeof 5 === "number"'), 1)
  is(await evaluate('typeof 3.14 === "number"'), 1)
  is(await evaluate('typeof NaN === "number"'), 1)
  is(await evaluate('typeof Infinity === "number"'), 1)
})

test('typeof - boolean', async () => {
  is(await evaluate('typeof true === "boolean"'), 1)
  is(await evaluate('typeof false === "boolean"'), 1)
  is(await evaluate('typeof (1 < 2) === "boolean"'), 1)
})

test('typeof - string', async () => {
  is(await evaluate('typeof "hello" === "string"'), 1)
  is(await evaluate('typeof "" === "string"'), 1)
})

test('typeof - undefined/null', async () => {
  is(await evaluate('typeof undefined === "undefined"'), 1)
  is(await evaluate('typeof null === "object"'), 1)  // JS quirk preserved for compatibility
})

test('typeof - object', async () => {
  is(await evaluate('typeof {x: 1} === "object"'), 1)
  is(await evaluate('typeof [1, 2] === "object"'), 1)
})

test('typeof - inequality', async () => {
  is(await evaluate('typeof 5 !== "string"'), 1)
  is(await evaluate('typeof "x" !== "number"'), 1)
  is(await evaluate('typeof true !== "object"'), 1)
})

// === strict equality (same as == for primitives, ref equality for objects)
test('=== primitives', async () => {
  is(await evaluate('5 === 5'), 1)
  is(await evaluate('5 === 5.0'), 1)
  is(await evaluate('5 === 6'), 0)
  is(await evaluate('true === true'), 1)
  is(await evaluate('true === false'), 0)
})

test('=== strings', async () => {
  is(await evaluate('"abc" === "abc"'), 1)
  is(await evaluate('"abc" === "def"'), 0)
})

test('=== arrays - reference equality', async () => {
  is(await evaluate('[1, 2] === [1, 2]'), 0)  // different refs
  is(await evaluate('a = [1]; a === a'), 1)   // same ref
  is(await evaluate('a = [1]; b = a; a === b'), 1)  // same ref via assignment
})

test('=== objects - reference equality', async () => {
  is(await evaluate('{x: 1} === {x: 1}'), 0)  // different refs
  is(await evaluate('o = {x: 1}; o === o'), 1)  // same ref
  is(await evaluate('o = {x: 1}; p = o; o === p'), 1)  // same ref via assignment
})

// !== strict inequality
test('!== primitives', async () => {
  is(await evaluate('5 !== 6'), 1)
  is(await evaluate('5 !== 5'), 0)
  is(await evaluate('true !== false'), 1)
})

test('!== arrays - reference inequality', async () => {
  is(await evaluate('[1] !== [1]'), 1)  // different refs
  is(await evaluate('a = [1]; a !== a'), 0)  // same ref
})

test('!== objects - reference inequality', async () => {
  is(await evaluate('{x: 1} !== {x: 1}'), 1)  // different refs
  is(await evaluate('o = {x: 1}; o !== o'), 0)  // same ref
})

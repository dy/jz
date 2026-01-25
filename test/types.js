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

// Number namespace
test('Number.isNaN', async () => {
  is(await evaluate('Number.isNaN(NaN)'), 1)
  is(await evaluate('Number.isNaN(5)'), 0)
  is(await evaluate('Number.isNaN(Infinity)'), 0)
  // Note: strings coerce to NaN in our system, so isNaN("NaN") returns 1
  is(await evaluate('Number.isNaN("NaN")'), 1)
})

test('Number.isFinite', async () => {
  is(await evaluate('Number.isFinite(5)'), 1)
  is(await evaluate('Number.isFinite(3.14)'), 1)
  is(await evaluate('Number.isFinite(Infinity)'), 0)
  is(await evaluate('Number.isFinite(-Infinity)'), 0)
  is(await evaluate('Number.isFinite(NaN)'), 0)
})

test('Number.isInteger', async () => {
  is(await evaluate('Number.isInteger(5)'), 1)
  is(await evaluate('Number.isInteger(5.0)'), 1)
  is(await evaluate('Number.isInteger(5.5)'), 0)
  is(await evaluate('Number.isInteger(Infinity)'), 0)
  is(await evaluate('Number.isInteger(NaN)'), 0)
})

test('Number constants', async () => {
  is(await evaluate('Number.MAX_VALUE'), 1.7976931348623157e+308)
  is(await evaluate('Number.MIN_VALUE'), 5e-324)
  is(await evaluate('Number.EPSILON'), 2.220446049250313e-16)
  is(await evaluate('Number.MAX_SAFE_INTEGER'), 9007199254740991)
  is(await evaluate('Number.MIN_SAFE_INTEGER'), -9007199254740991)
  is(await evaluate('Number.POSITIVE_INFINITY'), Infinity)
  is(await evaluate('Number.NEGATIVE_INFINITY'), -Infinity)
  // Note: Number.NaN conflicts with global NaN keyword, just use NaN directly
})

// Array namespace
test('Array.isArray', async () => {
  is(await evaluate('Array.isArray([1, 2, 3])'), 1)
  is(await evaluate('Array.isArray([])'), 1)
  is(await evaluate('Array.isArray(5)'), 0)
  is(await evaluate('Array.isArray("hello")'), 0)
  is(await evaluate('Array.isArray({x: 1})'), 0)
  is(await evaluate('a = [1]; Array.isArray(a)'), 1)
})
test('Array.from', async () => {
  // Basic array copy
  is(await evaluate('let a = [1, 2, 3]; let b = Array.from(a); b[0]'), 1)
  is(await evaluate('let a = [1, 2, 3]; let b = Array.from(a); b[1]'), 2)
  is(await evaluate('let a = [1, 2, 3]; let b = Array.from(a); b.length'), 3)
  // Verify it's a copy, not the same reference
  is(await evaluate('let a = [1, 2, 3]; let b = Array.from(a); a === b'), 0)
  // Mutation doesn't affect original
  is(await evaluate('let a = [1, 2, 3]; let b = Array.from(a); b[0] = 99; a[0]'), 1)
  // Empty array
  is(await evaluate('Array.from([]).length'), 0)
})

// Object namespace
test('Object.keys', async () => {
  is(await evaluate('let o = {a: 1, b: 2}; Object.keys(o).length'), 2)
  is(await evaluate('let o = {a: 1, b: 2}; Object.keys(o)[0]'), 'a')
  is(await evaluate('let o = {a: 1, b: 2}; Object.keys(o)[1]'), 'b')
  is(await evaluate('let o = {x: 5}; Object.keys(o).length'), 1)
  is(await evaluate('let o = {x: 5}; Object.keys(o)[0]'), 'x')
})

test('Object.values', async () => {
  is(await evaluate('let o = {a: 1, b: 2}; Object.values(o).length'), 2)
  is(await evaluate('let o = {a: 1, b: 2}; Object.values(o)[0]'), 1)
  is(await evaluate('let o = {a: 1, b: 2}; Object.values(o)[1]'), 2)
  is(await evaluate('let o = {x: 42}; Object.values(o)[0]'), 42)
})

test('Object.entries', async () => {
  is(await evaluate('let o = {a: 1, b: 2}; Object.entries(o).length'), 2)
  // First entry is ['a', 1]
  is(await evaluate('let o = {a: 1, b: 2}; Object.entries(o)[0][0]'), 'a')
  is(await evaluate('let o = {a: 1, b: 2}; Object.entries(o)[0][1]'), 1)
  // Second entry is ['b', 2]
  is(await evaluate('let o = {a: 1, b: 2}; Object.entries(o)[1][0]'), 'b')
  is(await evaluate('let o = {a: 1, b: 2}; Object.entries(o)[1][1]'), 2)
})

// Symbol (ATOM type) tests
test('Symbol - uniqueness', async () => {
  // Each Symbol call creates a unique symbol
  is(await evaluate('const a = Symbol, b = Symbol; a !== b'), 1)
  is(await evaluate('const a = Symbol(), b = Symbol(); a !== b'), 1)
  is(await evaluate('Symbol !== Symbol'), 1)
  is(await evaluate('Symbol() !== Symbol()'), 1)
})

test('Symbol - identity', async () => {
  // Same symbol equals itself
  is(await evaluate('const s = Symbol; s === s'), 1)
  is(await evaluate('const a = Symbol, b = a; a === b'), 1)
})

test('Symbol - typeof', async () => {
  is(await evaluate('typeof Symbol'), 'symbol')
  is(await evaluate('typeof Symbol()'), 'symbol')
  is(await evaluate('typeof Symbol === "symbol"'), 1)
})

test('Symbol - from function', async () => {
  is(await evaluate('const f = () => Symbol; typeof f()'), 'symbol')
  // Each call returns different symbol
  is(await evaluate('const f = () => Symbol; f() !== f()'), 1)
})

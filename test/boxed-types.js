import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// Boxed String tests - Object.assign("string", {props})

test('boxed string - basic property access', async () => {
  is(await evaluate('Object.assign("hello", {type: 1}).type'), 1)
  is(await evaluate('Object.assign("abc", {x: 10, y: 20}).x'), 10)
  is(await evaluate('Object.assign("abc", {x: 10, y: 20}).y'), 20)
})

test('boxed string - length delegated to inner string', async () => {
  is(await evaluate('Object.assign("hello", {type: 1}).length'), 5)
  is(await evaluate('Object.assign("ab", {x: 0}).length'), 2)
  is(await evaluate('Object.assign("", {empty: true}).length'), 0)
})

test('boxed string - indexing delegated to inner string', async () => {
  is(await evaluate('Object.assign("hello", {type: 1})[0]'), 104) // 'h'
  is(await evaluate('Object.assign("hello", {type: 1})[1]'), 101) // 'e'
  is(await evaluate('Object.assign("ABC", {upper: true})[0]'), 65) // 'A'
})

test('boxed string - store in variable', async () => {
  is(await evaluate('(s = Object.assign("test", {v: 42}), s.v)'), 42)
  is(await evaluate('(s = Object.assign("test", {v: 42}), s.length)'), 4)
  is(await evaluate('(s = Object.assign("test", {v: 42}), s[0])'), 116) // 't'
})

test('boxed string - multiple properties', async () => {
  is(await evaluate('(s = Object.assign("rgb", {r: 255, g: 128, b: 64}), s.r + s.g + s.b)'), 447)
})

// Array with Props tests - Object.assign([array], {props})

test('array props - basic property access', async () => {
  is(await evaluate('Object.assign([1, 2, 3], {loc: 5}).loc'), 5)
  is(await evaluate('Object.assign([10, 20], {x: 100, y: 200}).x'), 100)
  is(await evaluate('Object.assign([10, 20], {x: 100, y: 200}).y'), 200)
})

test('array props - element access unaffected', async () => {
  is(await evaluate('Object.assign([1, 2, 3], {loc: 5})[0]'), 1)
  is(await evaluate('Object.assign([1, 2, 3], {loc: 5})[1]'), 2)
  is(await evaluate('Object.assign([1, 2, 3], {loc: 5})[2]'), 3)
})

test('array props - length preserved', async () => {
  is(await evaluate('Object.assign([1, 2, 3], {loc: 5}).length'), 3)
  is(await evaluate('Object.assign([10, 20], {x: 0}).length'), 2)
  is(await evaluate('Object.assign([1], {single: true}).length'), 1)
})

test('array props - store in variable', async () => {
  is(await evaluate('(a = Object.assign([1, 2, 3], {sum: 6}), a.sum)'), 6)
  is(await evaluate('(a = Object.assign([1, 2, 3], {sum: 6}), a[0] + a[1] + a[2])'), 6)
  is(await evaluate('(a = Object.assign([1, 2, 3], {sum: 6}), a.length)'), 3)
})

test('array props - multiple properties', async () => {
  is(await evaluate('(a = Object.assign([0.5, 0.5, 0.5], {space: 1, alpha: 1}), a.space + a.alpha)'), 2)
})

// Use case: Color space arrays (like color.js)

test('array props - color space pattern', async () => {
  // [r, g, b] with .space property
  const code = `
    (rgb = Object.assign([1, 0.5, 0], {space: 1}),
     rgb[0] + rgb[1] + rgb[2])
  `
  is(await evaluate(code), 1.5)
})

test('array props - typed array metadata', async () => {
  // Array with metadata about its type/encoding
  const code = `
    (data = Object.assign([1, 2, 3, 4], {stride: 2, offset: 0}),
     data.stride * data.offset + data[0])
  `
  is(await evaluate(code), 1)
})

// Reference equality

test('boxed string - reference equality', async () => {
  is(await evaluate('(s = Object.assign("hi", {v: 1}), s === s)'), 1)
  is(await evaluate('Object.assign("hi", {v: 1}) === Object.assign("hi", {v: 1})'), 0) // different refs
})

test('array props - reference equality', async () => {
  is(await evaluate('(a = Object.assign([1], {x: 1}), a === a)'), 1)
  is(await evaluate('Object.assign([1], {x: 1}) === Object.assign([1], {x: 1})'), 0) // different refs
})

// Boxed Number tests - Object.assign(number, {props})

test('boxed number - basic property access', async () => {
  is(await evaluate('Object.assign(42, {type: 1}).type'), 1)
  is(await evaluate('Object.assign(3.14, {x: 10, y: 20}).x'), 10)
  is(await evaluate('Object.assign(3.14, {x: 10, y: 20}).y'), 20)
})

test('boxed number - store in variable', async () => {
  is(await evaluate('(n = Object.assign(100, {scale: 2}), n.scale)'), 2)
})

test('boxed number - multiple properties', async () => {
  is(await evaluate('(n = Object.assign(255, {r: 1, g: 0.5, b: 0}), n.r + n.g + n.b)'), 1.5)
})

// Boxed Boolean tests - Object.assign(boolean, {props})

test('boxed boolean - basic property access', async () => {
  is(await evaluate('Object.assign(true, {flag: 1}).flag'), 1)
  is(await evaluate('Object.assign(false, {reason: 42}).reason'), 42)
})

test('boxed boolean - store in variable', async () => {
  is(await evaluate('(b = Object.assign(true, {code: 200}), b.code)'), 200)
})

test('boxed boolean - multiple properties', async () => {
  is(await evaluate('(b = Object.assign(false, {err: 1, msg: 2}), b.err + b.msg)'), 3)
})

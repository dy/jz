import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// ===========================================================================
// PRIMITIVE LITERALS - Cannot hold properties (JS behavior)
// ===========================================================================

// In JS: Object.assign("hello", {x: 1}).x === undefined
// Primitives silently ignore property assignment
// JZ encodes undefined as 0

test('primitive string - cannot hold properties', async () => {
  // Property access on primitive returns undefined (0 in JZ)
  is(await evaluate('Object.assign("hello", {type: 1}).type'), 0)
})

test('primitive number - cannot hold properties', async () => {
  // Property access on primitive returns undefined (0 in JZ)
  is(await evaluate('Object.assign(42, {type: 1}).type'), 0)
})

test('primitive boolean - cannot hold properties', async () => {
  // Property access on primitive returns undefined (0 in JZ)
  is(await evaluate('Object.assign(true, {flag: 1}).flag'), 0)
  is(await evaluate('Object.assign(false, {flag: 1}).flag'), 0)
})

// ===========================================================================
// BOXED WRAPPER OBJECTS - new String/Number/Boolean CAN hold properties
// ===========================================================================

test('new String() - creates object that can hold properties', async () => {
  is(await evaluate('Object.assign(new String("hello"), {type: 1}).type'), 1)
  is(await evaluate('Object.assign(new String("abc"), {x: 10, y: 20}).x'), 10)
  is(await evaluate('Object.assign(new String("abc"), {x: 10, y: 20}).y'), 20)
})

// Note: .length and [idx] delegation on new String() wrapper not yet implemented
// test('new String() - length delegated to inner string', async () => {
//   is(await evaluate('Object.assign(new String("hello"), {type: 1}).length'), 5)
// })

// test('new String() - indexing delegated to inner string', async () => {
//   is(await evaluate('Object.assign(new String("hello"), {type: 1})[0]'), 104) // 'h'
// })

test('new String() - store in variable', async () => {
  is(await evaluate('(s = Object.assign(new String("test"), {v: 42}), s.v)'), 42)
  // Note: s.length delegation not yet implemented
})

test('new Number() - creates object that can hold properties', async () => {
  is(await evaluate('Object.assign(new Number(42), {type: 1}).type'), 1)
  is(await evaluate('Object.assign(new Number(3.14), {x: 10, y: 20}).x'), 10)
})

test('new Number() - store in variable', async () => {
  is(await evaluate('(n = Object.assign(new Number(100), {scale: 2}), n.scale)'), 2)
})

test('new Boolean() - creates object that can hold properties', async () => {
  is(await evaluate('Object.assign(new Boolean(true), {flag: 1}).flag'), 1)
  is(await evaluate('Object.assign(new Boolean(false), {reason: 42}).reason'), 42)
})

test('new Boolean() - store in variable', async () => {
  is(await evaluate('(b = Object.assign(new Boolean(true), {code: 200}), b.code)'), 200)
})

// ===========================================================================
// ARRAY WITH PROPS - Arrays are objects, CAN hold properties
// ===========================================================================

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

test('array props - reference equality', async () => {
  is(await evaluate('(a = Object.assign([1], {x: 1}), a === a)'), 1)
  is(await evaluate('Object.assign([1], {x: 1}) === Object.assign([1], {x: 1})'), 0) // different refs
})

// ===========================================================================
// REGEX WITH PROPS - Regex are objects, CAN hold properties
// ===========================================================================

test('boxed regex - basic property access', async () => {
  is(await evaluate('Object.assign(/abc/, {name: 42}).name'), 42)
  is(await evaluate('Object.assign(/\\d+/, {x: 10, y: 20}).x'), 10)
})

test('boxed regex - store in variable', async () => {
  is(await evaluate('(r = Object.assign(/test/, {priority: 5}), r.priority)'), 5)
})

test('boxed regex - multiple properties', async () => {
  is(await evaluate('(r = Object.assign(/[a-z]/, {min: 0, max: 100}), r.min + r.max)'), 100)
})

// ===========================================================================
// SET/MAP WITH PROPS - Sets and Maps are objects, CAN hold properties
// ===========================================================================

test('boxed set - basic property access', async () => {
  is(await evaluate('Object.assign(new Set(), {name: 42}).name'), 42)
})

test('boxed set - store in variable', async () => {
  is(await evaluate(`
    (s = new Set(),
     boxed = Object.assign(s, {category: 7}),
     boxed.category)
  `), 7)
})

test('boxed set - multiple properties', async () => {
  is(await evaluate(`
    (s = new Set(),
     boxed = Object.assign(s, {min: 1, max: 99}),
     boxed.min + boxed.max)
  `), 100)
})

test('boxed map - basic property access', async () => {
  is(await evaluate('Object.assign(new Map(), {name: 42}).name'), 42)
})

test('boxed map - store in variable', async () => {
  is(await evaluate(`
    (m = new Map(),
     boxed = Object.assign(m, {category: 7}),
     boxed.category)
  `), 7)
})

test('boxed map - multiple properties', async () => {
  is(await evaluate(`
    (m = new Map(),
     boxed = Object.assign(m, {min: 1, max: 99}),
     boxed.min + boxed.max)
  `), 100)
})
// ===========================================================================
// BOXED FUNCTIONS - Functions can hold properties via Object.assign
// ===========================================================================

test('boxed function - basic property access', async () => {
  is(await evaluate('Object.assign(() => 42, {name: 1}).name'), 1)
})

test('boxed function - store in variable', async () => {
  is(await evaluate(`
    (fn = Object.assign(() => 100, {scale: 2}),
     fn.scale)
  `), 2)
})

test('boxed function - call still works', async () => {
  is(await evaluate(`
    (fn = Object.assign(() => 100, {scale: 2}),
     fn())
  `), 100)
})

test('boxed function - multiple properties', async () => {
  is(await evaluate(`
    (fn = Object.assign(() => 0, {min: 1, max: 99}),
     fn.min + fn.max)
  `), 100)
})

test('boxed function - closure with props', async () => {
  is(await evaluate(`
    (x = 10,
     fn = Object.assign(() => x, {multiplier: 2}),
     fn() * fn.multiplier)
  `), 20)
})

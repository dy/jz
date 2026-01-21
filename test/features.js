import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// Tests for new features: if/else, typeof, void, array methods, string methods

// if/else statements
test('if/else - basic if', async () => {
  is(await evaluate('if (1) 5'), 5)
  is(await evaluate('if (0) 5'), 0)  // no else returns 0
  is(await evaluate('if (true) 10'), 10)
  is(await evaluate('if (false) 10'), 0)
})

test('if/else - with else', async () => {
  is(await evaluate('if (1) 5 else 10'), 5)
  is(await evaluate('if (0) 5 else 10'), 10)
  is(await evaluate('if (true) 1 else 2'), 1)
  is(await evaluate('if (false) 1 else 2'), 2)
})

test('if/else - with blocks', async () => {
  is(await evaluate('if (1) { 5 }'), 5)
  is(await evaluate('if (0) { 5 } else { 10 }'), 10)
  is(await evaluate('if (2 > 1) { 100 } else { 200 }'), 100)
})

test('if/else - nested', async () => {
  is(await evaluate('if (1) { if (1) 5 else 6 } else 7'), 5)
  is(await evaluate('if (1) { if (0) 5 else 6 } else 7'), 6)
  is(await evaluate('if (0) { if (1) 5 else 6 } else 7'), 7)
})

test('if/else - with expressions', async () => {
  // Note: if statements inside comma expressions not supported - use blocks
  is(await evaluate('{ x = 5; if (x > 3) { x * 2 } else { x } }'), 10)
  is(await evaluate('{ x = 2; if (x > 3) { x * 2 } else { x } }'), 2)
})

// typeof operator - returns strings, compare with ===
test('typeof - number', async () => {
  is(await evaluate('typeof 5 === "number"'), 1)
  is(await evaluate('typeof 3.14 === "number"'), 1)
  is(await evaluate('typeof (1 + 2) === "number"'), 1)
})

test('typeof - boolean', async () => {
  is(await evaluate('typeof true === "boolean"'), 1)
  is(await evaluate('typeof false === "boolean"'), 1)
  is(await evaluate('typeof (1 < 2) === "boolean"'), 1)
})

test('typeof - string', async () => {
  is(await evaluate('typeof "hello" === "string"'), 1)
})

test('typeof - undefined/null', async () => {
  is(await evaluate('typeof undefined === "undefined"'), 1)
  is(await evaluate('typeof null === "object"'), 1)  // JS quirk preserved
})

test('typeof - object/array', async () => {
  is(await evaluate('typeof {x: 1} === "object"'), 1)
  is(await evaluate('typeof [1, 2, 3] === "object"'), 1)  // arrays are objects
})

// void operator
test('void - returns 0', async () => {
  is(await evaluate('void 0'), 0)
  is(await evaluate('void 5'), 0)
  is(await evaluate('void (1 + 2)'), 0)
})

// Array methods
test('array.indexOf - found', async () => {
  is(await evaluate('[1, 2, 3].indexOf(2)'), 1)
  is(await evaluate('[10, 20, 30, 40].indexOf(30)'), 2)
  is(await evaluate('[5, 5, 5].indexOf(5)'), 0)  // returns first
})

test('array.indexOf - not found', async () => {
  is(await evaluate('[1, 2, 3].indexOf(5)'), -1)
  is(await evaluate('[].indexOf(1)'), -1)
})

test('array.includes', async () => {
  is(await evaluate('[1, 2, 3].includes(2)'), 1)  // true = 1
  is(await evaluate('[1, 2, 3].includes(5)'), 0)  // false = 0
  is(await evaluate('[].includes(1)'), 0)
})

test('array.find', async () => {
  is(await evaluate('[1, 2, 3, 4].find(x => x > 2)'), 3)
  is(await evaluate('[10, 20, 30].find(x => x > 15)'), 20)
})

test('array.findIndex', async () => {
  is(await evaluate('[1, 2, 3, 4].findIndex(x => x > 2)'), 2)
  is(await evaluate('[10, 20, 30].findIndex(x => x > 15)'), 1)
  is(await evaluate('[1, 2, 3].findIndex(x => x > 10)'), -1)
})

test('array.filter', async () => {
  is(await evaluate('[1, 2, 3, 4, 5].filter(x => x > 3)[0]'), 4)
  is(await evaluate('[1, 2, 3, 4, 5].filter(x => x > 3)[1]'), 5)
  // Memory mode returns proper length
  is(await evaluate('[1, 2, 3, 4, 5].filter(x => x > 3).length'), 2)
})

test('array.every', async () => {
  is(await evaluate('[2, 4, 6].every(x => x > 0)'), 1)  // all positive
  is(await evaluate('[2, 4, 6].every(x => x > 3)'), 0)  // not all > 3
  is(await evaluate('[].every(x => x > 0)'), 1)  // empty array returns true
})

test('array.some', async () => {
  is(await evaluate('[1, 2, 3].some(x => x > 2)'), 1)
  is(await evaluate('[1, 2, 3].some(x => x > 5)'), 0)
  is(await evaluate('[].some(x => x > 0)'), 0)  // empty array returns false
})

test('array.slice - basic', async () => {
  is(await evaluate('[1, 2, 3, 4, 5].slice(1, 3)[0]'), 2)
  is(await evaluate('[1, 2, 3, 4, 5].slice(1, 3)[1]'), 3)
  is(await evaluate('[1, 2, 3, 4, 5].slice(1, 3).length'), 2)
})

test('array.slice - negative indices', async () => {
  is(await evaluate('[1, 2, 3, 4, 5].slice(-2)[0]'), 4)
  is(await evaluate('[1, 2, 3, 4, 5].slice(-2)[1]'), 5)
})

test('array.reverse', async () => {
  is(await evaluate('(a = [1, 2, 3], a.reverse(), a[0])'), 3)
  is(await evaluate('(a = [1, 2, 3], a.reverse(), a[2])'), 1)
})

// String methods
test('string.slice - basic', async () => {
  is(await evaluate('"hello".slice(1, 3).length'), 2)
  is(await evaluate('"hello".slice(1, 3).charCodeAt(0)'), 101)  // 'e'
  is(await evaluate('"hello".slice(1, 3).charCodeAt(1)'), 108)  // 'l'
})

test('string.indexOf - char code', async () => {
  is(await evaluate('"hello".indexOf(101)'), 1)  // 'e' at index 1
  is(await evaluate('"hello".indexOf(108)'), 2)  // 'l' at index 2
  is(await evaluate('"hello".indexOf(120)'), -1)  // 'x' not found
})

// shift - returns first element (non-mutating for now)
test('array.shift - basic', async () => {
  is(await evaluate('[1, 2, 3].shift()'), 1)
  is(await evaluate('[10, 20, 30].shift()'), 10)
  is(await evaluate('[5].shift()'), 5)
})

test('array.shift - empty returns NaN', async () => {
  ok(Number.isNaN(await evaluate('[].shift()')))
})

// unshift - prepends element, returns new array
test('array.unshift - basic', async () => {
  is(await evaluate('[2, 3].unshift(1)[0]'), 1)
  is(await evaluate('[2, 3].unshift(1)[1]'), 2)
  is(await evaluate('[2, 3].unshift(1).length'), 3)
})

test('array.unshift - empty array', async () => {
  is(await evaluate('[].unshift(5)[0]'), 5)
  is(await evaluate('[].unshift(5).length'), 1)
})

// flat - flattens nested arrays
test('array.flat - basic', async () => {
  is(await evaluate('[[1, 2], [3, 4]].flat()[0]'), 1)
  is(await evaluate('[[1, 2], [3, 4]].flat()[2]'), 3)
  is(await evaluate('[[1, 2], [3, 4]].flat().length'), 4)
})

test('array.flat - mixed scalar and array', async () => {
  is(await evaluate('[1, [2, 3], 4].flat()[0]'), 1)
  is(await evaluate('[1, [2, 3], 4].flat()[1]'), 2)
  is(await evaluate('[1, [2, 3], 4].flat()[3]'), 4)
  is(await evaluate('[1, [2, 3], 4].flat().length'), 4)
})

// flatMap - map then flatten
test('array.flatMap - basic', async () => {
  is(await evaluate('[1, 2].flatMap(x => [x, x * 2])[0]'), 1)
  is(await evaluate('[1, 2].flatMap(x => [x, x * 2])[1]'), 2)
  is(await evaluate('[1, 2].flatMap(x => [x, x * 2])[2]'), 2)
  is(await evaluate('[1, 2].flatMap(x => [x, x * 2]).length'), 4)
})

test('array.flatMap - scalar returns', async () => {
  is(await evaluate('[1, 2, 3].flatMap(x => x * 2)[0]'), 2)
  is(await evaluate('[1, 2, 3].flatMap(x => x * 2)[1]'), 4)
  is(await evaluate('[1, 2, 3].flatMap(x => x * 2).length'), 3)
})
// Template literals
test('template literal - simple', async () => {
  is(await evaluate('`hello`.length'), 5)
  is(await evaluate('`hello`[0]'), 104) // 'h'
})

test('template literal - with string interpolation', async () => {
  is(await evaluate('const s = `world`; `hello ${s}!`.length'), 12)
})

// Closure mutation (counter pattern)
test('closure mutation - counter', async () => {
  is(await evaluate(`
    const make = () => { let n = 0; return () => { n += 1; return n } };
    const counter = make();
    counter() + counter() * 10 + counter() * 100
  `), 321) // 1 + 20 + 300
})

test('closure mutation - multiple counters independent', async () => {
  is(await evaluate(`
    const make = () => { let n = 0; return () => { n += 1; return n } };
    const a = make();
    const b = make();
    a(); a(); b();
    a() + b() * 10
  `), 23) // a=3, b=2
})

// ++/-- operators
test('prefix increment', async () => {
  is(await evaluate('let x = 5; ++x'), 6)
  is(await evaluate('let x = 5; ++x; x'), 6)
})

test('postfix increment', async () => {
  is(await evaluate('let x = 5; x++'), 5)
  is(await evaluate('let x = 5; x++; x'), 6)
})

test('prefix decrement', async () => {
  is(await evaluate('let x = 5; --x'), 4)
})

test('postfix decrement', async () => {
  is(await evaluate('let x = 5; x--'), 5)
  is(await evaluate('let x = 5; x--; x'), 4)
})

// Object property assignment
test('object property assignment - basic', async () => {
  is(await evaluate('let obj = {x: 1}; obj.x = 5; obj.x'), 5)
  is(await evaluate('let obj = {a: 1, b: 2}; obj.a = 10; obj.b = 20; obj.a + obj.b'), 30)
})

test('object property assignment - returns value', async () => {
  is(await evaluate('let obj = {x: 0}; (obj.x = 42)'), 42)
})

// Object method calls
test('object method call - simple', async () => {
  is(await evaluate('let obj = { add: (a, b) => a + b }; obj.add(2, 3)'), 5)
  is(await evaluate('let obj = { mul: (x, y) => x * y }; obj.mul(4, 5)'), 20)
})

test('object method call - multiple methods', async () => {
  is(await evaluate(`
    let math = { add: (a, b) => a + b, mul: (a, b) => a * b };
    math.add(2, 3) + math.mul(4, 5)
  `), 25)
})

test('object method call - assign function to property', async () => {
  is(await evaluate('let obj = {fn: 0}; obj.fn = (x) => x * 2; obj.fn(5)'), 10)
})

test('object method call - color-space pattern', async () => {
  const result = await evaluate(`
    let rgb = {
      gray: (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
    };
    rgb.gray(100, 150, 200)
  `)
  is(Math.round(result * 100), 14298) // ~142.98
})

// Static namespace - compile-time function grouping (no memory overhead)
test('static namespace - direct calls', async () => {
  // Namespace methods become direct function calls (call $ns_method)
  is(await evaluate(`
    let math = { add: (a, b) => a + b, sub: (a, b) => a - b };
    math.add(10, 5) + math.sub(10, 5)
  `), 20) // 15 + 5
})

test('static namespace - used in exports', async () => {
  // Namespace can be used in exported functions without capture overhead
  const { compile } = await import('./util.js')
  const instance = await compile(`
    let rgb = { gray: (r, g, b) => (r + g + b) / 3 };
    export let toGray = (r, g, b) => rgb.gray(r, g, b)
  `)
  is(instance.toGray(30, 60, 90), 60)
})

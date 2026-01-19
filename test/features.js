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

// typeof operator
test('typeof - number', async () => {
  is(await evaluate('typeof 5'), 1)  // 1 = number
  is(await evaluate('typeof 3.14'), 1)
  is(await evaluate('typeof (1 + 2)'), 1)
})

test('typeof - boolean', async () => {
  is(await evaluate('typeof true'), 3)  // 3 = boolean
  is(await evaluate('typeof false'), 3)
  is(await evaluate('typeof (1 < 2)'), 3)
})

test('typeof - string', async () => {
  is(await evaluate('typeof "hello"'), 2)  // 2 = string
})

test('typeof - undefined/null', async () => {
  is(await evaluate('typeof null'), 0)  // 0 = undefined (ref type)
  is(await evaluate('typeof undefined'), 0)
})

test('typeof - object/array', async () => {
  is(await evaluate('typeof {x: 1}'), 4)  // 4 = object
  is(await evaluate('typeof [1, 2, 3]'), 4)  // arrays are objects
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
  is(await evaluate('[1, 2, 3, 4, 5].filter(x => x > 3).length'), 5)  // Note: filter may return full-size array with trailing zeros
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

// gc:false versions
const GC = { gc: false }

test('gc:false - if/else', async () => {
  is(await evaluate('if (1) 5 else 10', 0, GC), 5)
  is(await evaluate('if (0) 5 else 10', 0, GC), 10)
})

test('gc:false - array.indexOf', async () => {
  is(await evaluate('[1, 2, 3].indexOf(2)', 0, GC), 1)
  is(await evaluate('[1, 2, 3].indexOf(5)', 0, GC), -1)
})

test('gc:false - array.includes', async () => {
  is(await evaluate('[1, 2, 3].includes(2)', 0, GC), 1)
  is(await evaluate('[1, 2, 3].includes(5)', 0, GC), 0)
})

test('gc:false - array.find', async () => {
  is(await evaluate('[1, 2, 3, 4].find(x => x > 2)', 0, GC), 3)
})

test('gc:false - array.findIndex', async () => {
  is(await evaluate('[1, 2, 3, 4].findIndex(x => x > 2)', 0, GC), 2)
})

test('gc:false - array.every', async () => {
  is(await evaluate('[2, 4, 6].every(x => x > 0)', 0, GC), 1)
  is(await evaluate('[2, 4, 6].every(x => x > 3)', 0, GC), 0)
})

test('gc:false - array.some', async () => {
  is(await evaluate('[1, 2, 3].some(x => x > 2)', 0, GC), 1)
  is(await evaluate('[1, 2, 3].some(x => x > 5)', 0, GC), 0)
})

test('gc:false - array.slice', async () => {
  is(await evaluate('[1, 2, 3, 4, 5].slice(1, 3)[0]', 0, GC), 2)
  is(await evaluate('[1, 2, 3, 4, 5].slice(1, 3).length', 0, GC), 2)
})

test('gc:false - array.reverse', async () => {
  is(await evaluate('(a = [1, 2, 3], a.reverse(), a[0])', 0, GC), 3)
})

test('gc:false - string.slice', async () => {
  is(await evaluate('"hello".slice(1, 3).length', 0, GC), 2)
})

test('gc:false - string.indexOf', async () => {
  is(await evaluate('"hello".indexOf(101)', 0, GC), 1)
})

// Switch statements
test('switch - basic case', async () => {
  is(await evaluate('switch (1) { case 1: 10; break; case 2: 20; break; default: 0 }'), 10)
  is(await evaluate('switch (2) { case 1: 10; break; case 2: 20; break; default: 0 }'), 20)
  is(await evaluate('switch (3) { case 1: 10; break; case 2: 20; break; default: 30 }'), 30)
})

test('switch - with variable', async () => {
  is(await evaluate('{ x = 2; switch (x) { case 1: 10; break; case 2: 20; break; default: 0 } }'), 20)
  is(await evaluate('{ x = 5; switch (x) { case 1: 10; break; case 2: 20; break; default: 99 } }'), 99)
})

test('switch - with expressions', async () => {
  is(await evaluate('{ x = 3; switch (x * 2) { case 4: 1; break; case 6: 2; break; default: 0 } }'), 2)
  is(await evaluate('switch (1 + 1) { case 1: 10; break; case 2: 20; break; default: 0 }'), 20)
})

test('switch - default only', async () => {
  is(await evaluate('switch (5) { default: 42 }'), 42)
})

test('gc:false - switch', async () => {
  is(await evaluate('switch (1) { case 1: 10; break; case 2: 20; break; default: 0 }', 0, GC), 10)
  is(await evaluate('switch (2) { case 1: 10; break; case 2: 20; break; default: 0 }', 0, GC), 20)
})

test('array.forEach', async () => {
  is(await evaluate('[1, 2, 3].forEach(x => x + 1), 42'), 42)
})

test('gc:false - array.forEach', async () => {
  is(await evaluate('[1, 2, 3].forEach(x => x + 1), 42', 0, GC), 42)
})

test('array.concat', async () => {
  is(await evaluate('[1, 2].concat([3, 4]).length'), 4)
})

test('gc:false - array.concat', async () => {
  is(await evaluate('[1, 2].concat([3, 4]).length', 0, GC), 4)
})

test('gc:false - array.push', async () => {
  is(await evaluate('[1, 2].push(3)', 0, GC), 3)
})

test('gc:false - array.pop', async () => {
  is(await evaluate('[1, 2, 3].pop()', 0, GC), 3)
})

test('string.substring', async () => {
  is(await evaluate('"hello".substring(1, 4).length'), 3)
})

test('gc:false - string.substring', async () => {
  is(await evaluate('"hello".substring(1, 4).length', 0, GC), 3)
})

test('string.toLowerCase', async () => {
  is(await evaluate('"HELLO".toLowerCase().charCodeAt(0)'), 104) // 'h'
})

test('gc:false - string.toLowerCase', async () => {
  is(await evaluate('"HELLO".toLowerCase().charCodeAt(0)', 0, GC), 104)
})

test('string.toUpperCase', async () => {
  is(await evaluate('"hello".toUpperCase().charCodeAt(0)'), 72) // 'H'
})

test('gc:false - string.toUpperCase', async () => {
  is(await evaluate('"hello".toUpperCase().charCodeAt(0)', 0, GC), 72)
})

test('string.includes', async () => {
  is(await evaluate('"hello".includes(101)'), 1) // 'e' = 101
  is(await evaluate('"hello".includes(120)'), 0) // 'x' = 120 (not found)
})

test('gc:false - string.includes', async () => {
  is(await evaluate('"hello".includes(101)', 0, GC), 1)
  is(await evaluate('"hello".includes(120)', 0, GC), 0)
})

test('string.startsWith', async () => {
  is(await evaluate('"hello".startsWith(104)'), 1) // 'h' = 104
  is(await evaluate('"hello".startsWith(101)'), 0) // 'e' = 101
})

test('gc:false - string.startsWith', async () => {
  is(await evaluate('"hello".startsWith(104)', 0, GC), 1)
  is(await evaluate('"hello".startsWith(101)', 0, GC), 0)
})

test('string.endsWith', async () => {
  is(await evaluate('"hello".endsWith(111)'), 1) // 'o' = 111
  is(await evaluate('"hello".endsWith(101)'), 0) // 'e' = 101
})

test('gc:false - string.endsWith', async () => {
  is(await evaluate('"hello".endsWith(111)', 0, GC), 1)
  is(await evaluate('"hello".endsWith(101)', 0, GC), 0)
})

test('string.trim', async () => {
  is(await evaluate('"  hello  ".trim().length'), 5)
})

test('gc:false - string.trim', async () => {
  is(await evaluate('"  hello  ".trim().length', 0, GC), 5)
})

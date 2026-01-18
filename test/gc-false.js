import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// gc:false mode tests - all array/object operations should work with memory-based implementation

const GC = { gc: false }

test('gc:false - basic arithmetic (no arrays)', async () => {
  is(await evaluate('1 + 2', 0, GC), 3)
  is(await evaluate('3 * 4', 0, GC), 12)
  is(await evaluate('Math.sin(0)', 0, GC), 0)
})

test('gc:false - array literal', async () => {
  is(await evaluate('[1, 2, 3][0]', 0, GC), 1)
  is(await evaluate('[1, 2, 3][1]', 0, GC), 2)
  is(await evaluate('[1, 2, 3][2]', 0, GC), 3)
})

test('gc:false - array length', async () => {
  is(await evaluate('[1, 2, 3].length', 0, GC), 3)
  is(await evaluate('[].length', 0, GC), 0)
  is(await evaluate('[1].length', 0, GC), 1)
})

test('gc:false - array in variable', async () => {
  is(await evaluate('(a = [10, 20, 30], a[1])', 0, GC), 20)
  is(await evaluate('(a = [1, 2, 3, 4, 5], a.length)', 0, GC), 5)
})

test('gc:false - array mutation', async () => {
  is(await evaluate('(a = [1, 2, 3], a[0] = 10, a[0])', 0, GC), 10)
  is(await evaluate('(a = [1, 2, 3], a[1] = 20, a[1])', 0, GC), 20)
})

test('gc:false - Array constructor', async () => {
  is(await evaluate('(a = Array(3), a.length)', 0, GC), 3)
  is(await evaluate('(a = Array(5), a[0])', 0, GC), 0)  // initialized to 0
})

test('gc:false - array destructuring', async () => {
  is(await evaluate('([a, b] = [1, 2], a)', 0, GC), 1)
  is(await evaluate('([a, b] = [1, 2], b)', 0, GC), 2)
  is(await evaluate('([a, b] = [1, 2], a + b)', 0, GC), 3)
})

test('gc:false - object literal', async () => {
  is(await evaluate('{x: 1}.x', 0, GC), 1)
  is(await evaluate('{x: 1, y: 2}.y', 0, GC), 2)
  is(await evaluate('{a: 10, b: 20, c: 30}.b', 0, GC), 20)
})

test('gc:false - object in variable', async () => {
  is(await evaluate('(obj = {x: 5, y: 10}, obj.x)', 0, GC), 5)
  is(await evaluate('(obj = {x: 5, y: 10}, obj.y)', 0, GC), 10)
})

test('gc:false - object destructuring', async () => {
  is(await evaluate('({a, b} = {a: 5, b: 10}, a)', 0, GC), 5)
  is(await evaluate('({a, b} = {a: 5, b: 10}, b)', 0, GC), 10)
  is(await evaluate('({a, b} = {a: 5, b: 10}, a + b)', 0, GC), 15)
})

test('gc:false - optional chaining', async () => {
  is(await evaluate('(a = [1, 2, 3], a?.[0])', 0, GC), 1)
  is(await evaluate('(a = null, a?.[0])', 0, GC), 0)
  is(await evaluate('(a = [1, 2, 3], a?.length)', 0, GC), 3)
  is(await evaluate('(a = null, a?.length)', 0, GC), 0)
})

test('gc:false - array.map', async () => {
  is(await evaluate('([1, 2, 3].map(x => x * 2))[0]', 0, GC), 2)
  is(await evaluate('([1, 2, 3].map(x => x * 2))[1]', 0, GC), 4)
  is(await evaluate('([1, 2, 3].map(x => x * 2))[2]', 0, GC), 6)
  is(await evaluate('[1, 2, 3].map(x => x * 2).length', 0, GC), 3)
})

test('gc:false - array.reduce', async () => {
  is(await evaluate('[1, 2, 3].reduce((a, b) => a + b)', 0, GC), 6)
  is(await evaluate('[1, 2, 3, 4].reduce((a, b) => a * b)', 0, GC), 24)
  is(await evaluate('[1, 2, 3].reduce((a, b) => a + b, 10)', 0, GC), 16)
})

test('gc:false - compound assignment on arrays', async () => {
  is(await evaluate('(arr = [1, 2, 3], arr[0] += 10, arr[0])', 0, GC), 11)
  is(await evaluate('(arr = [10, 20], arr[1] *= 2, arr[1])', 0, GC), 40)
})

test('gc:false - array reduce as loop alternative', async () => {
  // Loops in comma expressions have parser limitations, use reduce instead
  is(await evaluate('[1, 2, 3, 4].reduce((sum, x) => sum + x, 0)', 0, GC), 10)
})

test('gc:false - string literals', async () => {
  is(await evaluate('"hello".length', 0, GC), 5)
  is(await evaluate('"hello"[0]', 0, GC), 104)  // 'h'
  is(await evaluate('"hello"[1]', 0, GC), 101)  // 'e'
})

test('gc:false - string.charCodeAt', async () => {
  is(await evaluate('"hello".charCodeAt(0)', 0, GC), 104)
  is(await evaluate('"hello".charCodeAt(1)', 0, GC), 101)
  is(await evaluate('"A".charCodeAt(0)', 0, GC), 65)
})

// Compare gc:true vs gc:false results
test('gc:true vs gc:false - same results', async () => {
  const tests = [
    '[1, 2, 3][1]',
    '[1, 2, 3].length',
    '(a = [1, 2, 3], a[0] = 10, a[0])',
    '{x: 5}.x',
    '([a, b] = [3, 4], a * b)',
    '[1, 2, 3].map(x => x + 1)[0]',
    '[1, 2, 3, 4].reduce((a, b) => a + b)',
  ]
  
  for (const code of tests) {
    const gcTrue = await evaluate(code, 0, { gc: true })
    const gcFalse = await evaluate(code, 0, { gc: false })
    is(gcFalse, gcTrue, `gc:false should match gc:true for: ${code}`)
  }
})

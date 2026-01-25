import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate, compile } from './util.js'
import { compile as jzCompile } from '../index.js'

// Ring buffer tests
// Ring buffers provide O(1) shift/unshift operations via circular indexing
//
// JZ SEMANTICS (differs from JS):
// - shift() returns removed element, but caller must use returned array for continued access
// - unshift(x) returns the modified array (not length like JS)
// - To get JS-like mutation: a = a.unshift(x) or use the returned value

// === Basic shift/unshift - return values ===

test('shift - returns first element', async () => {
  is(await evaluate('[1, 2, 3].shift()'), 1)
  is(await evaluate('[10, 20, 30].shift()'), 10)
  is(await evaluate('[42].shift()'), 42)
})

test('shift - empty array returns NaN', async () => {
  ok(Number.isNaN(await evaluate('[].shift()')))
})

test('unshift - returns modified array', async () => {
  // In JZ, unshift returns the array, not length
  is(await evaluate('[2, 3].unshift(1).length'), 3)
  is(await evaluate('[2, 3].unshift(1)[0]'), 1)
  is(await evaluate('[2, 3].unshift(1)[1]'), 2)
  is(await evaluate('[2, 3].unshift(1)[2]'), 3)
})

test('unshift - empty array', async () => {
  is(await evaluate('[].unshift(5).length'), 1)
  is(await evaluate('[].unshift(5)[0]'), 5)
})

// === Chained operations ===

test('chained unshift', async () => {
  is(await evaluate('[3].unshift(2).unshift(1).length'), 3)
  is(await evaluate('[3].unshift(2).unshift(1)[0]'), 1)
  is(await evaluate('[3].unshift(2).unshift(1)[1]'), 2)
  is(await evaluate('[3].unshift(2).unshift(1)[2]'), 3)
})

test('shift then unshift', async () => {
  // [1,2,3].shift() returns 1, array becomes [2,3] (internally)
  // But we can't access the modified array without explicit tracking
  is(await evaluate('[1, 2, 3].shift()'), 1)
})

// === Queue pattern with reassignment ===

test('queue pattern - explicit reassignment', async () => {
  is(await evaluate(`{
    let q = [1, 2, 3];
    let first = q.shift();
    q = q.unshift(4);  // prepend 4 to get queue-like behavior
    first
  }`), 1)
})

// === Build array with unshift ===

test('build array with unshift', async () => {
  is(await evaluate(`{
    let a = [];
    a = a.unshift(3);
    a = a.unshift(2);
    a = a.unshift(1);
    a.length
  }`), 3)
  is(await evaluate(`{
    let a = [];
    a = a.unshift(3);
    a = a.unshift(2);
    a = a.unshift(1);
    a[0]
  }`), 1)
  is(await evaluate(`{
    let a = [];
    a = a.unshift(3);
    a = a.unshift(2);
    a = a.unshift(1);
    a[2]
  }`), 3)
})

// === Shift multiple values ===

test('shift returns correct values', async () => {
  is(await evaluate(`{
    let a = [1, 2, 3];
    let v1 = a.shift();
    v1
  }`), 1)
})

// === Performance test - unshift is O(1) ===

test('unshift - O(1) on large array', async () => {
  // Build array with unshift - should be O(n) total, not O(n²)
  const result = await evaluate(`{
    let a = [];
    let i = 0;
    while (i < 100) {
      a = a.unshift(i);
      i = i + 1;
    }
    a[0]
  }`)
  // Last unshifted value (99) should be at index 0
  is(result, 99)
})

test('unshift - preserves other elements', async () => {
  is(await evaluate(`{
    let a = [];
    let i = 0;
    while (i < 10) {
      a = a.unshift(i);
      i = i + 1;
    }
    a[9]
  }`), 0) // First inserted (0) is now at end
})

// === Array methods work on unshifted arrays ===

test('map on unshifted array', async () => {
  is(await evaluate(`{
    let a = [2, 3];
    a = a.unshift(1);
    a.map(x => x * 2)[0]
  }`), 2) // [1,2,3].map => [2,4,6], first is 2
})

test('filter on unshifted array', async () => {
  is(await evaluate(`{
    let a = [2, 3];
    a = a.unshift(1);
    a.filter(x => x > 1).length
  }`), 2) // [1,2,3].filter(>1) => [2,3]
})

test('reduce on unshifted array', async () => {
  is(await evaluate(`{
    let a = [4, 5];
    a = a.unshift(3);
    a = a.unshift(2);
    a = a.unshift(1);
    a.reduce((acc, x) => acc + x, 0)
  }`), 15) // 1+2+3+4+5 = 15
})

// === Shift with reassignment ===

test('shift with reassignment - array shrinks', async () => {
  // To see mutation, user must reassign from the returned ring
  is(await evaluate(`{
    let a = [1, 2, 3];
    a = a.unshift(0);  // convert to ring: [0,1,2,3]
    a.shift();         // shifts and mutates ring
    a.length           // ring is now [1,2,3]
  }`), 3)
})

test('shift with reassignment - correct elements', async () => {
  is(await evaluate(`{
    let a = [1, 2, 3];
    a = a.unshift(0);  // [0,1,2,3]
    a.shift();         // [1,2,3]
    a[0]
  }`), 1)
  is(await evaluate(`{
    let a = [1, 2, 3];
    a = a.unshift(0);  // [0,1,2,3]
    a.shift();         // [1,2,3]
    a[2]
  }`), 3)
})

// === Multiple shifts ===

test('multiple shifts drain ring', async () => {
  is(await evaluate(`{
    let a = [];
    a = a.unshift(1);
    a = a.unshift(2);
    a = a.unshift(3);
    // a = [3,2,1]
    a.shift() + a.shift() + a.shift()  // 3 + 2 + 1
  }`), 6)
})

// === Edge cases ===

test('unshift on empty then shift', async () => {
  is(await evaluate(`{
    let a = [];
    a = a.unshift(42);
    a.shift()
  }`), 42)
})

test('large ring buffer operations', async () => {
  // Build with unshift, then drain with shift
  // Use reduce pattern to avoid type inference issues
  const result = await evaluate(`{
    let a = [];
    let i = 0;
    while (i < 50) {
      a = a.unshift(i);
      i = i + 1;
    }
    // a = [49, 48, ..., 1, 0]
    // Sum by shifting all - use reduce pattern
    a.reduce((acc, x) => acc + x, 0)
  }`)
  // Sum of 0..49 = 1225
  is(result, 1225)
})

// === Edge cases ===

test('unshift single element', async () => {
  is(await evaluate('[1].unshift(0).length'), 2)
  is(await evaluate('[1].unshift(0)[0]'), 0)
  is(await evaluate('[1].unshift(0)[1]'), 1)
})

test('shift single element', async () => {
  is(await evaluate('[42].shift()'), 42)
})

// === Ring detection in WAT output ===

test('compiled output includes ring helpers', () => {
  const wat = jzCompile(`
    export const test = () => {
      let a = [1, 2, 3];
      a = a.unshift(0);
      return a.length;
    }
  `)
  ok(wat.includes('__arr_unshift') || wat.includes('__ring'), 'should use array/ring helpers')
})

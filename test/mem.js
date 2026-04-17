// jz.mem API tests: JS↔WASM interop constructors, read, write
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'

async function run(code) {
  return WebAssembly.instantiate(compile(code))
}

// ============================================
// Passthrough: read(number) → number
// ============================================

test('mem.read: regular number passthrough', async () => {
  const r = await run('export let f = () => [1]')
  const m = jz.mem(r)
  is(m.read(42), 42)
  is(m.read(0), 0)
  is(m.read(-1.5), -1.5)
  is(m.read(Infinity), Infinity)
})

test('mem.read: NaN passthrough (falls through type dispatch, returns NaN)', async () => {
  const r = await run('export let f = () => [0]')
  const m = jz.mem(r)
  ok(isNaN(m.read(NaN)))
})

// ============================================
// Array: JS → WASM → JS roundtrip
// ============================================

test('mem.Array: write + read roundtrip', async () => {
  const r = await run(`
    export let get = (a, i) => a[i]
    export let len = (a) => a.length
  `)
  const m = jz.mem(r)
  const ptr = m.Array([10, 20, 30])
  ok(isNaN(ptr))
  is(r.instance.exports.get(ptr, 0), 10)
  is(r.instance.exports.get(ptr, 1), 20)
  is(r.instance.exports.get(ptr, 2), 30)
  is(r.instance.exports.len(ptr), 3)
})

test('mem.read: WASM array → JS array', async () => {
  const r = await run(`export let make = () => { let a = [1, 2, 3]; return a }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  const arr = m.read(ptr)
  ok(Array.isArray(arr))
  is(arr.length, 3)
  is(arr[0], 1); is(arr[1], 2); is(arr[2], 3)
})

test('mem.write: update array in place', async () => {
  const r = await run(`
    export let make = () => { let a = [0, 0, 0]; return a }
    export let get = (a, i) => a[i]
  `)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  m.write(ptr, [7, 8, 9])
  is(r.instance.exports.get(ptr, 0), 7)
  is(r.instance.exports.get(ptr, 1), 8)
  is(r.instance.exports.get(ptr, 2), 9)
})

test('mem.write: capacity overflow throws', async () => {
  const r = await run(`export let get = (a, i) => a[i]`)
  const m = jz.mem(r)
  const ptr = m.Array([1, 2])  // cap=2, allocated by JS side (hdr(n,n,...))
  let threw = false
  try { m.write(ptr, [1, 2, 3, 4]) } catch (e) { threw = true }
  ok(threw)
})

// ============================================
// String: JS → WASM → JS roundtrip
// ============================================

test('mem.String: SSO roundtrip', async () => {
  const r = await run(`export let len = (s) => s.length`)
  const m = jz.mem(r)
  const ptr = m.String('hi')
  ok(isNaN(ptr))
  is(r.instance.exports.len(ptr), 2)
})

test('mem.String: heap roundtrip', async () => {
  const r = await run(`export let len = (s) => s.length`)
  const m = jz.mem(r)
  const ptr = m.String('hello world')
  ok(isNaN(ptr))
  is(r.instance.exports.len(ptr), 11)
})

test('mem.read: WASM SSO string → JS string', async () => {
  const r = await run(`export let make = () => { let s = "hi"; return s }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  is(m.read(ptr), 'hi')
})

test('mem.read: WASM heap string → JS string', async () => {
  const r = await run(`export let make = () => { let s = "hello world"; return s }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  is(m.read(ptr), 'hello world')
})

test('mem.String: SSO boundary (4 chars)', async () => {
  const r = await run(`export let len = (s) => s.length`)
  const m = jz.mem(r)
  is(r.instance.exports.len(m.String('abcd')), 4)  // exactly 4 = SSO
  is(r.instance.exports.len(m.String('abcde')), 5) // 5 = heap
})

// ============================================
// Object: JS → WASM → JS roundtrip
// ============================================

test('mem.Object: auto schema lookup', async () => {
  const r = await run(`
    export let getX = (o) => o.x
    export let getY = (o) => o.y
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
  `)
  const m = jz.mem(r)
  const ptr = m.Object({ x: 3, y: 4 })
  ok(isNaN(ptr))
  is(r.instance.exports.getX(ptr), 3)
  is(r.instance.exports.getY(ptr), 4)
})

test('mem.Object: key order independence', async () => {
  const r = await run(`
    export let getX = (o) => o.x
    export let getY = (o) => o.y
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
  `)
  const m = jz.mem(r)
  // Keys in reverse order — should still find schema
  const ptr = m.Object({ y: 10, x: 20 })
  is(r.instance.exports.getX(ptr), 20)
  is(r.instance.exports.getY(ptr), 10)
})

test('mem.Object: ambiguous schemas throws', async () => {
  const r = await run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {y: 3, x: 4}
    return a.x + b.y
  }`)
  const m = jz.mem(r)
  // Exact order match works
  is(r.instance.exports.f(), 4)  // a.x=1 + b.y=3
  const ptrA = m.Object({ x: 10, y: 20 })
  is(m.read(ptrA).x, 10)
  // Ambiguous key set (both [x,y] and [y,x] exist) — must pass in schema order
  let threw = false
  try { m.Object({ a: 1, b: 2 }) } catch { threw = true }
  ok(threw, 'unknown schema throws')
})

test('mem.Object: unknown schema throws', async () => {
  const r = await run(`export let f = () => { let o = {x: 1}; return o.x }`)
  const m = jz.mem(r)
  let threw = false
  try { m.Object({ z: 1, w: 2 }) } catch (e) { threw = true }
  ok(threw)
})

// === Null through mem bridge ===

test('mem.Array: null elements preserved', async () => {
  const r = await run('export let f = (a) => a[0]')
  const m = jz.mem(r)
  const ptr = m.Array([null, 1, 2])
  // null element should be NaN-boxed null, not 0
  const result = r.instance.exports.f(ptr)
  ok(isNaN(result), 'null element is NaN-boxed')
})

// === Shared memory: no data collision ===

test('shared memory: no static string collision', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const a = jz('export let f = () => "hello"', { memory })
  const aPtr = a.instance.exports.f()
  const aVal = a.mem.read(aPtr)
  is(aVal, 'hello')

  // Instantiate B on same memory — should not corrupt A's string
  const b = jz('export let f = () => "world"', { memory })
  // Re-read A's pointer — should still be "hello"
  is(a.mem.read(aPtr), 'hello')
})

test('mem.read: WASM object → JS object', async () => {
  const r = await run(`export let make = (a, b) => { let o = {x: a, y: b}; return o }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make(7, 11)
  const obj = m.read(ptr)
  ok(typeof obj === 'object')
  is(obj.x, 7)
  is(obj.y, 11)
})

test('mem.write: partial object update', async () => {
  const r = await run(`
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
    export let getX = (o) => o.x
    export let getY = (o) => o.y
  `)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make(1, 2)
  m.write(ptr, { x: 99 })  // partial update — y unchanged
  is(r.instance.exports.getX(ptr), 99)
  is(r.instance.exports.getY(ptr), 2)
})

// ============================================
// TypedArray: JS → WASM → JS roundtrip
// ============================================

test('mem.Float64Array: write + read roundtrip', async () => {
  const r = await run(`
    export let get = (a, i) => a[i]
    export let len = (a) => a.length
  `)
  const m = jz.mem(r)
  const ptr = m.Float64Array([1.1, 2.2, 3.3])
  ok(isNaN(ptr))
  almost(r.instance.exports.get(ptr, 0), 1.1)
  almost(r.instance.exports.get(ptr, 1), 2.2)
  is(r.instance.exports.len(ptr), 3)
})

test('mem.Float64Array: write roundtrip', async () => {
  const r = await run(`
    export let make = (n) => { let a = new Float64Array(n); return a }
    export let get = (a, i) => a[i]
  `)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make(3)
  m.write(ptr, [10, 20, 30])
  almost(r.instance.exports.get(ptr, 0), 10)
  almost(r.instance.exports.get(ptr, 2), 30)
})

test('mem.read: WASM TypedArray → JS typed array', async () => {
  const r = await run(`export let make = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; return a }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  const arr = m.read(ptr)
  ok(arr instanceof Float64Array, 'returns Float64Array')
  is(arr.length, 3)
  almost(arr[0], 1); almost(arr[1], 2); almost(arr[2], 3)
})

// ============================================
// write: unsupported types throw
// ============================================

test('mem.write: string pointer throws', async () => {
  const r = await run(`export let make = () => { let s = "hello world"; return s }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  let threw = false
  try { m.write(ptr, 'new value') } catch (e) { threw = true }
  ok(threw)
})

// ============================================
// Nested: array of floats roundtrip
// ============================================

test('mem.read: nested read (number elements)', async () => {
  const r = await run(`export let make = () => { let a = [1, 2, 3]; return a }`)
  const m = jz.mem(r)
  const ptr = r.instance.exports.make()
  const arr = m.read(ptr)
  is(arr[0], 1); is(arr[1], 2); is(arr[2], 3)
})

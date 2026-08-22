// jz.memory API tests: JS↔WASM interop constructors, read, write
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { i64ToF64, instantiate } from '../interop.js'
import { onWasi, onKernel, adaptI64 } from './_matrix.js'

// interop's instantiate (not raw WebAssembly.instantiate): a module whose
// unproven-receiver reads pull the env external machinery declares imports —
// interop supplies them; the tests still consume the RAW instance exports
// (i64 BigInt carriers), not the wrapped ones.
async function run(code, opts) {
  const r = instantiate(compile(code, opts))
  return { module: r.module, instance: { exports: adaptI64(r.module, r.instance.exports) } }
}

// ============================================
// Passthrough: read(number) → number
// ============================================

test('mem.read: regular number passthrough', async () => {
  const r = await run('export let f = () => [1]')
  const m = jz.memory(r)
  is(m.read(42), 42)
  is(m.read(0), 0)
  is(m.read(-1.5), -1.5)
  is(m.read(Infinity), Infinity)
})

test('mem.read: NaN passthrough (falls through type dispatch, returns NaN)', async () => {
  const r = await run('export let f = () => [0]')
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = m.Array([10, 20, 30])
  ok(typeof ptr === 'bigint')  // box is the i64 carrier (BigInt), not an f64 NaN-box
  is(r.instance.exports.get(ptr, 0), 10)
  is(r.instance.exports.get(ptr, 1), 20)
  is(r.instance.exports.get(ptr, 2), 30)
  is(r.instance.exports.len(ptr), 3)
})

test('mem.read: WASM array → JS array', async () => {
  const r = await run(`export let make = () => { let a = [1, 2, 3]; return a }`)
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  m.write(ptr, [7, 8, 9])
  is(r.instance.exports.get(ptr, 0), 7)
  is(r.instance.exports.get(ptr, 1), 8)
  is(r.instance.exports.get(ptr, 2), 9)
})

test('mem.write: capacity overflow throws', async () => {
  const r = await run(`export let get = (a, i) => a[i]`)
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = m.String('hi')
  ok(typeof ptr === 'bigint')  // box is the i64 carrier (BigInt), not an f64 NaN-box
  is(r.instance.exports.len(ptr), 2)
})

test('mem.String: heap roundtrip', async () => {
  const r = await run(`export let len = (s) => s.length`)
  const m = jz.memory(r)
  const ptr = m.String('hello world')
  ok(typeof ptr === 'bigint')  // box is the i64 carrier (BigInt), not an f64 NaN-box
  is(r.instance.exports.len(ptr), 11)
})

test('mem.read: WASM SSO string → JS string', async () => {
  const r = await run(`export let make = () => { let s = "hi"; return s }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  is(m.read(ptr), 'hi')
})

test('mem.read: WASM heap string → JS string', async () => {
  const r = await run(`export let make = () => { let s = "hello world"; return s }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  is(m.read(ptr), 'hello world')
})

test('mem.String: SSO boundary (4 chars)', async () => {
  const r = await run(`export let len = (s) => s.length`)
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = m.Object({ x: 3, y: 4 })
  ok(typeof ptr === 'bigint')  // box is the i64 carrier (BigInt), not an f64 NaN-box
  is(r.instance.exports.getX(ptr), 3)
  is(r.instance.exports.getY(ptr), 4)
})

test('mem.Object: key order independence', async () => {
  const r = await run(`
    export let getX = (o) => o.x
    export let getY = (o) => o.y
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
  `)
  const m = jz.memory(r)
  // Keys in reverse order — should still find schema
  const ptr = m.Object({ y: 10, x: 20 })
  is(r.instance.exports.getX(ptr), 20)
  is(r.instance.exports.getY(ptr), 10)
})

test('mem.Object: ambiguous schemas throws', async () => {
  if (onKernel()) return  // kernel: host {memory: pages} option doesn't reach the single-source self-compile
  // { memory: 1 } forces owned memory: the two object literals fold to scalars (their
  // only reads are `a.x`/`b.y`), so nothing lands on the heap and the module is otherwise
  // memoryless — but this test marshals host objects in via the registered schemas, which
  // needs a memory to allocate into.
  const r = await run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {y: 3, x: 4}
    return a.x + b.y
  }`, { memory: 1 })
  const m = jz.memory(r)
  // Exact order match works
  is(r.instance.exports.f(), 4)  // a.x=1 + b.y=3
  const ptrA = m.Object({ x: 10, y: 20 })
  is(m.read(ptrA).x, 10)
  // Unknown key set (neither schema matches) — marshals as a first-class HASH
  // (identity-preserving dyn object) instead of throwing / External reflection.
  const h = m.Object({ a: 1, b: 2 })
  is(m.read(h), { a: 1, b: 2 }, 'unknown schema marshals as hash, round-trips')
})

test('mem.Object: unknown schema marshals as first-class hash', async () => {
  // Schema-less plain objects become real jz HASHes: wasm-side dyn reads, NEW-prop
  // writes, and nested-container mutation all keep identity. (The old External
  // fallback decode/re-marshaled per access, so `params.P[i][i] = v` landed on a
  // marshaling copy and vanished — the digital-filter rls.js covariance repro.)
  const r = jz(`export default function f (params) {
    let N = params.order
    params.P = new Array(N)
    for (let i = 0; i < N; i++) {
      params.P[i] = new Float64Array(N)
      params.P[i][i] = params.delta
    }
    let P = params.P
    let sum = 0
    for (let i = 0; i < N; i++) sum += P[i][i]
    return sum
  }`)
  is(Number(r.exports.default(r.memory.Object({ order: 4, delta: 100 }))), 400, 'nested rows on a marshaled params bag')
  const h = r.memory.Object({ z: 1, w: 2 })
  is(r.memory.read(h), { z: 1, w: 2 }, 'round-trips through mem.read')
})

// === BigInt through mem bridge (mem.Object/mem.write route through mem.wrapVal) ===
//
// mem.Object's inline marshal loop, and mem.write's array/object in-place
// update branches, used to hand-roll their own null/string/array dispatch
// and fall through to bare `bits(v)` for everything else — a plain
// (non-isBox) BigInt value silently stored raw, unmarked i64 bits instead
// of going through mem.wrapVal's typed post-C4b throw (interop.js, the
// `isBox(v)` check). mem.Array/mem.Hash already routed every element/value
// through mem.wrapVal; mem.Object/mem.write now do too — one dispatch,
// same C4b doctrine everywhere a host value crosses into jz memory.

test('mem.Object: plain BigInt property value throws (post-C4b doctrine, mirrors mem.wrapVal)', async () => {
  const r = await run(`
    export let getX = (o) => o.x
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
  `)
  const m = jz.memory(r)
  let threw = null
  try { m.Object({ x: 5n, y: 1 }) } catch (e) { threw = e }
  ok(threw, 'plain BigInt property value throws')
  ok(threw && /no BigInt evidence/.test(threw.message) && /mem\.BigInt/.test(threw.message),
    'message names mem.BigInt as the fix')
})

test('mem.Object: boxed BigInt (mem.BigInt) property value round-trips', async () => {
  const r = await run(`
    export let getX = (o) => o.x
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
  `)
  const m = jz.memory(r)
  const ptr = m.Object({ x: m.BigInt(5n), y: 1 })
  is(m.read(ptr).x, 5n, 'isBox BigInt property value round-trips through mem.read')
})

test('mem.write: plain BigInt array element throws (same class as mem.Object)', async () => {
  const r = await run(`export let make = () => { let a = [0, 0]; return a }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  let threw = null
  try { m.write(ptr, [1, 2n]) } catch (e) { threw = e }
  ok(threw, 'plain BigInt array element throws')
  ok(threw && /no BigInt evidence/.test(threw.message) && /mem\.BigInt/.test(threw.message),
    'message names mem.BigInt as the fix')
})

test('mem.write: plain BigInt object property throws (same class as mem.Object)', async () => {
  const r = await run(`export let make = (a, b) => { let o = {x: a, y: b}; return o }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make(1, 2)
  let threw = null
  try { m.write(ptr, { x: 9n }) } catch (e) { threw = e }
  ok(threw, 'plain BigInt object property value throws')
  ok(threw && /no BigInt evidence/.test(threw.message) && /mem\.BigInt/.test(threw.message),
    'message names mem.BigInt as the fix')
})

test('mem.write: boxed BigInt (mem.BigInt) array element round-trips', async () => {
  const r = await run(`export let make = () => { let a = [0, 0]; return a }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  m.write(ptr, [1, m.BigInt(5n)])
  is(m.read(ptr)[1], 5n, 'isBox BigInt element round-trips through mem.read')
})

test('mem.write: boxed BigInt (mem.BigInt) object property round-trips', async () => {
  const r = await run(`export let make = (a, b) => { let o = {x: a, y: b}; return o }`)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make(1, 2)
  m.write(ptr, { x: m.BigInt(9n) })
  is(m.read(ptr).x, 9n, 'isBox BigInt property round-trips through mem.read')
})

// === Null through mem bridge ===

test('mem.Array: null elements preserved', async () => {
  const r = await run('export let f = (a) => a[0]')
  const m = jz.memory(r)
  const ptr = m.Array([null, 1, 2])
  // null element should be NaN-boxed null, not 0
  const result = r.instance.exports.f(ptr)
  ok(isNaN(result), 'null element is NaN-boxed')
})

// === Shared memory: no data collision ===

test('shared memory: no static string collision', async () => {
  if (onKernel()) return  // kernel: host shared {memory} option doesn't reach the single-source self-compile
  const memory = new WebAssembly.Memory({ initial: 1 })
  const a = jz('export let f = () => "hello"', { memory })
  // Raw instance export returns the i64 box (string is a NaN-box → i64 carrier);
  // reinterpret to the f64 pointer for memory.read (a.exports.f() would decode to "hello").
  const aPtr = i64ToF64(a.instance.exports.f())
  const aVal = a.memory.read(aPtr)
  is(aVal, 'hello')

  // Instantiate B on same memory — should not corrupt A's string
  const b = jz('export let f = () => "world"', { memory })
  // Re-read A's pointer — should still be "hello"
  is(a.memory.read(aPtr), 'hello')
})

test('mem.read: WASM object → JS object', async () => {
  const r = await run(`export let make = (a, b) => { let o = {x: a, y: b}; return o }`)
  const m = jz.memory(r)
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
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = m.Float64Array([1.1, 2.2, 3.3])
  ok(typeof ptr === 'bigint')  // box is the i64 carrier (BigInt), not an f64 NaN-box
  almost(r.instance.exports.get(ptr, 0), 1.1)
  almost(r.instance.exports.get(ptr, 1), 2.2)
  is(r.instance.exports.len(ptr), 3)
})

test('mem.Float64Array: write roundtrip', async () => {
  const r = await run(`
    export let make = (n) => { let a = new Float64Array(n); return a }
    export let get = (a, i) => a[i]
  `)
  const m = jz.memory(r)
  const ptr = r.instance.exports.make(3)
  m.write(ptr, [10, 20, 30])
  almost(r.instance.exports.get(ptr, 0), 10)
  almost(r.instance.exports.get(ptr, 2), 30)
})

test('mem.read: WASM TypedArray → JS typed array', async () => {
  const r = await run(`export let make = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; return a }`)
  const m = jz.memory(r)
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
  const m = jz.memory(r)
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
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  const arr = m.read(ptr)
  is(arr[0], 1); is(arr[1], 2); is(arr[2], 3)
})

// ============================================
// jz.memory() API
// ============================================

test('jz.memory(): creates enhanced WebAssembly.Memory', () => {
  const memory = jz.memory()
  ok(memory instanceof WebAssembly.Memory, 'instanceof WebAssembly.Memory')
  ok(typeof memory.read === 'function', 'has .read()')
  ok(typeof memory.String === 'function', 'has .String()')
  ok(typeof memory.Array === 'function', 'has .Array()')
  ok(typeof memory.Object === 'function', 'has .Object()')
  ok(typeof memory.write === 'function', 'has .write()')
  ok(typeof memory.Float64Array === 'function', 'has .Float64Array()')
  ok(Array.isArray(memory.schemas), 'has .schemas')
})

test('jz.memory(raw): patches and returns same object', () => {
  const raw = new WebAssembly.Memory({ initial: 1 })
  const enhanced = jz.memory(raw)
  ok(enhanced === raw, 'same object identity')
  ok(typeof enhanced.read === 'function', 'patched with .read()')
})

test('jz.memory(): idempotent — double-call returns same object', () => {
  const memory = jz.memory()
  const again = jz.memory(memory)
  ok(memory === again, 'idempotent')
})

test('jz.memory(): JS-side allocator works before compilation', () => {
  const memory = jz.memory()
  // Can write strings before any WASM module is compiled
  const ptr = memory.String('hello')
  is(memory.read(ptr), 'hello')
})

test('jz.memory(): JS-side Array + read roundtrip', () => {
  const memory = jz.memory()
  const ptr = memory.Array([10, 20, 30])
  const arr = memory.read(ptr)
  is(arr[0], 10); is(arr[1], 20); is(arr[2], 30)
})

test('jz({ memory }): auto-wraps raw WebAssembly.Memory', () => {
  const raw = new WebAssembly.Memory({ initial: 1 })
  const inst = jz('export let f = () => [1, 2]', { memory: raw })
  // raw should now be enhanced
  ok(typeof raw.read === 'function', 'raw is now enhanced')
  ok(inst.memory === raw, 'inst.memory is the same raw object')
  is(inst.memory.read(inst.instance.exports.f())[0], 1)
})

test('jz({ memory: pages }): creates owned memory with initial page count', () => {
  if (onKernel()) return  // kernel: host {memory: pages} option doesn't reach the single-source self-compile
  const inst = jz('export let f = () => [1, 2]', { memory: 2 })
  ok(inst.memory instanceof WebAssembly.Memory, 'has memory')
  is(inst.memory.buffer.byteLength, 2 * 65536)
  ok(!WebAssembly.Module.imports(inst.module).some(i => i.module === 'env' && i.name === 'memory'), 'does not import memory')
  is(inst.memory.read(inst.instance.exports.f())[0], 1)
})

test('compile({ memory: pages }): emits owned memory with initial page count', () => {
  if (onKernel()) return  // kernel: host {memory: pages} option doesn't reach the single-source self-compile
  const wasm = compile('export let f = () => [1, 2]', { memory: 3 })
  const mod = new WebAssembly.Module(wasm)
  ok(!WebAssembly.Module.imports(mod).some(i => i.module === 'env' && i.name === 'memory'), 'does not import memory')
  const inst = new WebAssembly.Instance(mod)
  is(inst.exports.memory.buffer.byteLength, 3 * 65536)
})

test('shared memory: inst.memory is the same object passed in', () => {
  const memory = jz.memory()
  const a = jz('export let f = () => 42', { memory })
  ok(a.memory === memory, 'same object')
})

test('shared memory: schemas accumulate across compilations', () => {
  if (onKernel()) return  // kernel: host shared {memory} option doesn't reach the single-source self-compile
  const memory = jz.memory()
  const a = jz('export let make = () => { let o = {x: 1, y: 2}; return o }', { memory })
  is(memory.schemas.length, 1, 'one schema after first compile')

  const b = jz('export let make2 = () => { let p = {name: 0, age: 0}; return p }', { memory })
  is(memory.schemas.length, 2, 'two schemas after second compile')

  // a's objects readable from shared memory
  const ptr = a.exports.make()
  const obj = memory.read(ptr)
  is(obj.x, 1)
  is(obj.y, 2)
})

test('shared memory: cross-instance object passing', () => {
  if (onWasi() || onKernel()) return  // wasi/kernel: shared-memory host orchestration not on the single-source self-compile
  const memory = jz.memory()
  const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
  const b = jz('export let read = (o) => o.x + o.y', { memory })
  is(b.exports.read(a.exports.make()), 30)
})

test('shared memory: duplicate schemas not re-added', () => {
  const memory = jz.memory()
  jz('export let f = () => { let o = {a: 1, b: 2}; return o }', { memory })
  jz('export let g = () => { let o = {a: 3, b: 4}; return o }', { memory })
  is(memory.schemas.length, 1, 'same schema not duplicated')
})

test('one-off: inst.memory works without shared memory', () => {
  if (onKernel()) return  // kernel: host {memory: pages} option doesn't reach the single-source self-compile
  // { memory: 1 } requests owned (non-shared) memory. A ≤8-element array return now
  // comes back as a multi-value tuple with no heap at all, so without the explicit
  // request this module would be memoryless — and there'd be no `inst.memory` to test.
  const inst = jz('export let f = () => [1, 2, 3]', { memory: 1 })
  ok(inst.memory instanceof WebAssembly.Memory, 'memory is WebAssembly.Memory')
  const arr = inst.memory.read(inst.instance.exports.f())
  is(arr[0], 1); is(arr[1], 2); is(arr[2], 3)
})

test('memory.reset(): own memory keeps page count flat across allocating calls', () => {
  const { exports, memory, instance } = jz`
    export let f = (n) => { let xs = []; for (let i = 0; i < n; i++) xs.push(i); return xs.length }
  `
  ok(typeof memory.reset === 'function', 'memory.reset is a function')
  ok(typeof instance.exports._clear === 'function', '_clear export is present')
  const before = memory.buffer.byteLength
  for (let i = 0; i < 500; i++) { exports.f(100); memory.reset() }
  is(memory.buffer.byteLength, before, 'no growth across 500 reset cycles')
})

test('memory.reset(): module-global heap values survive a reset (rewind to post-init mark)', () => {
  // A top-level `let o = {…}` is allocated during module init, ABOVE the static-data
  // end. reset() must rewind to the post-init high-water mark, not the static-data end,
  // or the next allocation overwrites the module global (was: OOB / wrong value).
  const { exports, memory } = jz`
    let o = { a: 11, b: 22, c: 33, d: 44 }
    let ks = ['a', 'b', 'c', 'd']
    export let get = (i) => o[ks[i & 3]]
    export let alloc = (n) => { let t = []; for (let i = 0; i < n; i++) t.push(i * 7); return t.length }
  `
  is(exports.get(0), 11, 'module global readable before reset')
  memory.reset()
  exports.alloc(64)                 // a per-batch allocation after reset
  is(exports.get(0), 11, 'module global intact after reset + realloc')
  is(exports.get(2), 33, 'all module-global slots intact')
})

test('memory.reset(): own memory grows without reset', () => {
  const { exports, memory } = jz`
    export let f = (n) => { let xs = []; for (let i = 0; i < n; i++) xs.push(i); return xs.length }
  `
  const before = memory.buffer.byteLength
  for (let i = 0; i < 500; i++) exports.f(100)
  ok(memory.buffer.byteLength > before, 'grows when reset is omitted')
})

test('memory.reset(): shared memory rewinds heap pointer to 1024', () => {
  if (onKernel()) return  // kernel: host shared {memory} option doesn't reach the single-source self-compile
  const memory = jz.memory()
  const { exports } = jz('export let f = (n) => { let xs = []; for (let i = 0; i < n; i++) xs.push(i); return xs.length }', { memory })
  exports.f(100)
  const dv = () => new DataView(memory.buffer)
  ok(dv().getInt32(1020, true) > 1024, 'heap advanced after allocations')
  memory.reset()
  is(dv().getInt32(1020, true), 1024, 'heap rewound to 1024')
})

test('memory.reset(): JS-side fallback works before any module compile', () => {
  const memory = jz.memory()
  ok(typeof memory.reset === 'function', 'JS-side reset wired with no module')
  memory.String('hello world')
  memory.Array([1, 2, 3, 4, 5])
  const dv = () => new DataView(memory.buffer)
  ok(dv().getInt32(1020, true) > 1024, 'heap advanced after JS writes')
  memory.reset()
  is(dv().getInt32(1020, true), 1024, 'JS-side reset rewinds')
})

test('memory.reset(): JS writes valid after reset (WASM reads new pointer)', () => {
  const { exports, memory } = jz`export let len = (s) => s.length`
  is(exports.len(memory.String('hello world')), 11)
  memory.reset()
  is(exports.len(memory.String('hi')), 2, 'fresh allocation works after reset')
})

test('memory.reset(): wires up after compile when memory was JS-only', () => {
  const memory = jz.memory()
  // JS-side reset is present immediately
  ok(typeof memory.reset === 'function')
  const { exports } = jz('export let f = (n) => { let xs = []; for (let i = 0; i < n; i++) xs.push(i); return xs.length }', { memory })
  // After compile, reset stays the JS-side rewind (to the post-init heap mark, so
  // module globals survive) — it does NOT switch to the wasm _clear constant rewind.
  ok(typeof memory.reset === 'function', 'reset still callable after compile')
  exports.f(100)
  memory.reset()
  is(new DataView(memory.buffer).getInt32(1020, true), 1024)
})

test('pure scalar module exposes no memory and no allocator exports', () => {
  const r = jz`export let add = (a, b) => a + b`
  ok(!r.memory, 'no memory on pure scalar module')
  ok(!('_alloc' in r.instance.exports), 'no _alloc export')
  ok(!('_clear' in r.instance.exports), 'no _clear export')
})

test('_clear() rewinds to the post-init heap mark, preserving module-init state', () => {
  // `table` is a heap-allocated typed array filled in __start; `probe` allocates a
  // fresh scratch buffer per call. If _clear rewound below `table` (the old bug — it
  // reset to the static-data end, into the module's own init allocations), the next
  // probe's scratch would overwrite `table` and the sum would be wrong. This is the
  // self-compile arena-reuse corruption reduced to one module.
  const { exports } = jz(`
    let table = new Float64Array(5)
    for (let i = 0; i < 5; i++) table[i] = (i + 1) * 10
    export let probe = (n) => {
      let scratch = new Float64Array(n)
      for (let i = 0; i < n; i++) scratch[i] = i * 1.0
      return table[0] + table[4]
    }`, { optimize: false })
  is(exports.probe(256), 60, 'baseline: 10 + 50')
  exports._clear()
  is(exports.probe(256), 60, 'table survives one _clear')
  exports._clear(); exports.probe(256); exports._clear()
  is(exports.probe(256), 60, 'table survives repeated _clear + alloc cycles')
})

test('_clear() restores runtime-written module globals to their post-init snapshot', () => {
  // The warm-reuse landmine class: a module-level lazy cache holds an ARENA pointer;
  // `_clear` rewinds the arena; the next round's `if (!CACHE)` sees a stale truthy
  // handle and dereferences whatever now lives at that offset (watr's in-kernel NCLS
  // dict, json's __jbuf — every one was this shape). The contract that kills the whole
  // class: _clear restores every runtime-written module global to its post-__start
  // value — warm behaves as fresh, minus the init cost. `churn` reuses the freed arena
  // between rounds so a dangling read is REAL garbage, not accidentally-intact bytes.
  const { exports } = jz(`
    let CACHE = null
    let hits = 0
    const get = () => { if (!CACHE) { CACHE = [7,8,9]; hits = hits + 1 }; return CACHE[1] }
    export let churn = (n) => { let a = [n + 0.5, n * 2, n * 3]; return a[0] }
    export let main = () => get()
    export let hitCount = () => hits`, { optimize: false })
  is(exports.main(), 8, 'round 1 builds the cache')
  is(exports.hitCount(), 1)
  exports._clear()
  exports.churn(999)   // overwrite the arena the stale CACHE pointed into
  is(exports.main(), 8, 'round 2 rebuilds — no dangling read through the stale handle')
  is(exports.hitCount(), 1, 'scalar warm state restores too (fresh-instance semantics: hits back to 0, then 1)')
})

test('_clear() heals ephemeral values written into DURABLE collection slots', () => {
  // The durable-interior sibling of the global sweep above: the dict itself is
  // init-created (const binding — the sweep rightly skips it), but a round-1
  // memo write stores a round-arena array INTO its durable slot. Without the
  // slot heal (__durable_slot_log/__durable_slot_heal), round 2's cache hit
  // returns the stale handle and reads churned garbage — the corpus-wide warm
  // trap (a durable literal-text→node dict handing round-1 arrays into round-2's
  // tree). With it, the entry reads `undefined` after _clear and the memo
  // rebuilds.
  const { exports } = jz(`
    const CACHE = new Map()
    let builds = 0
    const memo = (k) => {
      let v = CACHE.get(k)
      if (v === undefined) { v = [k.length, 7]; CACHE.set(k, v); builds = builds + 1 }
      return v[1]
    }
    export let churn = (n) => { let a = [n + 0.5, n * 2, n * 3, n * 4]; return a[0] }
    export let main = () => memo('nan:0x7FF8000200000000')
    export let buildCount = () => builds`, { optimize: false })
  is(exports.main(), 7, 'round 1 builds and caches')
  is(exports.main(), 7, 'same-round cache hit')
  is(exports.buildCount(), 1)
  exports._clear()
  exports.churn(999); exports.churn(123)   // reuse the arena the stale entry pointed into
  is(exports.main(), 7, 'round 2: healed entry reads undefined → memo rebuilds, no stale read')
})

test('_clear() heals a durable array header past IN-PLACE growth, not just relocation', () => {
  // Root-caused from .work/research.md's banked lead 2 ("warm _clear() corruption
  // non-repro… new durable-array heal length defect banked"): `site.length` read
  // 154 instead of 150 after one push-grow-clear-regrow round. `let site = []`
  // gets a __start capacity of 4 — the first 4 pushes of a round fit IN PLACE
  // (len bumped 0→1→2→3→4 directly on the durable header, no relocation, so
  // arrGrow's own durableFwdLogIR — gated on off/newOff crossing the durable/
  // ephemeral boundary — never fires). Only the 5th push crosses into a fresh
  // ephemeral block and finally logs, but by then it reads len=4 off the header,
  // not the header's true post-__start value of 0. `__durable_fwd_heal` then
  // "restored" the header to a length it never had: healed len 4 + this round's
  // 150 real pushes = 154. The fix (module/collection.js durableLenLogIR, called
  // from every in-place length-mutating site, idempotent via
  // __durable_fwd_log's now-dedup-per-`off` scan in module/core.js) captures the
  // header's true (len, cap) on the FIRST touch of a round — in place or
  // relocating — so N in-place writes before an eventual grow all converge on
  // the one correct snapshot.
  const { exports } = jz(`
    let site = []
    export let grow = (n) => { for (let i = 0; i < n; i++) site.push(i + '|' + i); return site.length }`,
    { optimize: false })
  is(exports.grow(150), 150, 'round 1: 150 real pushes')
  exports._clear()
  is(exports.grow(150), 150, 'round 2: healed length is exactly 150, not 154')
  exports._clear()
  is(exports.grow(150), 150, 'round 3: still exactly 150 — the fix is not a one-shot coincidence')
})

test('_clear() heals in-place length writes on the OTHER durable-array length sites', () => {
  // durableLenLogIR (module/collection.js) is called from every site that can
  // write a durable array header's `len` word without relocating — not just
  // __arr_push1 (the test above): __arr_set_idx_ptr (index assignment past the
  // current length), __arr_set_length (`.length =`), __arr_unshift, and
  // core.js's __set_len (`.pop()`). Each gets its own durable array here, grown/
  // shrunk once, `_clear()`d, then repeated — the SAME operation must read back
  // the SAME result both rounds if the header truly reset to its post-__start
  // state.
  const { exports } = jz(`
    let idx = [1, 2]
    export let setIdx = (n) => { idx[n] = 9; return idx.length }
    let len = [1, 2]
    export let setLen = (n) => { len.length = n; return len.length }
    let uns = [1, 2]
    export let unshift = (n) => { for (let i = 0; i < n; i++) uns.unshift(i); return uns.length }
    let pp = [1, 2, 3, 4, 5]
    export let pop = (n) => { let v; for (let i = 0; i < n; i++) v = pp.pop(); return pp.length }`,
    { optimize: false })
  is(exports.setIdx(5), 6, 'round 1: index-assign grows past length in place')
  exports._clear()
  is(exports.setIdx(5), 6, 'round 2: same result — no leaked round-1 length')

  is(exports.setLen(6), 6, 'round 1: .length = grows within/past capacity')
  exports._clear()
  is(exports.setLen(6), 6, 'round 2: same result')

  is(exports.unshift(3), 5, 'round 1: unshift grows in place')
  exports._clear()
  is(exports.unshift(3), 5, 'round 2: same result')

  is(exports.pop(2), 3, 'round 1: pop shrinks in place')
  exports._clear()
  is(exports.pop(2), 3, 'round 2: same result — the original popped elements are back')
})

// Root-cause prerequisite for the per-element fix below (found while building it,
// not the length-heal session): every durable-vs-ephemeral guard (durableFwdLogIR/
// durableLenLogIR/durableArrSnapIR/durableSlotLogIR/durableEntryLogIR) tests
// `offset < $__heap_reset`. `$__heap_reset` is only captured to its TRUE post-init
// watermark as the LAST thing `__start` does — while `__start` is still running its
// OWN body, the global still reads its declared constant (HEAP.START, the
// static-data-end address). A compile-time-constant literal (array/hash/set/map
// built entirely from literals) gets folded BELOW that address — so any in-place
// header mutation reachable from module-level (non-function) init code, e.g.
// `let a = [1,2,3,4,5,6,7,8]; a.length = 5` as top-level statements, reads its own
// low static address as "< __heap_reset" and wrongly logs itself as a this-round
// mutation to heal AWAY — even though it's establishing the module's own
// post-__start baseline. `_clear()` then "heals" the array back to its
// PRE-init-truncation content, corrupting the very state `_clear()` exists to
// restore TO. Fixed in src/wat/assemble.js by sentinel-ing `$__heap_reset` to 0 as
// the first instruction of `__start`'s own body (below every real pointer — nothing
// durable yet while `__start` runs), so every guard reads "not durable yet"
// throughout init; the pre-existing end-of-body capture still sets the TRUE
// watermark the instant `__start` finishes.
test('_clear() does not corrupt a durable array whose header is mutated by MODULE-LEVEL (non-function) init code', () => {
  const { exports } = jz(`
    let a = [1,2,3,4,5,6,7,8]
    a.length = 5
    export let dump = () => a.join(',')`,
    { optimize: false })
  is(exports.dump(), '1,2,3,4,5', 'post-init: the top-level truncate already ran')
  exports._clear()
  is(exports.dump(), '1,2,3,4,5', 'a bare _clear() with no other call must not revert past the top-level truncate')
  exports._clear()
  is(exports.dump(), '1,2,3,4,5', 'repeated bare _clear() — not a one-shot coincidence')
})

// splice-heal-2026-08-13: the length fix above heals the HEADER (len/cap) but a
// durable array has no per-ELEMENT heal at all — in-place mutations of EXISTING
// cells (arr[i]= on an in-bounds index, splice/copyWithin/unshift's memory.copy
// shifts, reverse/sort's swaps, fill's overwrite, and a `.length=` grow-in-place
// refill re-entering indices a same-round shrink narrowed past) leak round 1's
// bytes into round 2 even though the LENGTH reads back correct — banked lead from
// .work/research.md's own heal-length entry (`a.splice(1,2)` on `[1,2,3,4,5]` gave
// `3` both rounds, length healed, but the SURVIVING elements differed round to
// round). Each case below: mutate a durable array, `_clear()`, re-run the exact
// same operation — a correct heal means round 2 gives the SAME answer as round 1
// (starting from the same restored [1,2,3,4,5] baseline both times), not round 1's
// leftover data feeding into round 2's computation.
test('_clear() heals a durable array\'s ELEMENT DATA, not just its header, across every in-place mutator', () => {
  const { exports } = jz(`
    let a1 = [1,2,3,4,5]
    export let idx = () => { a1[1] = 99; return a1.join(',') }
    let a2 = [1,2,3,4,5]
    export let splice = () => { a2.splice(1,2); return a2.join(',') }
    let a3 = [1,2,3,4,5]
    export let spliceIns = () => { a3.splice(1,2,99); return a3.join(',') }
    let a4 = [1,2,3,4,5]
    export let copyWithin = () => { a4.copyWithin(0,3); return a4.join(',') }
    let a5 = [1,2,3,4,5]
    export let reverse = () => { a5.reverse(); return a5.join(',') }
    let a6 = [5,3,1,4,2]
    export let sort = () => { a6.sort(); return a6.join(',') }
    let a7 = [1,2,3,4,5]
    export let fill = () => { a7.fill(9,1,3); return a7.join(',') }
    let a8 = [1,2,3,4,5,6,7,8]
    a8.length = 5
    export let unshiftInPlace = () => { a8.unshift(9); return a8.join(',') }`,
    { optimize: false })
  const ops = {
    idx: '1,99,3,4,5', splice: '1,4,5', spliceIns: '1,99,4,5', copyWithin: '4,5,3,4,5',
    reverse: '5,4,3,2,1', sort: '1,2,3,4,5', fill: '1,9,9,4,5', unshiftInPlace: '9,1,2,3,4,5',
  }
  for (const [name, expect] of Object.entries(ops)) is(exports[name](), expect, `${name}: round 1`)
  exports._clear()
  for (const [name, expect] of Object.entries(ops)) is(exports[name](), expect, `${name}: round 2 — same answer as round 1, not round 1's leftover data`)
  exports._clear()
  for (const [name, expect] of Object.entries(ops)) is(exports[name](), expect, `${name}: round 3 — not a one-shot coincidence`)
})

// A `.length=` shrink-then-grow WITHIN one round re-enters indices a prior same-round
// truncate narrowed past — the undefined-fill loop for the grow overwrites TRUE
// original data with `undefined` unless the array-wide snapshot was taken before
// EITHER length write this round (not just the second one).
test('_clear() heals a durable array\'s data past a same-round shrink-then-grow `.length=` pair', () => {
  const { exports } = jz(`
    let a = [1,2,3,4,5]
    export let f = () => { a.length = 2; a.length = 5; return a.join(',') }`,
    { optimize: false })
  is(exports.f(), '1,2,undefined,undefined,undefined', 'round 1')
  exports._clear()
  is(exports.f(), '1,2,undefined,undefined,undefined', 'round 2 — same answer, not a further-eroded array')
})

// .shift()'s in-place rebasing is documented (module/array.js, __arr_shift's own
// comment) as INTENTIONALLY surviving `_clear()` — a durable array's header pointer
// permanently advances, treated as legitimate persistent state, not a per-round
// mutation to undo. This is a deliberate, narrower design choice than the element-data
// heal above: shift never corrupts any surviving element's VALUE (every element that
// survives a shift keeps its true original content, byte-for-byte — nothing here is a
// data-corruption bug), it only changes which physical cells count as "the array" —
// pinning the KNOWN, ACCEPTED behavior (compounds across rounds) so a future change
// to this design is a deliberate, visible diff here, not a silent regression.
test('_clear() does NOT heal .shift()\'s header rebasing (documented intentional, not a per-element data bug)', () => {
  const { exports } = jz(`
    let a = [1,2,3,4,5]
    export let f = () => a.shift()
    export let dump = () => a.join(',')`,
    { optimize: false })
  is(exports.f(), 1, 'round 1: shift returns the first element')
  is(exports.dump(), '2,3,4,5', 'round 1: remaining elements, in place')
  exports._clear()
  is(exports.f(), 2, 'round 2: NOT healed back to 1 — the rebasing persisted through _clear()')
  is(exports.dump(), '3,4,5', 'round 2: one element shorter than round 1 — compounds, by design')
})

// Relocation-forwarding bound check (layout.js followForwardingWat/ptrOffsetFwdWat):
// every ARRAY/SET/MAP/HASH pointer dereference validates its offset against
// "memory.size() * 65536" before trusting a cap=-1 forwarding sentinel. That bound
// used to be computed as `i32.shl(memory.size, 16)` — sound for every page count
// EXCEPT the wasm32 ceiling itself (memory.size()==65536 pages / 4 GiB), where
// 65536*65536 == 2^32 overflows i32 to exactly 0, making the bound "offset <= 0" —
// unsatisfiable for any real offset, so the forward-chase silently stops running for
// the rest of execution. A large-offset RUNTIME repro needs an actual ~4 GiB memory
// (exercised by the warm-kernel stress above, which drives a real build to that
// ceiling); this is the fast, host-level structural pin: the fix computes the same
// bound in i64 against a cached $__heap_end64 global (module/core.js, kept in sync by
// __memgrow) instead of recomputing the overflowing i32 shift at every dereference.
// Both counts are exact, not just "present" — 1 legitimate i32.shl(memory.size,16)
// survives (module/core.js's own $__heap_end assignment, whose wraparound is benign:
// __alloc's consumer just slow-paths one extra call, __memgrow re-derives everything
// fresh in i64 — see that file's comment); a regression back to the inline i32 bound
// at any forwarding site would push this count above 1.
test('followForwardingWat/ptrOffsetFwdWat bound check is i64 (not i32.shl(memory.size,16), which overflows to 0 at the wasm32 4GiB ceiling)', () => {
  const wat = compile(
    `export let f = (n) => { let xs = []; for (let i = 0; i < n; i++) xs.push(i); const m = new Map(); m.set(1, 2); return xs.length + m.size }`,
    { wat: true, optimize: 2 },
  )
  const shlMemSize = wat.match(/i32\.shl[\s\S]{0,3}\(memory\.size\)/g) || []
  is(shlMemSize.length, 1, 'exactly one i32.shl(memory.size,16) survives — __memgrow\'s own benign $__heap_end assignment')
  ok(/\$__heap_end64/.test(wat), 'forwarding-chase bound reads the cached i64 global')
  ok(/i64\.extend_i32_u/.test(wat), 'offset is widened to i64 before the bound compare')
})

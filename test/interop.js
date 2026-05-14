// jz/interop — standalone host-side ABI bridge.
//
// Validates that prebuilt jz wasm bytes can be instantiated and called using
// ONLY the `jz/interop` subpath (no compiler / parser / watr dep). The wasm is
// produced once via the full jz pipeline, then handed to the subpath as bytes.
//
// We import the subpath via its package specifier (`jz/interop`) — Node
// resolves it through the package.json exports map, exactly as a downstream
// consumer would. That doubles as a check that the exports map is correct.

import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import * as interop from 'jz/interop'
import * as interopNanbox from 'jz/interop/nanbox'

// ── subpath surface ─────────────────────────────────────────────────────────

test('interop: subpath surface matches expected exports', () => {
  for (const name of ['instantiate', 'memory', 'wrap', 'ptr', 'offset', 'type', 'aux',
                      'i64ToF64', 'f64ToI64', 'coerce', 'NULL_NAN', 'UNDEF_NAN']) {
    ok(name in interop, `jz/interop missing export: ${name}`)
  }
})

test('interop: `jz/interop` and `jz/interop/nanbox` resolve to the same module', () => {
  is(interop.instantiate, interopNanbox.instantiate, 'instantiate is the same fn')
  is(interop.memory, interopNanbox.memory, 'memory is the same fn')
})

test('interop: subpath file imports only wasi (no compiler/parser/watr)', async () => {
  // The whole point of the subpath: it can be loaded without dragging in the
  // compiler. Enforce it as a static contract — interop/nanbox.js must import
  // exactly one thing: `../wasi.js`. Any new dep here is a regression.
  const { readFileSync } = await import('node:fs')
  const url = await import.meta.resolve('jz/interop')
  const src = readFileSync(new URL(url), 'utf8')
  const importStmts = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
  is(importStmts.length, 1, `expected 1 import, got: ${importStmts.join(', ')}`)
  ok(importStmts[0].endsWith('wasi.js'),
    `interop subpath must import only wasi; got: ${importStmts[0]}`)
  // Defense in depth: also reject *import statements* for compiler-side
  // specifiers (substring match would catch the doc comment mentioning them).
  for (const forbidden of ['subscript', 'watr', './src/', './index.js']) {
    ok(!importStmts.some(s => s.includes(forbidden)),
      `interop must not import '${forbidden}'`)
  }
})

// ── prebuilt-wasm round-trip ────────────────────────────────────────────────
// Compile once via the full pipeline, then drive the resulting bytes through
// the subpath alone. Mirrors what a downstream "ship the .wasm" consumer does.

test('interop: instantiate prebuilt wasm — scalar args & return', () => {
  const wasm = compile(`export let add = (a, b) => a + b`)
  const { exports } = interop.instantiate(wasm)
  is(exports.add(2, 3), 5)
  is(exports.add(0.5, 0.25), 0.75)
})

test('interop: instantiate prebuilt wasm — string in, length out', () => {
  const wasm = compile(`export let len = (s) => s.length`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.len(memory.String('hello')), 5)
  is(exports.len(memory.String('')), 0)
  // ASCII-range coverage is enough for the interop test — multi-byte/codepoint
  // string semantics belong with the string suite.
  is(exports.len(memory.String('abcdefghij')), 10)
})

test('interop: instantiate prebuilt wasm — array in, reduce out', () => {
  const wasm = compile(`export let sum = (a) => a.reduce((s, x) => s + x, 0)`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.sum(memory.Array([1, 2, 3, 4])), 10)
  is(exports.sum(memory.Array([])), 0)
})

test('interop: instantiate prebuilt wasm — object schema round-trip', () => {
  // Plain arithmetic to keep the test about object marshaling, not pow precision.
  const wasm = compile(`export let f = (p) => p.x * 10 + p.y`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.f(memory.Object({ x: 3, y: 4 })), 34)
})

test('interop: instantiate prebuilt wasm — typed array in, scalar out', () => {
  // Returning a typed array crosses into jz-semantics territory (covered in
  // test/mem.js). Here we just prove a typed array marshals IN correctly.
  const wasm = compile(`export let sum = (buf) => buf[0] + buf[1] + buf[2]`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.sum(memory.Float64Array([1.5, 2.5, 3])), 7)
})

test('interop: instantiate accepts a WebAssembly.Module directly', () => {
  const wasm = compile(`export let f = (x) => x + 1`)
  const mod = new WebAssembly.Module(wasm)
  const { exports } = interop.instantiate(mod)
  is(exports.f(41), 42)
})

test('interop: instantiate accepts ArrayBuffer', () => {
  const wasm = compile(`export let f = () => 7`)
  // Slice into a fresh ArrayBuffer that's NOT a Uint8Array view
  const ab = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)
  const { exports } = interop.instantiate(ab)
  is(exports.f(), 7)
})

test('interop: imports option still routes through subpath', () => {
  const wasm = compile(`import { dbl } from "h"; export let f = (x) => dbl(x) + 1`,
    { imports: { h: { dbl: { params: 1 } } } })
  const { exports } = interop.instantiate(wasm, { imports: { h: { dbl: x => x * 2 } } })
  is(exports.f(20), 41)
})

test('interop: null/undefined sentinels round-trip', () => {
  const wasm = compile(`export let f = (x) => x`)
  const { exports } = interop.instantiate(wasm)
  is(exports.f(null), null)
  is(exports.f(undefined), undefined)
  is(exports.f(42), 42)
})

// ── NaN-box codec helpers (used by tooling around prebuilt wasm) ────────────

test('interop: ptr/offset/type/aux codec round-trips', () => {
  // type=4 (string), aux=0, offset=128
  const p = interop.ptr(4, 0, 128)
  is(interop.type(p), 4)
  is(interop.aux(p), 0)
  is(interop.offset(p), 128)
})

test('interop: i64ToF64 / f64ToI64 are bit-cast inverses', () => {
  const original = interop.ptr(6, 3, 1024)
  const asI64 = interop.f64ToI64(original)
  is(typeof asI64, 'bigint')
  is(interop.i64ToF64(asI64), original)
})

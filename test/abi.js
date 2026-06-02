// Non-JS consumer ABI — the "consumable by anything" contract, locked.
//
// A wasmtime/Rust/Go/Zig host runs prebuilt jz wasm with only (a) the exported
// allocator and (b) the documented quiet-NaN-box layout (layout.js) — no
// jz/interop, no i64 carrier, no jz:i64exp metadata. Every boundary value is an
// f64: a number is a plain f64; a tagged value (heap pointer / null|undef|bool
// atom) is a quiet NaN (0x7FF8) whose payload carries the PTR tag + offset, which
// every engine preserves across the call boundary. These tests reconstruct that
// host by hand. If they break, the cross-language promise broke.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { PTR, ATOM, encodePtrHi, decodePtrType, decodePtrAux } from '../layout.js'

// 8-byte scratch: f64 <-> (hi,lo) u32 bit views. No BigInt, no interop helpers —
// exactly what a non-JS host does with a union / reinterpret_cast.
const _ab = new ArrayBuffer(8), _u = new Uint32Array(_ab), _f = new Float64Array(_ab)
const box = (type, aux, off) => { _u[1] = encodePtrHi(type, aux); _u[0] = off >>> 0; return _f[0] }
// A tagged value is a quiet NaN with jz's exponent prefix (high bits 19–30 all set);
// the 4-bit type sits in bits 15–18 *below* the prefix, so this test is type-invariant.
const tag = (v) => { _f[0] = v; return { type: decodePtrType(_u[1]), aux: decodePtrAux(_u[1]), off: _u[0], nan: (_u[1] & 0x7FF80000) === 0x7FF80000 } }

// Instantiate a portable (wasi-target) module with NO interop. Pure-compute jz
// imports nothing, so a raw Instance with no import object suffices.
const raw = (src) => {
  const mod = new WebAssembly.Module(compile(src, { host: 'wasi' }))
  const inst = new WebAssembly.Instance(mod, WebAssembly.Module.imports(mod).length ? {} : undefined)
  return { mod, e: inst.exports }
}
const noI64 = (mod) => WebAssembly.Module.customSections(mod, 'jz:i64exp').length === 0

test('abi: the carrier is signature-self-describing — no jz:i64exp anywhere', () => {
  for (const src of [
    'export let add = (a, b) => a + b',
    'export let sum = (a) => a[0] + a[1]',
    'export let mk = (x, y) => ({ x, y })',
    'export let pos = (x) => x > 0',
  ]) ok(noI64(raw(src).mod), `no jz:i64exp: ${src.slice(11, 24)}`)
})

test('abi: scalar f64 in/out passes straight through (unwrapped export)', () => {
  const { e } = raw('export let add = (a, b) => a + b')
  is(e.add(2, 3), 5)
  is(e.add(-1.5, 0.5), -1)
})

test('abi: a raw host builds an array pointer (alloc + header + f64 elems)', () => {
  const { e } = raw('export let sum = (a) => a[0] + a[1] + a[2]')
  const dv = new DataView(e.memory.buffer)
  const p = e._alloc(16 + 24)        // 16-byte header + 3×f64
  dv.setBigInt64(p, 0n, true)        // [+0]  propsPtr (i64 = 0)
  dv.setInt32(p + 8, 3, true)        // [+8]  len
  dv.setInt32(p + 12, 3, true)       // [+12] cap
  const data = p + 16
  ;[10, 20, 30].forEach((v, i) => dv.setFloat64(data + i * 8, v, true))
  is(e.sum(box(PTR.ARRAY, 0, data)), 60)
})

test('abi: a boolean result is an f64 quiet-NaN atom (no i64 carrier)', () => {
  const { e } = raw('export let pos = (x) => x > 0')
  const t = tag(e.pos(5)), f = tag(e.pos(-5))
  ok(t.nan && t.type === PTR.ATOM && t.aux === ATOM.TRUE, 'pos(5) → TRUE atom')
  ok(f.nan && f.type === PTR.ATOM && f.aux === ATOM.FALSE, 'pos(-5) → FALSE atom')
})

test('abi: an object result is an f64 NaN-box readable by layout alone', () => {
  const { e } = raw('export let mk = (x, y) => ({ x, y })')
  const r = tag(e.mk(3, 4))
  ok(r.nan && r.type === PTR.OBJECT, 'mk → OBJECT NaN-box')
  const dv = new DataView(e.memory.buffer)
  is(dv.getFloat64(r.off, true), 3, 'field x at +0')
  is(dv.getFloat64(r.off + 8, true), 4, 'field y at +8')
})

// Non-JS consumer ABI — the "consumable by anything" contract, locked.
//
// A wasmtime/Rust/Go/Zig host runs prebuilt jz wasm with (a) the exported allocator,
// (b) the documented NaN-box layout (layout.js), and (c) the wasm function SIGNATURE,
// which is self-describing: a numeric param/result is `f64`; a value that can be a
// NaN-box — heap pointer, null|undef|bool atom, bigint, or a dynamic value — is `i64`
// carrying the box bits directly. The i64 carrier means no host ever depends on an
// engine preserving f64 NaN payloads across the boundary (JSC/Safari does NOT). A JS
// host reads the carrier map from the `jz:i64exp` custom section; a typed host (Rust/Go)
// reads it straight off the function type. Same binary, same contract, every host.
// These tests reconstruct a raw host by hand. If they break, the cross-language promise broke.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { PTR, ATOM, encodePtrHi, decodePtrType, decodePtrAux } from '../layout.js'

// Decode an i64 box — the u64 a raw host receives from an i64 result (BigInt in JS,
// plain int64 in Rust/Go) — with integer ops only. No f64 reinterpret, no interop.
const unbox = (b) => {
  const hi = Number((b >> 32n) & 0xFFFFFFFFn), off = Number(b & 0xFFFFFFFFn)
  return { type: decodePtrType(hi), aux: decodePtrAux(hi), off, nan: (hi & 0x7FF80000) === 0x7FF80000 }
}
// Inverse: build the i64 box from (type, aux, offset) to pass a pointer into an i64 param.
const mkbox = (type, aux, off) => (BigInt(encodePtrHi(type, aux)) << 32n) | BigInt(off >>> 0)
// A raw host passing a NUMBER to a dynamic (i64) param reinterprets the f64 bits → i64,
// exactly a `union { double; uint64_t }` / `f64.to_bits()`. No interop, no BigInt math.
const _ab = new ArrayBuffer(8), _f = new Float64Array(_ab), _i = new BigInt64Array(_ab)
const numI64 = (n) => { _f[0] = n; return _i[0] }

// Instantiate a portable (wasi-target) module with NO interop. Pure-compute jz imports
// nothing, so a raw Instance suffices. Exports are used RAW — no adaptI64 — exactly as a
// non-JS host sees them (i64 results arrive as BigInt; i64 params take BigInt).
const raw = (src) => {
  const mod = new WebAssembly.Module(compile(src, { host: 'wasi' }))
  const inst = new WebAssembly.Instance(mod, WebAssembly.Module.imports(mod).length ? {} : undefined)
  return { mod, e: inst.exports }
}
const i64Map = (mod) => {
  const s = WebAssembly.Module.customSections(mod, 'jz:i64exp')
  return s.length ? JSON.parse(new TextDecoder().decode(s[0])) : []
}

test('abi: numeric exports stay f64 — no i64 carrier, no jz:i64exp entry', () => {
  // A pure number-in/number-out export needs no boxing: it crosses as plain f64 and emits
  // no carrier metadata. Zero footprint off the box path (the DSP/bench hot shape).
  for (const src of ['export let add = (a, b) => a + b', 'export let sq = (x) => x * x'])
    is(i64Map(raw(src).mod).length, 0, `no i64exp: ${src.slice(11, 22)}`)
})

test('abi: scalar f64 in/out passes straight through', () => {
  const { e } = raw('export let add = (a, b) => a + b')
  is(e.add(2, 3), 5)
  is(e.add(-1.5, 0.5), -1)
})

test('abi: a boxed result crosses as i64 the host decodes by layout alone', () => {
  // Object result → i64 box; a raw host masks tag/offset off the u64 directly — no f64
  // reinterpret, so no NaN-canonicalization exposure on any engine.
  const { mod, e } = raw('export let mk = (x, y) => ({ x, y })')
  ok(i64Map(mod).some(x => x.name === 'mk' && x.r), 'mk marked i64-result in jz:i64exp')
  // x, y are dynamic params (the object can hold any value) → i64; a raw host reinterprets
  // the numbers to i64 bits to pass them.
  const r = unbox(e.mk(numI64(3), numI64(4)))
  ok(r.nan && r.type === PTR.OBJECT, 'mk → OBJECT box')
  const dv = new DataView(e.memory.buffer)
  is(dv.getFloat64(r.off, true), 3, 'field x at +0')
  is(dv.getFloat64(r.off + 8, true), 4, 'field y at +8')
})

test('abi: a boolean result is an i64 atom box (TRUE/FALSE)', () => {
  const { e } = raw('export let pos = (x) => x > 0')
  const t = unbox(e.pos(5)), f = unbox(e.pos(-5))
  ok(t.nan && t.type === PTR.ATOM && t.aux === ATOM.TRUE, 'pos(5) → TRUE atom')
  ok(f.nan && f.type === PTR.ATOM && f.aux === ATOM.FALSE, 'pos(-5) → FALSE atom')
})

test('abi: a raw host builds an array pointer and passes it as an i64 param', () => {
  const { mod, e } = raw('export let sum = (a) => a[0] + a[1] + a[2]')
  ok(i64Map(mod).some(x => x.name === 'sum' && x.p.includes(0)), 'sum param 0 marked i64')
  const dv = new DataView(e.memory.buffer)
  const p = e._alloc(16 + 24)        // 16-byte header + 3×f64
  dv.setBigInt64(p, 0n, true)        // [+0]  propsPtr (i64 = 0)
  dv.setInt32(p + 8, 3, true)        // [+8]  len
  dv.setInt32(p + 12, 3, true)       // [+12] cap
  const data = p + 16
  ;[10, 20, 30].forEach((v, i) => dv.setFloat64(data + i * 8, v, true))
  is(e.sum(mkbox(PTR.ARRAY, 0, data)), 60)   // i64 param: pass the box bits as u64 directly
})

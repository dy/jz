// Raw non-JS consumer ABI — internally locked for each emitted binary.
// This guards compiler/host agreement, not cross-release stability: a prebuilt
// module loads with the interop of the jz that built it, and the high-level
// wrapper is the public embedder contract.
//
// A wasmtime/Rust/Go/Zig host runs prebuilt jz wasm with (a) the exported allocator,
// (b) the documented NaN-box layout (layout.js), and (c) the wasm function SIGNATURE,
// which is self-describing: a numeric param/result is `f64`; a value that can be a
// NaN-box — heap pointer, null|undef|bool atom, bigint, or a dynamic value — is `i64`
// carrying the box bits directly. The i64 carrier means no host ever depends on an
// engine preserving f64 NaN payloads across the boundary (JSC/Safari does NOT). A JS
// host reads the carrier map from the `jz:i64exp` custom section; a typed host (Rust/Go)
// reads it straight off the function type. Same binary, same contract, every host.
// These tests reconstruct a raw host by hand. If they break, that binary is internally inconsistent.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { PTR, ATOM, encodePtrHi, decodePtrType, decodePtrAux } from '../layout.js'
import { scalarCase } from './_scalar-core-cases.js'

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
  for (const src of [scalarCase('abi-add').source, scalarCase('abi-square').source])
    is(i64Map(raw(src).mod).length, 0, `no i64exp: ${src.slice(11, 22)}`)
})

test('abi: scalar f64 in/out passes straight through', () => {
  const { e } = raw(scalarCase('abi-add').source)
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
  const p = e.__jz_alloc(16 + 24)        // 16-byte header + 3×f64
  dv.setBigInt64(p, 0n, true)        // [+0]  propsPtr (i64 = 0)
  dv.setInt32(p + 8, 3, true)        // [+8]  len
  dv.setInt32(p + 12, 3, true)       // [+12] cap
  const data = p + 16
  ;[10, 20, 30].forEach((v, i) => dv.setFloat64(data + i * 8, v, true))
  ok(i64Map(mod).some(x => x.name === 'sum' && x.r), 'unknown array elements keep the dynamic result carrier')
  is(e.sum(mkbox(PTR.ARRAY, 0, data)), numI64(60))   // i64 param: pass the box bits as u64 directly
})

// The ABI is every export the program does not declare: `memory`, `_initialize`,
// a WASI command's `_start` and the `__jz_` prefix. The host's namespace holds
// the program's exports alone; a program export cannot take `memory` or a `__jz_` name.
const ABI_NAME = /^(?:memory|_initialize|_start)$|^__jz_/
test('abi: exports holds the program\'s exports, the module the ABI', async () => {
  const { default: jz } = await import('../index.js')
  const small = jz('export let add = (a, b) => a + b; export let s = (x) => "ab" + x', { host: 'js' })
  is(Object.keys(small.exports), ['add', 's'], 'a string module: its two functions')
  ok(Object.keys(small.instance.exports).some(n => n === '__jz_alloc') && 'memory' in small.instance.exports, 'the allocator and memory stay on the instance')
  const big = jz(`export let counter = () => { let n = 0; return { next: () => ++n } }
    export let later = async (x) => { await 0; return x + 1 }
    export class P { constructor(x) { this.x = x } get d() { return this.x * 2 } m() { return this.x } }
    export let sym = Symbol('s'); export let n = 5; export let bump = () => { n++ }
    export let sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }`, { host: 'js' })
  is(Object.keys(big.exports).sort(), ['P', 'bump', 'counter', 'later', 'n', 'sum', 'sym'], 'closures, async, a class, values and a typed kernel')
  for (const name of Object.keys(big.instance.exports)) if (!(name in big.exports)) ok(ABI_NAME.test(name), `${JSON.stringify(name)} is an ABI name`)
  is(await big.exports.later(1), 2, 'the async boundary works through its ABI exports')
  is(big.exports.counter().next(), 1, 'closures call through the trampoline')
  is(new big.exports.P(3).d, 6, 'class members come from their ABI exports')
})

test('abi: a program export cannot take an ABI name', () => {
  for (const [src, name] of [['export let memory = (x) => x + 1', 'memory'],
    ['let a = 1\nexport { a as __jz_alloc }', '__jz_alloc'], ['export * from "./m.js"', 'memory']]) {
    let error
    try { compile(src, { modules: { './m.js': 'export let memory = 1' } }) } catch (e) { error = e }
    ok(error && error.message.includes(`export '${name}'`) && /at line \d+:\d+/.test(error.message), `${name}: a located compile error (${error?.message.split('\n')[0]})`)
  }
  ok(compile('export let _alloc = (x) => x + 1, _clear = 2, run = 3'), 'the former ABI names are the program\'s')
  // a program's own _initialize or _start is its WASI entry, jz's init run first (test/wasi.js)
  for (const host of ['js', 'wasi']) ok(new WebAssembly.Module(compile('console.log(1)\nexport let _initialize = () => 2, _start = () => 3', { host })), `${host}: _initialize and _start compile to one export each`)
})

// jz/interop — standalone host-side boundary bridge.
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
import { onWasi, onKernel } from './_matrix.js'

// ── subpath surface ─────────────────────────────────────────────────────────

test('interop: subpath surface matches expected exports', () => {
  for (const name of ['instantiate', 'toModule', 'memory', 'wrap', 'ptr', 'offset', 'type', 'aux',
                      'i64ToF64', 'f64ToI64', 'coerce', 'NULL_NAN', 'UNDEF_NAN']) {
    ok(name in interop, `jz/interop missing export: ${name}`)
  }
})

test('interop: instantiate works on baseline wasm', () => {
  const wasm = compile(`export let f = (x) => x + 1`)
  const { exports } = interop.instantiate(wasm)
  is(exports.f(41), 42)
})

test('package: root and every public subpath ship declarations; pointer carriers are bigint', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const root = new URL('../', import.meta.url)
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  for (const subpath of ['.', './interop', './wasi', './transform']) {
    const entry = pkg.exports[subpath]
    ok(entry && typeof entry === 'object' && entry.types, `${subpath} has a types export`)
    ok(existsSync(new URL(entry.types.replace(/^\.\//, ''), root)), `${entry.types} exists`)
    ok(pkg.files.includes(entry.types.replace(/^\.\//, '')), `${entry.types} ships in npm files`)
  }
  const rootTypes = readFileSync(new URL('index.d.ts', root), 'utf8')
  ok(rootTypes.includes('export type JzPointer = bigint'), 'public pointer carrier is bigint')
  ok(!/String\(str: string\): number/.test(rootTypes), 'string allocator is not mistyped as number')
  for (const name of ['interop.d.ts', 'wasi.d.ts', 'transform.d.ts'])
    ok(readFileSync(new URL(name, root), 'utf8').length > 0, `${name} is non-empty`)
})

test('interop: subpath stays compiler-free — only wasi.js and layout.js outside its file', async () => {
  // The whole point of the subpath: it can be loaded without dragging in the
  // compiler. Enforce it as a static contract — `jz/interop` may import only
  // `./wasi.js`, `./layout.js`, and `./err-codes.js` (the $__jz_err code→message
  // table — a leaf data module, same shape as layout.js, no compile machinery).
  // Any new dep here is a regression.
  const { readFileSync } = await import('node:fs')
  const url = await import.meta.resolve('jz/interop')
  const src = readFileSync(new URL(url), 'utf8')
  const imports = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
  const allowed = new Set(['./wasi.js', './layout.js', './err-codes.js'])
  for (const imp of imports) {
    ok(allowed.has(imp), `jz/interop imports ${imp} — only ${[...allowed].join(', ')} are allowed`)
    for (const forbidden of ['subscript', 'watr', './src/', './index.js', './module/']) {
      ok(!imp.includes(forbidden), `jz/interop must not import '${forbidden}'`)
    }
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
  if (onWasi()) return  // wasi: external object
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
  if (onKernel()) return  // kernel: host {imports} option doesn't reach the single-source self-compile
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
  // ptr() now yields the i64 carrier directly (a BigInt) — no NaN-box ever materializes as f64.
  const box = interop.ptr(6, 3, 1024)
  is(typeof box, 'bigint')
  // i64→f64→i64 round-trips the bits losslessly (the f64 form is intact on V8).
  is(interop.f64ToI64(interop.i64ToF64(box)), box)
  // and the plain-number direction is a clean inverse.
  is(interop.i64ToF64(interop.f64ToI64(3.5)), 3.5)
})

test('interop: boxes carry as i64 BigInt, never an f64 NaN-box (JSC-safe codec)', () => {
  // The Safari fix in one assertion: a box must never become a JS number (f64), or JSC
  // canonicalizes its NaN payload mid-decode. Every box-producing codec entry yields a BigInt,
  // and numbers stay numbers. (Reverting the codec to an f64 representation fails this.)
  is(typeof interop.ptr(4, 0, 1024), 'bigint')
  for (const atom of [interop.NULL_NAN, interop.UNDEF_NAN, interop.TRUE_NAN, interop.FALSE_NAN]) is(typeof atom, 'bigint')
  const { memory, exports } = interop.instantiate(compile('export let f = () => "hello world"'))
  is(typeof memory.String('hello world'), 'bigint')
  is(typeof memory.Array([1, 2, 3]), 'bigint')
  is(typeof memory.Uint8Array([1, 2]), 'bigint')
  is(typeof interop.coerce(null), 'bigint')      // null/undefined coerce to atom boxes
  is(interop.coerce(1.5), 1.5)                   // a number is left a number
  is(exports.f(), 'hello world')                 // and the boxed result still decodes correctly
})

// ── zero-copy I/O: allocTyped + Uint8Array memcpy ───────────────────────────

test('interop: Uint8Array arg crosses via native memcpy (correct for stride-1)', () => {
  // Regression: the inbound TypedArray path gated the fast `.set` memcpy on stride>=2,
  // so a Uint8Array (stride 1, e.g. a whole audio file) fell to a per-byte DataView
  // loop — slow, and a silent miscompile would surface here as a wrong sum.
  const { exports } = interop.instantiate(compile(`
    export let sum = (b) => { let n = b.length, s = 0; for (let i = 0; i < n; i++) s += b[i]; return s }
  `))
  const data = new Uint8Array(1000)
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff
  let expect = 0; for (let i = 0; i < data.length; i++) expect += i & 0xff
  is(exports.sum(data), expect)
})

test('interop: memory.allocTyped gives a live view + box for zero-copy input', () => {
  const { exports, memory } = interop.instantiate(compile(`
    export let dec = (b) => { let n = b.length, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b[i] / 255; return o }
  `))
  const { view, box } = memory.allocTyped(Uint8Array, 4)
  ok(view instanceof Uint8Array, 'view is a Uint8Array')
  ok(view.buffer === memory.buffer, 'view aliases wasm memory (zero-copy)')
  ok(typeof box === 'bigint', 'box is an i64 carrier')
  view.set([0, 64, 128, 255])               // fill the wasm-memory region directly
  const out = exports.dec(box)              // decoder reads in place — no 2nd copy
  ok(out.buffer === memory.buffer, 'result is a zero-copy view over wasm memory')
  is(out[0], 0); is(Math.round(out[3] * 255), 255)
  // matches the ordinary marshaled path
  const out2 = exports.dec(new Uint8Array([0, 64, 128, 255]))
  is(out2[2], out[2])
})

// decodeThrown / jz:schema (watr downstream CI, 2026-08): a thrown Error's
// `.message` decodes through mem.read's generic OBJECT case, which indexes
// `mem.schemas[sid]` positionally (compile/index.js's jz:schema writer:
// "entry index === schema id"). The reader used to merge incoming entries
// into `mem.schemas` by CONTENT alone (`props.join(',')`) — sound for
// ordinary object schemas (content really does mean "same shape" there),
// unsound for the 7 built-in Error classes, which module/schema.js
// deliberately keeps as SEPARATE compile-time ids sharing the identical
// physical prop list ['message','name'] (distinguished only by a `salt`
// — the class name — folded into ctx.schema.register's dedup key, never
// serialized into the jz:schema bytes themselves). Registering 2+ of the
// 7 collapsed every one after the first into ONE runtime index, shifting
// every later sid's position — so the SECOND (and later) Error class
// registered in a program decoded its thrown `.message` as `undefined`
// (mem.schemas[sid] resolves to some OTHER, unrelated, usually zero-field
// schema). This is the live-schema sibling of the dead-schema collision
// compile/index.js's jz:schema writer already names and fixes (its
// `[String(id)]` placeholder covers only entries with no salt to lose).
// Root cause: interop.js's read-side dedup key didn't mirror
// ctx.schema.register's write-side key (which folds in `salt`) — fixed by
// reading jz:errcls first and computing the identical salted key while
// merging jz:schema.
//
// This exact shape was watr's own downstream CI failure ("case: error on
// unknown instruction: should throw", compile.js's `err()` — a SECOND
// built-in Error class had already been registered elsewhere in the
// program by the time this one threw, e.g. `err()`'s own — the corruption
// throws off every Error class after the first one used anywhere in the
// module, not just at this call site).
for (const optimize of [false, 2, 3]) {
  const lbl = `O${optimize || 0}`
  test(`interop: decodeThrown recovers .message for EVERY built-in Error class in one module, not just the first (${lbl})`, () => {
    const { exports } = interop.instantiate(compile(`
      export let f = (which) => {
        if (which === 0) throw new TypeError('type problem')
        if (which === 1) throw new RangeError('range problem')
        if (which === 2) throw new SyntaxError('syntax problem')
        throw Error('generic problem')
      }
    `, { optimize }))
    const expect = [
      ['TypeError', 'type problem'],
      ['RangeError', 'range problem'],
      ['SyntaxError', 'syntax problem'],
      ['Error', 'generic problem'],
    ]
    expect.forEach(([name, message], which) => {
      try {
        exports.f(which)
        ok(false, `${name}: should throw`)
      } catch (e) {
        is(e.constructor.name, name, `${name}: class`)
        is(e.message, message, `${name}: message survives (not the empty-schema collision)`)
      }
    })
  })
}

test('interop: allocTyped rejects an unsupported ctor', () => {
  const { memory } = interop.instantiate(compile('export let f = () => 1'))
  throws(() => memory.allocTyped(Array, 4))
})

// ── numeric export boundary ─────────────────────────────────────────────────
// A proven-numeric param is an f64 slot; every box-capable param takes the i64
// lane (jz:i64exp). The wrapper hands an f64 slot the host value untouched, so the
// WebAssembly JS-API's ToNumber at the call is the exact JS coercion.

test('interop: an f64 slot receives the host value raw — ToNumber semantics of the JS-API', () => {
  const { exports } = interop.instantiate(compile(`
    export let dbl = (x) => x * 2
    export let neg = (x) => -x
    export let dec = (x) => x - 1
    export let poly = (x) => x * x * 0.5 + 3`))
  is(exports.dbl(null), 0)
  ok(Number.isNaN(exports.dbl(undefined)))
  is(exports.dbl('8'), 16)
  is(exports.dbl(true), 2)
  is(exports.dbl([4]), 8)
  is(exports.dbl({ valueOf: () => 21 }), 42)
  ok(Number.isNaN(exports.dbl('abc')))
  is(Object.is(exports.neg(null), -0), true, '-null is -0 in JS')
  is(exports.dec(null), -1)
  is(exports.poly('8'), 35)
  is(exports.poly(), NaN)
  throws(() => exports.dbl(1n), TypeError, 'a plain BigInt into a numeric slot is a TypeError, as in JS')
})

test('interop: the `x = +x` guard on a numeric export is free', () => {
  // The guard used to route through __to_num on the raw bits and pull the whole
  // ToNumber string-parse runtime (~18 KB) into a 40-byte kernel. The unary plus on a
  // proven number is identity; the host already applied ToNumber at the f64 slot.
  const guarded = compile(`export let f = x => { x = +x; return x * x * 0.5 + 3 }`)
  const bare = compile(`export let f = x => x * x * 0.5 + 3`)
  ok(guarded.length <= bare.length + 2, `guarded ${guarded.length} B vs bare ${bare.length} B`)
  const { exports } = interop.instantiate(guarded)
  is(exports.f('8'), 35)
  is(exports.f(null), 3)
  ok(Number.isNaN(exports.f(undefined)))
})

test('interop: a box-capable export param never rides the f64 lane', () => {
  // `Math.sumPrecise` takes an iterable, `x >= "9"` compares strings lexicographically:
  // neither is a numeric proof, so the param crosses as i64 and the wrapper boxes it.
  const lanes = (src) => {
    const s = WebAssembly.Module.customSections(interop.toModule(compile(src)), 'jz:i64exp')
    return s.length ? JSON.parse(new TextDecoder().decode(s[0])).find(e => e.name === 'f')?.p ?? [] : []
  }
  is(lanes(`export let f = (a) => Math.sumPrecise(a)`)[0], 0, 'sumPrecise arg is i64')
  is(lanes(`export let f = (x) => x >= "9"`)[0], 0, 'string-literal relational partner is i64')
  is(lanes(`export let f = (x) => x >= 9`).length, 0, 'numeric relational partner stays f64')
  is(lanes(`export let f = (x) => Math.sin(x)`).length, 0, 'Math.sin arg stays f64')
  const { exports } = interop.instantiate(compile(`export let f = (x) => x >= "9"`))
  is(exports.f(10), true)
  is(exports.f('10'), false)
})

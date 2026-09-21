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
import jz, { compile } from '../index.js'
import * as interop from 'jz/interop'
import { onWasi, onKernel, levels } from './_matrix.js'

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
  for (const subpath of ['.', './interop']) {
    const entry = pkg.exports[subpath]
    ok(entry && typeof entry === 'object' && entry.types, `${subpath} has a types export`)
    ok(existsSync(new URL(entry.types.replace(/^\.\//, ''), root)), `${entry.types} exists`)
    ok(pkg.files.includes(entry.types.replace(/^\.\//, '')), `${entry.types} ships in npm files`)
  }
  const rootTypes = readFileSync(new URL('index.d.ts', root), 'utf8')
  ok(rootTypes.includes('export type JzPointer = bigint'), 'public pointer carrier is bigint')
  ok(!/String\(str: string\): number/.test(rootTypes), 'string allocator is not mistyped as number')
  for (const name of ['interop.d.ts'])
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

test('interop: property dispatch converts once regardless of declaration order', () => {
  if (onWasi() || onKernel()) return
  const named = `export function named(){return get().value}`
  const computed = `export function f(k){let calls=0;const key={toString(){calls++;return k}};
    const o=get();return [o[key],calls]}`
  for (const declarations of [[computed, named], [named, computed], [computed]])
  for (const optimize of levels(0, 2, 3, 'size')) {
    let value = 7, reads = 0
    const object = new class { get value() { reads++; return value } }
    const src = `import {get} from 'host'; ${declarations.join('\n')}`
    const bytes = compile(src, { optimize, imports: { host: { get: { params: 0 } } } })
    const { exports } = interop.instantiate(bytes, { imports: { host: { get: () => object } } })
    for (const next of [7, 7, 13, undefined, 7]) {
      value = next
      is(exports.f('value'), [value, 1], `O${optimize}: computed host property`)
      is(exports.f('absent'), [undefined, 1], `O${optimize}: missing host property`)
      if (exports.named) is(exports.named(), value, `O${optimize}: prehashed host property`)
    }
    is(reads, exports.named ? 10 : 5, 'one host getter invocation per present-key read')
  }
})

test('interop: computed host reads preserve empty keys, errors and optional receivers', () => {
  if (onWasi() || onKernel()) return
  const src = `export function read(o,k){return o[k]}
    export function optional(o,k){return o?.[k]}`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { exports } = interop.instantiate(compile(src, { optimize }))
    const a = new class { get value() { return 7 } get bad() { throw new RangeError('host getter') } }
    const b = new class { get value() { return 13 } }
    a[''] = 9
    for (const obj of [a, a, b, a]) {
      for (const key of ['value', '', 'missing']) {
        is(exports.read(obj, key), obj[key], `O${optimize}: direct ${key}`)
        is(exports.optional(obj, key), obj?.[key], `O${optimize}: optional ${key}`)
      }
    }
    for (const obj of [null, undefined]) {
      is(exports.optional(obj, 'value'), undefined, `O${optimize}: optional nullish`)
      throws(() => exports.read(obj, 'value'), TypeError, `O${optimize}: nullish receiver`)
    }
    throws(() => exports.read(a, 'bad'), RangeError, 'host getter failure propagates')
    is(exports.read(a, 'value'), 7, 'same instance works after a throwing getter')
    for (const src of [
      `export function f(){let k='Math';return globalThis[k].PI}`,
      `function read(o,k){return o[k]} export function f(){return read(globalThis,'Math').PI}`,
      `function read(o,k){return o[k].PI} export function f(){return read(globalThis,'Math')}`
    ]) {
      const global = interop.instantiate(compile(src, { optimize }))
      is(global.exports.f(), Math.PI, 'host-global ingress reaches a reader emitted before its caller')
    }
  }
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
for (const optimize of levels(false, 2, 3)) {
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
  ok(guarded.length <= bare.length + 8, `guarded ${guarded.length} B vs bare ${bare.length} B`)
  ok(!/__to_num/.test(compile(`export let f = x => { x = +x; return x * x * 0.5 + 3 }`, { wat: true })), 'no ToNumber runtime')
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

// ── numeric array-like export parameters ────────────────────────────────────
// A parameter the body only indexes, measures, writes by element, forwards to
// a function that does the same, or returns, is a numeric array-like: the
// wrapper normalizes the host value to a Float64Array copy at entry and, when
// the body writes it, copies the storage back after the call. The body reads
// and writes typed storage directly: no receiver fork, no ToNumber runtime.

test('interop: a numeric array-like parameter is typed storage inside, any array-like outside', () => {
  const src = `function sum(w, t) { let s = 0; for (let i = 0; i < t.length; i++) s += w[i] * t[i]; return s }
    export let fit = (target) => { let w = new Float64Array(target.length); for (let i = 0; i < w.length; i++) w[i] = i; return sum(w, target) }
    export let first = (a) => a[1] * 10 + a.length`
  const bytes = compile(src)
  ok(bytes.length < 2000, `${bytes.length} bytes: no fork, no ToNumber runtime`)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  is(lanes.find(e => e.name === 'fit').t['0'], 'Float64Array')
  const { exports } = interop.instantiate(bytes)
  is(exports.fit([1, 2, 3]), 8)
  is(exports.fit(new Float64Array([1, 2, 3])), 8)
  is(exports.fit(new Float32Array([1, 2, 3])), 8)
  is(exports.fit(new Uint8Array([1, 2, 3])), 8)
  is(exports.first([5, 6, 7]), 63)
  throws(() => exports.fit(null), TypeError, 'null is not array-like, as JS would throw on null.length')
})

test('interop: a written array-like parameter copies its storage back to the host', () => {
  const src = `export let scale = (a, k) => { for (let i = 0; i < a.length; i++) a[i] *= k; return a }`
  const { exports, memory } = interop.instantiate(compile(src))
  const arr = [1, 2, 3], f64 = new Float64Array([1, 2, 3]), f32 = new Float32Array([1, 2, 3])
  const out = exports.scale(arr, 2)
  is(arr.join(), '2,4,6', 'a plain array is written back')
  is(out.join(), '2,4,6', 'the returned storage holds the result')
  exports.scale(f64, 3)
  is(f64.join(), '3,6,9')
  exports.scale(f32, 10)
  is(f32.join(), '10,20,30', 'another element kind is written back through set')
  const buf = memory.Float64Array([1, 2, 3])
  exports.scale(buf, 5)
  is(Array.from(memory.read(buf)).join(), '5,10,15', 'a jz buffer stays a live view')
})

test('interop: numeric output-only buffers use typed storage and copy back on repeated calls', () => {
  const src = `export let fill = (out, n) => { for (let i = 0; i < n; i++) out[i] = i * 0.5 + 1 }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const bytes = compile(src, { optimize })
    const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
    is(lanes.find(e => e.name === 'fill').t['0'], 'Float64Array+', 'numeric stores prove an output buffer without an element read')
    const wat = compile(src, { optimize, wat: true })
    ok(!/\(func \$__(?:arr_typed_obj_set_idx|to_str|dyn_set)\b/.test(wat), 'a proven output buffer links no object/key conversion runtime')
    const { exports } = interop.instantiate(bytes)
    const a = [9, 9, 9], b = new Float32Array([8, 8])
    exports.fill(a, 0)
    is(a.join(), '9,9,9', 'zero work preserves storage')
    exports.fill(a, 2)
    is(a.join(), '1,1.5,9', 'partial fill preserves the tail')
    exports.fill(a, 3)
    is(a.join(), '1,1.5,2', 'A to A fills the final element')
    exports.fill(b, 2)
    is(b.join(), '1,1.5', 'A to different B copies back to the new receiver')
    const empty = []
    exports.fill(empty, 0)
    is(empty.length, 0, 'empty output remains empty')
    throws(() => exports.fill(null, 1), TypeError)
  }
})

test('interop: one numeric store cannot type an otherwise unknown output buffer', () => {
  const src = `export let mixed = (out, v) => { out[0] = 1; out[1] = v }
    export let copy = (out, src) => { for (let i = 0; i < 2; i++) out[i] = src[i] }
    export let unstable = (out, v) => { let x = 1; x = v; out[0] = x }
    export let boolean = (out, v) => { out[0] = v > 0 ? true : 1 }
    export let nullable = (out, v) => { out[0] = v > 0 ? null : 1 }`
  const bytes = compile(src)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  for (const name of ['mixed', 'copy', 'unstable', 'boolean', 'nullable'])
    is(lanes.find(e => e.name === name).t?.['0'], undefined, `${name}: unknown stored values retain the generic boundary`)
})

test('interop: numeric input contracts propagate to output buffers independently of parameter order', () => {
  const src = `export let map = (out, input, n) => {
    for (let i = 0; i < n; i++) out[i] = input[i] + input[i] * 0.5
  }`
  const bytes = compile(src)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  const entry = lanes.find(e => e.name === 'map')
  is(entry.t['0'], 'Float64Array+', 'output is typed after the input contract settles')
  is(entry.t['1'], 'Float64Array', 'input elements are numeric')
  const { exports } = interop.instantiate(bytes)
  const out = [7, 7, 7]
  exports.map(out, new Float32Array([2, 4, 6]), 0)
  is(out.join(), '7,7,7')
  exports.map(out, new Float32Array([2, 4, 6]), 3)
  is(out.join(), '3,6,9')
})

test('interop: typed views, typed methods and accumulators keep an array-like parameter typed', () => {
  const src = `export let head = (data, n) => { let h = data.subarray(0, n); let s = 0; for (let i = 0; i < h.length; i++) s += h[i]; return s }
    export let fillz = (data) => { data.fill(0); data[0] = 7; return data.length }
    export let copy = (dst, src) => { dst.set(src); return dst[1] * 2 }
    export let keyed = (o, k) => o[k]
    export let chars = (s) => { let buf = ''; for (let i = 0; i < s.length; i++) buf = buf + s[i]; return buf.length }`
  const bytes = compile(src)
  const lanes = Object.fromEntries(JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0])).map(e => [e.name, e.t ?? null]))
  is(lanes.head['0'], 'Float64Array', 'a subarray view of the parameter is the same storage')
  is(lanes.fillz['0'], 'Float64Array+', 'fill writes, so the storage copies back')
  is(lanes.copy['0'], 'Float64Array+')
  is(lanes.keyed, null, 'an unproven key is the dictionary idiom')
  is(lanes.chars, null, 'a string indexed into a concat stays a string')
  const { exports } = interop.instantiate(bytes)
  is(exports.head(new Float32Array([1, 2, 3, 4]), 3), 6)
  is(exports.head([1, 2, 3, 4], 2), 3)
  const z = [5, 6, 7]
  is(exports.fillz(z), 3)
  is(z.join(), '7,0,0')
  const dst = new Float64Array(3)
  is(exports.copy(dst, [4, 5, 6]), 10)
  is(dst.join(), '4,5,6')
  is(exports.chars('banana'), 6)
})

// Two classes of one field list are two schemas: the compiler brands each
// (module/schema.js), and the `jz:brand` section carries the brand, so
// interop keeps their sids and field contracts apart within a module and
// across the modules sharing one memory. A plain object matches a plain shape
// first; among classes alone it is ambiguous.
test('interop: classes of one field list keep their identity through the sections', () => {
  if (onKernel()) return
  const one = jz(`class A { constructor(x) { this.x = x } }\nclass B { constructor(x) { this.x = x } }
export let a = () => new A(1), b = () => new B('s'), ra = (o) => o.x, rb = (o) => o.x, plain = () => ({ x: 2 })`)
  is(one.exports.ra(one.exports.a()), 1); is(one.exports.rb(one.exports.b()), 's')
  is(one.memory.schemas.filter(s => s.join() === 'x').length, 3, 'two branded shapes and the plain one')
  is(one.exports.ra(one.exports.plain()), 2)
  // another module's class C would bind at a fourth id while its pointers carry id 0: rejected
  throws(() => jz(`class C { constructor(x) { this.x = x } }\nexport let c = () => new C(true), rc = (o) => o.x`, { memory: one.memory }), /schema 0 \{x\} of this module binds as schema 3/)
})

test('interop: modules sharing a memory bind their schemas at the same ids or are rejected', () => {
  if (onKernel()) return
  const src = `export let mk = () => ({ p: 1, q: 'a' }), rp = (o) => o.p, rq = (o) => o.q`
  const one = jz(src)
  // a module of other names, slot orders and representations: its schema 0 would bind as schema 1
  throws(() => jz(`export let mk = () => ({ s: true, r: 2 }), rs = (o) => o.s`, { memory: one.memory }), /schema 0 \{[rs], [rs]\} of this module binds as schema 1/)
  // the same module again binds at the same ids: the instances' exports alternate
  const two = jz(src, { memory: one.memory })
  is(two.exports.rp(one.exports.mk()), 1); is(one.exports.rq(two.exports.mk()), 'a')
  is(JSON.stringify(two.memory.read(one.exports.mk())), '{"p":1,"q":"a"}')
  is(JSON.stringify(one.memory.read(two.exports.mk())), '{"p":1,"q":"a"}')
  // a module without schemas shares any memory
  const plain = jz('export let inc = (x) => x + 1', { memory: one.memory })
  is(plain.exports.inc(one.exports.rp(one.exports.mk())), 2)
})

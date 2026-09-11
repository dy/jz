import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onKernel, onWasi, levels } from './_matrix.js'
import jz, { compile } from '../index.js'

const run = (code, opts) => {
  const { exports, memory } = jz(code, opts)
  const r = exports.f()
  return typeof r === 'bigint' ? memory.read(r) : r
}

// Batch several standalone arrow bodies into ONE compiled module (each under its
// own export name) — one compile instead of one per arrow. Returns a thunk per
// arrow, decoded exactly like `run`, so callers can do `is(calls[i](), want)` or
// hand a thunk straight to `throws`.
const runMany = (arrows, opts) => {
  const { exports, memory } = jz(arrows.map((a, i) => `export let c${i} = ${a}`).join('\n'), opts)
  return arrows.map((_, i) => () => {
    const r = exports[`c${i}`]()
    return typeof r === 'bigint' ? memory.read(r) : r
  })
}

// === encodeURI / decodeURI ===

test('encodeURI: reserved set passes through, rest percent-encodes', () => {
  const src = `a b;/?:@&=+$,#-_.!~*'()中`
  const [c0, c1, c2] = runMany([
    `() => encodeURI(${JSON.stringify(src)})`,
    `() => encodeURIComponent(${JSON.stringify(src)})`,
    `() => encodeURI("")`,
  ])
  is(c0(), encodeURI(src))
  is(c1(), encodeURIComponent(src))
  is(c2(), '')
})

test('decodeURI: reserved escapes stay, case preserved, malformed throws', () => {
  const [c0, c1, c2, c3] = runMany([
    `() => decodeURI("a%20b%2f%3B%3f%23%e4%b8%ad")`,
    `() => decodeURI("%2F%2c")`,
    `() => decodeURIComponent("a%20b%2F")`,
    `() => decodeURI("%2G")`,
  ])
  is(c0(), decodeURI('a%20b%2f%3B%3f%23%e4%b8%ad'))
  is(c1(), '%2F%2c') // original case kept
  is(c2(), 'a b/')
  throws(c3)
})

// === console.info / console.debug (compile + run, output is host-side) ===

test('console.info/debug compile and run', () => {
  is(run(`export let f = () => { console.info("i", 1); console.debug("d", 2); return 1 }`), 1)
})

// === base64 / hex codecs ===

test('btoa/atob: host parity incl whitespace, padding, binary bytes', () => {
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8] = runMany([
    `() => btoa("hello world!")`,
    `() => btoa("")`,
    `() => btoa("a")`,
    `() => atob("aGVsbG8gd29ybGQh")`,
    `() => atob(" aGV sbG8\\n")`,
    `() => atob("gA==").charCodeAt(0)`,
    `() => atob("Y!Q=")`,
    `() => atob("AAAAA")`,
    `() => atob("AB=C")`,
  ])
  is(c0(), btoa('hello world!'))
  is(c1(), '')
  is(c2(), 'YQ==')
  is(c3(), 'hello world!')
  is(c4(), 'hello')       // forgiving: ws + no padding
  is(c5(), 128)     // binary byte reads back
  throws(c6)              // non-alphabet char
  throws(c7)             // len%4 == 1 after strip
  throws(c8)              // char after padding
})

test('Uint8Array.fromBase64/fromHex + instance codecs', () => {
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9] = runMany([
    `() => { let u = Uint8Array.fromBase64("AQIDBA=="); return u[0] * 1000 + u[3] }`,
    `() => Uint8Array.fromBase64("AQID").length`,
    `() => { let u = Uint8Array.fromHex("ff00Ab"); return [u[0], u[1], u[2]] }`,
    `() => Uint8Array.fromHex("f")`,
    `() => Uint8Array.fromHex("zz")`,
    `() => { let u = new Uint8Array(3); u[0] = 1; u[1] = 2; u[2] = 3; return u.toBase64() }`,
    `() => { let u = new Uint8Array(1); u[0] = 250; return u.toBase64() }`,
    `() => { let u = new Uint8Array(1); u[0] = 250; return u.toBase64({alphabet: 'base64url', omitPadding: true}) }`,
    `() => { let u = new Uint8Array(2); u[0] = 255; u[1] = 10; return u.toHex() }`,
    `() => Uint8Array.fromBase64(btoa("xyz")).toHex()`,
  ])
  is(c0(), 1004)
  is(c1(), 3)   // padless (loose)
  is(c2().join(','), '255,0,171')
  throws(c3)         // odd length
  throws(c4)        // non-hex
  is(c5(), 'AQID')
  is(c6(), '+g==')
  is(c7(), '-g')
  is(c8(), 'ff0a')
  is(c9(), '78797a')
})

test('setFromBase64/setFromHex: whole chunks, {read, written}', () => {
  const [c0, c1, c2] = runMany([
    `() => { let u = new Uint8Array(8); let r = u.setFromBase64("AQID"); return [r.read, r.written, u[2]] }`,
    `() => { let u = new Uint8Array(2); let r = u.setFromBase64("AQIDBA=="); return [r.read, r.written] }`,
    `() => { let u = new Uint8Array(2); let r = u.setFromHex("ff00ab"); return [r.read, r.written, u[0], u[1]] }`,
  ])
  is(c0().join(','), '4,3,3')
  // capacity 2 cannot take the 3-byte chunk — stops before it
  is(c1().join(','), '0,0')
  is(c2().join(','), '4,2,255,0')
})

test('TextDecoder: view-safe decode, UTF-8-only label', () => {
  const [c0, c1] = runMany([
    `() => { let u = new Uint8Array(4); u[0] = 120; u[1] = 104; u[2] = 105; u[3] = 33; return new TextDecoder().decode(u.subarray(1)) }`,
    `() => new TextDecoder('utf-8').decode(new TextEncoder().encode('ok'))`,
  ])
  // a subarray VIEW decodes its data, not its descriptor (pre-existing bug pin)
  is(c0(), 'hi!')
  is(c1(), 'ok')
  // a non-UTF-8 label is a compile-time reject (module/webio.js validates the
  // literal label statically) — batching it with the passing calls above would
  // fail the WHOLE shared module's compile, so it keeps its own compile.
  throws(() => run(`export let f = () => new TextDecoder('utf-16').decode(new Uint8Array(2))`))
})

test('TextEncoder.encodeInto: {read, written}, UTF-8 boundary safe', () => {
  const [c0, c1, c2] = runMany([
    `() => { let u = new Uint8Array(8); let r = new TextEncoder().encodeInto("hi", u); return [r.read, r.written, u[0]] }`,
    `() => { let u = new Uint8Array(2); return new TextEncoder().encodeInto("a中", u).written }`,
    `() => { let u = new Uint8Array(4); return new TextEncoder().encodeInto("a中b", u).written }`,
  ])
  is(c0().join(','), '2,2,104')
  // truncation never splits a multi-byte sequence ("中" is 3 bytes)
  is(c1(), 1)
  is(c2(), 4)
})

// === crypto ===

test('crypto.getRandomValues: fills, guards, returns receiver', () => {
  const [c0, c1, c2, c3] = runMany([
    `() => { let a = new Uint8Array(16); crypto.getRandomValues(a); return a }`,
    `() => { let a = new Uint8Array(4); return crypto.getRandomValues(a).length }`,
    `() => crypto.getRandomValues(new Float64Array(2))`,
    `() => crypto.getRandomValues(new Uint8Array(70000))`,
  ])
  ok(c0().some(b => b !== 0), 'entropy fill produced nonzero bytes')
  is(c1(), 4)
  throws(c2)  // TypeMismatch
  throws(c3) // QuotaExceeded
})

test('crypto.randomUUID: v4 shape; randomSeed reproducible', () => {
  if (onKernel()) return // options channel: kernel compile takes source only (no randomSeed)
  const uuid = run(`export let f = () => crypto.randomUUID()`)
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), `v4 shape: ${uuid}`)
  const a = run(`export let f = () => { let a = new Uint8Array(6); crypto.getRandomValues(a); return a }`, { randomSeed: 42 })
  const b = run(`export let f = () => { let a = new Uint8Array(6); crypto.getRandomValues(a); return a }`, { randomSeed: 42 })
  is([...a].join(','), [...b].join(','))
})

// === queueMicrotask ===

test('queueMicrotask: drains at export boundary, orders with promise jobs', async () => {
  if (onKernel()) return // async-runtime class (see async.js kernel guards)
  const { exports } = jz(`
    let x = 0
    export let f = () => { queueMicrotask(() => { x = 42 }); return x }
    export let get = () => x
  `)
  is(exports.f(), 0)       // job not yet run inside the turn
  is(exports.get(), 42)    // drained at the boundary
  const { exports: e2 } = jz(`
    let log = []
    export let f = async () => { queueMicrotask(() => log.push(1)); await Promise.resolve(); log.push(2); return log.join(',') }
  `)
  is(await e2.f(), '1,2')
})

test('web builtin shadows do not suppress lowering in sibling scopes', async () => {
  if (onKernel()) return
  const { exports } = jz(`
    function useParams(URLSearchParams) { return URLSearchParams('x').x }
    function usePromise(Promise) { return Promise.resolve(3) }
    function useMicrotask(queueMicrotask) { queueMicrotask(); return 9 }
    let queued = 0
    export let localParams = () => useParams(x => ({ x }))
    export let localPromise = () => usePromise({ resolve: x => x + 1 })
    export let localMicrotask = () => useMicrotask(() => 0)
    export let params = () => new URLSearchParams('a=1').get('a')
    export let promise = () => Promise.resolve(7)
    export let schedule = () => { queueMicrotask(() => { queued = 11 }); return queued }
    export let scheduled = () => queued
  `)
  is(exports.localParams(), 'x', 'shadowed URLSearchParams uses the supplied local function')
  is(exports.localPromise(), 4, 'shadowed Promise uses the supplied local object')
  is(exports.localMicrotask(), 9, 'shadowed queueMicrotask uses the supplied local callback')
  is(exports.params(), '1', 'a nested URLSearchParams shadow leaves the sibling builtin enabled')
  is(await exports.promise(), 7, 'a nested Promise shadow leaves the sibling builtin enabled')
  is(exports.schedule(), 0, 'queueMicrotask remains deferred inside the export turn')
  is(exports.scheduled(), 11, 'the sibling queueMicrotask drains at the export boundary')
})

// === requestAnimationFrame ===

test('requestAnimationFrame: fires with timestamp; cancel works', async () => {
  if (onWasi()) return // rAF is JS-host-only (the wasi build rejects it with the curated error — pinned below)
  const { exports } = jz(`
    let last = -1, frames = 0
    export let start = () => requestAnimationFrame((t) => { last = t; frames = frames + 1 })
    export let stats = () => [frames, last]
  `)
  exports.start()
  await new Promise(r => setTimeout(r, 60))
  const [frames, last] = exports.stats()
  is(frames, 1)
  ok(last > 0, 'callback received a timestamp')
  const { exports: e2 } = jz(`
    let hit = 0
    export let go = () => { let id = requestAnimationFrame(() => { hit = 1 }); cancelAnimationFrame(id); return id }
    export let hits = () => hit
  `)
  e2.go()
  await new Promise(r => setTimeout(r, 40))
  is(e2.hits(), 0)
})

test('requestAnimationFrame: clean error under wasi', () => {
  if (onKernel()) return // warnings/err channel class (KERNEL_EXCLUDE 'warnings')
  throws(() => jz(`export let f = () => requestAnimationFrame(() => 1)`, { host: 'wasi' }))
})

// === URLSearchParams ===

test('URLSearchParams: parse, get/getAll/has/set/append/delete, size', () => {
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11] = runMany([
    `() => new URLSearchParams('a=1&b=%20x&a=3&c').get('a')`,
    `() => new URLSearchParams('a=1&a=3').getAll('a')`,
    `() => new URLSearchParams('q=hello+world').get('q')`,
    `() => new URLSearchParams('a=%GGx').get('a')`,
    `() => new URLSearchParams('?x=1').get('x')`,
    `() => new URLSearchParams('flag').get('flag')`,
    `() => new URLSearchParams('a=1').get('zz') === null`,
    `() => new URLSearchParams('a=1&b=2&a=3').size`,
    `() => { let p = new URLSearchParams('a=1&b=2&a=3'); p.set('a', '9'); return p.toString() }`,
    `() => { let p = new URLSearchParams('a=1&b=2&a=3'); p.delete('a'); return p.toString() }`,
    `() => { let p = new URLSearchParams('a=1&a=3'); p.delete('a', '1'); return p.toString() }`,
    `() => { let p = new URLSearchParams(); p.append('k', 'v'); return p.has('k') && !p.has('k', 'z') }`,
  ])
  is(c0(), '1')
  is(c1().join(','), '1,3')
  is(c2(), 'hello world')
  is(c3(), '%GGx') // forgiving
  is(c4(), '1')
  is(c5(), '')
  is(c6(), true)
  is(c7(), 3)
  is(c8(), 'a=9&b=2')
  is(c9(), 'b=2')
  is(c10(), 'a=3')
  ok(c11())
})

test('URLSearchParams: sort, escaping, inits, iteration', () => {
  const [c0, c1, c2, c3, c4, c5, c6, c7] = runMany([
    `() => { let p = new URLSearchParams('c=3&a=1&b=2&a=0'); p.sort(); return p.toString() }`,
    `() => { let p = new URLSearchParams(); p.set('k v', 'a&b=c'); return p.toString() }`,
    `() => new URLSearchParams('n=' + encodeURIComponent('中文')).get('n')`,
    `() => new URLSearchParams([['a','1'],['b','2']]).toString()`,
    `() => new URLSearchParams({x: 'a', y: 'b'}).toString()`,
    `() => { let p = new URLSearchParams('a=1'); let q = new URLSearchParams(p); q.append('b','2'); return p.toString() + '|' + q.toString() }`,
    `() => { let out = ''; for (let e of new URLSearchParams('a=1&b=2').entries()) out += e[0] + e[1]; return out }`,
    `() => { let out = ''; new URLSearchParams('a=1&b=2').forEach((v, k) => { out += k + '=' + v + ';' }); return out }`,
  ])
  is(c0(), 'a=1&a=0&b=2&c=3')
  is(c1(), 'k+v=a%26b%3Dc')
  is(c2(), '中文')
  is(c3(), 'a=1&b=2')
  is(c4(), 'x=a&y=b')
  is(c5(), 'a=1|a=1&b=2')
  is(c6(), 'a1b2')
  is(c7(), 'a=1;b=2;')
})

// === navigator.hardwareConcurrency ===

test('navigator.hardwareConcurrency: ≥1 on js host; wasi warns + folds to 1', () => {
  if (onKernel()) return // warnings-sink channel class (KERNEL_EXCLUDE 'warnings')
  ok(run(`export let f = () => navigator.hardwareConcurrency`) >= 1)
  const w = { entries: [] }
  jz(`export let f = () => navigator.hardwareConcurrency`, { host: 'wasi', warnings: w })
  ok(w.entries.some(e => /hardwareConcurrency/.test(e.message)), 'wasi warns about the fold')
})

// === Float16Array ===
// Host-parity tests: they differentially compare against the host's own
// Float16Array (Node ≥ 24 / modern browsers). On older hosts there is nothing
// to compare against — skip, mirroring the runtime's own decode guard.

const skipF16 = { skip: typeof Float16Array === 'undefined' }
const f16 = (x) => new Float16Array([x])[0]

test('Float16Array: store/load round exactly like the host', skipF16, () => {
  const values = [1.5, 0.1, 0.30000000000000004, 65504, 65519.999, 65520, 5.96e-8, 2.98e-8, -2.5, 1 / 3, 1e-10]
  const calls = runMany([
    ...values.map(v => `() => { let a = new Float16Array(1); a[0] = ${v}; return a[0] }`),
    `() => { let a = new Float16Array(1); a[0] = 0/0; return a[0] !== a[0] }`,
    `() => { let a = new Float16Array(1); a[0] = 65520; return a[0] }`,
  ])
  values.forEach((v, i) => is(calls[i](), f16(v)))
  ok(calls[values.length](), 'NaN round-trips')
  is(calls[values.length + 1](), Infinity)
})

test('Float16Array: ctor forms, methods keep the kind', skipF16, () => {
  const [c0, c1, c2, c3, c4, c5] = runMany([
    `() => { let a = new Float16Array([1.1, 2.2]); return a[0] }`,
    `() => new Float16Array([1, 2, 3]).length`,
    `() => { let b = new Float16Array([1, 2, 3]).map(x => x * 0.1); return b[2] }`,
    `() => { let a = new Float16Array(3); a.fill(0.1); return a[1] }`,
    `() => { let a = new Float16Array([0.1, 0.2, 0.3]); return a.slice(1)[0] }`,
    `() => new Float16Array([1.5, 2.5]).reduce((a, b) => a + b, 0)`,
  ])
  is(c0(), f16(1.1))
  is(c1(), 3)
  is(c2(), f16(3 * 0.1))
  is(c3(), f16(0.1))
  is(c4(), f16(0.2))
  is(c5(), 4)
})

test('Float16Array: loops sum exactly at every optimize level', skipF16, () => {
  const src = `export let f = () => {
    let a = new Float16Array(100)
    for (let i = 0; i < 100; i++) a[i] = i * 0.1
    let s = 0
    for (let i = 0; i < 100; i++) s += a[i]
    return s
  }`
  const ref = (() => { const a = new Float16Array(100); for (let i = 0; i < 100; i++) a[i] = i * 0.1; let s = 0; for (let i = 0; i < 100; i++) s += a[i]; return s })()
  for (const optimize of levels(0, 2, 3, 'size')) is(run(src, { optimize }), ref)
})

test('Math.f16round matches host', skipF16, () => {
  const values = [0.1, 1 / 3, 65519.999, 5.96e-8]
  const calls = runMany(values.map(v => `() => Math.f16round(${v})`))
  values.forEach((v, i) => is(calls[i](), f16(v)))
})

test('DataView.getFloat16/setFloat16: LE + BE', () => {
  const [c0, c1] = runMany([
    `() => { let dv = new DataView(new ArrayBuffer(4)); dv.setFloat16(0, 1.5, true); return dv.getFloat16(0, true) }`,
    `() => { let dv = new DataView(new ArrayBuffer(4)); dv.setFloat16(0, 1.5); return [dv.getFloat16(0), dv.getUint8(0)] }`,
  ])
  is(c0(), 1.5)
  const beBytes = c1()
  is(beBytes[0], 1.5)
  is(beBytes[1], 0x3E) // big-endian high byte first
})

test('Float16Array: marshals both directions', skipF16, () => {
  const { exports, memory } = jz(`
    export let mk = () => new Float16Array([1.5, 2.5])
    export let bump = (a = new Float16Array(0)) => { a[0] = 0.1; return a }
  `)
  const out = memory.read(exports.mk())
  ok(out instanceof Float16Array, 'decodes as Float16Array')
  is(out[0], 1.5)
  is(memory.read(exports.bump(memory.Float16Array(new Float16Array(2))))[0], f16(0.1))
})

// === Uint8ClampedArray ===

test('Uint8ClampedArray: ToUint8Clamp semantics', () => {
  const [c0, c1, c2] = runMany([
    `() => { let a = new Uint8ClampedArray(6); a[0] = 300; a[1] = -5; a[2] = 250.5; a[3] = 249.5; a[4] = 0/0; a[5] = 1.5; return a }`,
    `() => { let a = new Uint8ClampedArray([256.7, -3]); return [a[0], a[1]] }`,
    `() => { let a = new Uint8ClampedArray(2); a[0] = 100; return a[0] + 1 }`,
  ])
  is([...c0()].join(','), '255,0,250,250,0,2') // clamp + round-half-even + NaN→0
  is(c1().join(','), '255,0')
  is(c2(), 101)
})

test('Uint8ClampedArray: loop stores clamp at every optimize level', () => {
  const src = `export let f = () => {
    let a = new Uint8ClampedArray(64)
    for (let i = 0; i < 64; i++) a[i] = i * 8.5 - 20
    let s = 0
    for (let i = 0; i < 64; i++) s += a[i]
    return s
  }`
  const ref = (() => { const a = new Uint8ClampedArray(64); for (let i = 0; i < 64; i++) a[i] = i * 8.5 - 20; let s = 0; for (let i = 0; i < 64; i++) s += a[i]; return s })()
  for (const optimize of levels(0, 2, 3, 'size')) is(run(src, { optimize }), ref)
})

// === direct fresh-ctor receivers (regression pin) ===
// `new T([…]).method(…)` receivers used to fall past elem resolution to the
// plain-array emitters, which read f64 slots — silently wrong for every
// element kind except Float64Array (Int32Array read 0s). Pin the class.

test('method chains on fresh typed ctors resolve the element kind', () => {
  const arrows = [
    `() => new Int32Array([1, 2, 3]).map(x => x * 2)[2]`,
    `() => new Uint8Array([1, 2, 3]).map(x => x + 1)[1]`,
    `() => new Float64Array([1, 2, 3]).map(x => x * 0.5)[2]`,
  ]
  if (!skipF16.skip) arrows.push(`() => new Float16Array([1, 2, 3]).map(x => x * 0.1)[2]`)
  const [c0, c1, c2, c3] = runMany(arrows)
  is(c0(), 6)
  is(c1(), 3)
  is(c2(), 1.5)
  if (!skipF16.skip) is(c3(), f16(3 * 0.1))
})

// === clean errors for the ext-dispatch class ===

test('unknown builtin method fails with a named error, not a host TypeError', () => {
  if (onWasi()) return // ext-dispatch is the JS-host bridge — no host to dispatch to under wasi
  let msg = ''
  try { jz(`export let f = () => new TextEncoder().fooBar(1)`).exports.f() } catch (e) { msg = e.message }
  ok(msg.includes(`'fooBar'`), `names the method: ${msg}`)
  ok(!msg.includes('Cannot read properties'), 'no raw host TypeError')
})


test('URLSearchParams: constructor distinguishes omitted input from primitive values', () => {
  // Web IDL's string union arm handles null and other primitives. Node versions
  // differ on null, so pin the standard rather than the host's behavior.
  // https://url.spec.whatwg.org/#interface-urlsearchparams
  const rows = [
    ['', ''], ['undefined', ''], ["''", ''], ['{}', ''], ['[]', ''],
    ['null', 'null='], ['false', 'false='], ['0', '0='], ['-0', '0='],
    ['1.5', '1.5='], ['1n', '1='],
  ]
  const calls = runMany(rows.map(([arg]) => `() => new URLSearchParams(${arg}).toString()`))
  for (let repeat = 0; repeat < 2; repeat++)
    for (let i = 0; i < rows.length; i++) is(calls[i](), rows[i][1], `${rows[i][0]} repeat ${repeat}`)
  const [copy] = runMany([
    `() => { let a = new URLSearchParams(null); let b = new URLSearchParams(a); a.append('a','1'); b.append('b','2'); a.delete('a'); return a.size + ':' + b.toString() }`,
  ])
  is(copy(), '1:null=&b=2')
  is(copy(), '1:null=&b=2')
})

test('URLSearchParams: shared methods keep instance and iteration state independent', () => {
  const sources = [
    `() => { let a = new URLSearchParams(); let b = new URLSearchParams(a); a.append('a','1'); b.append('b','2'); a.delete('a'); return a.size + ':' + b.toString() }`,
    `() => { let a = new URLSearchParams('a=1&a=2'); let b = new URLSearchParams(a); b.set('a','3'); a.append('b','4'); return a.toString() + '|' + b.toString() + ':' + b.size }`,
    `() => { let p = new URLSearchParams('a=1'); let s = ''; p.forEach((v,k,self) => { s += k + v; if (k === 'a') self.append('b','2') }); return s + ':' + p.size }`,
    `() => new URLSearchParams({__usp: 1, a: '2'}).toString()`,
    `() => { let p = new URLSearchParams('a=1&a=2&b=3'); p.delete('a','1'); p.set('b','4'); p.sort(); return p.toString() + ':' + p.size }`,
    `() => new URLSearchParams('?&a=%&b=%2&c=%GG&d=%F0%9F%98%80&e=%EF%BB%BF&f=%FF').toString()`,
    `() => new URLSearchParams('').toString()`,
  ]
  const calls = runMany(sources)
  for (let i = 0; i < calls.length; i++) {
    const expected = new Function('return (' + sources[i] + ')()')()
    is(calls[i](), expected, sources[i])
    is(calls[i](), expected, 'repeat ' + i)
  }
})

test('URLSearchParams: lookup drops unused escaping methods', () => {
  if (onKernel()) return
  const src = `export function f(s) { return new URLSearchParams(s).get('a') }`
  const wat = compile(src, { wat: true })
  ok(!wat.includes('(func $__usp_esc'), 'get-only module does not retain percent encoding')
})


test('URLSearchParams: forEach observes live entries across callback growth and deletion', () => {
  for (const body of [
    `let p = new URLSearchParams('a=1'); let s = ''; p.forEach((v,k,self) => { s += k + v; if (k === 'a') self.append('b','2') }); return s + ':' + p.size`,
    `let p = new URLSearchParams('a=1&b=2&c=3'); let s = ''; p.forEach((v,k,self) => { s += k + v; if (k === 'a') self.delete('b') }); return s + ':' + p.size`,
  ]) is(run('export function f(){' + body + '}'), new Function(body)(), body)
})

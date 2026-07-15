import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'

const run = (code, opts) => {
  const { exports, memory } = jz(code, opts)
  const r = exports.f()
  return typeof r === 'bigint' ? memory.read(r) : r
}

// === encodeURI / decodeURI ===

test('encodeURI: reserved set passes through, rest percent-encodes', () => {
  const src = `a b;/?:@&=+$,#-_.!~*'()中`
  is(run(`export let f = () => encodeURI(${JSON.stringify(src)})`), encodeURI(src))
  is(run(`export let f = () => encodeURIComponent(${JSON.stringify(src)})`), encodeURIComponent(src))
  is(run(`export let f = () => encodeURI("")`), '')
})

test('decodeURI: reserved escapes stay, case preserved, malformed throws', () => {
  is(run(`export let f = () => decodeURI("a%20b%2f%3B%3f%23%e4%b8%ad")`), decodeURI('a%20b%2f%3B%3f%23%e4%b8%ad'))
  is(run(`export let f = () => decodeURI("%2F%2c")`), '%2F%2c') // original case kept
  is(run(`export let f = () => decodeURIComponent("a%20b%2F")`), 'a b/')
  throws(() => run(`export let f = () => decodeURI("%2G")`))
})

// === console.info / console.debug (compile + run, output is host-side) ===

test('console.info/debug compile and run', () => {
  is(run(`export let f = () => { console.info("i", 1); console.debug("d", 2); return 1 }`), 1)
})

// === base64 / hex codecs ===

test('btoa/atob: host parity incl whitespace, padding, binary bytes', () => {
  is(run(`export let f = () => btoa("hello world!")`), btoa('hello world!'))
  is(run(`export let f = () => btoa("")`), '')
  is(run(`export let f = () => btoa("a")`), 'YQ==')
  is(run(`export let f = () => atob("aGVsbG8gd29ybGQh")`), 'hello world!')
  is(run(`export let f = () => atob(" aGV sbG8\\n")`), 'hello')       // forgiving: ws + no padding
  is(run(`export let f = () => atob("gA==").charCodeAt(0)`), 128)     // binary byte reads back
  throws(() => run(`export let f = () => atob("Y!Q=")`))              // non-alphabet char
  throws(() => run(`export let f = () => atob("AAAAA")`))             // len%4 == 1 after strip
  throws(() => run(`export let f = () => atob("AB=C")`))              // char after padding
})

test('Uint8Array.fromBase64/fromHex + instance codecs', () => {
  is(run(`export let f = () => { let u = Uint8Array.fromBase64("AQIDBA=="); return u[0] * 1000 + u[3] }`), 1004)
  is(run(`export let f = () => Uint8Array.fromBase64("AQID").length`), 3)   // padless (loose)
  is(run(`export let f = () => { let u = Uint8Array.fromHex("ff00Ab"); return [u[0], u[1], u[2]] }`).join(','), '255,0,171')
  throws(() => run(`export let f = () => Uint8Array.fromHex("f")`))         // odd length
  throws(() => run(`export let f = () => Uint8Array.fromHex("zz")`))        // non-hex
  is(run(`export let f = () => { let u = new Uint8Array(3); u[0] = 1; u[1] = 2; u[2] = 3; return u.toBase64() }`), 'AQID')
  is(run(`export let f = () => { let u = new Uint8Array(1); u[0] = 250; return u.toBase64() }`), '+g==')
  is(run(`export let f = () => { let u = new Uint8Array(1); u[0] = 250; return u.toBase64({alphabet: 'base64url', omitPadding: true}) }`), '-g')
  is(run(`export let f = () => { let u = new Uint8Array(2); u[0] = 255; u[1] = 10; return u.toHex() }`), 'ff0a')
  is(run(`export let f = () => Uint8Array.fromBase64(btoa("xyz")).toHex()`), '78797a')
})

test('setFromBase64/setFromHex: whole chunks, {read, written}', () => {
  const r1 = run(`export let f = () => { let u = new Uint8Array(8); let r = u.setFromBase64("AQID"); return [r.read, r.written, u[2]] }`)
  is(r1.join(','), '4,3,3')
  // capacity 2 cannot take the 3-byte chunk — stops before it
  const r2 = run(`export let f = () => { let u = new Uint8Array(2); let r = u.setFromBase64("AQIDBA=="); return [r.read, r.written] }`)
  is(r2.join(','), '0,0')
  const r3 = run(`export let f = () => { let u = new Uint8Array(2); let r = u.setFromHex("ff00ab"); return [r.read, r.written, u[0], u[1]] }`)
  is(r3.join(','), '4,2,255,0')
})

test('TextDecoder: view-safe decode, UTF-8-only label', () => {
  // a subarray VIEW decodes its data, not its descriptor (pre-existing bug pin)
  is(run(`export let f = () => { let u = new Uint8Array(4); u[0] = 120; u[1] = 104; u[2] = 105; u[3] = 33; return new TextDecoder().decode(u.subarray(1)) }`), 'hi!')
  is(run(`export let f = () => new TextDecoder('utf-8').decode(new TextEncoder().encode('ok'))`), 'ok')
  throws(() => run(`export let f = () => new TextDecoder('utf-16').decode(new Uint8Array(2))`))
})

test('TextEncoder.encodeInto: {read, written}, UTF-8 boundary safe', () => {
  const r1 = run(`export let f = () => { let u = new Uint8Array(8); let r = new TextEncoder().encodeInto("hi", u); return [r.read, r.written, u[0]] }`)
  is(r1.join(','), '2,2,104')
  // truncation never splits a multi-byte sequence ("中" is 3 bytes)
  is(run(`export let f = () => { let u = new Uint8Array(2); return new TextEncoder().encodeInto("a中", u).written }`), 1)
  is(run(`export let f = () => { let u = new Uint8Array(4); return new TextEncoder().encodeInto("a中b", u).written }`), 4)
})

// === crypto ===

test('crypto.getRandomValues: fills, guards, returns receiver', () => {
  const bytes = run(`export let f = () => { let a = new Uint8Array(16); crypto.getRandomValues(a); return a }`)
  ok(bytes.some(b => b !== 0), 'entropy fill produced nonzero bytes')
  is(run(`export let f = () => { let a = new Uint8Array(4); return crypto.getRandomValues(a).length }`), 4)
  throws(() => run(`export let f = () => crypto.getRandomValues(new Float64Array(2))`))  // TypeMismatch
  throws(() => run(`export let f = () => crypto.getRandomValues(new Uint8Array(70000))`)) // QuotaExceeded
})

test('crypto.randomUUID: v4 shape; randomSeed reproducible', () => {
  const uuid = run(`export let f = () => crypto.randomUUID()`)
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), `v4 shape: ${uuid}`)
  const a = run(`export let f = () => { let a = new Uint8Array(6); crypto.getRandomValues(a); return a }`, { randomSeed: 42 })
  const b = run(`export let f = () => { let a = new Uint8Array(6); crypto.getRandomValues(a); return a }`, { randomSeed: 42 })
  is([...a].join(','), [...b].join(','))
})

// === queueMicrotask ===

test('queueMicrotask: drains at export boundary, orders with promise jobs', async () => {
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

// === requestAnimationFrame ===

test('requestAnimationFrame: fires with timestamp; cancel works', async () => {
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
  throws(() => jz(`export let f = () => requestAnimationFrame(() => 1)`, { host: 'wasi' }))
})

// === URLSearchParams ===

test('URLSearchParams: parse, get/getAll/has/set/append/delete, size', () => {
  is(run(`export let f = () => new URLSearchParams('a=1&b=%20x&a=3&c').get('a')`), '1')
  is(run(`export let f = () => new URLSearchParams('a=1&a=3').getAll('a')`).join(','), '1,3')
  is(run(`export let f = () => new URLSearchParams('q=hello+world').get('q')`), 'hello world')
  is(run(`export let f = () => new URLSearchParams('a=%GGx').get('a')`), '%GGx') // forgiving
  is(run(`export let f = () => new URLSearchParams('?x=1').get('x')`), '1')
  is(run(`export let f = () => new URLSearchParams('flag').get('flag')`), '')
  is(run(`export let f = () => new URLSearchParams('a=1').get('zz') === null`), true)
  is(run(`export let f = () => new URLSearchParams('a=1&b=2&a=3').size`), 3)
  is(run(`export let f = () => { let p = new URLSearchParams('a=1&b=2&a=3'); p.set('a', '9'); return p.toString() }`), 'a=9&b=2')
  is(run(`export let f = () => { let p = new URLSearchParams('a=1&b=2&a=3'); p.delete('a'); return p.toString() }`), 'b=2')
  is(run(`export let f = () => { let p = new URLSearchParams('a=1&a=3'); p.delete('a', '1'); return p.toString() }`), 'a=3')
  ok(run(`export let f = () => { let p = new URLSearchParams(); p.append('k', 'v'); return p.has('k') && !p.has('k', 'z') }`))
})

test('URLSearchParams: sort, escaping, inits, iteration', () => {
  is(run(`export let f = () => { let p = new URLSearchParams('c=3&a=1&b=2&a=0'); p.sort(); return p.toString() }`), 'a=1&a=0&b=2&c=3')
  is(run(`export let f = () => { let p = new URLSearchParams(); p.set('k v', 'a&b=c'); return p.toString() }`), 'k+v=a%26b%3Dc')
  is(run(`export let f = () => new URLSearchParams('n=' + encodeURIComponent('中文')).get('n')`), '中文')
  is(run(`export let f = () => new URLSearchParams([['a','1'],['b','2']]).toString()`), 'a=1&b=2')
  is(run(`export let f = () => new URLSearchParams({x: 'a', y: 'b'}).toString()`), 'x=a&y=b')
  is(run(`export let f = () => { let p = new URLSearchParams('a=1'); let q = new URLSearchParams(p); q.append('b','2'); return p.toString() + '|' + q.toString() }`), 'a=1|a=1&b=2')
  is(run(`export let f = () => { let out = ''; for (let e of new URLSearchParams('a=1&b=2').entries()) out += e[0] + e[1]; return out }`), 'a1b2')
  is(run(`export let f = () => { let out = ''; new URLSearchParams('a=1&b=2').forEach((v, k) => { out += k + '=' + v + ';' }); return out }`), 'a=1;b=2;')
})

// === navigator.hardwareConcurrency ===

test('navigator.hardwareConcurrency: ≥1 on js host; wasi warns + folds to 1', () => {
  ok(run(`export let f = () => navigator.hardwareConcurrency`) >= 1)
  const w = { entries: [] }
  jz(`export let f = () => navigator.hardwareConcurrency`, { host: 'wasi', warnings: w })
  ok(w.entries.some(e => /hardwareConcurrency/.test(e.message)), 'wasi warns about the fold')
})

// === Float16Array ===

const f16 = (x) => new Float16Array([x])[0]

test('Float16Array: store/load round exactly like the host', () => {
  for (const v of [1.5, 0.1, 0.30000000000000004, 65504, 65519.999, 65520, 5.96e-8, 2.98e-8, -2.5, 1 / 3, 1e-10])
    is(run(`export let f = () => { let a = new Float16Array(1); a[0] = ${v}; return a[0] }`), f16(v))
  ok(run(`export let f = () => { let a = new Float16Array(1); a[0] = 0/0; return a[0] !== a[0] }`), 'NaN round-trips')
  is(run(`export let f = () => { let a = new Float16Array(1); a[0] = 65520; return a[0] }`), Infinity)
})

test('Float16Array: ctor forms, methods keep the kind', () => {
  is(run(`export let f = () => { let a = new Float16Array([1.1, 2.2]); return a[0] }`), f16(1.1))
  is(run(`export let f = () => new Float16Array([1, 2, 3]).length`), 3)
  is(run(`export let f = () => { let b = new Float16Array([1, 2, 3]).map(x => x * 0.1); return b[2] }`), f16(3 * 0.1))
  is(run(`export let f = () => { let a = new Float16Array(3); a.fill(0.1); return a[1] }`), f16(0.1))
  is(run(`export let f = () => { let a = new Float16Array([0.1, 0.2, 0.3]); return a.slice(1)[0] }`), f16(0.2))
  is(run(`export let f = () => new Float16Array([1.5, 2.5]).reduce((a, b) => a + b, 0)`), 4)
})

test('Float16Array: loops sum exactly at every optimize level', () => {
  const src = `export let f = () => {
    let a = new Float16Array(100)
    for (let i = 0; i < 100; i++) a[i] = i * 0.1
    let s = 0
    for (let i = 0; i < 100; i++) s += a[i]
    return s
  }`
  const ref = (() => { const a = new Float16Array(100); for (let i = 0; i < 100; i++) a[i] = i * 0.1; let s = 0; for (let i = 0; i < 100; i++) s += a[i]; return s })()
  for (const optimize of [0, 2, 3, 'size']) is(run(src, { optimize }), ref)
})

test('Math.f16round matches host', () => {
  for (const v of [0.1, 1 / 3, 65519.999, 5.96e-8]) is(run(`export let f = () => Math.f16round(${v})`), f16(v))
})

test('DataView.getFloat16/setFloat16: LE + BE', () => {
  is(run(`export let f = () => { let dv = new DataView(new ArrayBuffer(4)); dv.setFloat16(0, 1.5, true); return dv.getFloat16(0, true) }`), 1.5)
  const beBytes = run(`export let f = () => { let dv = new DataView(new ArrayBuffer(4)); dv.setFloat16(0, 1.5); return [dv.getFloat16(0), dv.getUint8(0)] }`)
  is(beBytes[0], 1.5)
  is(beBytes[1], 0x3E) // big-endian high byte first
})

test('Float16Array: marshals both directions', () => {
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
  const r = run(`export let f = () => { let a = new Uint8ClampedArray(6); a[0] = 300; a[1] = -5; a[2] = 250.5; a[3] = 249.5; a[4] = 0/0; a[5] = 1.5; return a }`)
  is([...r].join(','), '255,0,250,250,0,2') // clamp + round-half-even + NaN→0
  is(run(`export let f = () => { let a = new Uint8ClampedArray([256.7, -3]); return [a[0], a[1]] }`).join(','), '255,0')
  is(run(`export let f = () => { let a = new Uint8ClampedArray(2); a[0] = 100; return a[0] + 1 }`), 101)
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
  for (const optimize of [0, 2, 3, 'size']) is(run(src, { optimize }), ref)
})

// === direct fresh-ctor receivers (regression pin) ===
// `new T([…]).method(…)` receivers used to fall past elem resolution to the
// plain-array emitters, which read f64 slots — silently wrong for every
// element kind except Float64Array (Int32Array read 0s). Pin the class.

test('method chains on fresh typed ctors resolve the element kind', () => {
  is(run(`export let f = () => new Int32Array([1, 2, 3]).map(x => x * 2)[2]`), 6)
  is(run(`export let f = () => new Uint8Array([1, 2, 3]).map(x => x + 1)[1]`), 3)
  is(run(`export let f = () => new Float64Array([1, 2, 3]).map(x => x * 0.5)[2]`), 1.5)
  is(run(`export let f = () => new Float16Array([1, 2, 3]).map(x => x * 0.1)[2]`), f16(3 * 0.1))
})

// === clean errors for the ext-dispatch class ===

test('unknown builtin method fails with a named error, not a host TypeError', () => {
  let msg = ''
  try { jz(`export let f = () => new TextEncoder().fooBar(1)`).exports.f() } catch (e) { msg = e.message }
  ok(msg.includes(`'fooBar'`), `names the method: ${msg}`)
  ok(!msg.includes('Cannot read properties'), 'no raw host TypeError')
})

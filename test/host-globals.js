// The host's globals under the JS host: a name no declaration of the program
// binds and the target does not resolve (WritableStream, Response, a global the
// host page defines) reads the host's value, a ReferenceError where the host has
// none; `new`, `instanceof` and `typeof` of one ask the host. A member of a
// namespace the host backs that jz does not serve (`crypto.subtle`,
// `console.trace`) is the host's own. Each program runs under jz and as plain JS.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const agree = async (src, calls) => {
  const want = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) is(await got[name](...args), await want[name](...args), `O${optimize} ${name}(${args.map(a => a?.constructor?.name ?? a).join(', ')})`)
  }
}

test('instanceof a host class asks the host for a host value; a value of the program is none', async () => {
  if (onWasi()) return
  await agree(`
    export const kinds = (v) => [v instanceof WritableStream, v instanceof WritableStreamDefaultWriter, v instanceof ReadableStream]
    export const own = () => { const o = { a: 1 }, a = [1], u = new Uint8Array(2)
      return [o instanceof WritableStream, a instanceof Response, u instanceof Response, 5 instanceof Response, 'x' instanceof Response, null instanceof Response] }
    export const member = (v) => v instanceof globalThis.WritableStream
    export const bad = (v) => { try { return v instanceof jzTestPlain } catch (e) { return e.name } }
  `, [['kinds', new WritableStream()], ['kinds', new WritableStream().getWriter()], ['kinds', new ReadableStream()], ['kinds', {}],
    ['own'], ['member', new WritableStream()], ['member', 3], ['bad', {}]])
})

test('new of a host constructor constructs on the host, its arguments evaluated first', async () => {
  if (onWasi()) return
  await agree(`
    export const make = async (s) => { const r = new Response(s); return [r instanceof Response, await r.text()] }
    export const spread = async (parts) => await new Response(...parts).text()
    export const member = () => new globalThis.TextDecoderStream() instanceof TextDecoderStream
    export const order = () => { const log = []; try { new (log.push('ctor'), Response)(log.push('arg')) } catch {} return log.join() }
    export const wasm = (b) => new WebAssembly.Instance(new WebAssembly.Module(b)).exports.f()
  `, [['make', 'abc'], ['spread', ['xyz']], ['member'], ['order'],
    ['wasm', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 6, 1, 4, 0, 0x41, 0x2a, 0x0b])]])
})

test('new of a constructor a binding holds constructs a host one on the host and calls a class of the program', async () => {
  if (onWasi()) return
  await agree(`
    class A { constructor(o) { this.v = o.a * 2 } }
    class B { constructor(o) { this.v = o.a * 3 } }
    export const local = (x, flag) => { const K = flag ? A : B; return new K({ a: x }).v }
    export const alias = async (s) => { const R = Response; const r = new R(s); return [r instanceof Response, await r.text()] }
    export const param = (C, s) => new C(s).pathname
    export const later = async (s) => { let M = null; M = Response; return await new M(s).text() }
    export const order = () => { const log = [], R = Response; try { new R(log.push('arg')) } catch {} return log.join() }
  `, [['local', 2, true], ['local', 2, false], ['alias', 'abc'], ['param', URL, 'http://x.y/z'], ['later', 'def'], ['order']])
  // a class of the program held in a const compiles as its call, with no host arm
  const held = `class A { constructor(o) { this.v = o.a * 2 } }
    class B { constructor(o) { this.v = o.a * 3 } }
    export const f = (x, flag) => { const K = flag ? A : B; return new K({ a: x }).v }`
  ok(!/__ext_construct/.test(compile(held, { wat: true })), 'a const of classes constructs by call')
})

test('typeof a host function is function, of a host object object', async () => {
  if (onWasi()) return
  await agree(`
    export const kinds = (v, o) => [typeof v, typeof o, typeof o.m, typeof o.n, typeof v === 'function', typeof o === 'object']
    export const held = () => { const R = Response; return [typeof R, typeof crypto.subtle.digest, typeof console.log] }
  `, [['kinds', () => 1, { m() {}, n: 1 }], ['kinds', class {}, []], ['held']])
})

// A for-of over a host iterable takes its iterator's values one per step, the
// body running between them, in a program that makes no iterator of its own.
test('for-of over a host iterable pulls its iterator a value per step', async () => {
  if (onWasi()) return
  const src = `
    export const order = (it, note) => { let n = 0; for (const x of it) { note('body' + x); n++ } return n }
    export const pairs = (m) => { let s = ''; for (const [k, v] of m) s += k + '=' + v + ';'; return s }
    export const count = (it) => { let n = 0; for (const x of it) { n++; if (n > 4) break } return n }
    export const strings = (it) => { const out = []; for (const s of it) out.push(s.toUpperCase()); return out.join() }
    export const nested = (outer) => { let s = 0; for (const inner of outer) for (const x of inner) s += x; return s }
    export const spread = (it) => [...it].length
    export const bad = (v) => { try { for (const x of v) return x } catch (e) { return e.name } }`
  const drive = (m) => {
    const log = []
    const gen = function* () { try { for (let i = 1; i < 4; i++) { log.push('yield' + i); yield i } } finally { log.push('done') } }
    return [m.order(gen(), (s) => log.push(s)), log.join(), m.pairs(new Map([['a', 1], ['b', 2]])),
      m.count((function* () { let i = 0; for (;;) yield i++ })()), m.strings(new Set(['x', 'y'])),
      m.nested([new Set([1, 2]), [3]]), m.spread(new Set([1, 2, 3]).values()), m.bad({})]
  }
  const want = drive(oracle(src))
  for (const optimize of levels(0, 2, 3, 'size')) is(drive(jz(src, { optimize }).exports), want, `O${optimize}`)
  ok(!/__ext_iter/.test(compile('export const f = () => { let s = 0; for (const x of [1, 2]) s += x; return s }', { wat: true })), 'a source of the program is iterated as before')
})

test('a host global the host lacks throws a ReferenceError where read, and types as undefined', async () => {
  if (onWasi()) return
  globalThis.jzTestDouble = (a) => a * 2
  globalThis.jzTestPlain = 7
  try {
    await agree(`
      export const absent = () => { try { return jzTestMissing } catch (e) { return [e instanceof ReferenceError, e.message] } }
      export const types = () => [typeof jzTestMissing, typeof WritableStream, typeof jzTestDouble, typeof jzTestPlain, typeof jzTestMissing === 'undefined', typeof Response === 'function']
      export const grouped = () => [typeof (jzTestMissing), typeof ((jzTestMissing)) === 'undefined', typeof (Response) === 'function', typeof (Math) === 'object']
      export const call = (n) => jzTestDouble(n) + jzTestPlain
      export const probe = () => typeof Deno !== 'undefined' ? 'deno' : typeof Bun !== 'undefined' ? 'bun' : typeof TransformStream
      export const later = () => late + 1
      let late = 4
    `, [['absent'], ['types'], ['grouped'], ['call', 5], ['probe'], ['later']])
  } finally { delete globalThis.jzTestDouble; delete globalThis.jzTestPlain }
})

test("a member of a namespace the host backs that jz does not serve is the host's own", async () => {
  if (onWasi()) return
  await agree(`
    export const digest = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].join()
    export const kinds = () => [typeof crypto.subtle, typeof crypto.getRandomValues, typeof globalThis?.crypto?.subtle, console.table !== undefined]
  `, [['digest', 'abc'], ['kinds']])
})

test('without a JS host, or in the strict subset, an undeclared name stays a compile-time rejection', () => {
  throws(() => jz('export const f = (v) => v instanceof WritableStream', { host: 'wasi' }), /instanceof: unsupported right-hand side/)
  throws(() => jz('export const f = () => new Response("x")', { host: 'wasi' }), /not in scope/)
  throws(() => jz('export const f = () => new Response("x")', { strict: true }), /not in scope/)
  // a reserved word the parser read as a name is no IdentifierReference
  for (const word of ['catch', 'finally', 'await']) throws(() => jz(`let x; export const f = () => x = ${word}`), new RegExp(`'${word}'`))
  ok(!/__host_global|"global"/.test(compile('export const f = (v) => v + 1', { wat: true })), 'a program naming no host global imports none')
  if (!onWasi()) ok(/import "global" "Response"/.test(compile('export const f = () => new Response("x")', { wat: true })), 'a host global is one import by its name')
})

// A constructor a binding or an expression yields is asked of its value at run
// time, where it was a compile-time rejection: the host answers for one of its
// own (an exported class's handle included), the program by its classes and
// typed-array constructors, and a value that is no function throws.
test('instanceof a constructor a binding holds asks its value: the host for the host\'s, the program for its own', async () => {
  if (onWasi()) return
  await agree(`
    export class P { constructor() { this.p = 1 } }
    class Q {} class Z extends Q {}
    const pick = (k) => k ? Q : P, R = globalThis.URL
    export const is = (x, C) => { try { return x instanceof C } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }
    export const mk = () => new P()
    export const local = (k) => [new Z() instanceof pick(k), new P() instanceof pick(k), new Q() instanceof (k ? Z : Q)]
    export const typedArg = (k) => { const T = k ? Float64Array : Int8Array; return [new Float64Array(2) instanceof T, new Int8Array(1) instanceof T] }
    export const url = (x) => x instanceof R
  `, [['is', new Map(), Map], ['is', [], Map], ['is', new URL('http://a'), URL], ['is', {}, URL], ['is', 1, 5], ['is', {}, {}],
    ['local', 1], ['local', 0], ['typedArg', 1], ['typedArg', 0], ['url', new URL('http://b')], ['url', 1]])
  const mod = jz(`export class P { constructor() { this.p = 1 } }
    export const is = (x, C) => x instanceof C
    export const mk = () => new P()`).exports
  is([mod.is(mod.mk(), mod.P), mod.is(new mod.P(), mod.P), mod.is({}, mod.P)].join(), 'true,true,false', 'an exported class answers for its instances')
})

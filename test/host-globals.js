// The host's globals under the JS host: a name no declaration of the program
// binds and the target does not resolve (WritableStream, Response, a global the
// host page defines) reads the host's value, a ReferenceError where the host has
// none; `new`, `instanceof` and `typeof` of one ask the host. A member of a
// namespace the host backs that jz does not serve (`crypto.subtle`,
// `console.trace`) is the host's own. Each program runs under jz and as plain JS.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
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
  ok(!/__host_global|"global"/.test(jz.compile('export const f = (v) => v + 1', { wat: true })), 'a program naming no host global imports none')
  if (!onWasi()) ok(/import "global" "Response"/.test(jz.compile('export const f = () => new Response("x")', { wat: true })), 'a host global is one import by its name')
})

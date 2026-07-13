// async/await v1 (plain-jz promise runtime on the generator machinery):
// `async fn` lowers to (...aa) => __async_run((function* (params){ await→yield })(...aa));
// promises are fixed-shape objects with then/catch/finally closure props; the
// microtask queue drains at host boundaries (export return, timer tick) and
// the interop wrapper adopts promise-shaped returns into HOST Promises —
// pending ones settle from the after-tick sweep. Pay-per-use: sync programs
// never link any of it. v1 rejects: try/catch across await (precise message).
// Divergences (documented): job ordering is per-drain-cycle; no unhandled-
// rejection reporting; no SuppressedError.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { onWasi, onKernel } from './_matrix.js'

const val = async (src) => {
  const r = jz(src).exports.f()
  ok(r instanceof Promise, 'async export adopts into a host Promise')
  return r
}

test('async: completes synchronously to a settled host Promise', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function g(x) { return x * 2 } export let f = () => g(21)`), 42)
})

test('async: await chains through async callees', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function a() { return 7 }
                async function b() { let v = await a(); return v * 3 }
                export let f = () => b()`), 21)
  is(await val(`async function g() { let a = await 5; let b = await (a + 1); return b * 2 }
                export let f = () => g()`), 12)
})

test('async: then/catch/finally chains', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function g() { return 4 } export let f = () => g().then((v) => v + 1).then((v) => v * 10)`), 50)
  is(await val(`async function g() { throw 'boom' } export let f = () => g().catch((e) => 'caught:' + e)`), 'caught:boom')
  is(await val(`let log = ''
                async function g() { return 3 }
                export let f = () => g().finally(() => { log += 'F' }).then((v) => '' + v + log)`), '3F')
})

test('async: rejection propagates through await', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function bad() { throw 'E' }
                async function g() { let v = await bad(); return v }
                export let f = () => g().catch((e) => 'got:' + e)`), 'got:E')
})

test('async: Promise API — resolve/reject/all/race, executor', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`export let f = () => Promise.resolve(2).then((v) => v + 40)`), 42)
  is(await val(`export let f = () => Promise.reject('R').catch((e) => 'c:' + e)`), 'c:R')
  is(await val(`async function a() { return 1 }
                export let f = () => Promise.all([a(), Promise.resolve(2), 3]).then((vs) => vs.join('-'))`), '1-2-3')
  is(await val(`export let f = () => Promise.race([Promise.resolve('fast'), new Promise(() => 0)])`), 'fast')
  is(await val(`export let f = () => new Promise((res) => res(9)).then((v) => v + 1)`), 10)
})

test('async: arrows and expressions', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`let g = async (x) => { let v = await x; return v + 1 }
                export let f = () => g(41)`), 42)
  is(await val(`let g = async function (x) { return x + 1 }
                export let f = () => g(1).then((v) => v * 2)`), 4)
})

test('async: pending export parks on wasm timers, host Promise settles', async () => {
  if (onWasi() || onKernel()) return
  const src = `
    let sleep = (ms) => new Promise((res) => setTimeout(() => res(ms), ms))
    async function work() { let a = await sleep(8); let b = await sleep(4); return a + b }
    export let f = () => work()`
  is(await val(src), 12)
})

test('async: v1 rejects try across await with a precise message', () => {
  let e
  try { jz.compile(`async function g() { try { await 1 } catch (x) {} } export let f = () => 1`) } catch (x) { e = x }
  ok(e && e.message.includes('across `await`'), `precise reject: ${e?.message?.slice(0, 80)}`)
})

// Async HOST IMPORTS — a host function returning a thenable becomes a jz
// promise the module can await (made + settled via the runtime's __p_make/
// __p_finish exports; settlement drains + sweeps). This is the fetch story:
// no WASI networking — I/O stays host-side, awaitable in jz.
test('async: host imports returning promises are awaitable', async () => {
  if (onWasi() || onKernel()) return
  const src = `import { ft } from 'host'
    async function m(u) { let b = await ft(u); return b.length + ':' + b }
    export let f = (u) => m(u)`
  const out = jz(src, { imports: { host: { ft: (u) => new Promise((res) => setTimeout(() => res('hey:' + u), 5)) } } })
  is(await out.exports.f('x'), '5:hey:x')
  const out2 = jz(`import { bad } from 'host'
    async function m() { let v = await bad(); return v }
    export let f = () => m().catch((e) => 'caught:' + e)`,
    { imports: { host: { bad: () => Promise.reject(new Error('nope')) } } })
  is(await out2.exports.f(), 'caught:nope')
})

test('async: bare fetch binds from the JS host — Response methods await in turn', async () => {
  if (onWasi() || onKernel()) return
  const { createServer } = await import('node:http')
  const srv = createServer((req, res) => res.end('pong:' + req.url)).listen(0)
  await new Promise(r => srv.once('listening', r))
  try {
    const base = 'http://localhost:' + srv.address().port
    // no import statement: module/web.js lowers the bare call to env.fetch,
    // interop binds globalThis.fetch; the Response crosses as an external
    // handle so .text() dispatches host-side and is awaitable too
    const out = jz(`async function probe(base) {
        let r = await fetch(base + '/alpha')
        let a = await r.text()
        let r2 = await fetch(base + '/beta')
        let b = await r2.text()
        return a + '|' + b
      }
      export let f = (base) => probe(base)`)
    is(await out.exports.f(base), 'pong:/alpha|pong:/beta')
  } finally { srv.close() }
})

test('fetch: host wasi warns (bind env.fetch yourself)', () => {
  const warnings = { entries: [] }
  jz.compile('async function g() { let r = await fetch("x"); return r } export let f = () => g()', { host: 'wasi', warnings })
  ok(warnings.entries.some(w => w.code === 'host-global'), 'wasi warning present')
})

// Async generators — the same sync machine with TAGGED yields ({a:1}=await,
// {a:0}=yield), driven by __ag_run: next() returns promises, requests
// serialize through a per-instance queue, yield* delegates through await'd
// next(), and `for await` desugars to plain awaits (usable in async fns too,
// over async iterators, sync iterators, and arrays of promises alike).
test('async generators: protocol, await bodies, sent values', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function* g() { yield 1; yield 2 }
                async function drive() {
                  let it = g()
                  let r1 = await it.next()
                  let r2 = await it.next()
                  let r3 = await it.next()
                  return '' + r1.value + r1.done + '|' + r2.value + '|' + r3.done
                }
                export let f = () => drive()`), '1false|2|true')
  is(await val(`async function* g() { let a = await 10; yield a + 1; let b = await (a + 20); yield b }
                async function drive() {
                  let it = g()
                  let r1 = await it.next()
                  let r2 = await it.next()
                  return '' + r1.value + '|' + r2.value
                }
                export let f = () => drive()`), '11|30')
  is(await val(`async function* g() { let x = yield 'a'; yield x + '!' }
                async function drive() { let it = g(); await it.next(); let r = await it.next('hi'); return r.value }
                export let f = () => drive()`), 'hi!')
})

test('async generators: for await + yield* delegation', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function* g() { yield 1; yield 2; yield 3 }
                async function sum() { let s = 0; for await (const v of g()) s += v; return s }
                export let f = () => sum()`), 6)
  is(await val(`async function sum() {
                  let s = 0
                  for await (const v of [Promise.resolve(1), 2, Promise.resolve(3)]) s += v
                  return s
                }
                export let f = () => sum()`), 6)
  is(await val(`function* g() { yield 5; yield 6 }
                async function sum() { let s = 0; for await (const v of g()) s += v; return s }
                export let f = () => sum()`), 11)
  is(await val(`async function* inner() { yield 1; yield 2 }
                async function* g() { yield 0; yield* inner(); yield 3 }
                async function drive() { let out = ''; for await (const v of g()) out += v; return out }
                export let f = () => drive()`), '0123')
})

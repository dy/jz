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

test('async: real fetch through a host import (local http server)', async () => {
  if (onWasi() || onKernel()) return
  const { createServer } = await import('node:http')
  const srv = createServer((req, res) => res.end('pong:' + req.url)).listen(0)
  await new Promise(r => srv.once('listening', r))
  try {
    const base = 'http://localhost:' + srv.address().port
    const out = jz(`import { fetchText } from 'host'
      async function probe(base) {
        let a = await fetchText(base + '/alpha')
        let b = await fetchText(base + '/beta')
        return a + '|' + b
      }
      export let f = (base) => probe(base)`,
      { imports: { host: { fetchText: (url) => fetch(url).then(r => r.text()) } } })
    is(await out.exports.f(base), 'pong:/alpha|pong:/beta')
  } finally { srv.close() }
})

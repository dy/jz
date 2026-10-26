// async/await v1 (plain-jz promise runtime on the generator machinery):
// `async fn` lowers to (a, b) => __async_run((function* (a, b){ body })(a, b)), an await
// suspending the machine as a yield does;
// promises are fixed-shape objects with then/catch/finally closure props; the
// microtask queue drains at host boundaries (export return, timer tick) and
// the interop wrapper adopts promise-shaped returns into HOST Promises —
// pending ones settle from the after-tick sweep. Pay-per-use: sync programs
// never link any of it. try/catch across await routes the rejection to the catch.
// Divergences (documented): job ordering is per-drain-cycle; no unhandled-
// rejection reporting; no SuppressedError.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { batch, oracle } from './util.js'
import { onWasi, onKernel } from './_matrix.js'

const val = async (src, ...args) => {
  const r = jz(src).exports.f(...args)
  ok(r instanceof Promise, 'async export adopts into a host Promise')
  return r
}

// Batch several standalone `export let f = <arrow>` programs (no module-level
// state, no shared names) into ONE compiled module — one compile instead of
// one per program. Each thunk calls its own export and asserts the same
// Promise-adoption check `val` makes, ready to be awaited.
const valAll = (arrows) => batch(arrows).map(f => () => {
  const r = f()
  ok(r instanceof Promise, 'async export adopts into a host Promise')
  return r
})

test('async: named expressions preserve immutable self bindings', async () => {
  for (const generator of [false, true]) {
    const { f } = jz(`export async function f() {
      let name = 'outside', read, write, effects = 0
      const fn = async function${generator ? '*' : ''} name() {
        await 0
        read = () => name
        write = () => name = (effects++, 7)
      }
      ${generator ? 'await fn().next()' : 'await fn()'}
      const value = write()
      return [read() === fn, name, value, effects]
    }`).exports
    is(await f(), [true, 'outside', 7, 1])
    is(await f(), [true, 'outside', 7, 1])
  }
})

test('async: escaped promise handlers keep callback argument identity', async () => {
  const source = `const same = (a, b) => {
    if (a === b) return a !== 0 || 1 / a === 1 / b
    return a !== a && b !== b
  }
  var check = x => x
  check.same = (a, b) => { if (!same(a, b)) throw 'identity lost' }
  export function f() {
    check.same(1, 1)
    return Promise.resolve(true).then(value => {
      check.same(value, true)
      check.same(undefined, undefined)
      return typeof value
    })
  }`
  const { f } = jz(source).exports
  is(await f(), 'boolean')
  is(await f(), 'boolean', 'another drain preserves the same callback contract')
})

test('async: parameter initialization rejects instead of throwing synchronously', async () => {
  const { f } = jz(`const fail = () => { throw 'default' }
    async function work(x = fail()) { return x }
    export function f(provided) {
      let p
      try { p = provided ? work(7) : work() } catch (e) { return 'sync:' + e }
      return p.then(v => 'ok:' + v, e => 'rejected:' + e)
    }`).exports
  for (const [input, expected] of [[0, 'rejected:default'], [0, 'rejected:default'], [1, 'ok:7'], [0, 'rejected:default']])
    is(await f(input), expected)
  is(await val(`export async function f() { async function work({x}) { return x }; try { await work(null) } catch (e) { return 'caught' } }`), 'caught')
})

test('async: settled and pending reactions share FIFO ordering', async () => {
  const { f } = jz(`export async function f() {
    const actual = []
    let calls = 0
    const thenable = { then: resolve => resolve(++calls) }
    async function trigger() {
      actual.push('await:' + await thenable)
      actual.push('await:' + await thenable)
    }
    const done = trigger()
    new Promise(resolve => { actual.push('promise:1'); resolve() })
      .then(() => { actual.push('promise:2') })
      .then(() => { actual.push('promise:3') })
      .then(() => { actual.push('promise:4') })
    await done
    return actual.join(',')
  }`).exports
  for (let i = 0; i < 2; i++) is(await f(), 'promise:1,promise:2,await:1,promise:3,promise:4,await:2')
})

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
  const [c0, c1, c3, c4] = valAll([
    `() => Promise.resolve(2).then((v) => v + 40)`,
    `() => Promise.reject('R').catch((e) => 'c:' + e)`,
    `() => Promise.race([Promise.resolve('fast'), new Promise(() => 0)])`,
    `() => new Promise((res) => res(9)).then((v) => v + 1)`,
  ])
  is(await c0(), 42)
  is(await c1(), 'c:R')
  is(await val(`async function a() { return 1 }
                export let f = () => Promise.all([a(), Promise.resolve(2), 3]).then((vs) => vs.join('-'))`), '1-2-3')
  is(await c3(), 'fast')
  is(await c4(), 10)
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

// try/catch across an await: the machine's try regions route an awaited
// rejection (and a throw after the await) to the catch; a fulfilled await
// continues past it; the catch's own await works; a `finally` that awaits
// stays out with a precise message.
test('async: try/catch across await routes the rejection to the catch', async () => {
  if (onWasi() || onKernel()) return
  const src = `
    const fail = async (n) => { if (n > 2) throw 42; return n * 10 }
    const tag = async (v) => v + 1000
    export let f = async (n) => {
      let out = 0
      try { out = await fail(n); out += 1; if (n === 2) throw 5 } catch (e) { out = await tag(e) }
      return out * 1000 + n
    }`
  // Same program, three arguments — compile once, call three times.
  const { exports } = jz(src)
  const call = (n) => {
    const r = exports.f(n)
    ok(r instanceof Promise, 'async export adopts into a host Promise')
    return r
  }
  is(await call(1), 11001)
  is(await call(5), 1042005)
  is(await call(2), 1005002)
})

test('async: destructuring declarations across an await', async () => {
  if (onWasi() || onKernel()) return
  const src = `
    const get = async (n) => ({ a: n, b: n * 2, arr: [7, 8, 9] })
    export let f = async (n) => {
      let { a, b: c, d = 5 } = await get(n)
      const { arr: [x, , y, ...rest] } = await get(n)
      return a + c * 10 + d * 100 + x * 1000 + y * 10000 + rest.length * 100000
    }`
  is(await val(src, 3), 97563)
})

// Each export answers, once settled, what Node's does.
const agreeAsync = async (source) => {
  const expected = oracle(source), actual = jz(source).exports
  for (const name of Object.keys(expected)) is(await actual[name](), await expected[name](), name)
}

test('async: a finally that awaits runs for every completion', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    async function g(x) { try { await 1; if (x) throw 'E'; log += 't'; return 'r' } catch (e) { log += e } finally { await 2; log += 'f' } return 'n' }
    export async function passes() { log = ''; return await g(0) + log }
    export async function throws() { log = ''; return await g(1) + log }`)
})

// for await closes its iterator, awaiting return(), when the body leaves
// early, and a continue advances it.
test('async: for await closes its iterator on an early exit', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    function* g() { try { yield 1; yield 2; yield 3 } finally { log += 'F' } }
    const own = (ret) => ({ i: 0, next() { this.i++; return Promise.resolve({ value: this.i, done: this.i > 3 }) }, return: ret, [Symbol.asyncIterator]() { return this } })
    export async function broken() { log = ''; for await (const x of g()) { log += x; break } return log }
    export async function thrown() { log = ''; try { for await (const x of g()) throw 'E' } catch (e) { log += e } return log }
    export async function skipped() { log = ''; for await (const x of g()) { if (x < 3) continue; log += x } return log }
    export async function closed() { log = ''; for await (const x of own(() => { log += 'R'; return Promise.resolve({}) })) if (x === 2) break; return log }
    export async function notObject() { try { for await (const x of own(() => 5)) break } catch (e) { return e instanceof TypeError } }`)
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
  // a declaration in a for-await body inside an async generator, as a stream
  // reader binds each chunk (dy/jz#117: 0.9.2 read 'chunk' as declared twice)
  is(await val(`async function* frames(xs) {
                  for await (const data of xs) {
                    const chunk = data
                    if (chunk > 1) { const twice = chunk * 2; yield twice } else yield chunk
                  }
                }
                async function drive() { let out = ''; for await (const v of frames([1, Promise.resolve(2), 3])) out += v + ','; return out }
                export let f = () => drive()`), '1,4,6,')
})

// try/catch/finally across await and yield in an async generator: a rejected
// await, a rejected yielded value or a throw() lands in the catch; return(v)
// at a yield awaits v, then runs the finally blocks, which may await or yield;
// `return E` awaits E; requests queue (ECMA-262 27.6.3).
test('async generators: try/catch/finally across await and yield', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const show = (r) => r.value + ':' + r.done + ','
    const reject = (e) => Promise.reject(e)
    async function* caught() { try { await reject('E'); yield 'no' } catch (e) { yield 'c' + e } yield 'after' }
    async function* fin() { try { yield 1 } finally { await 0; log += 'F' } }
    async function* again() { try { yield 1 } finally { yield 'again'; log += 'Y' } }
    async function* handles() { try { yield 1 } catch (e) { log += e; yield 'h' } yield 'z' }
    async function* rejects() { try { yield reject('Y') } catch (e) { yield 'got' + e } }
    async function* returns() { try { return reject('R') } catch (e) { return 'ret' + e } }
    async function* plain() { log += 'S'; yield 1 }
    export async function awaited() { const it = caught(); return show(await it.next()) + show(await it.next()) + show(await it.next()) }
    export async function returned() { log = ''; const it = fin(); await it.next(); return show(await it.return(5)) + show(await it.next()) + log }
    export async function yieldsAgain() { log = ''; const it = again(); await it.next(); return show(await it.return(5)) + show(await it.next()) + log }
    export async function thrown() { log = ''; const it = handles(); await it.next(); return show(await it.throw('T')) + show(await it.next()) + log }
    export async function yieldedRejection() { const it = rejects(); return show(await it.next()) + show(await it.next()) }
    export async function returnAwaits() { const it = returns(); return show(await it.next()) }
    export async function returnRejectsAtYield() { log = ''; const it = handles(); await it.next(); return show(await it.return(reject('Q'))) + log }
    export async function throwAtStart() { log = ''; const it = plain(); let m = ''; try { await it.throw('X') } catch (e) { m = e } return m + show(await it.next()) + log }
    export async function returnAtStart() { log = ''; const it = plain(); return show(await it.return(Promise.resolve(4))) + show(await it.next()) + log }
    export async function completed() { const it = plain(); await it.next(); await it.next(); let m = ''; try { await it.throw('D') } catch (e) { m = e } return m + show(await it.return(Promise.resolve(3))) }
    export async function queued() { log = ''; const it = handles(); const a = it.next(), b = it.throw('Q'), c = it.return(Promise.resolve(8)), d = it.next(); return show(await a) + show(await b) + show(await c) + show(await d) + log }`)
})

// The driver settles requests and resumes the body in the microtask order
// Node's does, against a ticker counting jobs.
test('async generators: requests settle in microtask order', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const ticker = async (n) => { for (let i = 0; i < n; i++) { log += i; await null } }
    async function* g() { log += 'a'; yield 1; log += 'b'; try { await null; log += 'c'; yield 2 } finally { log += 'f'; await null; log += 'g' } }
    async function* h() { try { yield Promise.resolve('p'); log += 'h' } catch (e) { log += 'x' } return Promise.resolve('q') }
    export async function requests() {
      log = ''
      const it = g(), t = ticker(12)
      const p = it.next().then(r => { log += 'N' + r.value }), q = it.next().then(r => { log += 'M' + r.value }), s = it.return(9).then(r => { log += 'R' + r.value })
      await t; await p; await q; await s
      return log
    }
    export async function values() {
      log = ''
      const it = h(), t = ticker(10)
      const p = it.next().then(r => { log += 'N' + r.value }), q = it.next().then(r => { log += 'M' + r.value })
      await t; await p; await q
      return log
    }
    export async function returnAtStart() {
      log = ''
      const t = ticker(6), it = g()
      const p = it.return(Promise.resolve(3)).then(r => { log += 'R' + r.value }), q = it.next().then(r => { log += 'N' + r.done })
      await t; await p; await q
      return log
    }`)
})

// yield* in an async generator hands next(), throw() and return() to its
// delegate, awaiting each result; a sync delegate's values are awaited
// (CreateAsyncFromSyncIterator). A for await closes its iterator when the
// body leaves early or a return() arrives at a yield inside it.
test('async generators: yield* and for await forward to and close the inner iterator', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const show = (r) => r.value + ':' + r.done + ','
    async function* inner() { try { yield 'a'; yield 'b' } catch (e) { log += 'c' + e; yield 'h'; return 'r' } finally { log += 'I'; await null; log += 'J' } }
    async function* outer() { try { const v = yield* inner(); log += 'v' + v; yield 'z' } finally { log += 'O' } }
    function* sync() { try { yield 1; yield Promise.resolve(2) } catch (e) { log += 's' + e; yield 'k' } finally { log += 'S' } }
    async function* overSync() { const v = yield* sync(); log += 'w' + v }
    function* rejecting() { try { yield 1; yield Promise.reject('R') } finally { log += 'S' } }
    async function* overRejecting() { try { yield* rejecting() } catch (e) { log += 'c' + e } }
    async function* loop() { try { for await (const x of inner()) { yield x; if (x === 'b') break } yield 'end' } finally { log += 'F' } }
    const own = () => ({ next() { return Promise.resolve({ value: 1, done: false }) }, return() { log += 'R'; return Promise.resolve({}) }, [Symbol.asyncIterator]() { return this } })
    async function* viaOwn() { try { yield* own() } catch (e) { log += e instanceof TypeError ? 'T' : 'x'; yield 'p' } }
    const syncOwn = () => ({ next() { return { value: 1, done: false } }, return() { log += 'R'; return {} }, [Symbol.iterator]() { return this } })
    async function* viaSyncOwn() { try { yield* syncOwn() } catch (e) { log += e instanceof TypeError ? 'T' : 'x'; yield 'p' } }
    export async function returned() { log = ''; const it = outer(); await it.next(); return show(await it.return(5)) + log }
    export async function thrown() { log = ''; const it = outer(); await it.next(); return show(await it.throw('X')) + show(await it.next()) + show(await it.next()) + log }
    export async function syncValues() { log = ''; let s = ''; for await (const v of overSync()) s += v; return s + log }
    export async function syncThrown() { log = ''; const it = overSync(); await it.next(); return show(await it.throw('Y')) + show(await it.next()) + log }
    export async function missingThrow() { log = ''; const it = viaOwn(); await it.next(); return show(await it.throw('W')) + log }
    export async function syncMissingThrow() { log = ''; const it = viaSyncOwn(); await it.next(); return show(await it.throw('V')) + log }
    export async function syncRejects() { log = ''; let s = ''; for await (const v of overRejecting()) s += v; return s + log }
    export async function forSyncRejects() { log = ''; try { for await (const v of rejecting()) log += v } catch (e) { log += 'E' + e } return log }
    export async function broken() { log = ''; let s = ''; for await (const v of loop()) s += v; return s + log }
    export async function closedAtYield() { log = ''; const it = loop(); await it.next(); return show(await it.return(7)) + log }`)
})

// Forwarding takes the jobs Node's does: a done return() result ends the
// generator with its value as it is, a missing return() awaits it; a for
// await over an async iterator awaits each next() only.
test('async generators: delegation and for await settle in microtask order', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const ticker = async (n) => { for (let i = 0; i < n; i++) { log += i; await null } }
    async function* inner() { try { yield 'a'; yield 'b' } finally { log += 'I'; await null; log += 'J' } }
    async function* outer(src) { try { yield* src } finally { log += 'O' } }
    const own = (ret) => ({ next() { return Promise.resolve({ value: 1, done: false }) }, return: ret, [Symbol.asyncIterator]() { return this } })
    const closing = async (src, v) => {
      log = ''
      const it = outer(src)
      await it.next()
      const t = ticker(10), p = it.return(v).then(r => { log += 'R' + (typeof r.value === 'object' ? 'obj' : r.value) })
      await t; await p
      return log
    }
    export async function requests() {
      log = ''
      const it = outer(inner()), t = ticker(16)
      const a = it.next().then(r => { log += 'N' + r.value }), b = it.next().then(r => { log += 'M' + r.value }), c = it.return(9).then(r => { log += 'R' + r.value })
      await t; await a; await b; await c
      return log
    }
    export const doneValue = () => closing(own(() => { log += 'r'; return { value: Promise.resolve(9), done: true } }), 5)
    export const noReturn = () => closing({ next() { return Promise.resolve({ value: 1, done: false }) }, [Symbol.asyncIterator]() { return this } }, 5)
    export async function consumer() { log = ''; const t = ticker(12); for await (const v of inner()) log += 'v' + v; await t; return log }`)
})

// An await in a switch, a case's test, a loop's test, step or initializer
// suspends where it stands, in Node's order; an assignment reads its target's
// key and its current value before the await, as concurrent tasks see.
test('async: await in switch, loop heads and assignments', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const tick = async (n) => { for (let i = 0; i < n; i++) { log += i; await null } }
    class W { async write(x) { log += 'w' + x; await null; return x * 10 }
      async run(op) { let r = 0; switch (op) { case 1: r = await this.write(1); break; case 2: r = await this.write(2); case 3: r += await this.write(3); break; case (await this.write(4)) / 10: r = -4; break; default: r = -1 } return r } }
    let total = 0, i = 0, arr = [], calls = 0
    const add = async (n) => { total += await n }
    const slot = async (x) => { arr[i++] = await x }
    const v = async (x) => { calls++; return x }
    export async function switches() { log = ''; const w = new W(), t = tick(16), out = []; for (let k = 1; k < 6; k++) out.push(await w.run(k)); await t; return out.join() + log }
    export async function racing() { total = 0; await Promise.all([add(1), add(2), add(3)]); return total }
    export async function slots() { i = 0; arr = []; const a = slot(new Promise(r => setTimeout(() => r('A'), 5))), b = slot('B'); await a; await b; return arr.join() }
    export async function logical() { calls = 0; let a = 1, b = 0, c = null; a ||= await v(5); b ||= await v(6); c ??= await v(7); a &&= await v(8); return [a, b, c, calls].join() }
    export async function heads() { let n = 0, s = ''; const more = async () => n++ < 4; while (await more()) { if (n === 2) continue; s += n } do { n++; if (n === 7) continue; s += 'd' + n } while (await (n < 8)); for (let k = await 1; k < 4; k = await (k + 1)) { if (k === 2) continue; s += 'k' + k } return s }
    export async function labeled() { let s = ''; outer: for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) { await null; if (b === 1) continue outer; if (a === 2) break outer; s += a + '' + b } } return s }`)
})

// An await in a for-of or for-in body runs once per value, in Node's order; a
// return from the body closes the iterator; a labeled jump reaches its for await.
test('async: await in for-of and for-in bodies', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const tick = async (n) => { for (let i = 0; i < n; i++) { log += i; await null } }
    function* src() { try { yield 1; yield 2; yield 3 } finally { log += 'F' } }
    async function sum(a) { let s = 0; for (const x of a) s += await x; return s }
    async function first(a) { for (const x of a) { if (x > 1) return x * (await 10) } return 0 }
    async function walk() { for (const x of src()) { log += 'x' + x; await null; if (x === 2) return x } }
    async function keys(o) { let s = ''; for (const k in o) s += k + await o[k]; return s }
    async function* echo(a) { for (const x of a) yield await x }
    export async function values() { log = ''; const t = tick(8); const out = [await sum([1, Promise.resolve(2), 3]), await first([1, 2, 3]), await first([0]), await keys({ a: 1, b: Promise.resolve(2) })]; await t; return out.join() + log }
    export async function closes() { log = ''; const t = tick(8); const r = await walk(); await t; return r + log }
    export async function generated() { let s = ''; for await (const v of echo([1, Promise.resolve(2), 3])) s += v; return s }
    export async function labeled() { let s = ''; outer: for await (const x of [1, 2, 3]) { for await (const y of ['a', 'b']) { if (y === 'b') continue outer; if (x === 3) break outer; s += x + y } } return s }`)
})

// A closure made in a loop that awaits keeps its own iteration's bindings,
// a for await's and a for-in's included, while the loop's tasks interleave.
test('async: closures keep their iteration\'s bindings across awaits', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    async function loops() { const fs = []; for (let i = 0; i < 3; i++) { await null; fs.push(() => i) } for (const k in { a: 1, b: 2 }) { await null; fs.push(() => k) } for await (const x of [1, 2]) fs.push(() => x); return fs.map(f => f()).join() }
    async function task(tag) { for (let i = 0; i < 2; i++) { await null; setTimeout(() => { log += tag + i }, 0) } }
    export const bindings = () => loops()
    export async function interleaved() { log = ''; await Promise.all([task('a'), task('b')]); await new Promise(r => setTimeout(r, 5)); return log }`)
})

// A destructuring declaration across an await binds as one anywhere does:
// an object rest, an iterator's values through its protocol, a for await's
// pattern, a default that awaits.
test('async: destructuring with rests and iterators across awaits', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`function* src() { yield 1; yield 2; yield 3 }
    export async function f() { const { a, ...rest } = await Promise.resolve({ a: 1, b: 2, c: 3 }); const [x, ...more] = await src(); let s = ''; for await (const [k, { v = 0 }] of [['p', { v: 1 }], ['q', {}]]) s += k + v; return a + Object.keys(rest).join() + x + more.join() + s }
    export async function awaited() { const { a = await Promise.resolve(1), b = await 2 } = { b: 10 }; const [x = await 3] = []; return a + b + x }`)
})

// A function declaration in a block an async body splits binds at the
// block's start; an async one too, closing over its iteration.
test('async: function declarations in split blocks', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`export async function f(c) { let s = ''; if (c !== 0) { s += h() + await 1; function h() { return 5 } } for (let i = 0; i < 2; i++) { async function step() { await null; return 'i' + i } s += await step() } return s }`)
})

// An async generator's yield* takes a builtin iterable as for-of reads it,
// each value awaited: a string by code point, a Map's entries.
test('async generators: yield* over builtin iterables', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`async function* g(x) { yield* x }
    export async function strings() { let s = ''; for await (const v of g('x😀y')) s += v + '|'; return s }
    export async function entries() { let s = ''; for await (const [k, v] of g(new Map([['k', Promise.resolve(1)], ['j', 2]]))) s += k + typeof v; return s }
    export async function values() { let s = 0; for await (const v of g(new Set([1, Promise.resolve(2)]))) s += v; return s }`)
})

// An object rest of a value an async call resolves to (a layout the promise
// carries, lost to the summary) holds the keys its pattern leaves, for every
// reader: a property read, Object.keys and entries, a for-in.
test('async: an object rest of a resolved value holds its keys', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`const get = async (n) => ({ a: n, b: n * 2, c: n + 1 })
    const h = (v) => { const { a, ...rest } = v; let s = ''; for (const k in rest) s += k; return Object.keys(rest).join() + s + JSON.stringify(Object.entries(rest)) + rest.b }
    export async function passed() { return h(await get(3)) }
    export async function bound() { const { b, ...r } = await get(1); return Object.keys(r).join() + r.c }`)
})

// A call whose arguments await evaluates its callee first, a method's
// receiver and computed key; an optional chain whose base is nullish skips the
// rest of the chain, an await in it too (ECMA-262 EvaluateCall, OptionalChain).
test('async: a call reads its callee before an await in its arguments', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = ''
    const st = { obj: { tag: 'old', f(v) { return this.tag + v } } }
    const later = async () => { await null; st.obj = { tag: 'new', f(v) { return this.tag + v } }; return 1 }
    const v = async (x) => { log += 'V'; await null; return x }
    const pick = () => { log += 'P'; return (x) => log += 'C' + x }
    const o = { k: 5, a(x) { return log += 'a' + x }, m(x) { return this.k + x } }
    const key = () => { log += 'K'; return 'a' }
    export async function receiver() { return st.obj.f(await later()) }
    export async function callee() { log = ''; pick()(await v(1)); o[key()](await v(2)); const m = (o.m)(await v(3)); return log + m }
    export async function optional() {
      log = ''
      const a = null, b = { c: null }, d = { c: { e: (x) => x * 3 } }, p = { k: 1 }
      return [a?.b(await v(1)), a?.c.e(await v(2)), b.c?.e(await v(3)), d?.c.e(await v(4)), o.m?.(await v(5)), p.m?.(await v(6)), a?.[await v('x')], d?.[await v('c')].e(1), log].join()
    }`)
})

// `using` in an async body disposes its resource after the awaits of the rest
// of its block, a rejection's too.
test('async: using disposes across awaits', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`const log = []
    const res = async (n) => ({ n, [Symbol.dispose]() { log.push('d' + n) } })
    const fail = async () => { using a = await res(1); await null; throw 'e' }
    export async function f() { { using a = await res(4); log.push(a.n); await null } log.push('after'); try { await fail() } catch (e) { log.push(e) } return log.join() }`)
})

// What JS evaluates before a suspension reads before it where another
// activation could tell: a name another call or a closure assigns meanwhile,
// a callee of that name, a method off a receiver whose key the program
// writes or a getter defines (called on that receiver), a constructor, a
// spread's iteration, a shorthand's value, a computed key, an assignment's
// receiver. A name nothing else assigns, and a builtin method, read in place.
test('async: operands read before an await where JS reads them', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`let log = '', total = 0, n = 1, k = 'a', g = (x) => 'old' + x
    class A { constructor(x) { this.t = 'A' + x } }
    class B { constructor(x) { this.t = 'B' + x } }
    let C = A
    const o = { k: 3, m(x) { return this.k + x }, get h() { log += 'G'; return (x) => log += 'H' + x } }
    const ns = { get B() { log += 'N'; return B } }
    const v = async (x) => { log += 'V'; await null; return x }
    const swap = async () => { await null; g = (x) => 'new' + x; o.m = (x) => 'new' + x; C = B; n = 2; k = 'b'; return 1 }
    const add = async (x) => { total = total + await Promise.resolve(x); return total }
    export async function operand() { log = 'a'; return log + await v(1) }
    export async function concurrent() { total = 0; await Promise.all([add(1), add(2), add(3)]); return total }
    export async function captured() { let x = 1; const bump = async () => { await null; x = 10 }; const p = bump(); const r = x + await Promise.resolve(5); await p; return r + ',' + x }
    export async function callees() { return [g(await swap()), o.m(1)].join() }
    export async function methods() { o.m = function (x) { return 'kept' + x }; const r = o.m(await v(1)); log = ''; o.h(await v(2)); return r + log }
    export async function constructors() { C = A; log = ''; const a = new C(await swap()).t, b = new ns.B(await v(4)).x; return a + log }
    export async function literals() {
      const xs = [1, 2], obj = { a: 1 }
      const later = async () => { await null; xs.push(3); obj.b = 2; n = 5; k = 'z'; return 9 }
      n = 1; k = 'a'
      return JSON.stringify([[...xs, await later()], { ...obj, c: await later() }, { n, c: await later() }, { [k]: await later() }])
    }
    export async function receiver() { let p = { v: 0 }; const old = p; const swapP = async () => { await null; p = { v: 0 }; return 5 }; p.v = await swapP(); return old.v + ',' + p.v }
    export async function local() { let x = 1; x = 2; const out = []; for (let i = 0; i < 2; i++) out.push(x + await Promise.resolve(i)); return out.join() }`)
})

// A promise has no own enumerable property: JSON.stringify gives `{}`, and
// Object.keys, entries, for-in and a spread see nothing, while it still settles.
test('async: a promise enumerates no keys', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`const g = async () => 1
    const box = []
    export function json() { return JSON.stringify([Promise.resolve(1), { p: Promise.reject(2).catch(() => 0) }]) }
    export function keys() { const p = Promise.resolve(1); let s = ''; for (const k in p) s += k; return Object.keys(p).length + '|' + s + '|' + JSON.stringify({ ...p }) + '|' + Object.entries(p).length }
    export function dynamic() { box.push(Promise.resolve(3), { x: 1 }); return box.map(v => JSON.stringify(v)).join() }
    export async function settled() { const p = g(); const s = JSON.stringify(p); return s + (await p) + ('then' in p) }`)
})

// A class in an async body lowers in the body's scope, as in any function.
test('async: a class in the body reads its bindings', async () => {
  if (onWasi() || onKernel()) return
  await agreeAsync(`async function h(n) { await null; const C = class { v() { return n + 1 } }; return new C().v() }
    async function* g() { for (let i = 0; i < 2; i++) { await null; const C = class { v() { return i } }; yield new C().v() } }
    export async function f() { const out = [await h(5)]; for (let i = 0; i < 3; i++) { await null; const C = class { v() { return i } }; out.push(new C().v()) } for await (const v of g()) out.push(v); return out.join() }`)
})

test('async/generator bodies: nested function forms own their returns and declarations', async () => {
  if (onWasi() || onKernel()) return
  // Re-audit finding (2026-08-20): hasReturn/hasYield/hasFreeJump/collectLocals
  // stopped only at '=>' (or nowhere), so a nested function declaration's own
  // `return` forced statement decomposition and read as a machine return.
  // One canonical boundary (FN_BOUNDARY_OPS) + fn-decl hoisting fix these.
  // Function DECLARATION at machine-body top level — hoisted to a const-bound
  // expression; callable before its textual position (JS hoisting semantics).
  const [c0, c1, c2, c3, c4, c5] = valAll([
    `async () => { function helper() { return 1 } return helper() }`,
    `async () => { const v = helper(); function helper() { return 6 } return v }`,
    `async () => { const h = function () { return 2 }; return h() }`,
    `async () => { function helper() { let x = 7; return x } return helper() }`,
    `async () => { function helper() { return 10 } const v = await Promise.resolve(helper()); return v + 1 }`,
    `async () => { const h = () => 3; return h() }`,
  ])
  is(await c0(), 1)
  is(await c1(), 6)
  // Function EXPRESSION with its own return — was decomposed into a machine
  // return pre-fix ("yield inside `const`" rejection).
  is(await c2(), 2)
  // Nested declaration's own locals stay its own (collectLocals boundary).
  is(await c3(), 7)
  // Interleaves with genuine machine effects (await) correctly.
  is(await c4(), 11)
  // Nested arrows keep working (the one boundary the old walkers had).
  is(await c5(), 3)
  // Same machinery, plain generator: fn decl at generator-body top level.
  is(jz(`function* g() { function h() { return 4 } yield h() }
         export let f = () => g().next().value`).exports.f(), 4)
})

test('async: finally overrides rejection with return or throw', async () => {
  if (onWasi() || onKernel()) return
  is(await val(`async function g() { try { await Promise.reject('E') } finally { return 42 } }
    export let f = () => g()`), 42)
  is(await val(`async function g() { try { await Promise.reject('E') } finally { throw 'F' } }
    export let f = () => g().catch(e => e)`), 'F')
  is(await val(`let log = ''; async function g() {
    try { await Promise.reject('E') } catch(e) { log += e; throw 'C' } finally { log += 'F' }
  } export let f = () => g().catch(e => log + e)`), 'EFC')
})

test('async: an await anywhere in an expression suspends at a statement, in source order', async () => {
  if (onWasi() || onKernel()) return
  const g = 'let log = ""; const g = async (x) => { log += x; return x };'
  const cases = {
    operand: [`const q = async (a) => { return await a + 1 }; export let f = () => q(4)`, 5],
    argumentsInOrder: [`${g} const add = (a, b, c) => a * 100 + b * 10 + c; const q = async () => add(await g(1), 2, await g(3)); export let f = async () => (await q()) * 10 + log.length`, 1232],
    conditionalArms: [`${g} const q = async (c) => c ? await g(1) : await g(2); export let f = async () => (await q(true)) * 10 + (await q(false)) + log.length * 100`, 212],
    shortCircuit: [`${g} const q = async (c) => c && await g(7); export let f = async () => (await q(true)) * 10 + ((await q(false)) === false ? 1 : 0) + log.length * 100`, 171],
    ifTest: [`${g} const q = async () => { if (await g(1)) return 5; return 6 }; export let f = () => q()`, 5],
    whileTest: [`let n = 0; const more = async () => n++ < 3; const q = async () => { let s = 0; while (await more()) s += 2; return s }; export let f = () => q()`, 6],
    forTest: [`let n = 0; const more = async () => n++ < 3; const q = async () => { let s = 0; for (let i = 0; await more(); i++) s += i; return s }; export let f = () => q()`, 3],
    memberOfAwait: [`const g = async (x) => ({ v: x }); const q = async () => (await g(3)).v + 1; export let f = () => q()`, 4],
    forOfSource: [`const g = async () => [1, 2, 3]; const q = async () => { let s = 0; for (const v of await g()) s += v; return s }; export let f = () => q()`, 6],
    literalValue: [`${g} const q = async () => ({ a: await g(1), b: [await g(2)] }); export let f = async () => { const o = await q(); return o.a * 10 + o.b[0] }`, 12],
    compound: [`${g} const q = async () => { let v = await g(2); v += await g(3) * 2; return v }; export let f = () => q()`, 8],
    thrown: [`const q = async () => { throw new Error('e' + await Promise.resolve(1)) }; export let f = async () => { try { await q(); return 0 } catch (e) { return e.message } }`, 'e1'],
  }
  for (const [name, [src, want]] of Object.entries(cases)) is(await val(src), want, name)
})

// An object-literal `async m() {}` is a method shorthand whose one-statement
// body arrives bare (the parser's shape for every one-statement body); the
// async lowering took it for a concise expression body and returned the
// statement's own non-value (a NaN-box leak read as 2.78e-307). Async
// generator members `async *g()` and `async *[computed]()` parse with the
// async on the member's value, as `async m()` does. Reference: ECMA-262
// 15.6 AsyncFunctionBody, 15.7 AsyncGeneratorMethod, 27.7 Promise jobs.
test('async: object-literal method shorthands and async generator members', async () => {
  if (onWasi() || onKernel()) return
  const { main } = jz(`const o = {
      async m(x) { if (x) return 5; let y = x + 1; return y },
      async n() { return 'ab' },
      async k(a) { return await o.m(a) },
      async *g() { yield 1; yield 2 },
      async *[Symbol.asyncIterator]() { yield 3 },
    }
    export async function main() {
      let s = 0
      for await (const v of o.g()) s += v
      for await (const v of o) s += v
      return [await o.m(1), await o.m(0), await o.n(), await o.k(3), s]
    }`).exports
  is(await main(), [5, 1, 'ab', 5, 6])
})

test('async: class async and async generator methods, instance and static', async () => {
  if (onWasi() || onKernel()) return
  const { main } = jz(`class C {
      constructor() { this.k = 10 }
      async *g() { yield this.k; yield 2 }
      async m() { return 3 }
      static async *s() { yield 4 }
      static async t() { return 5 }
    }
    export async function main() {
      let t = 0
      const c = new C()
      for await (const v of c.g()) t += v
      for await (const v of C.s()) t += v
      return t + await c.m() + await C.t()
    }`).exports
  is(await main(), 24)
})

// `new Promise()` without an executor throws a TypeError, at the call and through an await.
test('async: a promise without an executor is a TypeError', async () => {
  if (onWasi() || onKernel()) return
  const src = `let sync = 0, awaited = 0
    try { new Promise() } catch (e) { sync = e instanceof TypeError ? 1 : 2 }
    async function foo() { await new Promise(5) }
    export let start = () => foo().catch((e) => { awaited = e instanceof TypeError ? 1 : 2 })
    export let check = () => sync * 10 + awaited`
  for (const optimize of [0, 2]) {
    const m = jz(src, { optimize }).exports
    await m.start()
    is(m.check(), 11, `O${optimize}: both the call and the await reject with a TypeError`)
  }
})

// async/await v1 (plain-jz promise runtime on the generator machinery):
// `async fn` lowers to (...aa) => __async_run((function* (params){ await→yield })(...aa));
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
import { batch } from './util.js'
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

test('async: a finally that awaits is a precise reject', () => {
  let e
  try { jz.compile(`async function g() { try { await 1 } finally { await 2 } } export let f = () => 1`) } catch (x) { e = x }
  ok(e && e.message.includes('finally'), `precise reject: ${e?.message?.slice(0, 80)}`)
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

test('async/generator bodies: block-nested function declaration is a named v1 reject', () => {
  if (onWasi() || onKernel()) return
  // A declaration inside a DECOMPOSED block (if/loop arm) has no hoist lane
  // yet — must refuse with the named limit, never leak an unresolvable
  // reference or a silent trap.
  let msg = ''
  try { jz(`export let f = async (c) => { if (c) { function h() { return 5 } return h() } return 0 }`) }
  catch (e) { msg = e.message }
  ok(/generators v1: function declaration 'h' inside a decomposed/.test(msg), `named reject (got: ${msg.slice(0, 60)})`)
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

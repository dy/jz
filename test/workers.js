// Workers v1 (extension-surface plan): shared-memory SPMD over wasm threads.
// Contract: shared TYPED ARRAYS + scalars; Atomics on PROVEN Int32Array
// receivers (proof via inference or the default-arg annotation
// `arr = new Int32Array(0)`, backed by __atomics_addr's runtime tag+elem
// guard); strings/objects stay thread-local. jz.pool spawns node
// worker_threads over ONE WebAssembly.Memory({shared:true}) — every worker
// runs fn(workerIndex, threads, ...args); boxed args cross as exact i64 bits
// (jz:i64exp lanes).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { onWasi, onKernel } from './_matrix.js'

const sharedMem = () => new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true })
const run = (code) => jz(code, { sharedMemory: true, memory: sharedMem() }).exports

test('atomics: single-thread semantics match host', () => {
  if (onWasi() || onKernel()) return
  const f = run(`export let f = () => {
    let a = new Int32Array(8)
    Atomics.store(a, 0, 41)
    let old = Atomics.add(a, 0, 1)
    let now = Atomics.load(a, 0)
    let x = Atomics.exchange(a, 1, 7)
    let c1 = Atomics.compareExchange(a, 1, 7, 9)
    let c2 = Atomics.compareExchange(a, 1, 7, 99)
    return '' + old + ',' + now + ',' + x + ',' + c1 + ',' + Atomics.load(a, 1) + ',' + c2 +
      ',' + Atomics.sub(a, 0, 2) + ',' + (Atomics.and(a, 0, 56) * 1) + ',' + Atomics.or(a, 0, 3) + ',' + Atomics.xor(a, 0, 1)
  }`).f
  // host-verified reference (same ops on a host Int32Array)
  is(f(), '41,42,0,7,9,9,42,40,40,43')
})

test('atomics: isLockFree, notify with no waiters, OOB throws, guard throws', () => {
  if (onWasi() || onKernel()) return
  const e = run(`
    export let lf = () => (Atomics.isLockFree(4) === true) && (Atomics.isLockFree(3) === false) ? 1 : 0
    export let notif = () => { let a = new Int32Array(2); return Atomics.notify(a, 0) }
    export let oob = () => { let a = new Int32Array(2); try { Atomics.load(a, 5); return 'no' } catch (err) { return 'threw' } }
  `)
  is(e.lf(), 1)
  is(e.notif(), 0)
  is(e.oob(), 'threw')
})

test('atomics: unproven receiver rejects at compile', () => {
  let err
  try { jz.compile('export let f = (x) => Atomics.load(x, 0)', { sharedMemory: true }) } catch (e) { err = e }
  ok(err && /proven Int32Array/.test(err.message), 'unproven receiver → clean compile reject')
})

test('atomics: shared-memory stringify (static region relocates)', () => {
  if (onWasi() || onKernel()) return
  // shared memory has no active data segment — static strings + Ryū/EL tables
  // memory.init at start behind $__staticBase
  const e = run(`export let f = () => String(0.1 + 0.2) + '|' + String(NaN) + '|' + Number('1.5')`)
  is(e.f(), '0.30000000000000004|NaN|1.5')
})

test('pool: SPMD contention + per-worker cells + wait/notify handshake', async () => {
  if (onWasi() || onKernel()) return
  const p = await jz.pool(`
    export let bump = (tid, threads, arr = new Int32Array(0)) => {
      for (let k = 0; k < 1000; k++) Atomics.add(arr, 0, 1)
      Atomics.store(arr, 1 + tid, tid * 10)
      return tid
    }
    export let waitFor = (tid, threads, arr = new Int32Array(0)) => {
      let r = Atomics.wait(arr, 7, 0)
      return r === 'ok' ? Atomics.load(arr, 7) : -1
    }
    export let release = (arr = new Int32Array(0), v) => {
      Atomics.store(arr, 7, v)
      return Atomics.notify(arr, 7)
    }
  `, { threads: 4, pages: 16 })
  try {
    const arrPtr = p.memory.Int32Array(new Int32Array(16))
    const ids = (await p.run('bump', arrPtr)).slice().sort()
    is(ids.join(','), '0,1,2,3')
    const view = p.memory.read(arrPtr)
    is(view[0], 4000)                                     // 4×1000 contended adds, none lost
    is([view[1], view[2], view[3], view[4]].join(','), '0,10,20,30')
    // workers block in Atomics.wait; the MAIN instance stores + notifies
    const waiting = p.run('waitFor', arrPtr)
    await new Promise(r => setTimeout(r, 50))
    const woken = p.exports.release(arrPtr, 42)
    const results = await waiting
    is(woken, 4)
    is(results.join(','), '42,42,42,42')
  } finally { await p.terminate() }
})

test('imported memory: static region relocates (stringify + parse work)', () => {
  if (onWasi() || onKernel()) return
  // pre-existing hole (predates Workers v1): the EL/Ryū tables and static
  // strings rode the address-0 active segment, which imported memory never
  // loads — String(n)/Number(s) read garbage. Now a passive segment + start
  // init behind $__staticBase.
  const m = new WebAssembly.Memory({ initial: 4, maximum: 64 })
  const e = jz(`export let f = () => String(0.1 + 0.2) + '|' + Number('2.5')`, { importMemory: true, memory: m }).exports
  is(e.f(), '0.30000000000000004|2.5')
})

test('atomics: BigInt64Array — i64 ops, BigInt values in and out', () => {
  if (onWasi() || onKernel()) return
  const e = run(`export let f = () => {
    let a = new BigInt64Array(4)
    Atomics.store(a, 0, 41n)
    let old = Atomics.add(a, 0, 1n)
    Atomics.compareExchange(a, 1, 0n, 7n)
    Atomics.exchange(a, 2, 1n << 40n)
    return '' + Number(old) + ',' + Number(Atomics.load(a, 0)) + ',' + Number(Atomics.load(a, 1)) + ',' + Number(Atomics.load(a, 2) >> 40n)
  }`)
  is(e.f(), '41,42,7,1')
  // number values on an i64 receiver reject at compile
  let err
  try { jz.compile('export let f = () => { let a = new BigInt64Array(2); return Number(Atomics.store(a, 0, 5)) }', { sharedMemory: true }) } catch (x) { err = x }
  ok(err && /BigInt values/.test(err.message), 'number value on BigInt64Array receiver rejects')
})

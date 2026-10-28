/**
 * SPMD worker pool over ONE shared memory (Workers v1). Internal and
 * experimental: not a package export, node worker_threads only.
 *
 * Compiles `source` with { sharedMemory: true }, instantiates it on the main
 * thread AND in `threads` node worker_threads, all linked to the same
 * WebAssembly.Memory({ shared: true }). Kernels coordinate through shared
 * typed arrays + Atomics (module/atomics.js); strings/objects stay
 * thread-local by the v1 contract.
 *
 * Worker instances link `env.memory` ONLY — a kernel needing other host
 * imports fails instantiation loudly (pure-compute contract).
 *
 *   const p = await pool(src, { threads: 4, pages: 16, maxPages: 256 })
 *   p.exports.setup(...)                    // main-thread instance
 *   await p.run('tile')                     // every worker: tile(workerIndex, threads)
 *   await p.run('tile', a, b)               // extra args broadcast to each worker
 *   p.memory                                // the shared, jz-enhanced memory
 *   await p.terminate()
 *
 * @param {string} source - jz source (compiled once; module shared with workers)
 * @param {object} [opts] - { threads=4, pages=16, maxPages=16384, ...compile opts }
 * @returns {Promise<{exports, memory, module, threads, run, terminate}>}
 */
import jz from './index.js'

export default async function pool(source, opts = {}) {
  const { threads = 4, pages = 16, maxPages = 16384, ...rest } = opts
  const memory = new WebAssembly.Memory({ initial: pages, maximum: maxPages, shared: true })
  const main = jz(source, { ...rest, sharedMemory: true, memory })
  const { Worker } = await import('node:worker_threads')
  // The worker shim honors the jz:i64exp lane map (exact-bits ABI): an i64 lane
  // takes a BigInt — scalars convert to their f64 bits, boxed pointers (BigInt
  // args from the main thread's memory) pass through; i64 results
  // reinterpret back to numbers (v1 kernels return scalars).
  const workerSrc = `
    const { parentPort, workerData } = require('node:worker_threads')
    const inst = new WebAssembly.Instance(workerData.module, { env: { memory: workerData.memory } })
    const dv = new DataView(new ArrayBuffer(8))
    const bits = (x) => (dv.setFloat64(0, x), dv.getBigUint64(0))
    const unbits = (b) => (dv.setBigUint64(0, BigInt.asUintN(64, b)), dv.getFloat64(0))
    const lanes = new Map()
    for (const s of WebAssembly.Module.customSections(workerData.module, 'jz:i64exp'))
      try { for (const e of JSON.parse(new TextDecoder().decode(s))) lanes.set(e.name, e) } catch {}
    parentPort.on('message', (m) => {
      try {
        const sig = lanes.get(m.fn), p = new Set(sig?.p || [])
        const args = m.args.map((x, i) => p.has(i) && typeof x === 'number' ? bits(x) : x)
        let r = inst.exports[m.fn](...args)
        if (sig?.r && typeof r === 'bigint') r = unbits(r)
        parentPort.postMessage({ id: m.id, r })
      } catch (e) { parentPort.postMessage({ id: m.id, e: String(e) }) }
    })
    parentPort.postMessage({ ready: true })`
  const workers = Array.from({ length: threads }, () =>
    new Worker(workerSrc, { eval: true, workerData: { module: main.module, memory } }))
  await Promise.all(workers.map(w => new Promise((res, rej) => {
    w.once('message', res); w.once('error', rej)
  })))
  let seq = 0
  const call = (w, fn, args) => new Promise((res, rej) => {
    const id = seq++
    const on = (m) => { if (m.id !== id) return; w.off('message', on); m.e ? rej(new Error(m.e)) : res(m.r) }
    w.on('message', on)
    w.postMessage({ id, fn, args })
  })
  return {
    exports: main.exports, memory: main.memory, module: main.module, threads,
    run: (fn, ...args) => Promise.all(workers.map((w, i) => call(w, fn, [i, threads, ...args]))),
    terminate: () => Promise.all(workers.map(w => w.terminate())),
  }
}

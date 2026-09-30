/** Compile and instantiate JavaScript, with host value interop. */
import { compileInProcess, compileSource, normalizeOptions } from './src/compiler.js'
import { serialize } from './src/source-literal.js'
import jzify from './jzify/index.js'
import { memory as enhanceMemory, instantiate as instantiateRuntime } from './interop.js'

/**
 * jz — JS subset → WASM compiler.
 *
 * jz('code') or jz`code` → { exports, memory, instance, module }
 * jz.compile('code') → Uint8Array (raw WASM binary)
 * jz.compile('code', { wat: true }) → string (WAT text)
 * jz.memory([src]) → enhanced WebAssembly.Memory (read/write JS↔WASM values)
 *
 * @example
 * const { exports: { add } } = jz('export let add = (a, b) => a + b')
 * add(2, 3)  // 5
 */
jz.memory = enhanceMemory

/**
 * jz.pool(source, opts) — SPMD worker pool over ONE shared memory (Workers v1).
 * Experimental and undocumented: node worker_threads only, not in index.d.ts.
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
 *   const p = await jz.pool(src, { threads: 4, pages: 16, maxPages: 256 })
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
jz.pool = async function pool(source, opts = {}) {
  const { threads = 4, pages = 16, maxPages = 16384, ...rest } = opts
  const memory = new WebAssembly.Memory({ initial: pages, maximum: maxPages, shared: true })
  const main = jz(source, { ...rest, sharedMemory: true, memory })
  // Computed specifier keeps bundlers (esbuild web dist) from resolving the
  // node builtin statically; browsers get a clear v1 error instead.
  const { Worker } = await import('node:' + 'worker_threads').catch(() => {
    throw new Error('jz.pool v1 runs on node worker_threads; browser Worker support is a follow-up')
  })
  // The worker shim honors the jz:i64exp lane map (exact-bits ABI): an i64 lane
  // takes a BigInt — scalars convert to their f64 bits, boxed pointers (BigInt
  // args from jz.memory.* on the main thread) pass through; i64 results
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

/**
 * Compile jz source to a WASM binary (or WAT text with `wat: true`). No instantiation.
 *
 * Public options (index.d.ts is the contract):
 *   modules, imports, define, host, memory, optimize, randomSeed, names, wat, warnings, why.
 * `memory` takes a page count, a WebAssembly.Memory to share, or
 * `{ initial, maximum, shared, import }`. `optimize` takes true (default), 'speed',
 * 'size', false, or `{ level, simd, tailCall, exceptions, alloc, ...passes }`.
 * `normalizeOptions` folds those objects onto the internal flags below.
 *
 * Internal/test-only options (undocumented, may change): strict, sourceType,
 * alloc, noSimd, noTailCall, noEhAbort, nativeTimers, maxMemory, importMemory,
 * sharedMemory, whyNotSimd, whyNotRewind, stencil, outerStrip, toneMap,
 * importMetaUrl, profile, inspect, helperCounters, helperCallsites, _interp,
 * _eagerStdlib, _compactCollections.
 *
 * @param {string} code
 * @param {object} [opts]
 * @returns {Uint8Array|string}
 */
export { setCompileTarget as _setCompileTarget } from './src/compiler.js'
jz.compile = (code, opts = {}) => compileSource(code, opts, jzify)

/** In-process entry for tests that inspect analysis and compilation state. */
export const _compileInProcess = (code, opts = {}) => compileInProcess(code, opts, jzify)

export default function jz(code, ...args) {
  // Template tag: jz`code ${val}` — numbers, functions, strings, arrays, objects
  if (Array.isArray(code)) {
    const interp = {}, data = {}, define = {}

    let src = code[0]
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (typeof v === 'function') {
        const key = `$$${i}`; interp[key] = v; src += key
      } else {
        const s = serialize(v)
        if (s !== null && (typeof v === 'number' || typeof v === 'boolean')) {
          // Parentheses keep a negative literal from joining the preceding operator.
          src += `(${s})`
        } else if (s !== null) {
          // Strings, arrays, objects — hoist as compile-time literal
          const key = `$$${i}`
          define[key] = v
          src += key
        } else {
          // Non-serializable (host objects, etc.) — post-instantiation getter
          const key = `$$${i}`, ref = { ptr: 0 }
          data[key] = { val: v, ref }; interp[key] = () => ref.ptr
          src += `${key}()`
        }
      }
      src += code[i + 1]
    }
    const hasInterp = Object.keys(interp).length
    const tplOpts = { _interp: hasInterp ? interp : null, ...(Object.keys(define).length && { define }) }
    const result = instantiateRuntime(jz.compile(src, tplOpts), tplOpts)
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  const callOpts = normalizeOptions(args[0])
  const out = jz.compile(code, callOpts)
  const wasm = out && typeof out === 'object' && 'wasm' in out ? out.wasm : out
  const result = instantiateRuntime(wasm, callOpts)
  const extra = {}
  if (callOpts.inspect && out && typeof out === 'object' && 'inspect' in out) extra.inspect = out.inspect
  if (callOpts.warnings) extra.warnings = callOpts.warnings.entries
  return Object.keys(extra).length ? Object.assign(result, extra) : result
}

export { jz }
const jzCompile = jz.compile
export { jzCompile as compile }

export { instantiateRuntime as instantiate }

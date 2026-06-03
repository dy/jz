/**
 * WASI shim for jz-emitted modules — NOT a general WASI Preview 1 runtime.
 *
 * jz emits only the few `wasi_snapshot_preview1` imports its lowerings use:
 * `fd_write` (console.log/error), `fd_read` (stdin), `clock_time_get`
 * (Date.now/performance.now/timers), `random_get` (only with `{ randomSeed: true }`,
 * to seed Math.random), plus no-op `proc_exit` / `environ_*` stubs. This shim
 * implements exactly that set, so jz modules run in browsers and plain Node
 * without native WASI. (The compiled `.wasm` uses standard WASI and runs on
 * wasmtime/wasmer/deno natively — the shim is only for hosts that lack WASI.)
 *
 * It is deliberately NOT a complete Preview 1 polyfill: `args_get`,
 * `fd_fdstat_get`, `fd_prestat_dir_name`, `poll_oneoff`, `path_*` etc. are absent
 * because jz never emits them. To run an arbitrary (e.g. C-compiled) WASI program,
 * use a real runtime — wasmtime/wasmer/deno or Node's `node:wasi`.
 *
 * @example
 *   import { instantiate } from 'jz/wasi'
 *   const inst = instantiate(wasm)
 *   inst.exports.f()
 *
 * @module wasi
 */

/**
 * Create WASI import object for WebAssembly instantiation.
 * @param {object} [opts]
 * @param {function} [opts.write] - Custom write: (fd, text) => void
 * @param {function} [opts.read] - Custom read: (fd, buf: Uint8Array) => bytesRead
 */
const TEXT_DEC = new TextDecoder()  // reused across every fd_write (was per-iov alloc)

export function wasi(opts = {}) {
  let mem = null
  const fallbackWrite = (fd, text) => {
    const stream = fd === 1 ? globalThis.process?.stdout : globalThis.process?.stderr
    if (stream && typeof stream.write === 'function') {
      try { stream.write(text); return }
      catch {}
    }
    const msg = text.replace(/\n$/, '')
    ;(fd === 1 ? console.log : console.warn)(msg)
  }
  const write = opts.write || fallbackWrite

  return {
    wasi_snapshot_preview1: {
      fd_read(fd, iovs, iovs_len, nread) {
        const dv = new DataView(mem.buffer)
        let total = 0
        for (let i = 0; i < iovs_len; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true)
          const len = dv.getUint32(iovs + i * 8 + 4, true)
          const buf = new Uint8Array(mem.buffer, ptr, len)
          total += opts.read ? (opts.read(fd, buf) || 0) : 0
        }
        dv.setUint32(nread, total, true)
        return 0
      },
      fd_write(fd, iovs, iovs_len, nwritten) {
        const dv = new DataView(mem.buffer)
        let written = 0
        for (let i = 0; i < iovs_len; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true)
          const len = dv.getUint32(iovs + i * 8 + 4, true)
          write(fd, TEXT_DEC.decode(new Uint8Array(mem.buffer, ptr, len)))
          written += len
        }
        dv.setUint32(nwritten, written, true)
        return 0
      },
      clock_time_get(clock_id, precision, result_ptr) {
        const dv = new DataView(mem.buffer)
        const now = clock_id === 0
          ? BigInt(Math.round(Date.now() * 1e6))       // realtime: ms → ns
          : BigInt(Math.round(performance.now() * 1e6)) // monotonic: ms → ns
        dv.setBigInt64(result_ptr, now, true)
        return 0
      },
      // Present only for modules compiled with { randomSeed: true } — one read of
      // OS entropy to seed Math.random. Prefers crypto; falls back to Math.random.
      random_get(buf, buf_len) {
        const bytes = new Uint8Array(mem.buffer, buf, buf_len)
        if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
        else for (let i = 0; i < buf_len; i++) bytes[i] = (Math.random() * 256) | 0
        return 0
      },
      proc_exit() {},
      environ_sizes_get(count_ptr, size_ptr) {
        const dv = new DataView(mem.buffer)
        dv.setUint32(count_ptr, 0, true)
        dv.setUint32(size_ptr, 0, true)
        return 0
      },
      environ_get() { return 0 },
    },
    _setMemory(m) { mem = m },
  }
}

/**
 * Drive a `host: 'wasi'` module's WASM timer queue from JS scheduling.
 *
 * The wasi timer lowering compiles `setTimeout`/`setInterval` into an in-wasm
 * queue drained by the exported `__timer_tick` (returns ms until the next due
 * callback, ≤0 when the queue is empty). A native runtime ticks it from its own
 * event loop; in a JS host we poll via `setInterval`, stopping once the queue
 * drains. No-op for modules without timers. (The `host: 'js'` build lowers to
 * `env.setTimeout` instead — that path lives in interop.js, not here.)
 *
 * @param {WebAssembly.Instance} inst
 */
export const attachTimers = (inst) => {
  if (!inst.exports.__timer_tick) return
  const tick = inst.exports.__timer_tick
  let hadTimers = false
  const id = setInterval(() => {
    const remaining = tick()
    if (remaining > 0) hadTimers = true
    if (hadTimers && remaining <= 0) clearInterval(id)
  }, 1)
}

/**
 * Compile and instantiate a jz WASI module.
 * @param {BufferSource} wasm
 * @param {object} [opts] - Options passed to wasi()
 * @returns {WebAssembly.Instance}
 */
export function instantiate(wasm, opts = {}) {
  const imports = wasi(opts)
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
  imports._setMemory(inst.exports.memory)
  return inst
}

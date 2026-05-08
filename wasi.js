/**
 * WASI Preview 1 polyfill for jz modules.
 *
 * Provides wasi_snapshot_preview1 imports for environments without native WASI.
 * The compiled .wasm uses standard WASI — runs natively on wasmtime/wasmer/deno.
 * This polyfill is only needed for browsers and plain Node.
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
          write(fd, new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len)))
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

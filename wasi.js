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
 */
export function wasi(opts = {}) {
  let mem = null
  const write = opts.write || ((fd, text) => {
    if (fd === 1) typeof process !== 'undefined' && process.stdout ? process.stdout.write(text) : console.log(text.replace(/\n$/, ''))
    else typeof process !== 'undefined' && process.stderr ? process.stderr.write(text) : console.warn(text.replace(/\n$/, ''))
  })

  return {
    wasi_snapshot_preview1: {
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

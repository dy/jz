/**
 * Interop: shared (ABI-agnostic) host-side infrastructure.
 *
 * Glue every jz interop ABI needs regardless of value representation:
 *   - WASI linking decision + import build
 *   - Linear-memory allocator wiring (wasm `_alloc`/`_clear` or JS bump fallback)
 *   - Custom-section reader scaffolding (varint, length-prefixed strings)
 *   - Instance lifecycle: `_setMemory`, `__timer_tick` driver, `__invoke_closure` ref
 *
 * What is NOT here: anything that knows how a value is encoded across the
 * boundary. The codec, `memory.String`/`Array`/`Object` constructors, `read`/
 * `write`, env.print's decode, opts.imports marshaling, host-globals wiring —
 * those live in `interop/<abi>.js` because they're the ABI's whole purpose.
 *
 * @module jz/interop/_shared
 */

import { wasi } from '../wasi.js'

// ── WASI linking ────────────────────────────────────────────────────────────

/**
 * Inspect a wasm module for `wasi_snapshot_preview1` imports and build the
 * matching JS-side wasi object if needed.
 * @returns {{ needsWasi: boolean, wasiImports: object|null }}
 *   `wasiImports` includes `_setMemory(memory)` — call it once after instantiate.
 */
export const linkWasi = (mod, opts) => {
  const needsWasi = WebAssembly.Module.imports(mod).some(i => i.module === 'wasi_snapshot_preview1')
  return { needsWasi, wasiImports: needsWasi ? wasi(opts) : null }
}

/** Set of `env.<name>` function imports declared by the module. */
export const envFuncNames = (mod) =>
  new Set(WebAssembly.Module.imports(mod)
    .filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name))

// ── Allocator wiring ────────────────────────────────────────────────────────
// Heap pointer lives at byte 1020 (same convention as wasm-side allocator).
// 8-byte aligned bump on JS side; wasm `_alloc` takes over if exported.

const HEAP_PTR_ADDR = 1020
const HEAP_START = 1024

/**
 * JS-side fallback allocator over a WebAssembly.Memory. Returns
 * `{ alloc, reset, initHeapPtr }`. Use when the module didn't export `_alloc` /
 * `_clear` (raw-memory enhancement, no module-bound instance).
 */
export const makeJsAllocator = (mem) => {
  const dv = () => new DataView(mem.buffer)
  const alloc = (bytes) => {
    let d = dv(), p = d.getInt32(HEAP_PTR_ADDR, true)
    const aligned = (p + 7) & ~7
    const next = aligned + bytes
    if (next > mem.buffer.byteLength) {
      mem.grow(Math.ceil((next - mem.buffer.byteLength) / 65536))
      d = dv()  // buffer was detached by grow
    }
    d.setInt32(HEAP_PTR_ADDR, next, true)
    return aligned
  }
  const reset = () => dv().setInt32(HEAP_PTR_ADDR, HEAP_START, true)
  const initHeapPtr = () => {
    const d = dv()
    if (d.getInt32(HEAP_PTR_ADDR, true) < HEAP_START) d.setInt32(HEAP_PTR_ADDR, HEAP_START, true)
  }
  return { alloc, reset, initHeapPtr }
}

// ── Custom-section reading ──────────────────────────────────────────────────

/** Return the raw bytes of the first `name` custom section, or null. */
export const customSection = (mod, name) => {
  const secs = WebAssembly.Module.customSections(mod, name)
  return secs.length ? new Uint8Array(secs[0]) : null
}

/**
 * Streaming reader over a custom section's bytes. Used by both `jz:schema`
 * (string-list dedup) and any future ABI metadata sections (`jz:sig`, …).
 */
export const sectionReader = (bytes) => {
  const td = new TextDecoder()
  let i = 0
  return {
    pos: () => i,
    seek: (p) => { i = p },
    eof: () => i >= bytes.length,
    u8: () => bytes[i++],
    varint: () => {
      let r = 0, s = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const x = bytes[i++]
        r |= (x & 0x7F) << s
        if (!(x & 0x80)) return r
        s += 7
      }
    },
    str: (n) => { const s = td.decode(bytes.subarray(i, i + n)); i += n; return s },
    bytes: (n) => { const r = bytes.subarray(i, i + n); i += n; return r },
  }
}

// ── Instance lifecycle ──────────────────────────────────────────────────────

/**
 * Drive a non-blocking wasm timer queue (host: 'js' mode). No-op if the
 * module doesn't export `__timer_tick`.
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

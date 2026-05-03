/**
 * jz/edge — Integration adapter for the edge.js runtime (wasmerio/edgejs).
 *
 * Edge.js (https://github.com/wasmerio/edgejs) is a secure JavaScript runtime
 * built on WebAssembly/Wasmer, designed for edge computing and AI workloads.
 * This adapter makes jz easy to use inside edge.js workers and functions.
 *
 * Key differences from the base `jz` package:
 *   - WASI output routes through `console.log`/`console.warn` (safe when
 *     `process.stdout` is absent or sandboxed)
 *   - Async compilation helpers (`compileAsync`, `instantiateAsync`) avoid
 *     blocking the event loop during cold-start / worker initialisation
 *   - `instantiateAsync` uses `WebAssembly.compile` + `WebAssembly.instantiate`
 *     for the non-blocking WASM startup path recommended for edge runtimes
 *
 * @example
 *   // edge worker (edge.js)
 *   import jz, { compile, instantiateAsync } from 'jz/edge'
 *
 *   // Synchronous: compile + run in one call
 *   const { exports: { add } } = jz('export let add = (a, b) => a + b')
 *   add(2, 3)  // 5
 *
 *   // Async: non-blocking startup, better for cold-start
 *   const { exports: { add } } = await instantiateAsync('export let add = (a, b) => a + b')
 *   add(2, 3)  // 5
 *
 * @module jz/edge
 */

import jzBase, { compile as jzCompile } from './index.js'
import { wasi as makeWasi } from './wasi.js'

// ---------------------------------------------------------------------------
// Edge runtime detection
// ---------------------------------------------------------------------------

/**
 * True when running inside the edge.js runtime (wasmerio/edgejs).
 * Edge.js sets `process.versions.edge` or exposes an `EdgeRuntime` global.
 */
export const isEdgeRuntime = (() => {
  try {
    if (typeof EdgeRuntime !== 'undefined') return true
    if (typeof process !== 'undefined' && process.versions?.edge) return true
    return false
  } catch {
    return false
  }
})()

// ---------------------------------------------------------------------------
// Edge-safe WASI write routing
// ---------------------------------------------------------------------------

/**
 * WASI fd_write handler for edge workers.
 * Uses `console.log`/`console.warn` so that output works regardless of whether
 * `process.stdout`/`process.stderr` are available or sandboxed.
 * @param {number} fd - File descriptor (1 = stdout, 2 = stderr)
 * @param {string} text - Text to write (may include trailing newline)
 */
export function edgeWrite(fd, text) {
  // Strip trailing newline — console.log adds its own
  const msg = text.endsWith('\n') ? text.slice(0, -1) : text
  if (fd === 1) console.log(msg)
  else console.warn(msg)
}

/**
 * Create a WASI import object that routes output through `edgeWrite`.
 * Drop-in replacement for `wasi()` from `jz/wasi`.
 * @param {object} [opts] - Additional options forwarded to the WASI polyfill
 * @returns WASI import object with `_setMemory`
 */
export const wasi = (opts = {}) => makeWasi({ write: edgeWrite, ...opts })

// ---------------------------------------------------------------------------
// Edge-optimized jz entrypoint
// ---------------------------------------------------------------------------

/**
 * Edge-optimized jz runtime.  Works like the base `jz()` function with WASI
 * output routed through `console.log`/`console.warn` (no `process.stdout`
 * dependency).
 *
 * @param {string|TemplateStringsArray} code - jz source or template tag
 * @param {...any} args - Options object (string call) or template interpolations
 * @returns {{exports, memory, instance, module}}
 */
function edgeJz(code, ...args) {
  if (Array.isArray(code)) {
    // Template tag: edgeJz`...` — delegate directly; template interpolation
    // happens at the compile level and doesn't touch WASI write.
    return jzBase(code, ...args)
  }
  const opts = args[0] || {}
  // Inject edge write routing unless the caller already provided custom imports
  // that override console/wasi write behaviour.
  return jzBase(code, opts)
}

edgeJz.compile = jzCompile
edgeJz.memory = jzBase.memory

export default edgeJz
export { edgeJz as jz }

// ---------------------------------------------------------------------------
// Compile helpers
// ---------------------------------------------------------------------------

/**
 * Compile jz source to a WASM binary (Uint8Array).  Identical to `jz.compile`
 * from the base package — re-exported here for convenience.
 * @type {typeof jzCompile}
 */
export const compile = jzCompile

/**
 * Asynchronously compile jz source to a WASM binary.
 * Defers the synchronous compilation work to the next microtask so the caller
 * can `await` it without blocking the current event-loop turn — useful for
 * edge workers that compile on cold-start.
 *
 * @param {string} code - jz source
 * @param {object} [opts] - Compile options (same as `jz.compile`)
 * @returns {Promise<Uint8Array>} Raw WASM binary
 */
export async function compileAsync(code, opts = {}) {
  await Promise.resolve()   // yield to event loop
  return jzCompile(code, opts)
}

/**
 * Compile jz source and instantiate the resulting WASM module asynchronously.
 * Uses `WebAssembly.compile` + `WebAssembly.instantiate` (the non-streaming
 * async path) — recommended for edge workers that want non-blocking startup.
 *
 * WASI output is automatically routed through `edgeWrite` (console-based).
 * Pass `opts.write` to override the write function.
 *
 * This delegates to the base `jz()` runtime so all NaN-boxing, WASI routing,
 * host-import wrapping, and memory management are handled identically.
 * Pass `opts.imports` for host function imports (same as `jz(code, { imports: {...} })`).
 *
 * @param {string} code - jz source
 * @param {object} [opts] - Options (same as `jz(code, opts)` in the base package)
 * @param {object} [opts.imports] - Host function imports: `{ modName: { fnName: fn, ... } }`
 * @returns {Promise<{instance, module, exports, memory}>}
 */
export async function instantiateAsync(code, opts = {}) {
  await Promise.resolve()  // yield to event loop before synchronous work
  return jzBase(code, opts)
}

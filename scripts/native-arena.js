/**
 * The kernel's arena intrinsics as a JS host has them. scripts/self.js reads
 * the heap's marks, grows the park lane and takes phase checkpoints through
 * intrinsics of module/core.js; run natively (bench/_lib/run-v8.mjs,
 * test/self-compile-perf.js, the flat shell bundle of bench/bench.mjs), the
 * arena has no mark, nothing ever grows past a threshold and no phase is
 * parked: every intrinsic answers so, and the compile keeps its memory as a JS
 * program does. One list, so a new intrinsic of self.js lands in every host.
 */
export const NATIVE_ARENA = {
  __heap_mark: () => 0,
  __heap_large: () => false,
  __heap_since: () => 0,
  __park_mark: () => 0,
  __park_enter: () => -1,
  __park_low_enter: () => -1,
  __park_base_enter: () => -1,
  __park_end: () => undefined,
  __park_safe: () => 0,
  __esc_get: () => -1,
  __park_worth: () => 0,
  __durable_state: () => 0n,
  __gc_phase: (mark, out) => out,
}
/** Install the intrinsics a host lacks on `globalThis`. */
export const installNativeArena = () => { for (const [name, fn] of Object.entries(NATIVE_ARENA)) globalThis[name] ??= fn }
/** The same intrinsics as a line of script, for a bundle that runs as a plain file. */
export const NATIVE_ARENA_SHIM = 'var ' + Object.entries(NATIVE_ARENA).map(([name, fn]) => `${name} = ${fn.toString()}`).join(', ') + '\n'
/** Whether a script reads any of them. */
export const NATIVE_ARENA_RE = new RegExp('\\b(?:' + Object.keys(NATIVE_ARENA).join('|') + ')\\b')

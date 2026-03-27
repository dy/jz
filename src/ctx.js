/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 */
export const ctx = {
  // --- Core ---
  emit: {},             // emitter table: op → (args) => WasmNode (prototype: emitter)
  stdlib: {},           // WAT function defs: name → string (included on demand)
  includes: new Set(),  // stdlib names to include in output
  imports: [],          // WASM import declarations
  scope: {},            // name resolution: sin → math.sin (prototype: GLOBALS)
  modules: {},          // loaded module init guards: name → true

  // --- Functions ---
  exports: {},          // exported names (lookahead for prepare)
  funcs: [],            // function defs: {name, body, exported, sig, defaults?, raw?}
  globals: [],          // WASM global declarations (WAT strings)

  // --- Per-function (reset per function in compile) ---
  locals: new Map(),    // name → 'i32' | 'f64'
  stack: [],            // [{brk, loop}] for break/continue
  uid: 0,              // unique counter for labels/temps
  sig: null,           // current function signature

  // --- Schema (object property layouts, set by ptr module) ---
  schema: { list: [], vars: new Map(), register: null, find: null },

  // --- Closures (set by fn module) ---
  fn: { types: null, table: null, bodies: null, make: null, call: null },
}

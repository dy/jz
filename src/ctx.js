/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Multi-value returns just work (return [a, b] → result f64 f64).
 * Memory auto-enabled when arrays/objects/strings are used.
 */
export const ctx = {
  // --- Core pipeline ---
  emit: {},             // emitter table: op → (args) => WasmNode (prototype: emitter)
  stdlib: {},           // WAT function defs: name → string (included on demand)
  includes: new Set(),  // stdlib names to include in output
  imports: [],          // WASM import declarations
  scope: {},            // name resolution: sin → math.sin (prototype: GLOBALS)
  memory: false,        // whether memory section is needed
  modules: {},          // loaded module init guards: name → true

  // --- Functions ---
  exports: {},          // exported function names: name → true
  funcs: [],            // function defs: {name, body, exported, sig, defaults?, raw?}
  globals: [],          // WASM global declarations (WAT strings)

  // --- Per-function (reset by compile per function) ---
  locals: new Map(),    // local variables: name → 'i32' | 'f64'
  stack: [],            // nested scope: [{brk, loop}] for break/continue
  uid: 0,              // unique counter for labels and temps
  sig: null,           // current function signature: {params, results}

  // --- Schemas (object property layouts, set by ptr module) ---
  schemas: [],          // id → [prop names]. Dedup: same props = same id.
  varSchemas: new Map(), // variable name → schema id
  findPropIndex: null,  // (varName, prop) → index (set by ptr module)
  registerSchema: null, // (props) → schemaId (set by ptr module)

  // --- Closures (set by fn module) ---
  fnTypes: null,        // Set<arity> — function types for call_indirect
  fnTable: null,        // string[] — function names in table
  closureBodies: null,  // closure body descriptors for compilation
  makeClosure: null,    // (params, body, captures) → WasmNode (set by fn module)
  callClosure: null,    // (closureExpr, args) → WasmNode (set by fn module)
}

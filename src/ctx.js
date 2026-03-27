/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Multi-value returns just work (return [a, b] → result f64 f64).
 * Memory auto-enabled when arrays are used.
 */
export const ctx = {
  emit: {},         // emitter table: op → (args) => WasmNode
  stdlib: {},       // WAT function definitions: name → string
  includes: new Set(), // stdlib functions to include in output
  imports: [],      // WASM import declarations
  scope: {},        // name resolution: sin → math.sin
  memory: false,    // whether memory section is needed
  modules: {},      // loaded module init guards
  exports: {},      // exported function names
  funcs: [],        // function defs with sig: {params, results}
  globals: [],      // WASM global declarations
}

/**
 * Global compilation context, reset per jz() call.
 *
 * Profile controls the ABI — what WASM signatures are emitted:
 * - 'scalar': all params f64, single f64 return (default)
 * - 'multi':  all params f64, multi-value f64 returns (for tuples)
 * - 'memory': f64 + i32 pointer params, shared linear memory (planned)
 */
export const ctx = {
  emit: {},         // emitter table: op → (args) => WasmNode
  stdlib: {},       // WAT function definitions: name → string
  includes: new Set(), // stdlib functions to include in output
  imports: [],      // WASM import declarations
  scope: {},        // name resolution: sin → math.sin
  memory: false,    // whether memory section is needed
  modules: {},      // loaded module init guards
  vars: {},         // variable type info (for future type system)
  exports: {},      // exported function names
  funcs: [],        // function defs with sig: {params, results}
  globals: [],      // WASM global declarations
  profile: 'scalar', // ABI profile: 'scalar' | 'multi' | 'memory'
}

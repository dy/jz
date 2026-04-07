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
  globals: new Map(),    // name → WAT string. .has(name) for module-scope var checks.
  globalTypes: new Map(), // name → 'i32'|'f64' for optimized globals (default f64)
  userGlobals: new Set(), // user-declared module-scope names (for runtime collision check)

  // --- Per-function (reset per function in compile) ---
  locals: new Map(),    // name → 'i32' | 'f64'
  valTypes: new Map(),  // name → 'number'|'array'|'string'|'object'|'set'|'map'|'closure'|'typed'
  boxed: new Map(),     // name → cell local name (i32) for mutably-captured variables
  stack: [],            // [{brk, loop}] for break/continue
  uniq: 0,             // incrementing counter for unique temp/label names
  sig: null,         // current function {params, results}

  // --- Schema (object property layouts, set by ptr module) ---
  schema: { list: [], vars: new Map(), register: null, find: null, target: null },

  // --- Closures (set by fn module) ---
  fn: { types: null, table: null, bodies: null, make: null, call: null },

  // --- Atoms (interned symbols, set by symbol module) ---
  atom: null,          // { table: Map<name,id>, next: number }

  // --- TypedArray tracking (set by compile analyzeValTypes) ---
  typedElem: null,     // Map<varName, ctorName> e.g. 'buf' → 'new.Float64Array'

  // --- Regex (set by regex module) ---
  regex: null,         // { count, vars: Map, compiled: Map }

  // --- Try/catch state ---
  _inTry: false,       // true inside try block (disables tail call optimization)

  // --- Static data ---
  data: null,          // string data for WASM data segment (at address 0)

  // --- Const tracking ---
  consts: null,          // Set<string> — const-declared names (reject reassignment)

  // --- Options ---
  sharedMemory: false,   // true when memory is imported (shared across modules)

  // --- Error tracking ---
  src: '',             // source code (for error messages)
  loc: null,           // current AST node char offset (from parser .loc)
  throws: false,       // emit WASM exception tag for throw/catch
}

/** Reset all compilation state. Called once per jz() invocation. */
export function reset(proto, globals) {
  ctx.emit = Object.create(proto)
  ctx.stdlib = {}
  ctx.includes = new Set()
  ctx.imports = []
  ctx.scope = Object.create(globals)
  ctx.modules = {}
  ctx.exports = {}
  ctx.funcs = []
  ctx.globals = new Map()
  ctx.globalTypes = new Map()
  ctx.userGlobals = new Set()
  ctx.locals = new Map()
  ctx.valTypes = new Map()
  ctx.boxed = new Map()
  ctx.stack = []
  ctx.uniq = 0
  ctx.sig = null
  ctx.schema = { list: [], vars: new Map(), register: null, find: null, target: null }
  ctx.fn = { types: null, table: null, bodies: null, make: null, call: null }
  ctx.typedElem = null
  ctx.regex = null
  ctx._inTry = false
  ctx.sharedMemory = false
  ctx.consts = null
  ctx.data = null
  ctx.src = ''
  ctx.loc = null
  ctx.atom = null
  ctx.throws = false
}

/** Throw with source location context. */
export function err(msg) {
  if (ctx.loc != null && ctx.src) {
    const before = ctx.src.slice(0, ctx.loc)
    const line = before.split('\n').length
    const col = ctx.loc - before.lastIndexOf('\n')
    const src = ctx.src.split('\n')[line - 1]
    throw Error(`${msg}\n  at line ${line}:${col}\n  ${src}\n  ${' '.repeat(col - 1)}^`)
  }
  throw Error(msg)
}

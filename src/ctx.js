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
  valTypes: new Map(),  // name → 'number'|'array'|'string'|'object'|'set'|'map'|'closure'|'typed'
  stack: [],            // [{brk, loop}] for break/continue
  uid: 0,              // unique counter for labels/temps
  sig: null,           // current function signature

  // --- Schema (object property layouts, set by ptr module) ---
  schema: { list: [], vars: new Map(), register: null, find: null },

  // --- Closures (set by fn module) ---
  fn: { types: null, table: null, bodies: null, make: null, call: null },

  // --- Error tracking ---
  src: '',             // source code (for error messages)
  loc: null,           // current AST node char offset (from parser .loc)
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
  ctx.globals = []
  ctx.locals = new Map()
  ctx.valTypes = new Map()
  ctx.stack = []
  ctx.uid = 0
  ctx.sig = null
  ctx.schema = { list: [], vars: new Map(), register: null, find: null }
  ctx.fn = { types: null, table: null, bodies: null, make: null, call: null }
  ctx.src = ''
  ctx.loc = null
  ctx._atoms = null
  ctx._atomNext = 0
  ctx._hasTag = false
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

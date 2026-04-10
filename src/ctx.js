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
  globalValTypes: null,  // Map<string, string> — module-scope value types for method dispatch

  // --- Options ---
  sharedMemory: false,   // true when memory is imported (shared across modules)
  memoryPages: 0,        // initial memory pages (0 = default 1 page = 64KB)
  importSources: null,   // {specifier: source} for import resolution (set by compile opts)
  hostImports: null,     // Map<module, {name: {params}|fn}> for host-provided imports
  moduleStack: [],       // import cycle detection
  resolvedModules: null, // Map<specifier, {exports: Map<name, mangledName>}>

  // --- Error tracking ---
  src: '',             // source code (for error messages)
  loc: null,           // current AST node char offset (from parser .loc)
  throws: false,       // emit WASM exception tag for throw/catch
}

/** Create a child scope that falls back to parent on lookup (replaces Object.create).
 *  Uses Object.create for now — the only non-jz-compatible construct in the codebase.
 *  To self-compile: replace with plain object + explicit lookup function. */
export const derive = (parent) => Object.create(parent)

/** Include stdlib names for emission. */
export const inc = (...names) => names.forEach(n => ctx.includes.add(n))

/** NaN-boxing pointer type codes: [type:4 bits] in the quiet NaN payload. */
export const PTR = { ATOM: 0, ARRAY: 1, TYPED: 3, STRING: 4, SSO: 5, OBJECT: 6, HASH: 7, SET: 8, MAP: 9, CLOSURE: 10 }

/** Stdlib call-dependency graph: fn → fns it calls internally.
 *  resolveIncludes() expands transitively before WASM assembly. */
export const STDLIB_DEPS = {
  // number → string conversion chain
  __mkstr: ['__alloc'],
  __ftoa: ['__itoa', '__pow10', '__mkstr', '__static_str'],
  __toExp: ['__itoa', '__pow10', '__mkstr', '__static_str'],
  __to_str: ['__ftoa', '__static_str'],

  // string operations
  __str_concat: ['__to_str', '__str_byteLen', '__char_at', '__alloc'],
  __str_slice: ['__char_at', '__str_byteLen', '__alloc'],
  __str_indexof: ['__str_byteLen', '__char_at'],
  __str_substring: ['__str_slice'],
  __str_startswith: ['__str_byteLen', '__char_at'],
  __str_endswith: ['__str_byteLen', '__char_at'],
  __str_case: ['__str_byteLen', '__char_at', '__alloc'],
  __str_trim: ['__str_slice'],
  __str_trimStart: ['__str_slice'],
  __str_trimEnd: ['__str_slice'],
  __str_repeat: ['__str_byteLen', '__char_at', '__alloc'],
  __str_replace: ['__str_indexof', '__str_slice', '__str_concat'],
  __str_replaceall: ['__str_indexof', '__str_slice', '__str_concat'],
  __str_split: ['__str_slice'],
  __str_pad: ['__str_byteLen', '__char_at', '__alloc'],
  __str_join: ['__str_concat', '__to_str', '__str_byteLen'],
  __str_encode: ['__str_byteLen', '__char_at'],
  __str_to_buf: ['__str_byteLen', '__char_at'],

  // hash operations
  __hash_set: ['__str_hash', '__str_eq'],
  __hash_get: ['__str_hash', '__str_eq'],
  __hash_new: ['__alloc_hdr'],

  // console
  __write_val: ['__write_str', '__write_num', '__write_byte', '__static_str'],
  __write_num: ['__ftoa'],
  __write_str: ['__sso_char', '__str_len'],

  // JSON stringify
  __stringify: ['__json_val', '__jput', '__jput_str', '__jput_num'],
  __jput_num: ['__ftoa'],
  __jput_str: ['__char_at', '__str_byteLen'],

  // JSON parse
  __jp: ['__jp_val', '__jp_str', '__jp_num', '__jp_arr', '__jp_obj', '__jp_peek', '__jp_adv', '__jp_ws'],
  __jp_str: ['__sso_char', '__char_at', '__str_byteLen'],
  __jp_num: ['__pow10'],
  __jp_arr: ['__jp_val'],
  __jp_obj: ['__jp_val', '__hash_new', '__hash_set'],

  // number
  __parseInt: ['__char_at', '__str_byteLen'],
}

/** Expand ctx.includes transitively via STDLIB_DEPS. Call before WASM assembly. */
export function resolveIncludes() {
  const queue = [...ctx.includes]
  while (queue.length) {
    const name = queue.pop()
    const deps = STDLIB_DEPS[name]
    if (deps) for (const dep of deps) {
      if (!ctx.includes.has(dep)) { ctx.includes.add(dep); queue.push(dep) }
    }
  }
}

/** Reset all compilation state. Called once per jz() invocation. */
export function reset(proto, globals) {
  ctx.emit = derive(proto)
  ctx.stdlib = {}
  ctx.includes = new Set()
  ctx.imports = []
  ctx.scope = derive(globals)
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
  ctx._localProps = null
  ctx._inTry = false
  ctx.sharedMemory = false
  ctx.memoryPages = 0
  ctx.importSources = null
  ctx.hostImports = null
  ctx.moduleStack = []
  ctx.resolvedModules = new Map()
  ctx.consts = null
  ctx.globalValTypes = null
  ctx.autoBox = null
  ctx.jzify = null
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

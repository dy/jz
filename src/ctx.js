/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 *
 * Refactored into focused sub-contexts for better maintainability.
 */

// === NaN-boxing pointer type codes ===
export const PTR = {
  ATOM: 0,      // null, undefined, booleans
  ARRAY: 1,     // heap-allocated arrays
  BUFFER: 2,    // ArrayBuffer: [-8:byteLen][-4:byteCap][bytes]
  TYPED: 3,     // TypedArrays (Float64Array, etc.)
  STRING: 4,    // heap-allocated strings
  SSO: 5,       // short string optimization (≤4 ASCII chars inline)
  OBJECT: 6,    // plain objects
  HASH: 7,      // dynamic objects (Map-like)
  SET: 8,       // Set collections
  MAP: 9,       // Map collections
  CLOSURE: 10,  // first-class functions
  EXTERNAL: 11, // JS host object refs (aux=0, offset→extMap index)
}

// === Global context with nested sub-contexts ===
export const ctx = {
  core: {},       // Core Compilation (rarely reset)
  module: {},     // Module Resolution (per-compile reset)
  scope: {},      // Scope & Bindings (per-compile reset)
  func: {},       // Function State (per-function reset)
  types: {},      // Type System (per-function reset)
  schema: {},     // Object Schema (per-compile reset)
  closure: {},    // Closures (initialized once, used per-compile)
  runtime: {},    // Runtime Support (initialized once)
  memory: {},     // Memory Configuration (per-compile)
  error: {},      // Error Context (set during compilation)
  transform: {},  // Transform State
}

/** Create a child scope via shallow flat copy (metacircular-safe: no prototype chain).
 *  Mutations to the child do not affect the parent; lookups work via direct property access. */
export const derive = (parent) => ({ ...parent })

/** Include stdlib names for emission. */
export const inc = (...names) => names.forEach(n => ctx.core.includes.add(n))

/** Stdlib call-dependency graph: fn → fns it calls internally.
 *  resolveIncludes() expands transitively before WASM assembly. */
export const STDLIB_DEPS = {
  __set_has: ['__ext_has'],
  __set_delete: [],
  __map_set: ['__ext_set'],
  __map_get: ['__ext_prop', '__map_set'],
  __map_delete: [],

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
  __str_idx: ['__str_byteLen', '__char_at', '__mkptr'],
  __str_eq: ['__str_byteLen', '__char_at'],
  __str_pad: ['__str_byteLen', '__char_at', '__alloc'],
  __str_join: ['__str_concat', '__to_str', '__str_byteLen'],
  __str_encode: ['__str_byteLen', '__char_at'],
  __str_to_buf: ['__str_byteLen', '__char_at'],

  __len: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
  __cap: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
  __byte_length: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
  __byte_offset: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
  __typed_data: ['__ptr_offset', '__ptr_aux'],
  __to_buffer: ['__ptr_type', '__ptr_offset', '__ptr_aux', '__mkptr'],

  __arr_idx: ['__len', '__ptr_offset'],
  __arr_grow: ['__dyn_move'],
  __arr_set_idx_ptr: ['__arr_grow', '__len', '__ptr_offset', '__set_len'],
  __typed_idx: ['__len', '__ptr_type', '__ptr_aux', '__ptr_offset'],
  __dyn_get: ['__hash_get_local', '__to_str', '__ptr_offset', '__is_nullish'],
  __dyn_get_expr: ['__dyn_get', '__hash_get_local', '__ptr_type'],
  __dyn_get_or: ['__dyn_get'],
  __dyn_set: ['__hash_new', '__hash_get_local', '__hash_set_local', '__to_str', '__ptr_offset', '__is_nullish'],
  __dyn_move: ['__hash_get_local', '__hash_set_local', '__to_str', '__is_nullish'],
  __hash_get_local: ['__str_hash', '__str_eq'],
  __hash_set_local: ['__str_hash', '__str_eq'],
  __eq: ['__str_eq', '__ptr_type'],

  // hash operations
  __hash_set: ['__str_hash', '__str_eq', '__ptr_type', '__ext_set'],
  __hash_get: ['__str_hash', '__str_eq', '__ptr_type', '__ext_prop'],
  __hash_has: ['__str_hash', '__str_eq', '__ptr_type', '__ext_has'],
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
  __to_num: ['__char_at', '__str_byteLen', '__pow10'],
  __parseInt: ['__char_at', '__str_byteLen'],
}

/** Expand ctx.core.includes transitively via STDLIB_DEPS. Call before WASM assembly. */
export function resolveIncludes() {
  const queue = [...ctx.core.includes]
  while (queue.length) {
    const name = queue.pop()
    const deps = STDLIB_DEPS[name]
    if (deps) for (const dep of deps) {
      if (!ctx.core.includes.has(dep)) { ctx.core.includes.add(dep); queue.push(dep) }
    }
  }
}

/** Reset all compilation state. Called once per jz() invocation. */
export function reset(proto, globals) {
  ctx.core = {
    emit: derive(proto),
    stdlib: {},
    includes: new Set(),
  }


  ctx.module = {
    imports: [],
    modules: {},
    importSources: null,
    hostImports: null,
    resolvedModules: new Map(),
    moduleStack: [],
    moduleInits: [],
    currentPrefix: null,
  }

  ctx.scope = {
    chain: derive(globals),
    globals: new Map(),
    userGlobals: new Set(),
    globalTypes: new Map(),
    globalValTypes: null,
    consts: null,
  }

  ctx.func = {
    list: [],
    exports: {},
    current: null,
    locals: new Map(),
    valTypes: new Map(),
    boxed: new Map(),
    stack: [],
    uniq: 0,
  }

  ctx.types = {
    typedElem: null,
    _localProps: null,
  }

  ctx.schema = {
    list: [],
    vars: new Map(),
    register: null,
    find: null,
    targetStack: [],
    autoBox: null,
  }

  ctx.closure = {
    types: null,
    table: null,
    bodies: null,
    make: null,
    call: null,
  }

  ctx.runtime = {
    atom: null,
    regex: null,
    data: null,
    throws: false,
    _inTry: false,
  }

  ctx.memory = {
    shared: false,
    pages: 0,
  }

  ctx.error = {
    src: '',
    loc: null,
  }

  ctx.transform = {
    jzify: null,
    lenient: true,
  }
}

/** Throw with source location context. */
export function err(msg) {
  if (ctx.error.loc != null && ctx.error.src) {
    const before = ctx.error.src.slice(0, ctx.error.loc)
    const line = before.split('\n').length
    const col = ctx.error.loc - before.lastIndexOf('\n')
    const src = ctx.error.src.split('\n')[line - 1]
    throw Error(`${msg}\n  at line ${line}:${col}\n  ${src}\n  ${' '.repeat(col - 1)}^`)
  }
  throw Error(msg)
}

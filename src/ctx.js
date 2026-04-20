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

/** Expand ctx.core.includes transitively via ctx.core.stdlibDeps. Call before WASM assembly.
 *  Each module co-locates its own deps with its stdlib registrations at init time. */
export function resolveIncludes() {
  const graph = ctx.core.stdlibDeps
  const queue = [...ctx.core.includes]
  while (queue.length) {
    const name = queue.pop()
    const deps = graph[name]
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
    stdlibDeps: {},   // populated per-module at init time (was STDLIB_DEPS in this file)
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
    globalTypedElem: null,
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
    inTry: false,
    localProps: null,
  }

  ctx.types = {
    typedElem: null,
    dynKeyVars: null,
    anyDynKey: false,
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
    dataDedup: new Map(),  // str → offset (dedup literal bytes in active data segment)
    strPool: null,         // shared-memory: accumulated raw bytes of string literals (no length prefix)
    strPoolDedup: new Map(),  // str → offset in strPool
    throws: false,
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

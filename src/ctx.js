/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 *
 * Refactored into focused sub-contexts for better maintainability.
 */

// === NaN-boxing pointer type codes ===
// SEALED: 4-bit tag (values 0-15). Layout is hardcoded in dispatch funcs
// (__length/__typeof/__to_str/__ptr_type) and the static-data strip pass
// ([src/compile.js] SHIFTABLE). No plugin/extension API — internal A/B
// measurement goes through `ctx.features.*` flags instead (see reset()).
// To retire a type, gate emission behind a feature flag and drop its dispatch
// branches; to add, renumber with care — all hardcoded branches must update.
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
// Each namespace has a single lifecycle phase and clear ownership. Violating
// these boundaries (e.g. emit writing to ctx.scope) signals a design smell.
//
// Lifecycle phases (reset() at phase start):
//   init     — once at boot (reset() on first jz() call)
//   compile  — per jz() invocation
//   function — per function being lowered
//   emit     — transient during a single AST→IR dispatch
//
// | Namespace | Phase    | Writers                   | Readers                    |
// |-----------|----------|---------------------------|----------------------------|
// | core      | compile  | reset, modules, inc()     | emit, compile, modules     |
// | module    | compile  | prepare, index.js         | prepare, compile, emit     |
// | scope     | compile  | analyze, compile          | compile, emit              |
// | func      | function | compile                   | emit, modules              |
// | types     | function | analyze                   | emit, modules              |
// | schema    | compile  | prepare, analyze, compile | prepare, analyze, emit     |
// | closure   | init     | modules (fn plugin)       | emit, compile              |
// | runtime   | compile  | emit, modules             | emit, compile              |
// | memory    | compile  | index.js                  | compile                    |
// | error     | compile  | prepare, compile, emit    | err()                      |
// | transform | compile  | index.js                  | prepare                    |
// | features  | compile  | emit, modules, prepare    | compile (resolveIncludes), |
// |           |          |                           | stdlib factories           |
export const ctx = {
  core: {},       // emitter table + stdlib registry (seeded by reset + modules)
  module: {},     // module graph: imports, resolved sources, module-init blocks
  scope: {},      // bindings: globals, consts, typed-elem ctors per global
  func: {},       // current function: locals, signature, name registry, uniq counter
  types: {},      // per-function type analysis: typedElem map, dyn-key vars
  schema: {},     // object shape inference: var→schema, schema list
  closure: {},    // first-class fn infrastructure (installed by module/function.js)
  runtime: {},    // runtime state: data segments, string pool, atom table, throws flag
  memory: {},     // module memory config (pages, shared)
  error: {},      // source location carried through emit for err() messages
  transform: {},  // compile-time options (jzify, etc.)
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
    const entry = graph[name]
    const deps = typeof entry === 'function' ? entry() : entry
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
    extImports: new Set(),  // __ext_* helpers actually emitted as env imports —
                            // pullStdlib() removes them from `includes` after wiring,
                            // so post-compile auditors (host: 'wasi') read this instead.
  }


  ctx.module = {
    imports: [],
    modules: {},
    importSources: null,
    hostImports: null,
    hostImportValTypes: new Map(),
    resolvedModules: new Map(),
    moduleStack: [],
    moduleInits: [],
    initFacts: null,
    currentPrefix: null,
  }

  ctx.scope = {
    chain: derive(globals),
    globals: new Map(),
    userGlobals: new Set(),
    globalTypes: new Map(),
    globalValTypes: null,
    globalTypedElem: null,
    repByGlobal: null, // Map<name, ValueRep> — module-level pointer reps (TYPED const globals stored as raw i32 offset, etc.)
    consts: null,
  }

  ctx.func = {
    list: [],
    names: new Set(),  // Set<string> — known func names (list + imported funcs); populated at compile() start
    map: new Map(),    // Map<string, func> — name → func entry; populated at compile() start
    exports: {},
    current: null,
    locals: new Map(),
    repByLocal: null,
    refinements: new Map(),  // flow-sensitive: name → VAL.* inside a type-guarded branch
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
    slotTypes: new Map(),  // schemaId → Array<VAL.* | null | undefined>
                           //   undefined: no observation, null: ≥2 distinct kinds, VAL.*: monomorphic
                           // Populated by collectProgramFacts on object literals;
                           // read by ctx.schema.slotVT (precise-only) so valTypeOf
                           // returns the slot's kind for `.prop` AST nodes, letting
                           // `+`/`===`/method dispatch elide `__is_str_key` checks
                           // on numeric properties of known shapes.
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
    noTailCall: false,  // when true, emit `return call` instead of `return_call` (wasm2c compat)
    strict: false,      // when true, dynamic features (obj[k], for-in) error at compile time
                        // instead of pulling in dynamic-dispatch stdlib. See ProgramFacts walk.
    runtimeExports: true, // when false, omit helper exports like _alloc/_reset from raw wasm output.
    optimize: null,     // resolved {watr, hoistPtrType, ...} config — set in index.js via resolveOptimize().
                        // Read by optimizeModule() (compile.js) and the post-watr pass (index.js).
                        // null is treated as level 2 (all on) for back-compat with internal callers.
    importMetaUrl: null, // compile-time URL for import.meta.url / import.meta.resolve static lowering.
    host: 'js',         // 'js' (default): allow `env.__ext_*` imports to be wired by the JS host at
                        // instantiation time. 'wasi': error at compile time if any `__ext_*` import
                        // would be emitted, since wasmtime/wasmer hosts have no JS runtime to satisfy
                        // them and silent fallback would corrupt output.
  }

  // Feature flags: capabilities the compiled module may exercise at runtime.
  // Set true by producer sites (import points, auto-imports, dynamic call sites).
  // Read by stdlib template factories and deps graph at resolveIncludes() time to
  // elide dead branches / skip unused imports. All default false; templates must be
  // safe when flag is off (i.e. no way to produce a value of the gated kind).
  //
  // Only `external` is wired into emission today. The rest are slots for future
  // work — most are currently usage-gated organically by `inc()`/stdlibDeps (a
  // stdlib only lands in the binary if something called inc() for it, directly
  // or transitively). Promote them here when one of two conditions holds:
  //   (a) a stdlib has dead conditional branches that can be elided when off
  //       (how `external` saves bytes in __hash_*/__set_*/__map_*/__dyn_get_any)
  //   (b) a capability needs an opt-in A/B switch against the default path
  //       (SSO is the planned first user — default string-literal emission
  //       currently forces SSO for ≤4 ASCII chars at string.js:49)
  ctx.features = {
    external: false,  // PTR.EXTERNAL possible — opts.imports, HOST_GLOBALS, or __ext_call site. WIRED.
    hash: false,      // PTR.HASH + __dyn_* substrate. Organic: any inc(__hash_*/__dyn_*) implies on.
    sso: true,        // ≤4-ASCII string packing. Default on; flip off to A/B the heap-only path.
    regex: false,     // RegExp literals + methods. Organic via inc(__regex_*).
    json: false,      // JSON.parse/stringify. Organic via inc(__jp_*/__json_*).
    typedarray: false,// Float64Array/Int32Array/etc. Organic via inc(__typed_*) + ctx.closure.floor.
    set: false,       // Set. Organic via inc(__set_*).
    map: false,       // Map. Organic via inc(__map_*).
    closure: false,   // First-class functions. Organic via ctx.closure.table population.
    timers: false,          // Set by prepare.js when timer module is included
    blockingTimers: false,   // wasmtime CLI: include __timer_loop in _start
  }
}

/** Throw with source location context. */
export function err(msg) {
  if (ctx.error.loc != null && ctx.error.src) {
    const before = ctx.error.src.slice(0, ctx.error.loc)
    const line = before.split('\n').length
    const col = ctx.error.loc - before.lastIndexOf('\n')
    const src = ctx.error.src.split('\n')[line - 1]
    const detail = `${msg}\n  at line ${line}:${col}\n  ${src}\n  ${' '.repeat(col - 1)}^`
    const e = new Error(detail)
    e.stack = `${e.name}: ${detail}\n${e.stack.split('\n').slice(1).join('\n')}`
    throw e
  }
  throw new Error(msg)
}

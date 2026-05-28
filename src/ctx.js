/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 *
 * Refactored into focused sub-contexts for better maintainability.
 */

import { makeAbi } from './abi/index.js'
export { HEAP, LAYOUT, PTR, ATOM, nanPrefixHex, atomNanHex, ssoBitI64Hex, sliceBitI64Hex, ptrNanHex, ptrBoxPrefixBigInt, encodePtrHi, decodePtrType, decodePtrAux, ATOM_HI, oobNanLiteral, oobNanIR } from '../layout.js'

// === Carrier layout ===
// Canonical bit layout lives in layout.js (compiler-free). Re-exported above for
// backward-compatible `import { LAYOUT, PTR } from './ctx.js'`.
//
// i64 carrier holds either:
//   - raw f64 number bits (any non-NaN-shape pattern), discriminated by
//     `f64.eq(f, f)` — true for real numbers, false for NaN-shape pointers.
//   - NaN-shape tagged pointer: [63:51]=NAN_PREFIX | [50:47]=tag | [46:32]=aux | [31:0]=offset.
//
// LAYOUT is the single source of truth. WAT templates reference
// `${LAYOUT.TAG_SHIFT}` etc. so a layout change propagates by re-evaluation.
// Hot dispatch (__ptr_type/__ptr_aux/__ptr_offset) keeps the inline expansion
// for codegen size; those sites are commented as LAYOUT-tied.

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
// | Namespace | Phase    | Writers                      | Readers                    |
// |-----------|----------|------------------------------|----------------------------|
// | core      | compile  | reset, modules, inc()        | emit, compile, modules     |
// | module    | compile  | prepare, index.js            | prepare, compile, emit     |
// | scope     | compile  | analyze, compile, plan       | compile, emit              |
// | func      | function | compile, narrow              | emit, modules              |
// | types     | function | analyze, plan                | emit, modules              |
// | schema    | compile  | prepare, analyze, compile    | prepare, analyze, emit     |
// | closure   | init     | modules (fn plugin)          | emit, compile              |
// | runtime   | compile  | emit, modules                | emit, compile              |
// | memory    | compile  | index.js                     | compile                    |
// | error     | compile  | prepare, compile, emit       | err()                      |
// | transform | compile  | index.js                     | prepare                    |
// | features  | compile  | emit, modules, prepare       | compile (resolveIncludes), |
// |           |          |                              | stdlib factories           |
//
// plan-phase writers (extending compile-phase): plan writes
//   ctx.scope.{globalValTypes, globalTypedElem, globals, globalTypes} via
//   inferModuleLetTypes / unboxConstTypedGlobals / inferModuleIntGlobals,
//   and ctx.types.{dynKeyVars, anyDynKey} from collectProgramFacts results.
// narrow-phase writers: narrowSignatures (under plan) temporarily swaps
//   ctx.func.{localReps, locals, current} per-function with save/restore
//   so per-call-site signature inference sees the right scope.
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
  transform: {},  // compile-time options + injected services. Three categories:
                  //   user opts   : noTailCall, strict, alloc, importMetaUrl, host, inspect
                  //   derived cfg : optimize (resolved by resolveOptimize from user input)
                  //   services    : parse, resolveUrl, jzify (when set to a function by the
                  //                 host pipeline; boolean form is a user opt). Service
                  //                 injection is the pattern that lets the self-host kernel
                  //                 run without a parser — it omits these and prepare uses
                  //                 ctx.module.importAsts instead.
  abi: {},        // per-type rep lookup (see abi/index.js). { number: rep, string: rep, ... }
                  // Set by reset() to the default carrier bundle. Read by codegen sites
                  // that delegate rep-specific behavior — today just the optimizer's
                  // peephole hook; expanding as per-site narrowing tags individual sites.
}

/** Create a child scope via shallow flat copy (metacircular-safe: no prototype chain).
 *  Mutations to the child do not affect the parent; lookups work via direct property access. */
export const derive = (parent) => ({ ...parent })

/** Include stdlib names for emission. */
export const inc = (...names) => names.forEach(n => ctx.core.includes.add(n))

/** Wrap an emit handler with a declarative stdlib-dependency list. The deps
 *  become data — exposed as `.deps` (tabulatable, analyzable) — and are `inc`'d
 *  on every call, while the body `fn` stays a pure `args → IR` builder (also
 *  reachable as `.pure`). Emitters with no stdlib needs skip the wrapper and
 *  register as plain functions; behaviour is identical either way. */
export const emitter = (deps, fn) => {
  const run = (...args) => (inc(...deps), fn(...args))
  run.deps = deps
  run.pure = fn
  // Carry the body's parameter count as `.argc`: the rest-param wrapper above
  // reports `.length` 0, so a handler's logical arity must travel as plain data
  // (read back via `emitArity`, never the masked function `.length`). Two
  // consumers need it — `typeof Math.x` folding (callable builtin vs constant)
  // and the `.`-emit property/method split (arity-1 reads as a value; arity ≥2
  // is call-only).
  run.argc = fn.length
  return run
}

/** Logical arity of an emit handler: wrapped handlers (emitter/call/method/dual)
 *  carry it as `.argc`; bare ones expose it as the function's own `.length`. */
export const emitArity = (h) => h?.argc ?? h?.length

/** Tag an emit handler as a property getter — it yields a value when the
 *  property is *read* (`re.source`, `m.size`), so the `.`-read path may fire it.
 *  Untagged handlers are methods: a bare read of `m.values` must not invoke them
 *  (that would materialize a view instead of reading the `"values"` property);
 *  they fire only from the method-call path. Apply outermost: `getter(emitter(…))`. */
export const getter = (fn) => (fn.getter = true, fn)

/** Expand ctx.core.includes transitively via ctx.core.stdlibDeps. Call before WASM assembly.
 *  Each module co-locates its own deps with its stdlib registrations at init time. */
export function resolveIncludes() {
  const graph = ctx.core.stdlibDeps
  let changed = true
  while (changed) {
    changed = false
    for (const name of [...ctx.core.includes]) {
      const entry = graph[name]
      const deps = typeof entry === 'function' ? entry() : entry
      if (deps) for (const dep of deps) {
        if (!ctx.core.includes.has(dep)) {
          ctx.core.includes.add(dep)
          changed = true
        }
      }
    }
  }
}

/** Reset all compilation state. Called once per jz() invocation. */
export function reset(proto, globals, bridge) {
  ctx.bridge = bridge
  ctx.core = {
    emit: derive(proto),
    stdlib: {},
    stdlibDeps: {},   // populated per-module at init time (was STDLIB_DEPS in this file)
    includes: new Set(),
    extImports: new Set(),  // __ext_* helpers actually emitted as env imports —
                            // pullStdlib() removes them from `includes` after wiring,
                            // so post-compile auditors (host: 'wasi') read this instead.
    jsstring: new Set(),    // `wasm:js-string` builtin names referenced by emitted code.
                            // Drained at module-assembly time into `(import "wasm:js-string" "name" …)`
                            // nodes; host wires JS-side polyfills via interop's
                            // env builder for engines without builtin support.
  }


  ctx.module = {
    imports: [],
    modules: {},
    importSources: null,
    importAsts: null,   // self-host: pre-parsed [specifier, ast] pairs (the kernel can't parse).
                        // Consulted by prepareModule before falling back to ctx.transform.parse(source).
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
    globalReps: null, // Map<name, ValueRep> — module-level pointer reps (TYPED const globals stored as raw i32 offset, etc.)
    consts: null,
  }

  ctx.func = {
    list: [],
    names: new Set(),  // Set<string> — known func names (list + imported funcs); populated at compile() start
    map: new Map(),    // Map<string, func> — name → func entry; populated at compile() start
    multiProp: new Set(),  // Set<"obj.prop"> — function-properties assigned >1× (wrapper composition); suppresses the static fn.prop() direct call
    exports: {},
    current: null,
    locals: new Map(),
    localReps: null,
    refinements: new Map(),  // flow-sensitive: name → {val?: VAL.*, notString?: true} inside a type-guarded branch
    boxed: new Map(),
    stack: [],
    uniq: 0,
    inTry: false,
    localProps: null,
    // Pass-scoped overlays installed by analyzeBody/observeSlots. While set,
    // `lookupValType`/`typedElemCtor` consult the in-progress fact maps before
    // falling back to global state — lets shorthand `{x}` / typed-array writes
    // observe locals that haven't been promoted to ctx.types yet. Saved/restored
    // by the pass owners so re-entrant analyzeBody calls don't clobber each other.
    localValTypesOverlay: null,
    localTypedElemsOverlay: null,
    _ccBody: null,      // memo key: body node last scanned by inBoundsCharCodeAt (src/type.js)
    ccInBounds: null,   // memo value: Set of in-bounds charCodeAt callee nodes for _ccBody
    _aiBody: null,      // memo key: body node last scanned by inBoundsArrIdx (src/type.js)
    aiInBounds: null,   // memo value: Set of in-bounds "recv\0idx" array-read keys for _aiBody
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
    slotIntCertain: new Map(),  // schemaId → Array<boolean | undefined>
                                //   undefined: no write observed, true: all observed
                                //   writes are integer-shaped, false: poisoned by at
                                //   least one non-int write. Populated by
                                //   `analyzeSchemaSlotIntCertain` (whole-program
                                //   walk over `{}` literals + `obj.prop = expr`
                                //   writes). Read by `ctx.schema.slotIntCertainAt`
                                //   so Math.floor/toNumF64/intIndexIR consumers fire
                                //   on `.prop` reads of provably-integer slots.
    inlineArray: new Set(),     // schemaId set — schemas whose `Array<S>` instances
                                //   use the `structInline` SRoA carrier (K f64
                                //   fields inlined per element, no per-row object).
                                //   Populated whole-program by `analyzeStructInline`
                                //   (default-disqualify); read by the array
                                //   push/index/length codegen.
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
    userThrows: false,  // user wrote `throw`/`try`/`catch`/`finally` — keep runtime declared
                        // even when all throws are dead-code-eliminated (JS-side ABI contract).
    staticPtrSlots: null,  // [byteOffset] data-segment slots holding NaN-boxed ptrs (host relocates); lazy-init in ir.js
    staticDataLen: 0,      // byte length of the address-0 static string block (seeded by module/number staticStr)
    typeofStrs: null,      // [str] interned typeof result strings; lazy-init in module/core `typeof`
  }

  ctx.memory = {
    shared: false,
    pages: 0,
  }

  ctx.error = {
    src: '',
    loc: null,
    node: null,
  }

  ctx.transform = {
    jzify: null,
    noTailCall: false,  // when true, emit `return call` instead of `return_call` (wasm2c compat)
    strict: false,      // when true, dynamic features (obj[k], for-in) error at compile time
                        // instead of pulling in dynamic-dispatch stdlib. See ProgramFacts walk.
    alloc: true,        // when false, omit raw allocator exports like _alloc/_clear from wasm output.
    optimize: null,     // resolved {watr, hoistPtrType, ...} config — set in index.js via resolveOptimize().
                        // Read by optimizeModule() (compile.js) and the post-watr pass (index.js).
                        // null is treated as level 2 (all on) for back-compat with internal callers.
    importMetaUrl: null, // compile-time URL for import.meta.url / import.meta.resolve static lowering.
    host: 'js',         // 'js' (default): allow `env.__ext_*` imports to be wired by the JS host at
                        // instantiation time. 'wasi': error at compile time if any `__ext_*` import
                        // would be emitted, since wasmtime/wasmer hosts have no JS runtime to satisfy
                        // them and silent fallback would corrupt output.
    inspect: false,     // when true, compile() additionally populates ctx.inspect with the inferred
                        // per-function signatures, locals, and JSON shapes — readable by editor
                        // hosts for inlay hints / hover types without re-running the analyzer.
  }

  // Inspection sink. Populated by compile() only when transform.inspect is true.
  // Shape: { abi, functions: { [name]: { exported, params, results, ptrKind?, locals, callerReps } }, schemas }.
  ctx.inspect = null

  // Advisory sink. Populated when compile() receives opts.warnings.
  ctx.warnings = null

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
  ctx.abi = makeAbi()

  // Only flags actually read by codegen live here. Hash/regex/json substrates
  // are pulled organically by inc(__*) — no flag mediates them, so no flag exists.
  ctx.features = {
    external: false,  // PTR.EXTERNAL possible — opts.imports, HOST_GLOBALS, or __ext_call site.
    sso: true,        // ≤4-ASCII string packing. Default on; flip off to A/B the heap-only path.
    typedarray: false,// Float64Array/Int32Array/etc. Set on typed-array construction; gates PTR.TYPED dispatch.
    set: false,       // Set. Set on Set construction; gates PTR.SET dispatch.
    map: false,       // Map. Set on Map construction; gates PTR.MAP dispatch.
    closure: false,   // First-class functions. Set when ctx.closure.table is populated.
    timers: false,          // Set by prepare.js when timer module is included
    blockingTimers: false,   // wasmtime CLI: include __timer_loop in _start
  }
}

/** Debug-mode invariant checks. Encodes the writers/readers contract documented
 *  above as runtime asserts so a bad refactor surfaces at the phase boundary
 *  instead of as a distant nondeterministic failure. No-op unless
 *  `JZ_DEBUG_INVARIANTS=1`; designed so phase-boundary callers can sprinkle
 *  `assertCtxInvariants('post-prepare')` without runtime cost in production.
 *
 *  Phases checked:
 *   - `post-reset`     : every sub-context exists; Maps/Sets initialized.
 *   - `post-prepare`   : module + scope populated; func.list possibly empty.
 *   - `pre-emit`       : func.current set; locals Map present; rep maps live.
 *   - `post-compile`   : no transient temps leaked (func.uniq stable across calls). */
const DBG_INVARIANTS = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'
export function assertCtxInvariants(phase) {
  if (!DBG_INVARIANTS) return
  const fail = msg => { throw new Error(`[ctx invariant] ${phase}: ${msg}`) }
  const must = (cond, msg) => { if (!cond) fail(msg) }

  must(ctx.core && ctx.module && ctx.scope && ctx.func && ctx.transform && ctx.features,
       'sub-contexts present')
  if (phase !== 'pre-reset') {
    must(ctx.core.includes instanceof Set, 'core.includes is Set')
    must(ctx.core.emit && typeof ctx.core.emit === 'object', 'core.emit table')
    must(Array.isArray(ctx.func.list), 'func.list array')
    must(ctx.func.locals instanceof Map, 'func.locals Map')
    must(ctx.func.refinements instanceof Map, 'func.refinements Map')
  }
  if (phase === 'pre-emit') {
    must(ctx.func.current, 'func.current set before emit')
    must(ctx.func.locals.size != null, 'locals open for writes')
  }
}

/** Enable compile-time advisories. Pass `opts.warnings` (mirrors `opts.profile`). */
export function initWarnings(sink) {
  if (sink == null) {
    ctx.warnings = null
    return
  }
  sink.entries ||= []
  ctx.warnings = { sink, seen: new Set() }
}

/** Record one advisory; `loc` is a source byte offset used only to derive
 *  line/column — it is never persisted on the entry. No-op unless
 *  `initWarnings` wired a sink. */
export function warn(code, message, meta = {}, loc = null) {
  if (!ctx.warnings) return
  const key = `${code}:${meta.fn || ''}:${meta.line || ''}`
  if (ctx.warnings.seen.has(key)) return
  ctx.warnings.seen.add(key)
  const entry = { code, message, ...meta }
  if (loc != null && ctx.error.src) {
    const before = ctx.error.src.slice(0, loc)
    entry.line = before.split('\n').length
    entry.column = loc - before.lastIndexOf('\n')
  }
  ctx.warnings.sink.entries.push(entry)
}

/** Throw with source location context. */
export function err(msg) {
  let detail = msg

  if (ctx.error.loc != null && ctx.error.src) {
    const before = ctx.error.src.slice(0, ctx.error.loc)
    const line = before.split('\n').length
    const col = ctx.error.loc - before.lastIndexOf('\n')
    const src = ctx.error.src.split('\n')[line - 1]
    detail += `\n  at line ${line}:${col}\n  ${src}\n  ${' '.repeat(col - 1)}^`
  }

  if (ctx.func.current?.name) {
    detail += `\n  in function: ${ctx.func.current.name}`
  }

  if (ctx.error.node != null) {
    detail += `\n  current AST: ${formatErrorNode(ctx.error.node)}`
  }

  const e = new Error(detail)
  const stackLines = e.stack.split('\n')
  const firstFrame = stackLines.findIndex(line => line.trimStart().startsWith('at '))
  const frames = firstFrame >= 0 ? stackLines.slice(firstFrame) : stackLines.slice(1)
  e.stack = `${e.name}: ${detail}\n${frames.join('\n')}`
  throw e
}

function formatErrorNode(node) {
  const seen = new WeakSet()
  const json = JSON.stringify(node, (_key, value) => {
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'symbol') return value.toString()
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  })
  return json.length > 2000 ? `${json.slice(0, 2000)}...` : json
}

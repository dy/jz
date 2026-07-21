/**
 * Global compilation context, reset per jz() call.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 *
 * Refactored into focused sub-contexts for better maintainability.
 */

import { makeAbi } from './abi/index.js'
export { HEAP, LAYOUT, PTR, ATOM, FORWARDING_MASK, nanPrefixHex, atomNanHex, ssoBitI64Hex, sliceBitI64Hex, ptrNanHex, ptrBoxPrefixBigInt, encodePtrHi, decodePtrType, decodePtrAux, ATOM_HI, oobNanLiteral, oobNanIR, followForwardingWat } from '../layout.js'

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
// | Namespace | Phase    | Writers                         | Readers                   |
// |-----------|----------|---------------------------------|---------------------------|
// | core      | compile  | reset, modules, inc(), emit*    | emit, compile, modules    |
// | module    | compile  | prepare, index.js               | prepare, compile, emit    |
// | scope     | compile  | analyze, compile, plan, modules, assemble | compile, emit   |
// | func      | function | compile, narrow, assemble       | emit, modules             |
// | types     | function | analyze, plan                   | emit, modules             |
// | schema    | compile  | prepare, analyze, compile       | prepare, analyze, emit    |
// | closure   | init     | modules (fn plugin), plan, emit | emit, compile             |
// | runtime   | compile  | emit, modules                   | emit, compile             |
// | memory    | compile  | index.js                        | compile                   |
// | error     | compile  | prepare, compile, emit          | err()                     |
// | transform | compile  | index.js                        | prepare, compile, emit    |
// | features  | compile  | emit, modules, prepare          | compile, stdlib factories |
// | abi       | compile  | reset (makeAbi)                 | ir.js codegen, optimizer  |
// | bridge    | compile  | reset (bridge.js)               | bridge.js → emit, modules |
//
// *emit's only `core` write is ctx.core.hostGlobals (a bare host-global reference),
//  drained to env imports at compile (compile/index.js) — NOT to ctx.scope, so emit
//  never writes scope. The stdlib module factories DO write ctx.scope.globals
//  directly (core/string register __heap, __strBase, __tof_* there at compile phase).
//
// plan-phase writers (extending compile-phase): plan writes
//   ctx.scope.{globalValTypes, globalTypedElem, globals, globalTypes} via
//   inferModuleLetTypes / unboxConstTypedGlobals / inferModuleIntGlobals,
//   and ctx.types.{dynKeyVars, anyDynKey} from collectProgramFacts results.
// narrow-phase writers: narrowSignatures (under plan) temporarily swaps
//   ctx.func.{localReps, locals, current} per-function with save/restore
//   so per-call-site signature inference sees the right scope.
// assemble-phase writers: buildStartFn (wat/assemble.js) re-owns the ctx.func frame
//   (locals/stack/refinements/…) to emit the module-init `start` fn, save/restoring
//   around it; the data pass also const-folds ctx.scope.globals (mut→false) and
//   declares the __heap* globals. emit seeds ctx.closure.{paramTypes,paramTypedCtors}
//   at direct-call sites (read by emitClosureBody); plan sets ctx.closure.{floor,width}.
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
  bridge: {},     // emit/flat/wat dispatch, bound by reset() (see bridge.js). Lets every
                  // module call emit() without importing the emitter — breaks the cycle.
  features: {},   // codegen capability flags (external, sso, typedarray, …), reset() seeds
                  // the defaults; see reset() for the field list and who flips each.
}

/** Create a child scope via shallow flat copy with NO prototype chain. Critical:
 *  `{ ...parent }` would inherit Object.prototype in V8 (jz.js), so a name-keyed lookup
 *  like `chain['valueOf']`/`emit['toString']` returns the inherited method instead of
 *  undefined — corrupting resolution of any identifier named like an Object method. The
 *  kernel's jz objects are already prototype-less, so this was a jz.js-ONLY footgun. A
 *  prototype-less dict (Object.create(null) + assign) is correct in both engines.
 *  Mutations to the child do not affect the parent; lookups work via direct property access. */
export const derive = (parent) => Object.assign(Object.create(null), parent)

/** Include stdlib names for emission. */
export const inc = (...names) => names.forEach(n => ctx.core.includes.add(n))

/** Declare a module global as a structured record — the single shape behind
 *  every `ctx.scope.globals` entry:
 *    { type: 'i32'|'i64'|'f64', mut: bool, init: number|string, export: string|null }
 *  `init` is a number or a watr const literal (`-1`, `nan:0x…`, hex). Replaces
 *  the old WAT-text strings: type queries are field reads, emission builds IR
 *  directly (no parse-back), and `globalTypes` is set in the same move. */
export const declGlobal = (name, type, init = 0, opts) => {
  ctx.scope.globals.set(name, { type, mut: opts?.mut !== false, init, export: opts?.export ?? null })
  ctx.scope.globalTypes.set(name, type)
}

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

/** Register `fn` as a property-GETTER emitter for `key` — it yields a value when
 *  the property is *read* (`re.source`, `m.size`, `a.byteOffset`), so the `.`-read
 *  path fires it. (Untagged `ctx.core.emit` handlers are methods: a bare read of
 *  `m.values` must NOT invoke them — that would materialize a view — they fire only
 *  from the method-call path.) Getter-ness lives in `ctx.core.getters` (a plain Set),
 *  NOT as a flag on the emitter closure: the self-host kernel can't reliably read a
 *  dynamic property off a closure returned via a dynamic-key lookup, so a closure tag
 *  silently read `undefined` and every getter fell through to `__dyn_get`. A Set
 *  key-lookup is kernel-safe. Dispatch (module/core.js) checks `ctx.core.getters.has(key)`. */
export const registerGetter = (key, fn) => {
  ctx.core.emit[key] = fn
  ctx.core.getters.add(key)
}

/** Expand ctx.core.includes transitively via ctx.core.stdlibDeps. Call before WASM assembly.
 *  Each module co-locates its own deps with its stdlib registrations at init time. */
export function resolveIncludes() {
  const graph = ctx.core.stdlibDeps
  const stdlib = ctx.core.stdlib
  // Auto-derived deps: a stdlib template that calls `$__foo` (a registered stdlib
  // func) depends on it, whether or not the hand-maintained `deps()` list says so.
  // Scanning the *realized* template keeps the graph honest, so a missing manual
  // entry can't silently drop a transitively-needed helper (the bug class the old
  // blanket `inc('__mkptr','__alloc')` masked). Factory templates are realized
  // (called) so feature-gated branches — `${hasExt ? '(call $__ext_prop …)' : ''}`
  // — resolve before scanning; reading raw source would over-pull the dead branch.
  // jz's templates are pure string builders, so realizing here (and again at
  // emission) is side-effect-free. A `$__foo` naming a global (not a stdlib func)
  // is skipped. Realization can fail if called before its inputs are ready — then
  // we return nothing *without caching*, so a later pass retries. Memoized per compile.
  const autoCache = ctx.core._autoDeps ??= new Map()
  const autoDepsOf = (name) => {
    let found = autoCache.get(name)
    if (found !== undefined) return found
    const v = stdlib[name]
    let text
    if (typeof v === 'string') text = v
    else if (typeof v === 'function') { try { text = v() } catch { return [] } }
    if (typeof text !== 'string') return (autoCache.set(name, []), [])
    found = []
    const seen = new Set()
    for (const m of text.matchAll(/\$(__[A-Za-z0-9_]+)/g)) {
      const d = m[1]
      if (d !== name && stdlib[d] && !seen.has(d)) { seen.add(d); found.push(d) }
    }
    autoCache.set(name, found)
    return found
  }
  let changed = true
  while (changed) {
    changed = false
    for (const name of [...ctx.core.includes]) {
      const entry = graph[name]
      const deps = typeof entry === 'function' ? entry() : entry
      const add = (dep) => { if (!ctx.core.includes.has(dep)) { ctx.core.includes.add(dep); changed = true } }
      if (deps) for (const dep of deps) add(dep)
      for (const dep of autoDepsOf(name)) add(dep)
    }
  }
  // Self-host divergence diagnostics (scripts/self.js compileDiag): snapshot
  // what THIS side resolved, so a host-vs-kernel JSON diff names the first
  // differing fact instead of leaving byte-drift archaeology. Near-zero cost
  // when the sink is absent (one truthiness test per call).
  if (ctx.core.diagSink) {
    if (!ctx.core.diagSink.resolve) ctx.core.diagSink.resolve = []
    ctx.core.diagSink.resolve.push({
      includes: [...ctx.core.includes].sort().join(' '),
      autoAlloc: autoDepsOf('__alloc').join(' '),
      memShared: !!ctx.memory.shared,
      memSharedRaw: String(ctx.memory.shared),
      allocOwned: typeof stdlib['__alloc'] === 'string' && stdlib['__alloc'].indexOf('global.get $__heap') >= 0,
    })
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
    hostGlobals: new Set(), // host globals (globalThis/process/WebAssembly/…) referenced as
                            // values. Recorded by emit on first use; drained into
                            // `(import "env" "name" (global $name i64))` at assembly. Same
                            // usage-gated pattern as jsstring — emit records, assembly owns
                            // the ctx.module.imports write.
    getters: new Set(), // keys of emit entries that are property getters — the
                        // kernel-safe authority for getter dispatch (a closure-attached
                        // flag was unreadable in the self-host kernel after a dynamic-key
                        // lookup, so every getter silently fell through to __dyn_get).
                        // MUST remain last: adding fields before stdlib/stdlibDeps/… shifts
                        // their slot indices and breaks the self-host compiled kernel's reads.
                        // Populated by registerGetter(); checked by module/core.js dispatch.
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
    globals: new Map(), // name → { type, mut, init, export } records (see declGlobal)
    userGlobals: new Set(),
    globalTypes: new Map(),
    globalValTypes: null,
    globalTypedElem: null,
    globalReps: null, // Map<name, ValueRep> — module-level pointer reps (TYPED const globals stored as raw i32 offset, etc.)
    consts: null,
    constInts: null,      // Map<name, int> — module const folded to an integer literal (prepare/plan seed; static/ir read)
    constStrs: null,      // Map<name, string> — module const folded to a string literal
    shapeStrs: null,      // Map<expr, string> / shapeStrArrays: Map<name, string[]> — schema-shape string folds
    shapeStrArrays: null,
  }

  ctx.func = {
    list: [],
    names: new Set(),  // Set<string> — known func names (list + imported funcs); populated at compile() start
    map: new Map(),    // Map<string, func> — name → func entry; populated at compile() start
    multiProp: new Set(),  // Set<"obj.prop"> — function-properties assigned >1× (wrapper composition); suppresses the static fn.prop() direct call
    exports: Object.create(null),  // name-keyed: prototype-less (see derive) — `export let valueOf` must not hit Object.prototype
    current: null,
    locals: new Map(),
    localReps: null,
    refinements: new Map(),  // flow-sensitive: name → {val?: VAL.*, notString?: true, schemaId?: number} inside a guarded branch
    boxed: new Map(),
    cellTypes: new Set(), // boxed vars whose CELL stores raw i32 (closure-capture narrowing)
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
    dynWriteVars: null,
    anyDynKey: false,
    literalWriteKeys: null, // Map<var, Set<key>> — literal-key prop writes per bare-var receiver (plan/index.js)
  }

  ctx.schema = {
    list: [],
    vars: new Map(),
    poisoned: new Set(),   // names whose assignments disagree on shape (literal +
                           //   non-literal, or two different literals). A poisoned
                           //   name never (re)binds in schema.vars: fixed-slot reads
                           //   against ONE literal's layout would misread the other
                           //   sources' objects. Populated by prepare's `=` handler;
                           //   end-of-prepare state is what compile reads, so the
                           //   conflict is order-insensitive.
    // (varsBarred deleted — BindingId totality makes cross-function bare-name
    //  collisions unrepresentable; same name ⇒ same binding, so the bar census
    //  and its belt had nothing left to guard.)
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
    slotConstInts: new Map(), // schemaId → Array<int | null | undefined>
                              //   integer discriminants observed at every source
                              //   literal construction of a schema. null means
                              //   conflicting/non-constant; consumed only for
                              //   branch refinement, never as a value substitute.
    slotTypedCtors: new Map(),  // schemaId → Array<ctor-string | null | undefined>
                                //   undefined: no observation, null: ≥2 distinct
                                //   ctors, string: every observed value of the slot
                                //   is that typed-array kind. The elem-width sibling
                                //   of slotTypes' VAL.TYPED — populated by
                                //   observeProgramSlots on object literals; read by
                                //   ctx.schema.slotTypedCtorAt (gated on the prop
                                //   never being WRITTEN program-wide) so `plan.twRe`
                                //   keeps its concrete Float64Array kind through
                                //   field provenance (bench: provenance, fftplan).
    slotIntLevels: new Map(),   // schemaId → Array<0|1|2 | undefined> — the int
                                //   census's WORKING state (type.js lattice:
                                //   1 integral, 2 strict-int32). Consumers read
                                //   the two projections below, published when
                                //   `analyzeSchemaSlotIntCertain`'s rounds settle.
    slotIntCertain: new Map(),  // schemaId → Array<boolean | undefined>
                                //   undefined: no write observed, true: all observed
                                //   writes are integer-shaped, false: poisoned by at
                                //   least one non-int write. Populated by
                                //   `analyzeSchemaSlotIntCertain` (whole-program
                                //   walk over `{}` literals + `obj.prop = expr`
                                //   writes). Read by `ctx.schema.slotIntCertainAt`
                                //   so Math.floor/toNumF64/intIndexIR consumers fire
                                //   on `.prop` reads of provably-integer slots.
    slotI32Certain: new Map(),  // schemaId → Array<boolean> — the strict (=2)
                                //   projection: every write is exactly-int32 and
                                //   never -0, so `i32.trunc_sat_f64_s` of the slot's
                                //   f64 is an exact round-trip. Read by
                                //   `ctx.schema.slotI32CertainAt` → raw i32 slot
                                //   loads (module/core.js) + i32 local typing
                                //   (type.js exprType '.').
    externSlotSids: new Set(),  // schemaId set — sids whose slot VALUES can be
                                //   written by machinery the write censuses never
                                //   see: the JSON const emitter / shaped runtime
                                //   parser (arbitrary runtime JSON into a sid
                                //   shared with source literals) and spread /
                                //   Object.assign slot copies across schemas.
                                //   Populated by plan's markExternSlotSids sweep
                                //   (+ belts at the emit registration sites); the
                                //   slot censuses pre-poison these sids and every
                                //   census reader (slotVT / slotTypedCtor* /
                                //   slotIntCertainAt / guardedNumSlot stamp)
                                //   answers null/false for them.
    inlineArray: new Set(),     // schemaId set — schemas whose `Array<S>` instances
                                //   use the `structInline` SRoA carrier (K f64
                                //   fields inlined per element, no per-row object).
                                //   Populated whole-program by `analyzeStructInline`
                                //   (default-disqualify); read by the array
                                //   push/index/length codegen.
    inlineCellI32: new Set(),   // inlineArray subset — every slot strict-int32
                                //   (slotI32Certain) and K ≥ 2, so the element
                                //   packs K raw i32 cells (⌈K/2⌉ physical 8-byte
                                //   cells, C's exact record layout): raw i32
                                //   loads/stores, no trunc_sat/convert per field.
                                //   Standalone `{S}` objects of the same sid keep
                                //   f64 slots — the packed decision rides the
                                //   CURSOR (inlineCellCursors → node.cellI32),
                                //   never the bare sid.
    inlineUnion: new Map(),     // canonical 'a,b,…' key → { sids, stride } —
                                //   CLOSED heterogeneous unions whose Array
                                //   instances store max-K-stride packed i32
                                //   cells (analyzeUnionInline; fail-closed)
    inlineUnionArrays: new Map(), // sig → Map<name, key>: union-array locals
    inlineUnionCursors: new Map(), // sig → Map<name, key>: `const o = a[i]`
                                //   cursors of union arrays (reads resolve
                                //   via refinement/agreeing slots to cells)
    inlineCellCursors: new Map(), // sig → Set<name>: `const p = a[i]` cursor
                                //   locals of packed (inlineCellI32) arrays in
                                //   that function — readVar tags their reads
                                //   with `.cellI32` so slot access picks the
                                //   packed i32 ops instead of f64 cells.
  }

  ctx.closure = {
    types: null,
    table: null,
    bodies: null,
    make: null,
    call: null,
    numericReturn: null,  // Set<closureBodyName> proven to return a plain number — lets
                          // callers skip the __to_num result coercion (function.js seeds it).
    paramTypes: null,     // Map<closureBodyName, bool[]> — per-param "every direct call site
                          // passed a number" lattice; emitClosureBody marks such params
                          // VAL.NUMBER so their body uses skip __to_num (tryDirectClosureCall seeds).
    minArgc: null,        // Map<closureBodyName, number> — fewest args any direct call passed.
                          // A slot at index ≥ minArgc is omitted by some call (→ may be undefined),
                          // so it must NOT be typed NUMBER, else `x === undefined` mis-folds to false.
    floor: null,          // min closure-table arity (modules: fn/timer/typedarray/array; read in plan). null ⇒ 0.
    width: null,          // closure call/make signature width (plan/scope sets; emit/assemble read). null ⇒ MAX_CLOSURE_ARITY.
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
    max: 0,         // 0 = unbounded; >0 emits a maximum on the memory type (cap growth)
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
    helperCounters: false, // internal profiling mode: export mutable i64 counters for selected
                           // runtime helpers and instrument their entry blocks. Build-time opt-in
                           // only; normal output is byte-identical and pays no counter cost.
    helperCallsites: false, // profiling-only: export mutable i64 counters for selected runtime
                            // helper callsites after optimization, so hot helpers can be traced
                            // back to the compiled function that calls them.
    loopXformId: 0,     // monotonic id for the per-function loop transforms' generated locals
                        // (loop-model freshLoopId). Per-compile (reset here), not a module-global —
                        // so compile(P) is deterministic regardless of prior compiles in the process.
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

/** Advise that an emit site fell back to generic runtime dispatch (the slow,
 *  un-inferred path). Called from the actual emission point so it fires only when
 *  inference/optimization truly couldn't fold it — never a false positive on a
 *  case that vectorized/unrolled/slot-folded. `ctx.error.loc` is the current AST
 *  node's byte offset (kept up to date by the emit walk), giving line/column. */
export function warnDeopt(code, message) {
  warn(code, message, { fn: ctx.func.current?.name }, ctx.error.loc)
}

/** Throw with source location context. */
export function err(msg, cause) {
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

  // Preserve the triggering error (if any) as the cause: when an internal jz bug
  // is wrapped, the original stack — pointing at the actual codegen site — survives
  // in the chain (`Error: …  [cause]: …`) instead of being replaced by this frame.
  const e = cause !== undefined ? new Error(detail, { cause }) : new Error(detail)
  const stackLines = e.stack.split('\n')
  const firstFrame = stackLines.findIndex(line => line.trimStart().startsWith('at '))
  const frames = firstFrame >= 0 ? stackLines.slice(firstFrame) : stackLines.slice(1)
  e.stack = `${e.name}: ${detail}\n${frames.join('\n')}`
  throw e
}

// Recursive walk, NOT a stringify replacer — the kernel drops replacers, so
// in-kernel error nodes would print with bigints/cycles unhandled. Cold path.
function formatErrorNode(node) {
  const seen = new Set()
  const fmt = (v) => {
    if (typeof v === 'bigint') return `"${v}n"`
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) {
      if (seen.has(v)) return '"[Circular]"'
      seen.add(v)
      let s = '['
      for (let i = 0; i < v.length; i++) s += (i ? ',' : '') + fmt(v[i])
      return s + ']'
    }
    return v === undefined ? 'null' : String(v)
  }
  const json = fmt(node)
  return json.length > 2000 ? `${json.slice(0, 2000)}...` : json
}

/**
 * CompileSession record, reset per jz() call (architecture item 11 / audit-B
 * finding 5, .work/compile-session-design.md Slice A — formalization only,
 * no shape change). `ctx` IS the CompileSession: 20 named subtrees below,
 * one lifecycle phase each, writer/reader tables documented per-field. See
 * src/session.js's `beginSession()` — "the ONE owner of per-compile
 * lifecycle state" — for the fuller record's owning seam.
 *
 * Everything is f64. Scalars are regular numbers. Pointers are NaN-boxed f64.
 * Memory auto-enabled when arrays/objects/strings are used.
 *
 * Refactored into focused sub-contexts for better maintainability.
 */

import { makeAbi } from './abi/index.js'
import { createActiveFunction, isInactiveFunction } from './compile/active-function.js'
import { HOT_PASSES } from './passes.js'
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
// | func      | function | active-function authority, compile scopes | emit, modules       |
// | types     | function | analyze, plan                   | emit, modules             |
// | schema    | compile  | prepare, analyze, compile       | prepare, analyze, emit    |
// | closure   | init     | modules (fn plugin), plan, emit | emit, compile             |
// | runtime   | compile  | emit, modules                   | emit, compile             |
// | memory    | compile  | index.js                        | compile                   |
// | error     | compile  | prepare, compile, emit          | err()                     |
// | transform | compile  | index.js                        | prepare, compile, emit    |
// | features  | compile  | prepare, analyze                | compile, optimizer, stdlib factories |
// | linkDemand| compile  | emit, modules                   | resolveIncludes()+, assemble |
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
// narrow-phase writers: narrowSignatures (under plan) installs scoped overlays
//   within the current record so per-call-site inference sees the right scope.
// assemble-phase writers: buildStartFn (wat/assemble.js) swaps one complete
//   active-function record to emit the module-init `start` fn; closure emission
//   does the same and restores by identity. The data pass also const-folds
//   ctx.scope.globals (mut→false) and
//   declares the __heap* globals. emit seeds ctx.closure.{paramTypes,paramTypedCtors}
//   at direct-call sites (read by emitClosureBody); plan sets ctx.closure.{floor,width}.
export const ctx = {
  core: {},       // emitter table + stdlib registry (seeded by reset + modules)
  module: {},     // module graph: imports, resolved sources, module-init blocks
  scope: {},      // bindings: globals, consts, typed-elem ctors per global
  funcs: {},      // compile-lifetime ProgramFunctions registry: list + indexes + exports
  names: {},      // compile-lifetime synthetic-name authorities outside active emission frames
  func: {},       // active function analysis/emission frame: locals, signature, uniq counter
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
  features: {},   // frozen FeaturePlan (SESSION+PROGRAM+ANALYSIS facts), reset() seeds
                  // the defaults; see reset() for the field list and who flips each.
  linkDemand: {}, // DEMAND stratum (emission-produced reachability), reset() seeds the
                  // defaults; see reset()'s ctx.linkDemand doc for the field list.
}

/** Reset-hook registry (session survey audit-#13 slice a — single reset
 *  choreography, not relocation): prepare/index.js's 14-let working set,
 *  module/regex.js's 4-var literal parser, and optimize/vectorize.js's
 *  why-not-simd arm/disarm flags all live at MODULE scope outside ctx for
 *  performance (documented, deliberate at each site) — but before this, each
 *  had its OWN independent reset point (prepare's own resetPrepState() call
 *  at its entry, regex's inline reset at parseRegex()'s entry, vectorize's
 *  disarm at its own call tail with no exception safety), invisible to
 *  reset()/beginSession() — the seam session.js's own docstring already
 *  names "the ONE owner of per-compile lifecycle state." A subsystem
 *  registers its own reset callback here once at module load; reset() (used
 *  by every entry point — beginSession AND raw-reset test harnesses alike,
 *  see reset()'s own DBG_INVARIANTS bridge-hook comment) drains the list at
 *  the end. Plain array + for-of, no Proxy/getter machinery (self-host
 *  subset, survey §4) — index.js's `compileTarget` test-injection override is
 *  deliberately NOT registered here: it is a process-wide switch that must
 *  survive the raw `reset()` calls test/types.js makes directly (unlike the
 *  other three, which are genuine per-compile working state) — see
 *  session.js's narrower `registerSessionResetHook` for that one. */
const RESET_HOOKS = []
export function registerResetHook(fn) { RESET_HOOKS.push(fn) }

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

/** THE guarded write for the structured stdlib-registration dialects —
 *  reg()/wat() (src/bridge.js) and registerGetter() below. Throws
 *  immediately, naming both registration sites, instead of silently
 *  overwriting (CONTRIBUTING "Stdlib registration"): a name already claimed
 *  — by an earlier reg()/wat()/registerGetter() call, OR by a raw
 *  `table[name] = …` assignment (~580 sites across module/*.js, the OTHER
 *  half of the two-dialect split) — is a mistake, not a legitimate override.
 *
 *  A genuinely raw bracket assignment can't be trapped at the moment it
 *  runs: intercepting an arbitrary property write needs a Proxy, and this
 *  file is compiled BY jz into dist/jz.wasm as part of self-hosting
 *  (scripts/self.js imports it directly) — Proxy traps aren't in the
 *  self-hostable subset, so wrapping `table` in one would break the
 *  self-build. A raw write BEFORE this call is still caught (the plain
 *  `table[name]` read below sees it — no registered value is ever
 *  `undefined`); `verifyEmitIntegrity` (called after every module's
 *  init(ctx) in src/autoload.js, ctx.core.emit only) closes the other
 *  direction — a raw write AFTER a reg() call, which is the direction
 *  CONTRIBUTING documents as dangerous (it silently drops emitter()'s
 *  auto-inc/argc wrapper).
 *
 *  `order`/`siteDialect`/`siteModule` are plain ARRAYS (insertion-ordered
 *  names, two parallel attribution arrays) — deliberately not a name-keyed
 *  dict/Map, and deliberately never string-CONCATENATED on the hot
 *  (non-throwing) path. Both were live self-host warm-reuse hazards, found
 *  by bisecting this exact function against `test/selfhost.js`'s
 *  "warm-instance reuse" test (a `_clear()`-then-recompile round-trip
 *  within one wasm instance, byte-pinned against a fresh instance): a
 *  name-keyed dict/Map accumulating stdlib-registration scale (~150-600
 *  entries) as a SECOND such structure alongside `ctx.core.emit`'s own
 *  large dict corrupted it with a bare "memory access out of bounds" even
 *  though `ctx.core.emit` itself proves ONE large dynamic dict is fine
 *  every compile; separately, building `${module}|${dialect}` via string
 *  concatenation ~150 times during registration corrupted it even with
 *  ZERO dicts involved (arrays only) — string concat is used constantly
 *  elsewhere in normal compiles without issue, so the trigger is concat
 *  specifically inside the compiler's OWN self-hosted bookkeeping, at this
 *  call volume, surviving to the NEXT `_clear()`. Root-causing either
 *  inside the self-hosted dyn-props/string runtime is a separate, deeper
 *  investigation (ledger note, .work/research.md); this function sidesteps
 *  both entirely — plain `.push()` of already-existing string references
 *  (`dialect`, `ctx.core.currentModule` — never a newly concatenated one)
 *  into plain arrays, the exact shape bisected safe. Every `+`/template
 *  literal below lives ONLY inside a `throw` branch (dead code on any
 *  passing compile — registerName/verifyEmitIntegrity only throw when the
 *  stdlib source itself has a genuine duplicate registration bug), so it
 *  never executes during warm reuse either. */
export const registerName = (table, order, siteDialect, siteModule, name, dialect, value) => {
  if (table[name] !== undefined) {
    const i = order.indexOf(name)
    if (i >= 0) throw new Error(`Duplicate stdlib registration: '${name}' already registered by module '${siteModule[i]}' via ${siteDialect[i]}(), registered again by module '${ctx.core.currentModule}' via ${dialect}(). Rename one or delete the redundant registration — silent overwrite drops the earlier handler with no error.`)
    throw new Error(`Duplicate stdlib registration: '${name}' already exists (a raw assignment) before module '${ctx.core.currentModule}' registered it via ${dialect}(). Rename one or delete the redundant registration — silent overwrite drops the earlier handler with no error.`)
  }
  table[name] = value
  order.push(name)
  siteDialect.push(dialect)
  siteModule.push(ctx.core.currentModule)
}

/** Complements registerName's pre-write check: after a module's init(ctx)
 *  returns (src/autoload.js includeModule), verify none of the previously
 *  reg()-registered ctx.core.emit handlers got silently clobbered by a raw
 *  assignment inside that module — the dangerous direction registerName
 *  can't see coming (it only guards the moment of ITS OWN write, not a
 *  later raw one). Together the two calls cover both temporal orders
 *  without a Proxy.
 *
 *  ctx.core.emit ONLY — not ctx.core.stdlib/wat(): a WAT body is a plain
 *  string with no attached wrapper metadata to silently lose, so a raw
 *  clobber there is an outright wrong-text bug (caught by ordinary
 *  functional tests), not the invisible-guarantee-drop CONTRIBUTING singles
 *  out for `ctx.core.emit`. Detecting it needs a per-name marker
 *  distinguishable from a plain overwrite; tagging a STRING isn't possible.
 *  reg()'d ctx.core.emit handlers already carry that marker for free —
 *  `emitter()` (this file) tags every one with `.deps`/`.argc`; a raw
 *  handler clobbering one loses that tag, which is the check below.
 *  registerGetter() entries aren't emitter()-wrapped (no deps to
 *  auto-include), so they're checked for bare presence only. */
export const verifyEmitIntegrity = (table, order, siteDialect, siteModule) => {
  for (let i = 0; i < order.length; i++) {
    const name = order[i]
    const v = table[name]
    const isReg = siteDialect[i] === 'reg'
    if (v === undefined || (isReg && (typeof v !== 'function' || v.deps === undefined)))
      throw new Error(`Duplicate stdlib registration: core.emit '${name}' registered by module '${siteModule[i]}' via ${siteDialect[i]}() was silently overwritten by a raw assignment (likely in module '${ctx.core.currentModule}', just registered). Rename one or delete the redundant raw assignment.`)
  }
}

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
  registerName(ctx.core.emit, ctx.core.regEmitOrder, ctx.core.regEmitDialect, ctx.core.regEmitModule, key, 'registerGetter', fn)
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

/**
 * Fact-store storage (audit P1 stage 5) — see src/session.js's DEPS table for
 * the full per-slice contract (what each slice caches, what invalidates it).
 * Storage lives HERE rather than in session.js to avoid a module cycle:
 * program-facts.js / analyze.js / analyze-scans.js each read their slice, and
 * analyze.js is itself imported by wat/assemble.js, which session.js imports
 * (clearStdlibParseCache) — routing the accessor through session.js would
 * close analyze.js -> session.js -> wat/assemble.js -> analyze.js (jz's own
 * self-host module resolver rejects import cycles outright, so this isn't
 * just a style question — it breaks `npm run build`). ctx.js is the one leaf
 * every one of those already depends on with nothing importing back, so
 * ownership of WHERE the store lives sits here; session.js's beginSession
 * still owns WHEN a fresh one is created (calls resetFactStore()) and
 * re-exports getFactStore() as the public accessor.
 */
function createFactStore() {
  return {
    programFacts: { gen: 0, walkCache: new WeakMap(), moduleInitSlot: new WeakMap(), bodyIntCertain: new WeakMap(), hazard: null },
    bodyFacts: new Map(),
    bindingUses: new WeakMap(),
    mayBeUndefinedTrace: new WeakMap(),
    mapGetShapedTrace: new WeakMap(),
    presentValTrace: new WeakMap(),
    // ctx.func AdHocMemo retirement (ctxfunc-survey.md §2/§5, coordinator
    // ruling #2): 6 hand-rolled single-slot `_xBody === body ? cached :
    // recompute` caches, each keyed on the CURRENT function body's identity
    // and — like mayBeUndefinedTrace et al. above — persisting ACROSS
    // enterFunc by design (self-invalidating purely by body identity, not
    // reset per-function). Same WeakMap-on-identity idiom, same session-
    // ownership reasoning (kernel WeakMap→strong-Map lowering means a bare
    // module-global would leak entries across compiles; resetFactStore()
    // swaps in a fresh WeakMap every beginSession). See each consuming site
    // for the field it replaces.
    ccInBounds: new WeakMap(),        // src/type.js inBoundsCharCodeAt (was ctx.func._ccBody/ccInBounds)
    aiInBounds: new WeakMap(),        // src/type.js inBoundsArrIdx (was ctx.func._aiBody/aiInBounds)
    aiLitBounds: new WeakMap(),       // src/type.js inBoundsArrIdx/litBoundArrIdx (was ctx.func.aiLitBounds)
    ipProven: new WeakMap(),          // src/type.js intervalProvenIdx (was ctx.func._ipBody/ipProven)
    ipRanges: new WeakMap(),          // src/type.js intervalProvenIdx/intervalIdxRanges/stampClonedIdxProof (was ctx.func.ipRanges)
    constPropAliases: new WeakMap(),  // src/compile/flow-types.js constPropAliases (was ctx.func._constPropAliasBody/_constPropAliases)
    boolEager: new WeakMap(),         // src/compile/emit.js boolEagerBody (was ctx.func._boolEagerBody/_boolEagerValue)
    typedBundleGuards: new WeakMap(), // module/typedarray.js typedBundleGuard (was ctx.func._typedBundleBody/_typedBundleGuards)
  }
}
let _factStore = createFactStore()
/** The current session's fact store. Prefer importing this from session.js
 *  (the documented public seam) — exported here too since that's where the
 *  storage actually lives (see the comment above). */
export function getFactStore() { return _factStore }
/** Start a fresh fact store (called once per session by beginSession). */
export function resetFactStore() { _factStore = createFactStore() }

/** Reset all compilation state. Called once per jz() invocation. */
export function reset(proto, globals, bridge) {
  // Every session entry (index.js setupCtx, scripts/self.js kernel entries,
  // raw-reset test harnesses) must bind the FULL bridge hook set — a missing
  // hook surfaces as an empty-IR internal error deep inside a compile (the
  // emitIdentitySafe/self.js incident: native fine, kernel leg crashed).
  // Fail loudly at session start instead, under the invariants leg.
  if (DBG_INVARIANTS) for (const h of ['emit', 'flat', 'body', 'bool', 'idx', 'spread', 'emitIdentitySafe'])
    if (typeof bridge?.[h] !== 'function') throw new Error(`reset: bridge hook '${h}' missing — every beginSession/reset caller must bind the full hook set (see bridge.js)`)
  // FeaturePlan freeze tripwire state (see setFeature/assertCtxInvariants below): cleared
  // HERE, not only at the optional 'post-reset' assertCtxInvariants call — `reset()` itself
  // is the one entry point every caller uses, including raw-reset test harnesses
  // (test/types.js's runAnalyze etc.) that never call beginSession/assertCtxInvariants at
  // all. Clearing only on the phase call let a PRIOR compile's `_postAnalyze=true` leak
  // into an unrelated later reset()-only test in the same warm process, false-tripping the
  // tripwire on that test's own (legitimately pre-analyze) ctx.features writes.
  _featureSnapshot = null
  _postAnalyze = false
  // linkDemand freeze tripwire state (setLinkDemand/assertCtxInvariants below) —
  // same reasoning as _postAnalyze just above: cleared here so a raw-reset-only
  // caller in the same warm process never inherits a PRIOR compile's `_preAssemble`.
  _preAssemble = false
  ctx.bridge = bridge
  ctx.core = {
    emit: derive(proto),
    stdlib: Object.create(null),   // prototype-less: registerName's `name in table` collision
                                    // check must not false-positive on inherited Object.prototype
                                    // names ('toString', 'constructor', …) — emit is already
                                    // prototype-less via derive(), this matches it.
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
                        // Populated by registerGetter(); checked by module/core.js dispatch.
    currentModule: null,   // module name currently running its init(ctx) (set by
                            // includeModule(), src/autoload.js) — attributes a
                            // registerName()/verifyEmitIntegrity() collision to a module
                            // without threading a param through every call site.
    regEmitOrder: [],       // names registered on ctx.core.emit via reg()/registerGetter()
                            // this compile, in registration order — registerName's
                            // collision ledger (see registerName's doc comment: plain
                            // arrays, deliberately NOT a name-keyed dict/Map, and never
                            // string-concatenated on the hot path — both broke self-host
                            // warm-instance reuse; see registerName for the bisection).
    regEmitDialect: [],     // parallel to regEmitOrder: dialect string ('reg'/'registerGetter').
    regEmitModule: [],      // parallel to regEmitOrder: registering module's name.
    regStdlibOrder: [],     // same trio, for ctx.core.stdlib names registered via wat().
    regStdlibDialect: [],
    regStdlibModule: [],
                        // MUST remain last: adding fields before stdlib/stdlibDeps/… shifts
                        // their slot indices and breaks the self-host compiled kernel's reads.
  }


  ctx.module = {
    imports: [],
    modules: {},
    importSources: null,  // user compile's bundled source graph; reset() clears it every session
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
    // ES §14.7.4.7 per-iteration bindings at MODULE scope: names prepare
    // routed through the local (not global) path because a nested closure
    // inside their declaring loop captures them (see prepare/index.js's
    // loopLocalNames — same names, accumulated across the whole compile
    // instead of scoped to one loop). Consulted once, at assemble.js's
    // buildStartFn, to box the (rare) subset ALSO mutated after capture —
    // scoped narrowly to just these names so an ordinary module-global
    // capture is never mistakenly cell-boxed.
    moduleLoopCaptured: new Set(),
  }

  // Compile-lifetime function registry. This is the authoritative program
  // catalog; unlike ctx.func's active analysis/emission frame it is never
  // replaced at function entry. Keep the record identity stable for the whole
  // session while prepare/variant/plan append and index functions.
  ctx.funcs = {
    list: [],
    names: new Set(),  // Set<string> — known func names (list + imported funcs); populated at compile() start
    map: new Map(),    // Map<string, func> — name → func entry; populated at compile() start
    multiProp: new Set(),  // Set<"obj.prop"> — function-properties assigned >1× (wrapper composition); suppresses the static fn.prop() direct call
    exports: Object.create(null),  // name-keyed: prototype-less (see derive) — `export let valueOf` must not hit Object.prototype
    globalDevirt: null, // Map<global, function name> published by plan/scope.js, consumed by emit
  }

  // Prepare/session synthetic names must not consume the active frame's temp
  // counter: prepare runs before any function entry and spans bundled modules.
  ctx.names = { prepare: 0 }

  // Complete active-function analysis/emission authority. Every real function
  // boundary replaces this record by identity through enterActiveFunction();
  // nested emitters restore the displaced record rather than copying a selected
  // field list. ProgramFunctions fields live exclusively on ctx.funcs above.
  ctx.func = createActiveFunction()

  ctx.types = {
    typedElem: null,
    typedLen: null,  // mirrors typedElem's per-function lifecycle exactly (audit P2: its swap is
                      // now structural, via enterActiveFunction/restoreActiveFunction — compile/active-function.js)
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
    arrayVars: new Map(), // synthetic destructure-temp name → prepped array-literal
                          // element AST nodes (the array sibling of `vars` above).
                          // NOT content-deduped like the object schema list: arrays
                          // have no structural identity to safely share a program-wide
                          // id by (every same-length array literal would collide onto
                          // one id). Populated only for compiler-synthesized decl-
                          // destructure temps (prepare/index.js prepDecl), which are
                          // single-write and non-escaping by construction — read by
                          // kind.js valTypeOf's VT['[]'] to recover an element's kind
                          // through `let [a, b] = [1, BigInt(v)]`-shaped destructuring.
    // SlotFact unification (product-lattice design .work/lattice-design.md
    // §1/§5 Slice 6a, OQ2 6a/6b split): schemaId → Array<SlotFact | undefined>,
    // one record per (sid, idx) replacing 4 formerly-parallel Maps that shared
    // the IDENTICAL clash-poison/OR-join write discipline (FINDING-2) —
    // slotTypes, slotObjSids, slotTypedCtors, slotBigintObserved. Each
    // SlotFact = `{ kind, objSid, typedCtor, bigintObserved }`:
    //   .kind:      VAL.* | null | undefined — undefined: no observation,
    //     null: ≥2 distinct kinds observed (clash-poisoned), VAL.*:
    //     monomorphic. Was slotTypes. Populated by observeProgramSlots on
    //     object literals; read by ctx.schema.slotVT (precise-only) so
    //     valTypeOf returns the slot's kind for `.prop` AST nodes, letting
    //     `+`/`===`/method dispatch elide `__is_str_key` checks on numeric
    //     properties of known shapes.
    //   .objSid:    childSchemaId | null | undefined — PROPERTY-KIND TRACING
    //     (§19/§20, .work/carrier-representation-design.md): the nested-sid
    //     sibling of .kind's VAL-kind lattice, one level up. undefined: no
    //     `r.p = {...}` write observed, null: ≥2 distinct literal shapes (or
    //     a non-literal RHS) — poisoned, childSid: EVERY resolvable write to
    //     this (sid, idx) slot is provably that ONE `{}`-literal shape. Was
    //     slotObjSids. Populated ONLY by observeProgramSlots' `.prop=`/`=`-
    //     write branch (NOT the `{}`-literal decl-site branch — a receiver's
    //     OWN declared value is a separate, potentially-placeholder shape;
    //     see §19's ctx.schema finding for why conflating the two would
    //     poison the flagship case). Read by ctx.schema.idOf (via chainSid)
    //     so a `.`-node receiver (`ctx.schema`, not a bare name) can chain-
    //     resolve to a schema id, precise-only, fail-closed on any
    //     unresolved/hazarded hop.
    //   .typedCtor: ctor-string | null | undefined — undefined: no
    //     observation, null: ≥2 distinct ctors, string: every observed value
    //     of the slot is that typed-array kind. Was slotTypedCtors. The
    //     elem-width sibling of .kind's VAL.TYPED — populated by
    //     observeProgramSlots on object literals; read by
    //     ctx.schema.slotTypedCtorAt (gated on the prop never being WRITTEN
    //     program-wide) so `plan.twRe` keeps its concrete Float64Array kind
    //     through field provenance (bench: provenance, fftplan).
    //   .bigintObserved: true | undefined — CARRIER PROGRAM §15/§16 write
    //     census: a pure OR-join (unlike .kind's first-wins-then-clash
    //     lattice), true iff ANY write to this (sid, idx) slot anywhere in
    //     the program — a `{}` construction literal value, an `obj.prop=`
    //     assignment, or a hazarded write the kind census can't resolve
    //     precisely (Object.assign/spread merges, computed-key writes — see
    //     applySlotWriteHazards' fail-OPEN belt below, the opposite
    //     direction from every other census's fail-closed hazard poison:
    //     under-boxing a slot that really does carry a BigInt is unsound,
    //     over-boxing one that never does is a rare harmless cost) — is
    //     BIGINT-typed. A later differing-kind write never erases this bit:
    //     a slot mixing NUMBER and BIGINT writes must still box its BIGINT
    //     instances. Was slotBigintObserved. Populated by observeProgramSlots
    //     alongside .kind (same clear-on-`fresh` lifecycle). Raw census
    //     only — never read directly; the boxing DECISION also needs the
    //     schema-wide needsDynShadow join (ctx.types.dynKeyVars/anyDynKey,
    //     published after this census runs), composed at consume time by
    //     ctx.schema.slotBigintBoxedAt/BySid and their narrower read-side
    //     twins slotBigintProvenAt/BySid (module/schema.js).
    //
    // slotIntCertain/slotI32Certain (below) deliberately stay their OWN
    // dedicated Maps, not folded in here: unlike the four fields above (one
    // shared single-pass producer, observeProgramSlots, genuinely duplicated
    // clash-poison algebra — FINDING-2's actual target), they're published
    // together from ONE already-unduplicated source (slotIntLevels) by a
    // materially different producer (analyzeSchemaSlotIntCertain's
    // round-based fixpoint, its own clear/rebuild discipline keyed on
    // opts.paramReps, not opts.fresh) and have genuine external Map-native
    // consumers (compile/index.js's `.size` gate, slot-hazards.js's
    // `.values()` assertion, the P-carrier invariant loop just below) —
    // merging them onto this shared array would reconcile two independently-
    // timed clear disciplines on the SAME storage for zero reduction in
    // actual duplicated logic (there was never a second slotIntCertain-
    // shaped algebra here to delete). See §6 risk item 6's own precedent for
    // numeric's observation-timing independence — extended from the
    // FINDING-10 pass-sharing question to the storage-representation
    // question it structurally implies.
    slotFacts: new Map(),
    slotConstInts: new Map(), // schemaId → Array<int | null | undefined>
                              //   integer discriminants observed at every source
                              //   literal construction of a schema. null means
                              //   conflicting/non-constant; consumed only for
                              //   branch refinement, never as a value substitute.
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
    dictValueTypes: new Map(),  // name → Set<VAL.*> — dict-value-census global
                                //   half (product-lattice Slice 7, retiring the
                                //   old first-wins-then-clash poison-to-null
                                //   algebra per .work/lattice-design.md §thesis:
                                //   this is an EXISTENTIAL fact — "which kinds
                                //   was this dict ever written with" — so
                                //   disagreeing writes UNION into the Set
                                //   instead of collapsing it to null; an
                                //   unresolved write unions in the full
                                //   KIND_UNIVERSE (TOP), never a sentinel).
                                //   Every VAL.* kind ever written through
                                //   `name[key] = v` (any key) across the whole
                                //   program (ast top-level, every function body,
                                //   module inits), populated/cleared by
                                //   observeProgramSlots alongside slotTypes/
                                //   slotCtors. Rooted at the bare name (nested
                                //   `[]` chains resolve to their root), whole-
                                //   program name-keyed same as dynWriteVars/
                                //   nameEscapes — NOT scope-aware, consumers
                                //   gate at read time. Published into
                                //   ctx.scope.globalReps as dictValueValType (a
                                //   Set, same exact-or-null projection kept by
                                //   kind.js's dictValueKindOf) by
                                //   observeProgramSlots itself; the raw Set is
                                //   also the union censusKindsOf exposes.
    mapValueTypes: new Map(),  // name → Set<VAL.*> — Map-value-census Tier 1
                                //   global half, dictValueTypes' union-lattice
                                //   sibling (product-lattice Slice 7): every
                                //   VAL.* kind ever written through a proven-
                                //   VAL.MAP receiver's `recv.set(k, v)` (any
                                //   key) across the whole program — same
                                //   union/TOP-on-unresolved algebra and whole-
                                //   program name-keyed convention as
                                //   dictValueTypes just above (Map has no `[]=`
                                //   write form, so the census matches the CALL
                                //   shape instead). Populated/cleared by
                                //   observeProgramSlots alongside dictValueTypes;
                                //   published into ctx.scope.globalReps as
                                //   mapValueValType.
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
    envMeta: null,   // Array<{len, cellMask}>, parallel to `table` (index = funcIdx) — region
                     // arena's CLOSURE relocation side table source (module/function.js's
                     // ctx.closure.make; materialized by src/wat/assemble.js). Reset fresh
                     // every compile like `table`/`bodies` — module/function.js's own
                     // `if (!ctx.closure.envMeta) …` guard (re)creates the array on first use.
    // Map<closureBodyName, VAL.*> — round-6 prereq (a): the closure return-kind
    // pre-pass (module/function.js, ctx.closure.make) derives each closure's
    // unified return-tail VAL kind from its raw AST at CREATION time (always
    // before any later call site in program order — closure bodies themselves
    // only compile at module end, after their callers, so calleeValType
    // couldn't otherwise see this). Subsumes the old numericReturn Set (VAL.
    // NUMBER was the only kind it tracked) — calleeValType (kind-traits.js)
    // reads this generically, letting a direct-dispatched call to ANY kind of
    // closure (not just numeric ones) skip its own re-derivation.
    valResult: null,
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
    optFlags: 0,        // hot per-node pass flags flattened to an i32 bitmask (optimize/index.js
                        // OPTF/optFlagsOf) — set beside `optimize` at compile setup; emit paths
                        // mask-test this fixed slot instead of property-probing the cfg per node.
    importMetaUrl: null, // compile-time URL for import.meta.url / import.meta.resolve static lowering.
    host: 'js',         // 'js' (default): allow `env.__ext_*` imports to be wired by the JS host at
                        // instantiation time. 'wasi': error at compile time if any `__ext_*` import
                        // would be emitted, since wasmtime/wasmer hosts have no JS runtime to satisfy
                        // them and silent fallback would corrupt output.
    targetProfile: null, // TargetProfile (audit P1): the named, frozen output-target policy object
                        // derived from `host` — set right after `host` in session.js beginSession
                        // (targetProfileFor). Consumers gate on ITS named fields (envImports,
                        // jsStringInterop, wasiShims, commandEntry, timerModel,
                        // preserveClosureTable), not on `host === 'wasi'` directly, so a third
                        // target adds a profile, not a new string comparison at every call site.
                        // Distinct from HOST_PROFILE below (compiler-engine capabilities) — this is
                        // the OUTPUT target's policy, not the engine running the compiler.
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
    sessionPhase: null, // W1 lifecycle contract: last completed ordered phase (assertCtxInvariants)
    cseId: 0,           // monotonic id for CSE temps (freshCseName) — per-compile, so warm-process WAT text is deterministic
                        // (loop-model freshLoopId). Per-compile (reset here), not a module-global —
                        // so compile(P) is deterministic regardless of prior compiles in the process.
    loopPlanId: 0,      // monotonic id for loop-model's HIR provenance LoopPlan records
                        // (.work/research.md §BodyModel slice 4, freshLoopPlanId) — a SEPARATE
                        // space from loopXformId: identifies a loop RECORD, never names anything
                        // emitted. Per-compile (reset here) for the same determinism reason.
    closureId: 0,       // monotonic id for src/compile/closure-plan.js's ClosureId (architecture
                        // re-audit item 4, .work/todo.md) — a SEPARATE space from the others
                        // above: identifies a closure PLAN RECORD, never names anything emitted.
                        // Per-compile (reset here) for the same determinism reason.
  }

  // Inspection sink. Populated by compile() only when transform.inspect is true.
  // Shape: { abi, functions: { [name]: { exported, params, results, ptrKind?, locals, callerReps } }, schemas }.
  ctx.inspect = null

  // Advisory sink. Populated when compile() receives opts.warnings.
  ctx.warnings = null

  // Feature flags: the frozen FeaturePlan (.work/research.md §FeaturePlan freeze).
  // Every key here MUST be seeded, not an absent key: the self-hosted kernel's
  // absent-dyn-key read misfires truthy, so a missing key silently turns a gate ON
  // (the original bigint bug — pure-number programs exported subnormals as bigint
  // carriers, -5e-324 → -1, data.js pins). Three strata, each with its own writer
  // phase; assertCtxInvariants (below) snapshots SESSION+PROGRAM at 'post-prepare',
  // extends the snapshot with ANALYSIS at 'post-analyze', and asserts all three
  // unchanged (+ every key present) at 'pre-assemble' — a genuine freeze: nothing
  // below writes ctx.features during emission any more (the DEMAND stratum that
  // used to live here — external/typedarray/set/map/closure/f16/clamped — moved
  // out to ctx.linkDemand, see its own doc a few lines down).
  //
  //   SESSION  — from opts, set once at reset(), stable for the whole compile:
  //     sso, blockingTimers
  //   PROGRAM  — prepare()'s universal per-node prescan, order-independent
  //     (settled by post-prepare regardless of where the triggering node sits):
  //     bigint, error, errorClasses, timers
  //   ANALYSIS — settled by the per-function analyze pass (post-analyze), exact-
  //     equality frozen like every other stratum, no exceptions. Currently no
  //     members: `typedView` — the one candidate — turned out to be DEMAND-
  //     shaped in practice (module/typedarray.js's view-constructing EMIT
  //     handlers keep flipping it false→true past post-analyze, not just
  //     analyze.js's static tracker) and was reclassified onto ctx.linkDemand
  //     (.work/research.md §FeaturePlan freeze). Kept as a named stratum for
  //     the next genuinely analyze-settled fact, not deleted.
  ctx.abi = makeAbi()

  ctx.features = {
    // SESSION
    sso: true,        // ≤4-ASCII string packing. Default on; flip off to A/B the heap-only path.
    blockingTimers: false,   // wasmtime CLI: include __timer_loop in _start

    // PROGRAM
    bigint: false,    // BigInt construction anywhere (tagged literal / BigInt() call — prep()'s
                      // scan). Gates ir.js toNumF64's carrier check. MUST be seeded, not an
                      // absent key: the self-hosted kernel's absent-dyn-key read misfired
                      // truthy, turning the carrier gate ON for pure-number programs and
                      // exporting subnormals as bigint carriers (-5e-324 → -1, data.js pins).
    error: false,     // A jz Error/TypeError/…/EvalError value ever gets constructed
                      // (`new X(...)` or bare `X(...)`, any of the 7 built-in classes)
                      // anywhere in the program — prep()'s universal per-node scan sets
                      // it, same order-independence reason as `bigint` above (a template
                      // literal stringifying a caught Error can textually precede the
                      // `new Error(...)` site that proves an Error schema exists at all).
                      // Gates src/ir.js toStrI64's Error-schema arm: false everywhere in
                      // an Error-free program, so it costs nothing there.
    errorClasses: null, // Set<className> — WHICH of the 7 built-in classes are actually
                      // constructed somewhere in the program (same prep() scan as `error`
                      // above, populated alongside it). Lets `instanceof`'s base-'Error'
                      // OR-chain (src/compile/emit.js) and toStrI64's Error-schema arm
                      // (src/ir.js) iterate only classes that can ever exist at runtime —
                      // a never-constructed class's `instanceof` folds to compile-time
                      // `false` and never mints/bakes a schema id for it (audit-#9 P0-2
                      // per-class-sid brand redesign).
    timers: false,          // Set by prepare.js when timer module is included

    // ANALYSIS — currently no members, see the stratum doc above ctx.abi.
  }

  // linkDemand: the DEMAND stratum of the frozen FeaturePlan (.work/research.md
  // §FeaturePlan freeze, audit-#14 item 3 refinement) — reachability facts
  // EMISSION discovers ("this program's output will need EXTERNAL dispatch /
  // a typed-array kind / Set / Map / closures / f16 / clamped stores"), as
  // opposed to ctx.features' facts, which are all settled before/at analyze.
  // Monotone false→true, written across emission (src/compile/emit.js,
  // emit-assign.js, module/{typedarray,function,core,collection}.js — the
  // `new Set()`/`new Map()`/typed-array-ctor/EXTERNAL-dispatch/closure-table
  // sites). Read ONLY at resolveIncludes()+ (module template factories +
  // deps-graph lambdas, e.g. module/collection.js's `ifExt`) and assemble —
  // never at emit time, so a DEMAND flag flipping mid-emission is safe by
  // construction: nothing has consulted it yet. Every key MUST be seeded
  // (the same absent-key hazard as ctx.features — the self-hosted kernel's
  // absent-dyn-key read misfires truthy). `external` is the one flag actually
  // wired into an emission decision beyond template gating (it also gates the
  // `host: 'wasi'` legalization check in index.js); the typed-kind ones
  // (typedarray/set/map/closure/f16/clamped) are today usage-gated organically
  // by inc()/stdlibDeps and mostly save bytes by eliding dead branches in the
  // stdlib templates that read them (module/collection.js's EXTERNAL-arm
  // elision is the canonical example).
  //
  // `typedView` (reclassified from ctx.features' ANALYSIS stratum, .work/
  // research.md §FeaturePlan freeze): written by analyze.js's static `.view`-
  // ctor tracker (mid-analyze, ANALYSIS-shaped) AND by module/typedarray.js's
  // view-constructing EMIT handlers (`new.*`'s buffer-reinterpret/unknown-arg
  // branches, `.typed:subarray` — genuinely DEMAND-shaped, only known once
  // emission walks those call sites, past post-analyze). Its one reader,
  // optimize/vectorize.js's SLP store-pairing bail, runs inside optimizeModule
  // — PHASE ORDERING VERIFIED: compile/index.js emits every function AND
  // closure body (emitFuncs/emitClosures/buildStartFn, the only writers) all
  // complete before assertCtxInvariants('pre-assemble'), which itself precedes
  // both pullStdlib(resolveIncludes) and optimizeModule. So the SLP read is
  // not just within resolveIncludes()+, it is later than resolveIncludes()
  // itself — safe by the same "nothing has consulted it yet" construction as
  // every other DEMAND key.
  ctx.linkDemand = {
    external: false,  // PTR.EXTERNAL possible — opts.imports, HOST_GLOBALS, or __ext_call site.
    typedarray: false,// Float64Array/Int32Array/etc. Set on typed-array construction; gates PTR.TYPED dispatch.
    set: false,       // Set. Set on Set construction; gates PTR.SET dispatch.
    map: false,       // Map. Set on Map construction; gates PTR.MAP dispatch.
    closure: false,   // First-class functions. Set when ctx.closure.table is populated.
    f16: false,       // Float16Array construction anywhere.
    clamped: false,   // Uint8ClampedArray construction anywhere.
    typedView: false, // A typed-array VIEW (subarray / buffer-reinterpret / unknown-arg ctor
                      // that may zero-copy) exists somewhere in the program — set by
                      // analyze.js's typed tracker (`c.endsWith('.view')`) and by
                      // module/typedarray.js's view-constructing emit handlers. Read by
                      // the SLP vectorizer (optimize/vectorize.js) to bail on cross-base
                      // pairing when any view could alias. See the phase-ordering note
                      // above this object.
  }

  // ctx.plans — session-owned plan store (architecture re-audit item 3, .work/
  // todo.md): the pre-emission frozen-fact WeakMaps (src/compile/
  // closure-plan.js's ClosureEnvPlan records, src/compile/loop-model.js's
  // LoopPlan records, src/ir.js's WAT-side loopPlanLink records) used to be
  // three separate module-scope `let` bindings, each independently reassigned
  // to a fresh WeakMap by its own resetX() hook registered on RESET_HOOKS
  // (registerResetHook) — the audit-#19 P0 session-ownership fix applied three
  // times over, once per original map, because self-hosting lowers WeakMap to a strong
  // Map (no native GC), so a module-global map would let entries from a PRIOR
  // compile() survive into the next one. Folded into ONE ctx subtree here,
  // rebuilt directly by reset() every session — the SAME idiom ctx.features/
  // ctx.linkDemand already use just above (a plain object assigned fresh every
  // reset(), no hook-array indirection) — for state whose owning modules have
  // no reason to keep their own private reset plumbing once reset() can just
  // hand them a fresh subtree directly. Consumers (module/function.js's
  // ctx.closure.make, src/compile/emit.js's loop/closure-plan reads,
  // src/optimize/vectorize.js's loopPlanLink read) read ctx.plans.* — no
  // import-time WeakMap binding to go stale.
  ctx.plans = {
    functions: new WeakMap(),     // src/compile/function-plan.js, keyed on prepared function record
    closures: new WeakMap(),      // src/compile/closure-plan.js mintClosureEnvPlans, keyed on closure body node
    loops: new WeakMap(),         // src/compile/loop-model.js mintLoopPlans, keyed on loop body node
    loweringLinks: new WeakMap(), // src/ir.js, keyed on the WAT loop-block node — { plan, lowering }
  }

  // Single reset choreography (see RESET_HOOKS' doc above): every subsystem that
  // keeps module-scope working state outside ctx for perf clears it HERE, driven
  // by the one seam every entry point already calls.
  for (const hook of RESET_HOOKS) hook()
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
 *                        Also snapshots ctx.features' SESSION+PROGRAM strata
 *                        (FeaturePlan freeze, .work/research.md) for the
 *                        post-analyze/pre-assemble drift check below.
 *   - `pre-emit`       : func.current set; locals Map present — the per-
 *                        function-frame boundary right where `repsFrozen`
 *                        flips true (audit-#11: documented since 4b149108,
 *                        wired at every body-emission entry that sets it —
 *                        compile/index.js emitFunc's block/multi/expression
 *                        paths and emitClosureBody's block/expression paths,
 *                        wat/assemble.js buildStartFn's per-moduleInit and
 *                        main __start body). Unordered w.r.t. PHASE_ORDER —
 *                        fires once per function frame, not once per compile.
 *   - `post-analyze`   : extends the post-prepare snapshot with ctx.features'
 *                        ANALYSIS stratum (currently empty — see the stratum
 *                        doc above ctx.abi) — fired once per compile, right
 *                        after the per-function analyze passes settle and
 *                        before any function emits. Unordered w.r.t. PHASE_ORDER
 *                        (like pre-emit): asserted host- and self-host-uniformly
 *                        from inside compile/index.js's compile(), independent
 *                        of whether the caller ever reaches 'post-prepare'.
 *   - `pre-assemble`   : asserts every SESSION+PROGRAM+ANALYSIS key is present
 *                        AND unchanged since its post-prepare/post-analyze
 *                        snapshot — the frozen FeaturePlan facts must not drift
 *                        during emission. Fired once per compile, right before
 *                        resolveIncludes()/pullStdlib start reading the DEMAND
 *                        stratum. Unordered w.r.t. PHASE_ORDER, same reason.
 *   - `post-compile`   : no transient temps leaked (func.uniq stable across calls). */

// Hot per-node pass flags flattened to ONE i32 bitmask (ctx.transform.optFlags,
// set beside `optimize` at compile setup). Emit-path sites test a fixed-schema
// integer slot instead of a property read on the ~84-key resolved cfg — on the
// self-host kernel the cfg is a spread-built dictionary, so each per-node
// `cfg?.flag` read was a HASH probe; the same read is slot-cheap on V8, and
// that asymmetry alone moved the warm self-host ratio. Lives here (not
// optimize/index.js) so ir.js/module consumers stay cycle-free.
// WIDE_BIGINT / HOST_PROFILE.wideBigint (audit P0-2, removed): used to gate pre-eval's
// rational carry and emitNeg's literal-negation path on whether the ENGINE RUNNING THE
// COMPILER had arbitrary-precision BigInt — false under self-host, where the kernel's
// BigInt is a wrapping i64 carrier. Both consumers are now host-independent (bignum.js
// u32-limb arithmetic for the rational carry; a structurally-tagged bigint-literal AST
// node, not a magnitude probe, for emitNeg — see parse.js), so the capability gate has
// no reader left; removed rather than kept as an unread flag.

/** CompilerHostProfile (stage-4 seed): capabilities of the ENGINE RUNNING THE
 *  COMPILER, probed once at load. Consumers branch on named capabilities, not
 *  scattered environment probes — new host-capability gates land HERE. (The
 *  OUTPUT target's profile — host:'wasi'|'js' legalization — is a separate,
 *  future TargetProfile; do not conflate the two.) Currently empty — no named
 *  capability gate needs a host probe right now; keep the seed for the next one.
 */
export const HOST_PROFILE = Object.freeze({})

// Hot per-node pass flags come from THE registry (src/passes.js — zero imports,
// so this direction is cycle-free too): one list generates both the bitmask
// constants and the cfg→mask mapping, and the registry-membership assert in
// optimize/index.js covers the same source of truth.
export const OPTF = Object.freeze(Object.fromEntries(HOT_PASSES.map((n, i) => [n, 1 << i])))
export const optFlagsOf = (cfg) => {
  if (!cfg) return 0
  let m = 0
  for (const n of HOT_PASSES) if (cfg[n]) m |= OPTF[n]
  return m
}

export const DBG_INVARIANTS = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'

// Carrier program (.work/carrier-representation-design.md). FLIPPED ON BY
// DEFAULT (§34: FLIP-READY verdict, every §15-§34 blocker closed — carrier
// test:wasm fully green, kernel-parity/kernel-oracle agree with native under
// the flag, fuzz zero-divergence, default-battery delta scoped to the one
// pre-pinned audit-#16 row). The BigInt tagged-pointer box (PTR.BIGINT) is
// now the standard representation; `JZ_CARRIER_BOX=0` is the escape-hatch
// opt-OUT back to the legacy raw-i64-in-f64-slot carrier, kept for A/B and
// as a rollback lever, not because the boxed path is in doubt.
export const CARRIER_BOX = typeof process === 'undefined' || process.env?.JZ_CARRIER_BOX !== '0'

// Session wave W1 (stage 4): the lifecycle table above is an executable,
// ORDERED contract — each named phase must follow its predecessor within one
// compile session ('pre-emit', 'post-analyze', 'pre-assemble' are unordered:
// 'pre-emit' is a per-function interleave; 'post-analyze'/'pre-assemble' fire
// from inside compile/index.js's compile() itself — host- and self-host-
// uniform — independent of whether the caller wired the optional
// 'post-prepare'/'post-compile' hooks around it (self.js does not today)).
// A skipped or repeated ORDERED phase is a pipeline-wiring bug caught here
// instead of as a distant stale-state failure.
const PHASE_ORDER = ['post-reset', 'post-prepare', 'post-compile']

// FeaturePlan freeze (.work/research.md §FeaturePlan freeze): ctx.features'
// SESSION+PROGRAM+ANALYSIS strata must not drift after their settling phase.
// Snapshotted at 'post-prepare' (SESSION+PROGRAM, when wired) and extended at
// 'post-analyze' (+ANALYSIS, always); compared at 'pre-assemble'. Module-scope
// (not on ctx) — reset() doesn't own it, 'post-reset' clears it below so a
// stale snapshot from a PRIOR compile in the same warm process (self.js
// compiles many modules per process) can never leak into this one's check.
const FEATURE_STRATA = {
  SESSION: ['sso', 'blockingTimers'],
  PROGRAM: ['bigint', 'error', 'errorClasses', 'timers'],
  ANALYSIS: [], // no members — typedView reclassified to ctx.linkDemand (DEMAND-shaped
                // in practice); kept as a named stratum for the next genuinely
                // analyze-settled fact.
}
let _featureSnapshot = null
let _postAnalyze = false // true once 'post-analyze' has fired for the current compile
const snapFeatureVal = (v) => v instanceof Set ? [...v].sort() : v
const snapFeatureEq = (a, b) => Array.isArray(a)
  ? Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  : a === b
const snapshotFeatures = (keys, into) => { for (const k of keys) into[k] = snapFeatureVal(ctx.features[k]); return into }

/** Emission-time write tripwire for ctx.features (.work/research.md §FeaturePlan
 *  freeze, Slice 2): every writer of a SESSION/PROGRAM/ANALYSIS key routes through
 *  here instead of assigning directly, so a write that lands after 'post-analyze'
 *  throws AT THE CALL SITE under JZ_DEBUG_INVARIANTS — naming the offending write
 *  instead of leaving the drift to surface generically at 'pre-assemble' (Slice 1's
 *  snapshot compare). Uniform, no exceptions: `typedView` — the one key that used
 *  to need a carve-out here, because it kept flipping false→true during emission —
 *  moved to ctx.linkDemand (DEMAND-shaped in practice), so every remaining
 *  ctx.features key really is frozen the instant post-analyze fires. */
export function setFeature(key, value) {
  if (DBG_INVARIANTS && _postAnalyze)
    throw new Error(`[ctx invariant] ctx.features.${key} written after post-analyze — frozen FeaturePlan facts must not change during emission (DEMAND writes belong on ctx.linkDemand)`)
  ctx.features[key] = value
}

let _preAssemble = false // true once 'pre-assemble' has fired for the current compile

/** Emission-time write tripwire for ctx.linkDemand (session survey audit-#13
 *  slice b), mirroring setFeature() exactly — the DEMAND stratum's own freeze
 *  point is 'pre-assemble', not 'post-analyze' (see ctx.linkDemand's own doc
 *  above reset(): every writer — emit, emit-assign, analyze's typed tracker,
 *  the module/* emit handlers — completes before assertCtxInvariants('pre-
 *  assemble'), which itself precedes resolveIncludes()/pullStdlib and
 *  optimizeModule, the DEMAND stratum's only readers). Monotone false→true by
 *  construction (every call site sets `true`; no caller ever needs to unset a
 *  flag), so there is no value param — a write past 'pre-assemble' would mean
 *  a reader has already started consuming a DEMAND fact that's about to change
 *  under it, the same "frozen facts drifting during emission" hazard
 *  setFeature's post-analyze freeze guards, one phase boundary later. */
export function setLinkDemand(key) {
  if (DBG_INVARIANTS && _preAssemble)
    throw new Error(`[ctx invariant] ctx.linkDemand.${key} written after pre-assemble — DEMAND facts must be settled before resolveIncludes()/assemble read them`)
  ctx.linkDemand[key] = true
}

export function assertCtxInvariants(phase) {
  if (!DBG_INVARIANTS) return
  const fail = msg => { throw new Error(`[ctx invariant] ${phase}: ${msg}`) }
  const must = (cond, msg) => { if (!cond) fail(msg) }
  const po = PHASE_ORDER.indexOf(phase)
  if (po >= 0) {
    if (po > 0) must(ctx.transform.sessionPhase === PHASE_ORDER[po - 1],
      `phase out of order (previous: '${ctx.transform.sessionPhase}', expected '${PHASE_ORDER[po - 1]}')`)
    ctx.transform.sessionPhase = phase
  }

  must(ctx.core && ctx.module && ctx.scope && ctx.funcs && ctx.func && ctx.transform && ctx.features && ctx.linkDemand && ctx.plans,
       'sub-contexts present')
  if (phase !== 'pre-reset') {
    must(ctx.core.includes instanceof Set, 'core.includes is Set')
    must(ctx.core.emit && typeof ctx.core.emit === 'object', 'core.emit table')
    must(Array.isArray(ctx.funcs.list), 'funcs.list array')
    must(ctx.funcs.names instanceof Set, 'funcs.names Set')
    must(ctx.funcs.map instanceof Map, 'funcs.map Map')
    must(ctx.funcs.multiProp instanceof Set, 'funcs.multiProp Set')
    must(ctx.func.locals instanceof Map, 'func.locals Map')
    must(ctx.func.refinements instanceof Map, 'func.refinements Map')
  }
  if (phase === 'pre-emit') {
    must(ctx.func.current, 'func.current set before emit')
    must(ctx.func.locals.size != null, 'locals open for writes')
  }
  if (phase === 'post-compile')
    must(isInactiveFunction(ctx), 'active function record restored after analysis/emission')

  // FeaturePlan freeze snapshot/compare (see FEATURE_STRATA above). Uniform exact
  // equality across every stratum, no exceptions — SESSION+PROGRAM are genuinely
  // settled by post-prepare (their only writers are prepare/index.js's per-node
  // scan and autoload.js, both mid-prepare); ANALYSIS is currently empty (its one
  // former member, typedView, turned out to be DEMAND-shaped — module/typedarray.js's
  // view-constructing EMIT handlers kept flipping it past post-analyze — and was
  // reclassified onto ctx.linkDemand, .work/research.md §FeaturePlan freeze).
  if (phase === 'post-reset') { _featureSnapshot = null; _postAnalyze = false; _preAssemble = false }
  if (phase === 'post-prepare') _featureSnapshot = snapshotFeatures([...FEATURE_STRATA.SESSION, ...FEATURE_STRATA.PROGRAM], {})
  if (phase === 'post-analyze') { snapshotFeatures(FEATURE_STRATA.ANALYSIS, _featureSnapshot ??= {}); _postAnalyze = true }
  if (phase === 'pre-assemble') {
    _preAssemble = true
    for (const k of [...FEATURE_STRATA.SESSION, ...FEATURE_STRATA.PROGRAM, ...FEATURE_STRATA.ANALYSIS]) {
      must(k in ctx.features, `ctx.features.${k} missing — every FeaturePlan key must be seeded, not an absent key`)
      if (_featureSnapshot && k in _featureSnapshot)
        must(snapFeatureEq(_featureSnapshot[k], snapFeatureVal(ctx.features[k])),
          `ctx.features.${k} drifted after its settling phase — frozen FeaturePlan facts must not change during emission`)
    }
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

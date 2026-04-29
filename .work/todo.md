# jz Todo

Last cleaned: Apr 27 2026.

This file is the active roadmap only. Historical benchmark notes, completed phase logs,
old line-number anchors, and stale implementation claims were removed because they made
the next task harder to choose. Verify benchmark claims before using them for decisions.

Current verified baseline:

- `npm test`: 935/935 pass on Apr 28 2026.
- Compiler shape: `compile.js` split into ten named phases with docstring contracts;
  compile() body is a flat pipeline (~300 lines of orchestration).
- Main risk: representation facts are still scattered across ctx maps, IR `.type` sidecars,
  schema state, pointer annotations, and ad hoc inference (see ValueRep unification).

## Guiding Questions

- What decision makes the implementation simpler, not just faster?
- Which feature pulls generic runtime machinery into otherwise simple programs?
- Where are we recovering facts locally that should have been known once globally?
- Can the source constraint be tightened instead of adding another optimizer pass?

## Active Priorities

Architecture first. More peepholes will not fix the main complexity. The compiler needs
a cleaner substrate before pointer ABI or closure dispatch work.

### Tier S — Substrate

* [x] **ProgramFacts pass** — Apr 27. `walkFacts` (compile.js) now does one whole-program
  walk over ast + user funcs + moduleInits, collecting `dynVars/anyDyn`, `propMap`,
  `valueUsed`, closure arity (`maxDef/maxCall/hasRest/hasSpread`), and raw `callSites`
  for the type/schema fixpoint. The fixpoint no longer re-walks the AST — it iterates
  the captured call-site list. Three walks → one walk; bundled into a single
  `programFacts` object. 912/912 PASS. Compile time on watr self-host ~72 ms → ~47 ms
  median (≈35% reduction). Remaining: representation state still leaks via
  `ctx.types.dynKeyVars/anyDynKey` (read by `ir.js` at emit). Will be lifted when emit
  takes facts explicitly (paired with phase split S3).

* [x] **ValueRep unification** — replaced the spread of `.type`, `ctx.func.valTypes`,
  `ptrKind`, `ptrAux`, `schema.vars` (local-key portion), `globalTypes`, and local
  inference with one record: `{ val, ptrKind, ptrAux, schemaId, … }` stored at
  `ctx.func.repByLocal: Map<name, ValueRep>` (per-function, auto-resets) and
  `ctx.scope.repByGlobal: Map<name, ValueRep>` (module-level). Helpers `repOf` /
  `repOfGlobal` / `updateRep` / `updateGlobalRep` are the canonical access pattern.
  Apr 28 — landed in four stages (S2a–d), each preserving 923/923 + goldens +
  watr metacircular byte-parity. `wasm`, `nullable`, `stableOffset` not yet tracked.

  Staged plan (a full single-pass refactor would touch ~80+ sites; doing it
  in stages keeps each landable independently with byte-parity guarantee):

  * [x] **S2a — collapse `ptrKinds`+`ptrAuxes` → `repByLocal`.** Apr 28.
    Introduced `ValueRep` record + `repOf(name)` / `updateRep(name, fields)` helpers
    in `analyze.js`. Two per-function maps (`ctx.func.ptrKinds`,
    `ctx.func.ptrAuxes`) replaced by one (`ctx.func.repByLocal:
    Map<name, ValueRep>`); 14 touch sites migrated across compile.js / emit.js /
    ir.js (readVar, writeVar, emitDecl, emitFunc unbox seed, param-narrowing
    seed). 923/923 PASS, all goldens unchanged (3306 / 6062 / 3921 / 1968),
    watr metacircular byte-parity holds across all 10 vendored examples.
  * [x] **S2b — collapse `unboxedTypedGlobals` → `repByGlobal`.** Apr 28.
    `ctx.scope.unboxedTypedGlobals` retired; pointer-rep facts for module-
    level globals now live in `ctx.scope.repByGlobal: Map<name, ValueRep>`
    via parallel helpers `repOfGlobal(name)` / `updateGlobalRep(name, fields)`.
    The TYPED-global path now stores `{ ptrKind: VAL.TYPED, ptrAux }` instead
    of a hardcoded VAL.TYPED at the read site, generalizing to any unboxed
    pointer-kind global (room for unboxed CLOSURE / OBJECT globals later).
    Four touch sites migrated (ctx.js, compile.js writer, emit.js global
    init, ir.js readVar global branch). 923/923 PASS, all goldens
    byte-identical, watr metacircular byte-parity holds.
  * [x] **S2c — collapse `ctx.func.valTypes` → `repByLocal.val`.** Apr 28.
    `ctx.func.valTypes` retired; per-local value-type facts now live in
    `repByLocal.val`. `lookupValType` consolidated to `repOf(name)?.val`
    with global fallback; `analyzeValTypes` rewritten with `setVal/getVal`
    helpers. `updateRep` now drops empty entries (undefined-as-delete +
    empty-rep cleanup) so the map stays sparse. ~14 touch sites migrated
    across analyze.js, compile.js (param seeding, closure-body seed,
    buildStartFn reset), emit.js (spread propagation), ctx.js (drop
    field), and module/ (array.js, core.js, object.js readers/writers).
    repOf/updateRep re-exported through compile.js for module/* imports.
    923/923 PASS, all goldens byte-identical (3306 / 6062 / 3921 / 1968),
    watr metacircular byte-parity holds.
  * [x] **S2d — collapse `ctx.schema.vars` (local-key portion) → `repByLocal.schemaId`.** Apr 28.
    Per-name schema bindings for function-local names now live in
    `repByLocal.schemaId`. Dual-write pattern at every emit-time write
    site (compile.js paramSchemas seed, emit.js decl ptrAux mirror,
    analyze.js auto-box localProps register, module/object.js Object.assign
    target, closure body `cb.schemaVars` seed). All emit-time readers
    prefer `repOf(name)?.schemaId` and fall back to `ctx.schema.vars` only
    for names missing from rep (covers prepare-time + module-level
    bindings still resident there). Migrated readers: ir.js readVar
    fallback chain, emit.js auto-box reader, module/object.js merged
    target, module/function.js capture snapshot, module/schema.js
    `resolve` / `isBoxed` / `find`. `ctx.schema.vars` retained as
    backward-compat backing store and module-level/prepare-time storage —
    full removal would require splitting prepare.js scope-tracking and is
    deferred. The IR-sidecar `.type`, `ctx.func.boxed`, and
    `ctx.func.refinements` decided to stay separate (not per-name facts):
    `.type` is per-emitted-node, `boxed` carries a storage cell name,
    `refinements` is a flow-sensitive overlay. 923/923 PASS, all goldens
    byte-identical, watr metacircular byte-parity holds.

* [x] **Explicit compile pipeline** — split `compile.js` by phase:
  `facts -> specialize signatures -> emit funcs -> emit start -> assemble module -> optimize module`.
  Each phase should have an input/output contract. Ordering should be encoded structurally,
  not remembered through comments.
  Apr 27 — four phases extracted as top-level functions with docstring
  contracts: `collectProgramFacts(ast)` → programFacts record;
  `narrowSignatures(programFacts)` → mutates func.sig records;
  `emitFunc(func, programFacts)` → returns one func's WAT IR;
  `emitClosureBody(cb)` → returns one closure-body's WAT IR (parallel
  to emitFunc, used by incremental `compilePendingClosures`). Inline
  blocks at the call sites collapsed to single calls; per-function emit
  no longer captures outer closure state. compile() body shrunk from
  one ~1300-line blob (1529 → 1395 lines) to a sequence of named-phase
  calls. 922/922 PASS, golden sizes unchanged.
  Apr 27 (extension) — three additional tail phases extracted:
  `dedupClosureBodies(closureFuncs, sec)` → alpha-rename + structural
  hash dedup of closure bodies, redirect through elem table;
  `finalizeClosureTable(sec)` → drop dead $ftN/table/elem when no
  call_indirect remains, then per-body ABI shrink (drop unused
  $__env/$__argc/$__a{i} params and matching args);
  `stripStaticDataPrefix(sec)` → R-mode prefix-shift when __static_str
  unused. compile() tail blocks collapsed to single calls. 922/922 PASS,
  golden sizes unchanged.
  Apr 27 (continuation) — three more phases:
  `buildStartFn(ast, sec, closureFuncs, compilePendingClosures)` →
  reset per-fn state, emit moduleInits + ast, build boxInit/schemaInit
  /strPoolInit/typeofInit, assemble __start, flush late closures;
  `pullStdlib(sec)` → resolveIncludes, memory section, extStdlib +
  factory stdlibs;
  `optimizeModule(sec)` → ordered specializeMkptr → specializePtrBase
  → sortStrPoolByFreq → optimizeFunc per fn → hoistConstantPool +
  $__heap base bump.
  compile() body is now a flat sequence of named phase calls.
  922/922 PASS, golden sizes unchanged.
  Remaining: assembly tail (data/customs/exports/treeshake/sort) — a
  modest cleanup, not architectural.

* [x] **Strict core mode** — Apr 27. `compile(code, { strict: true })` and `jz(code, { strict: true })`
  now reject (with clear `strict mode: ...` errors): `obj[runtimeKey]` falling to `__dyn_get`
  (typed-array `buf[i]` still allowed, since it lowers to typed-element load), `for (… in …)`,
  and method calls on values of unknown type that would emit `__ext_call` or `__dyn_get_expr`.
  Default behavior unchanged (back-compat). Hooked at the actual stdlib-pull sites so static
  shapes pay nothing. 6 new tests in `test/errors.js` (3 reject + 3 accept). 922/922 PASS.
  Future work: surface strict in golden size tests once a representative dyn-heavy program
  is added (today's golden cases compile identically with/without strict).

* [x] **Golden size tests** — Apr 27. `test/perf.js` now snapshots WASM byte counts
  for known-shape object (3306 b), typed-array loop (1968 b), closure-heavy parser
  (4042 b post-A3, was 4084 b), unknown/dynamic object (6072 b); ±5% tolerance
  (min ±20 b). Existing scalar add `< 150` covers the trivial case. Catches
  accidental stdlib / feature-gate regressions; prerequisite for landing
  strict-core mode safely. 916/916 PASS at landing.

### Tier A — Runtime / Output Wins

* [ ] **Internal narrow ABI** — make internal non-exported calls use the narrowest proven
  representation. Exported boundaries keep the JS-compatible f64 NaN-box ABI; internal
  code should use i32 offsets/tags where proven safe.
  Apr 28 — first slice landed: narrow OBJECT result with constant `schemaId` carried in
  `sig.ptrAux` (commit 25010aa). Apr 28 — second slice: program-wide slot-type tracking
  (commit eb294e0). `collectProgramFacts` observes the value-kind of each static-key
  object literal slot and stores it on `ctx.schema.slotTypes`; `ctx.schema.slotVT(name,
  prop)` answers on the precise (bound-`schemaId`) path; `valTypeOf` consults it on
  `.prop` AST nodes so `+`, `===`, method dispatch elide `__is_str_key` runtime checks
  on monomorphic-numeric props of known shapes. `analyzeValTypes` propagates `schemaId`
  from a narrowed call return into the local's ValueRep. Structural-subtyping fallback
  intentionally off — without per-call-site flow inference, structural agreement on a
  slot would mistype non-object holders as VAL.NUMBER and grow the binary by routing
  property accesses through `__hash_get`. 935/935 tests pass; goldens unchanged
  (3306/6062/3921/1968); watr metacircular byte-parity holds at 149314 bytes; one
  `__is_str_key` call eliminated in watr metacircular (173 → 172).
  Apr 28 — third slice: TYPED narrowing. `narrowSignatures` now narrows
  helpers whose every return produces a TYPED with the same constant `elemAux`
  (Float64=7, Int32=4, etc.); `sig.results = ['i32']`, `sig.ptrAux = elemAux`.
  Caller-side dual-write was incorrectly mirroring TYPED/CLOSURE aux into
  `ctx.schema.vars` (treating it as schemaId) — split the dual-write so only
  OBJECT mirrors to schemaId, while `rep.ptrAux` is set unconditionally. New
  `analyze.js` helper `ctorFromElemAux` reverse-maps the aux through
  `ctx.types.typedElem` so `analyzePtrUnboxable` picks up the same aux on
  unboxed locals. Probe `let mk = () => new Float64Array([…]); export f = i =>
  { let a = mk(); return a[i] }`: 2614 → 807 b (-69%). Watr metacircular size
  unchanged (no narrowable typed returns there). 9 focused tests in
  `test/typed-narrow.js`; 966/966 PASS; goldens 3306/6036/3931/1968 unchanged;
  watr metacircular byte-parity holds. Future slices: i32 pointer-ABI for
  non-pointer-returning narrowed funcs; CLOSURE narrowing (blocked — funcIdx
  isn't determined until emit-time, requires sig-update after emit phase).

* [x] **Devirtualize non-escaping closures** — Apr 28 (gap-fill). The `directClosures`
  path already lowered const-bound, non-escaping closures to `call $bodyFn` (no
  call_indirect). Remaining waste: when watrOptimize's inliner inlines that body into
  the caller, the call-site's `asF64(local.get $g)` (rebox to f64 for body's
  `__env: f64`) immediately meets the body's `i32.wrap_i64(i64.reinterpret_f64 __env)`
  (unbox back to envPtr i32). Our `fusedRewrite` peephole folds exactly this pattern,
  but ran *before* watr's inline pass — so the inlined-output rebox roundtrip survived.
  Fix: run `optimizeFunc` once more after `watrOptimize` in `index.js`. Watr's own
  `peephole` table doesn't include reinterpret/wrap_i64+extend folds. Impact:
  • Trivial closure-call probe: 284 → 252 b (-32, 2 → 0 reboxes).
  • `let a = …; let b = …; a(1) + b(2)`: 345 → 313 b (-32).
  • Watr metacircular: 149559 → 149402 b (-157).
  949/949 PASS; goldens unchanged (3306 / 6062 / 3957 / 1968).

* [x] **CLOSURE local unboxing** — Apr 28. `VAL.CLOSURE` now in `UNBOXABLE_KINDS`.
  Closure NaN-box has [type=PTR.CLOSURE, aux=funcIdx, offset=envPtr]; unboxing to i32
  envPtr loses funcIdx, so `closure.make` now stamps `ir.closureFuncIdx = tableIdx` on
  the returned IR (alongside existing `ir.closureBodyName`), and `emitDecl`'s unbox path
  copies it into `repByLocal[name].ptrAux`. Result: `asF64(local.get $g)` reboxes via
  `boxPtrIR(localGet, PTR.CLOSURE, ptrAux)` reconstructing the correct call_indirect
  target on every escape (array store, fn-param, capture by inner arrow). Direct dispatch
  is unaffected — it bypasses the rebox via `directClosures`. 9 focused tests in
  `test/closure-unbox.js`, 949/949 PASS, all 4 goldens unchanged. Pre-existing bug:
  `o.fn(g)` (closure stored in object dispatched via `__dyn_get_expr` / `__ext_call`)
  hits `RuntimeError: table index is out of bounds` *with or without* unboxing; root
  cause not in this change — logged for follow-up.

* [x] **TYPED local unboxing extension — `.map` receiver** — Apr 28.
  `analyzePtrUnboxable.isFreshInit` now accepts `arr.map(fn)` for VAL.TYPED when
  `arr` is in `ctx.types.typedElem` (locally TYPED with a known elem ctor). Only
  `.typed:map` registers as TYPED-returning emitter; `.filter`/`.slice` fall back
  to ARRAY emit, so the `typedElem.has(src)` gate prevents accepting the
  polymorphic-receiver path. `propagateTyped` already mirrors src ctor onto the
  receiver, so the unbox path's `typedElemAux` lookup populates `rep.ptrAux`
  → static elem load (direct `f64.load`) on subsequent index access.
  Concretely:
  ```
  let mk = () => new Float64Array([1.5, 2.5, 3.5])
  export let f = (i) => { let a = mk(); let b = a.map(x => x + 10); return b[i] }
  ```
  Now `$a` AND `$b` are both `i32` locals; `b[i]` is one `f64.load` with
  shifted offset — no `__is_str_key`, no `__pt0` kind dispatch, no
  `__typed_idx` fallback. 4 regression tests in `test/typed-narrow.js` (added
  to the existing 9). 970/970 PASS, watr metacircular byte-identical, all 4
  goldens unchanged. `.subarray()` / typed `.filter` / `.slice` deferred —
  none currently registered as TYPED-returning emitters in `module/`; would
  require new emitters (out of scope for this slice).

* [x] **Known table-slot direct calls** — Apr 27. const-bound, non-escaping local closures
  now lower their call sites to `call $<bodyFn>` (same uniform `(env, argc, a0..)` ABI as
  the body, just skipping the `call_indirect` + `__ptr_aux` funcIdx extraction). Tagged at
  `closure.make`, registered in `ctx.func.directClosures` from `emitDecl` when the binding
  is non-boxed, non-global, and not reassigned in the function body. Also fixed
  `isReassigned` to not flag `let g = …` initialization as a write of `g`. Closure-heavy
  parser golden: 4084 → 4042 b. 922/922 PASS.
  Apr 27 (extension) — direct dispatch now propagates across capture boundaries:
  `closure.make` snapshots parent's `directClosures` for each capture (gated on
  `isReassigned(body, captureName)`), `emitClosureBody` seeds `ctx.func.directClosures`
  from the snapshot. Inner arrows can therefore direct-call captured const-bound
  closures instead of going through `call_indirect`. watr metacircular:
  21 → 34 of 66 closure calls direct (~52%, was ~32%); 153484 → 153220 b (-264 b).
  Closure-heavy parser golden: 4042 → 4022 b. 922/922 PASS.
  Apr 27 (cleanup) — drop dead `$ftN` type / table / elem when post-emit scan
  finds zero `call_indirect` (i.e. every closure call site direct-dispatched
  AND no top-level fn taken as value). Closure pointers still carry funcIdx
  in their NaN-box aux bits, but those bits become dead state with no reader.
  Closure-heavy parser golden: 4022 → 4005 b. 922/922 PASS.
  Apr 27 (per-body ABI shrink) — when no `call_indirect` remains, every
  closure body is direct-only, so the uniform `(env, argc, a0..a{W-1})`
  ABI is no longer required. Each body now sheds unused params:
  • `$__env` when captures.length === 0
  • `$__argc` when no rest param (defaults check the param value, not argc)
  • `$__a{i}` for i ≥ fixedN when no rest param
  Matching args are dropped at every `call`/`return_call` site. Rest-param
  closures keep all W slots (that's how rest packs). Closure-heavy parser
  golden: 4005 → 3933 b. Cumulative session win on parser fixture:
  4084 → 3933 b (-151 b, -3.7%). 922/922 PASS.

* [ ] **Head-offset `Array.shift`** — replace O(n) `memory.copy` shift with amortized O(1)
  head offset. High leverage, high touch surface: every array index/iteration path must
  account for the shifted base.

* [x] **Fast-path `Array.push`** — Apr 27. For known-ARRAY pushes, hoist `__ptr_offset`
  once and check `cap < len + N` inline; only call `__arr_grow` (and re-extract offset)
  on the slow path. Saves call dispatch + ~14 prologue ops per push when cap fits.
  Compile-time impact within noise (still ~47–50 ms median on watr self-host). 912/912 PASS.

### Tier B — Compiler-Itself

* [x] **Fuse per-function optimize passes** — Apr 27. `fusedRewrite` now piggybacks
  local-ref counting via an optional `counts` Map; `sortLocalsByUse` reuses the
  pre-computed counts and only does its own walk when called outside `optimizeFunc`
  (whole-module path). 3 walks per function → 2 walks. 912/912, 21/21 PASS.
  `hoistPtrType` stays separate — it must run first to introduce hoisted locals
  before `fusedRewrite` inlines `__ptr_type` body bits.

* [ ] **Structural hash for closure dedup** — replace clone + `JSON.stringify` with a
  single-walk structural hash only if measurement shows it beats V8's optimized stringify
  path. Previous ad hoc rewrites regressed.

* [x] **Cross-block pointer-type CSE** — Apr 27. `hoistPtrType` now walks structured AST
  tracking per-variable "alive" state with one open region per X. Splits on
  `local.set`/`local.tee`, intersects alive states across `if`/`else` arms (entry alive
  iff alive on both paths with same region ref), and conservatively clears at `loop`
  boundaries. One shared `$__ptN` local per X reused across regions; per-region
  threshold ≥2 (singletons skipped at commit). Goldens: unknown/dynamic 6072 → 6062
  (-10), closure-parser 3933 → 3921 (-12). 922/922 PASS.

* [x] **Elide `argc` for fixed closures** — Apr 27. Done as part of the per-body
  ABI shrink in the no-`call_indirect` path: when the table is dropped, every
  closure becomes direct-only, and bodies shed `$__env` (when no captures),
  `$__argc` (when no rest), and trailing `$__a{i}` slots beyond fixedN.
  Programs with at least one genuinely-indirect closure call still pay the
  uniform `$ftN` ABI — that's the cost of the call_indirect dispatch shape.

* [-] **Hot stdlib partial evaluation** — Apr 27 attempt rolled back. Wired `__dyn_get_h`
  / `__hash_get_h` / `__dyn_get_or_h` / `__dyn_get_expr_h` / `__dyn_get_any_h` variants
  taking precomputed `i32` hash; emitted FNV-1a in JS at literal-key call sites
  (`emitPropAccess`, `emit['?.']`, object-spread). Result: each literal-key call site
  grew by ~5 bytes (full 32-bit LEB128 const), helper body savings only ~3 bytes once;
  net **+5.1% on unknown/dynamic golden** (6072 → 6379, beyond ±5%) and **+0.7% on
  watr metacircular** (149305 → 150352). Runtime savings (skip `__str_hash` ≈ 100 ops
  per call) are real but unmeasured. Not worth the concrete code-size regression at
  current call-site cost. Reconsider when string interning lets the literal hash
  travel as a small index instead of a 32-bit constant.

## Product / Validation

* [ ] Pick one undeniable use case and optimize around it.
* [ ] Add benchmark coverage beyond internal examples: DSP kernel, typed-array processing,
  math loop, parser/string workload, and a JS-engine comparison set.
* [ ] Add warning/error behavior for memory growth failure or configured memory limits.
* [ ] Add wasm2c/w2c2 integration tests.
* [ ] Add source maps or at least function/name-section diagnostics.
* [ ] Continue metacircular path: minimal parser or jessie fork suitable for jz.

## Discovered Bugs

* [x] **Conditional with narrowed-OBJECT branches reboxes via numeric convert.**
  Apr 28 — fixed earlier; `?:` emit now propagates matching `ptrKind`/`ptrAux`
  so downstream `asF64` takes the NaN-rebox path. Regression coverage:
  `test/object-regressions.js` lines 61–122 (same-schema cases).

* [x] **Polymorphic `?:` with different-shape OBJECT schemas — `.prop` returns null.**
  Apr 28 — fixed (path (a)). `?:` emit now preserves per-arm `ptrAux` even when
  arms have different `schemaId`s, falling through to the f64 rebox path so each
  arm carries its own aux. `__dyn_get` gained an OBJECT-schema arm: reads receiver
  aux as schemaId, looks up `__schema_tbl[sid]` for the keys array, iterates and
  returns the matching slot. `__schema_tbl` declaration lifted into core (it was
  json-module-private) when any `__dyn_get*` family is used. Regression coverage:
  3 active tests in `test/object-regressions.js` (different-shape `.y`, different-
  shape `.x`, polymorphic TYPED arrays with distinct elemType bits).

* [x] **`o.fn(g)` — closure stored in object property fails dispatch.**
  Apr 28 — fixed in two parts.
  (1) Function-scope variant (was: `RuntimeError: table index is out of bounds`)
  fell out of the polymorphic `?:` + schema-aware `__dyn_get` fix above: receiver
  now carries the correct schemaId, dispatch resolves the slot, the stored closure
  has its funcIdx preserved through the f64 rebox.
  (2) Module-scope variant (was: compile-time `Unknown local $g`) had a separate
  root cause: `let g = (n) => …` at module level is extracted via `defFunc` into
  `ctx.func.list` (top-level function, not a closure literal). The arrow-handler's
  `includeMods('core', 'fn')` only fires at depth>0, so the fn module never loaded
  for purely top-level functions; `ctx.closure.table` stayed null; emit.js's
  func-as-value branch (line 1819) was gated on `ctx.closure.table` and fell
  through to the unconditional `(local.get $name)` fallback — bogus WAT.
  Fix: post-prep scan in `prepare.js` walks the prepared AST + every func body +
  moduleInits looking for top-level func names appearing in value positions
  (anything other than `()` callee or `.` property name). If found, includes the
  `fn` module so trampoline emission has its closure.table machinery. Regression:
  two active tests in `test/closure-unbox.js` (function-scope + module-scope).

## Deferred / No-Go

These are kept to prevent repeating bad work.

* [-] **Hoist `__ptr_offset` globally** — unsafe for ARRAY forwarding. The heap behind an
  unchanged local can move after mutation/reallocation.

* [-] **Naively inline `__ptr_type`, `__is_nullish`, or `__is_truthy` for size** — call sites
  are usually smaller than inline bit checks. Only hoist or specialize when repeated use
  amortizes the cost.

* [-] **Drop SSO for size** — short string literals are often cheaper as SSO constants than
  heap/data-segment strings plus construction.

* [-] **Rewrite upstream watr JS to push loops before fixing jz push** — previous source-level
  rewrites regressed because current spread paths are better optimized than push loops.

* [-] **Full unboxed pointer ABI now** — still promising, but too broad before ProgramFacts
  and ValueRep. Doing it now would scatter representation state further.

## Working Rule

When a task needs a stale fact from old notes, re-measure or re-read source first. Do not
optimize from memory. This compiler is small enough that wrong remembered details are more
dangerous than the cost of verification.


## Backlog

### Build & tooling

* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to derive() in ctx.js (1 function to replace)
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid (const.js)
* [x] Metacircularity: watr WASM validation — all 5 watr modules (util/const/encode/parse/compile) validate via wasm-validate. Repro: `node ~/projects/watr/.work/repro-jz-codegen-bug.mjs`.
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm correctly compiles all 21 examples (verified via /tmp/jz-c/watr-native). Required watr fix: `unbranch` opt at [watr/src/optimize.js:1394](../node_modules/watr/src/optimize.js#L1394) was stripping trailing `(br $loop_label)` from `loop` blocks (loop-back jump, not exit), making loops run once. Patched locally and upstream — gate on `op !== 'block'`.
* [ ] Metacircularity: subscript parser — needs jz-jessie fork excluding class/async/regex features + refactoring parse.js function-property assignments (~30 lines)
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling (modules option), host imports (imports option)
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via { imports: { mod: { fn } } }
* [x] Shared memory — { memory } option, cross-module pointer sharing
* [ ] Source maps — blocked on watr upstream; can add WASM name section (function names) independently
* [x] Memory: configurable pages via { memoryPages: N }, auto-grow in __alloc, trap on grow failure
* [x] Template tag
* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices
* [ ] swappable watr: likely AST will need to be stringified before compile if adapter is provided?

## Phase 14: Internal Parser (Future)
* [ ] Extract minimal jz parser from subscript features
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap


### Validation & quality

* [ ] color-space converter (validates multi profile)
* [ ] digital-filter biquad (validates memory profile)
* [ ] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs — compile time + runtime
* [ ] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)
* [ ] test262 basics
* [ ] Warn/error on hitting memory limits
* [ ] Excellent WASM output
* [ ] wasm2c / w2c2 integration test

### Future

* [ ] metacircularity (jz compiling jz)
* [ ] Component interface (wit)
* [ ] threads/atomics (SharedArrayBuffer, Worker coordination)
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders

## Offering

* [ ] Clear, fully transparent and understood codebase
* [ ] Completed: docs, readme, code, tests, repl
* [ ] Integrations (floatbeat, color-space, digital-filter)
* [ ] Benchmarks
* [ ] Pick ONE use case, make jz undeniable for it
* [ ] Ship something someone uses

## Floatbeat playground

* [ ] Syntax highlighter
* [ ] Waveform renderer
* [ ] Database + recipe book
* [ ] Samples collection

## REPL

* [ ] Auto-convert var→let, function→arrow on paste
* [ ] Auto-import implicit globals
* [ ] Show produced WAT
* [ ] Document interop

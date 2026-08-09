# CompileSession phase-views survey (audit-#13 critical-path item 6 / Stage 4)

READ-ONLY inventory for the coordinator to design FROM. No design decisions here —
counts, ownership, blockers, constraints, and ranked candidates only. FINDINGs are
flagged inline. Method: `mcp__fff__grep`/direct `grep` census over every file
importing `src/ctx.js` (src/ + module/ + jzify/ + root, test/ and scripts/
excluded per scope), classified by import shape (bare `ctx` object vs. free
functions vs. default-export DI parameter) and by `ctx.<subtree>` read/write
occurrence (assignment / `.push,.set,.add,.delete,.clear,.splice`/compound-assign
= write; everything else = read). Regex-based, so treat counts as ±low-single-
digits per file, exact for aggregate shape.

## 0. Pipeline phases (ground truth, from index.js's own docstring + session.js)

```
source ──parse──▶ raw AST ──jzify──▶ desugared AST ──prepare──▶ prepared AST
  (ctx.func.list / ctx.module.imports / ctx.schema.list populated)
        ──compile──▶ WAT IR   (per-function: analyze ⇄ narrow ⇄ emit interleaved,
                                then src/wat/assemble.js's optimizeModule = the
                                one jz-side optimizer pass, incl. vectorize)
        ──resolveIncludes (ctx.js, called from wat/assemble.js/index.js)──▶
        ──assemble (wat/assemble.js buildStartFn etc.)──▶
        ──watOptimize (watr, external, the SOLE final optimizer)──▶
        ──watrPrint/watrCompile──▶ WAT text / wasm bytes
        ──interop.js (host marshaling, instantiate)──▶ running program
```
`interop.js` imports **zero** ctx.js symbols (confirmed by grep) — it runs
entirely off `layout.js`/`err-codes.js` compiler-free constants, post-compile.
Already a clean phase boundary; no session-shape change touches it.
`src/resolve.js` (module-graph resolution) is likewise ctx-free.
`src/session.js`'s `beginSession()` is the existing partial CompileSession seam
(see §5) — reset + explicit-lifecycle cache clears + TargetProfile + optFlags.

## 1. ctx importer census

**61 files** import something from `src/ctx.js` (src/+module/+jzify/+root,
excluding ctx.js itself and test/scripts/). Of those:

- **42 files bare-import the `ctx` object itself** (`import { ctx, ... } from
  '.../ctx.js'`) — 35 in `src/`, 1 root (`index.js`), 6 in `module/`
  (core.js, object.js, array.js, string.js, regex.js, collection.js).
- **16 `module/*.js` files never import `ctx` from ctx.js at all** — they
  receive it as the **parameter of their default export**, `export default
  (ctx) => { ... }` (number, typedarray, simd, timer, symbol, web, console,
  atomics, math, schema, function, date, json, navigator, crypto, fs). At
  runtime it is always the same global singleton (index.js's `setupCtx` calls
  every module's default export once, passing `ctx`), but the **call-site
  shape already accepts an injected object** — a real precedent for threading
  a phase-scoped view through unchanged call sites (§5).
- **3 files touch ctx.js only for its free-standing helper exports**, never
  the `ctx` object: `src/front.js` (`err` only — the two `ctx.func`/
  `ctx.transform` mentions in its source are prose comments, not code, a
  regex false positive I verified and excluded), `jzify/classes.js` (`err`
  only), `transform.js` (`initWarnings`, `warn` only).

FINDING: **audit's "~43 ctx importers" ≈ confirmed** — my bare-`ctx`-object
count is 42, one below the audit's figure; either a single file drifted
in/out since the audit snapshot (`compile/erasure-diag.js`, `loop-model.js`,
`dyn-closure-tables.js` all landed/changed post-audit-#13 per .work/research.md
§BodyModel) or the audit counted `module/core.js`'s bare import + DI-param
pattern as 2. Not worth chasing further — the number is stable to within 1.

### Per-file subtree touch matrix (R=read-sites, W=write-sites, regex census)

Phase tag: **prep**=prepare/jzify, **an**=analyze/program-facts, **pl**=plan
(compile/plan/*, a sub-phase inside compile per ctx.js's own "plan-phase
writers" note), **nar**=narrow, **em**=emit (incl. ir/kind/type/reps/static —
cross-phase utility reads), **opt**=optimize (pre-watr, inside emit), **asm**=
assemble/resolveIncludes, **reg**=module registration (DI param, init-time
install of ctx.core.emit handlers — separate from the SAME file's emit-time
handler bodies, which are **em**), **sess**=session/reset, **orch**=root
orchestrator (spans all).

```
FILE                                    PHASE  SUBTREE:R/W…
src/helper-counters.js                  em     core:R0/W1 scope:R1 transform:R5
src/type.js                             em     scope:R10 func:R29/W9 types:R20/W1 schema:R1
src/optimize/index.js                   opt    core:R1 scope:R10 func:R2 types:R7 schema:R1 abi:R1
src/optimize/vectorize.js               opt    linkDemand:R2
src/ir.js                               em     core:R7 module:R3 scope:R7 func:R39/W4 types:R3 schema:R13 closure:R3 runtime:R6/W7 transform:R3/W1 features:R7 abi:R9
src/prepare/index.js                    prep   core:R15 module:R43/W13 scope:R82/W17 func:R46/W32 schema:R37/W10 closure:R3 runtime:R1 error:R0/W1 transform:R21 features:R3(via setFeature)
src/prepare/pre-eval.js                 prep   core:R1 func:R4 transform:R1
src/bridge.js                           em     core:R6 module:R1/W1 bridge:R8
src/session.js                          sess   func:R1 types:R1 schema:R1 error:R0/W1 transform:R6/W5
src/kind.js                             em     scope:R11 func:R26 types:R9 schema:R11 closure:R3 inspect:R1
src/front.js                            prep   (no ctx object — err only)
src/compile/dyn-closure-tables.js       an     module:R4 scope:R20/W1 func:R8
src/compile/flow-types.js               an     module:R2 func:R12/W2 schema:R16 closure:R2
src/compile/loop-model.js               em     transform:R0/W1
src/compile/plan/literals.js            pl     module:R1 func:R9/W5 transform:R3
src/compile/plan/advise.js              pl     scope:R2 func:R5 transform:R4 warnings:R4
src/compile/plan/index.js               pl     scope:R1 types:R1/W7
src/compile/plan/inline.js              pl     func:R10/W6 transform:R1
src/compile/plan/scope.js               pl     module:R15 scope:R43 func:R27/W6 types:R3 schema:R14/W5 closure:R3/W1 warnings:R1
src/compile/plan/common.js              pl     transform:R3
src/compile/plan/loops.js               pl     func:R3/W4 transform:R1
src/compile/erasure-diag.js             em     func:R4
src/compile/narrow.js                   nar    module:R3 scope:R16 func:R71/W31 types:R7/W5 schema:R6 closure:R1 transform:R3 warnings:R1
src/compile/index.js                    orch   core:R10 module:R4/W1 scope:R32/W4 func:R92/W91 types:R19/W17 schema:R17/W4 closure:R12 runtime:R18/W4 memory:R3 transform:R14/W1 features:R2 linkDemand:R1 inspect:R3/W1
src/compile/analyze-scans.js            an     func:R15/W1
src/compile/emit.js                     em     core:R47/W2 module:R8 scope:R20 func:R163/W111 types:R16/W9 schema:R20/W2 closure:R39/W2 runtime:R1/W8 error:R0/W2 transform:R20 features:R10 linkDemand:R0/W3 abi:R13 bridge:R1
src/compile/analyze.js                  an     module:R3 scope:R12 func:R80/W6 types:R23/W1 schema:R47/W9 runtime:R1/W1 transform:R2 linkDemand:R0/W1
src/compile/loop-square.js              em     scope:R2
src/compile/emit-assign.js              em     core:R4 scope:R2 func:R17/W14 schema:R21 transform:R6 linkDemand:R0/W3 abi:R6
src/compile/program-facts.js            an     core:R1 module:R13/W1 scope:R4 func:R24/W11 types:R1 schema:R37/W2 closure:R1 transform:R1
src/compile/infer.js                    an     scope:R6 func:R7 types:R1 schema:R7 runtime:R1/W1
src/compile/inplace-store.js            em     func:R1 schema:R2/W2
src/wat/assemble.js                     asm    core:R43/W9 module:R6 scope:R31/W4 func:R19/W21 schema:R7 closure:R7/W2 runtime:R42/W16 memory:R16 transform:R5 features:R2
src/autoload.js                         prep   module:R2 features:(setFeature)
src/static.js                           em     scope:R6 func:R6 types:R1 schema:R6
src/reps.js                             em     scope:R4 func:R13 closure:R2
module/number.js                        reg+em core:R48 scope:R2 func:R1 runtime:R5/W5 memory:R3 features:R5
module/typedarray.js                    reg+em core:R78 scope:R2 func:R13/W12 types:R14 closure:R10/W1 runtime:R0/W10 transform:R6 linkDemand:R7/W16
module/simd.js                          reg+em core:R1
module/timer.js                         reg+em core:R22 closure:R0/W2 transform:R1
module/symbol.js                        reg+em core:R2 runtime:R3/W3
module/core.js                          reg+em core:R83/W2 module:R1 scope:R15 func:R8/W2 types:R11/W2 schema:R38 closure:R4 runtime:R2/W1 memory:R4 transform:R3 features:R4 linkDemand:R7/W5 abi:R6
module/web.js                           reg+em core:R1 transform:R1
module/console.js                       reg+em core:R15 func:R1 transform:R1
module/object.js                        reg+em core:R32 module:R7 scope:R7 func:R4/W12 types:R5 schema:R26/W1 runtime:R5/W8 memory:R3 abi:R26
module/atomics.js                       reg+em core:R9 scope:R1 func:R2/W4 types:R1 runtime:R0/W1
module/array.js                         reg+em core:R64 module:R4 scope:R4 func:R17/W15 types:R1 schema:R13 closure:R3/W1 runtime:R3/W5 memory:R1 transform:R3 linkDemand:R2 abi:R5
module/string.js                        reg+em module:R1 scope:R1 closure:R3 runtime:R7/W15 memory:R4 transform:R3 features:R2 linkDemand:R0/W2 abi:R2
module/math.js                          reg+em core:R26 module:R1 func:R2 schema:R2 runtime:R0/W2 transform:R7
module/schema.js                        reg+em func:R6 types:R8 schema:R60/W27
module/function.js                      reg+em scope:R1 func:R10 types:R1 schema:R4 closure:R12/W8 transform:R1 linkDemand:R0/W1
module/regex.js                         reg+em core:R19 module:R1 scope:R2 closure:R3 runtime:R15/W6
module/date.js                          reg+em core:R132 schema:R2/W1
module/json.js                          reg+em core:R27 scope:R5 schema:R8/W1 runtime:R3/W3 features:R1 abi:R3
module/navigator.js                     reg+em core:R1 transform:R1
module/crypto.js                        reg+em runtime:R0/W1 transform:R3 linkDemand:R0/W1
module/collection.js                    reg+em core:R117 scope:R16 func:R1/W11 schema:R8 closure:R2 runtime:R1/W3 transform:R1 features:R1 linkDemand:R30/W2
module/fs.js                            reg+em core:R7 transform:R1
jzify/classes.js                        prep   (no ctx object — err only)
index.js                                orch   core:R5 module:R2/W3 func:R6 types:R1 schema:R3 closure:R1 runtime:R1 memory:R1/W6 error:R1 transform:R11/W17 features:R1/W1 linkDemand:R0/W2 inspect:R2
transform.js                            prep   (no ctx object — warn/initWarnings only)
```

### Per-subtree aggregate (fanout = refactor-risk proxy)

```
subtree      files-touching  read-sites  write-sites  DIRECT writers (not incl. ctx.js's own reset())
core          30              824          14          helper-counters, compile/emit, wat/assemble, module/core
module        21              125          19          prepare/index, bridge, compile/index, compile/program-facts, index.js
scope         32              378          26          prepare/index, compile/dyn-closure-tables, compile/index, wat/assemble
func          40              805         410          20 files — the most promiscuous subtree by far
types         22              154          42          type.js, compile/plan/index, compile/narrow, compile/index, compile/emit, compile/analyze, module/core
schema        28              428          64          11 files incl. 3 module/*
closure       20              114          17          compile/plan/scope, compile/emit, wat/assemble, module/typedarray, module/timer, module/array, module/function
runtime       21              115         100          19 files, mostly module/*
memory         8               35           6          index.js only
error          4                1           4          prepare/index, session.js, compile/emit
transform     33              143          25          5 non-module writers + module writers scattered
features      11               38           1 (regex)  REAL writer = setFeature() indirection: only autoload.js + prepare/index.js call it (4 call sites total) — FROZEN discipline confirmed
linkDemand    13               49          36          9 files, direct `= true` assignment (monotone, no indirection function)
abi            9               71           0          write-once at ctx.js's own reset() (makeAbi()) — read-only externally
bridge         2                9           0          write-once at ctx.js's own reset() — read-only externally
inspect        3                6           1          compile/index.js only, gated on ctx.transform.inspect
warnings       3                6           0          write-only via initWarnings()/warn()/warnDeopt() functions — never raw-assigned externally
```

## 2. Subtree ownership map

ctx.js **already documents** writer/reader phases per subtree in its own
header comment (lines 34-48) — the census above cross-validates it, not
duplicates it blind. Reproduced + annotated:

| subtree | lifecycle (reset()) | writer phases | reader phases | discipline |
|---|---|---|---|---|
| `core` | compile | reset, module registration, emit* | emit, compile, module registration | **promiscuous** (824 reads/30 files) but writes concentrated in 4 files — mostly a registry (`emit` table, `stdlib`, `includes` Set), not scattered state |
| `module` | compile | prepare, index.js | prepare, compile, emit | promiscuous, moderate fanout |
| `scope` | compile | analyze, compile, plan, module registration, assemble | compile, emit | promiscuous — 32 files read `ctx.scope.globals`/`chain` |
| `func` | **function** (reset per fn, not per compile) | compile, narrow, assemble, +17 more | emit, module registration, +23 more | **most promiscuous subtree in the codebase** — 40/61 importers touch it, 410 write-sites. Matches ctx.js's own doc: func is written across compile/narrow/assemble because it's the per-function WORKING SET (locals, refinements, boxed, stack) — every pass that lowers or analyzes one function necessarily writes here. This is the single riskiest subtree for a views refactor: any phase view exposing `func` either has to be the FULL mutable frame (no real narrowing) or the refactor has to first decompose `func` itself. |
| `types` | function | analyze, plan | emit, module registration | promiscuous, function-scoped |
| `schema` | compile | prepare, analyze, compile | prepare, analyze, emit | promiscuous, 28 files, but see product-lattice `slotFacts` consolidation (already-landed precedent for shrinking N-parallel-Maps to 1 inside a subtree — same technique, smaller scope, applicable to session-view design) |
| `closure` | init (installed by module/function.js) | module registration (fn plugin), plan, emit | emit, compile | moderate fanout |
| `runtime` | compile | emit, module registration | emit, compile | promiscuous (100 write-sites, 19 files) — mostly module/* stdlib emit handlers writing data-segment/atom-table state, i.e. legitimately emit-phase-only despite the fanout |
| `memory` | compile | index.js only | compile | **already phase-disciplined** — single writer file |
| `error` | compile | prepare, compile, emit | `err()`/`warn()` (ctx.js functions) | already funneled through `err()`/`warnDeopt()` — direct field writes are just `src`/`loc`/`node` bookkeeping (4 sites) |
| `transform` | compile | index.js (opts) | prepare, compile, emit | mixed bag: SESSION-shaped user opts (noTailCall, strict, alloc, host) that are genuinely write-once-at-reset, alongside per-node counters (`cseId`, `loopXformId`, `loopPlanId`) that mutate throughout compile. FINDING: `ctx.transform` is itself two subtrees wearing one name (see §5). |
| `features` | compile | prepare (`setFeature()` only) | compile, optimizer, stdlib factories | **already phase-disciplined** — the FeaturePlan freeze (landed, .work/research.md §FeaturePlan freeze). `setFeature()` throws under `JZ_DEBUG_INVARIANTS` if called after `post-analyze`. THIS IS THE PRECEDENT the coordinator should generalize, not re-derive. |
| `linkDemand` | compile | emit, module registration | `resolveIncludes()`+, assemble | **half-disciplined**: correctly split OUT of ctx.features (audit-#14 item 3) into its own monotone-false→true DEMAND stratum, phase-fenced by construction (read only post-emission) — but writes are still 36 raw `ctx.linkDemand.x = true` assignments across 9 files, no `setLinkDemand()` indirection/tripwire the way `ctx.features` has `setFeature()`. Cheap, safe, already-designed-for slice: add the indirection function (§5). |
| `abi` | compile | reset (`makeAbi()`) | ir.js codegen, optimizer | **already phase-disciplined** — write-once, 0 external writers |
| `bridge` | compile | reset (bridge.js) | bridge.js → emit, module registration | **already phase-disciplined** — write-once |
| `inspect` | compile (opt-in) | compile/index.js only, gated on `ctx.transform.inspect` | host (editor integration) | already narrow |
| `warnings` | compile (opt-in) | `initWarnings()`/`warn()`/`warnDeopt()` functions only | host (warnings sink) | already narrow, functional-API-gated |

**FINDING**: 6 of 17 subtrees (`memory`, `error`, `features`, `abi`, `bridge`,
`warnings`, `inspect` — really 7) are ALREADY phase-disciplined today, by
either write-once-at-reset or a functional indirection (`setFeature`,
`initWarnings`/`warn`). `linkDemand` is one indirection function away from
joining them. The promiscuous core is `func`/`scope`/`schema`/`runtime`/
`types`/`module`/`closure`/`core` — 8 subtrees, dominated by `func`.

## 3. Reentrancy blockers

`compile()` is non-reentrant today for four independent reasons, none of
which a phase-views refactor alone fixes (views narrow ACCESS, not OWNERSHIP —
the underlying storage is still one process-wide mutable object graph unless
storage itself moves):

1. **`ctx` is a module-level singleton object** (`export const ctx = {...}`,
   ctx.js:70-102), mutated in place by `reset()`. Two concurrent `compile()`
   calls in one JS realm (e.g. a worker pool sharing a module instance, or
   nested calls) stomp each other's `ctx.func.current`, `ctx.scope.chain`,
   etc. `beginSession()`/`reset()` clears state at ENTRY, which is sufficient
   for sequential reuse (documented explicitly at ctx.js:258-276) but not for
   overlap.

2. **Module-scope mutable state OUTSIDE ctx**, found by grep for
   module-level `let`/mutable-container declarations (excluding frozen
   `const`-Set/Map lookup tables, which are immutable and reentrancy-safe by
   construction — the vast majority of the `new Set([...])`/`new Map([...])`
   hits are this class):
   - **`src/prepare/index.js:92-153`** — 14 module-scope `let`s (`depth`,
     `scopes`, `staticConstScopes`, `assignedStaticGlobals`,
     `mutatedArrayNames`, `funcLocalNames`, `funcValueNames`,
     `reassignedTopLevel`, `assignSid`, `declInitUnknown`, `ownerStack`,
     `ownerUniq`, `renameSerial`, `loopLocalNames`) — "the prepare-pass
     working set," explicitly documented (line 86-91) as module-scope
     rather than `ctx.prepare.*` **for performance** ("78 read sites would
     mean a single indirection on every scope query"). Reset via
     `resetPrepState()` at prepare()'s own entry (line 708), NOT wired
     through `beginSession()` — **a second, independent reset choreography
     outside the documented CompileSession seam**. Sequential-safe by the
     module's own reasoning; not reentrant.
   - **`module/regex.js:82`** — `let src, idx, groupNum, groupNames`, the
     regex-literal parser's own state (used to compile `/pattern/` literals
     found IN the program being compiled — a compile-time parse, not
     runtime regex execution). Reset at the top of every `parseRegex()`
     call (line 90-91). Entirely outside `ctx` and outside session.js's
     reset choreography — a THIRD independent reset point.
   - **`src/optimize/vectorize.js:3130-3144`** — `_whyNotActive`,
     `_whyNotReason`, `_relaxF32`, `_crPow` — "armed for the duration of a
     call, cleared on exit" (dynamically-scoped globals, not stack-scoped).
     Recursive/reentrant calls to the SAME armed function would corrupt each
     other; the module's own comment acknowledges the arm/disarm discipline
     is a manual per-call-site contract, not enforced.
   - **`index.js:372`** — `let compileTarget = null`, a test-injection seam
     (`_setCompileTarget`) that redirects EVERY subsequent `compile()` call
     process-wide. Not per-compile state; a global override switch.
   - `src/ir.js:1807` (`DOLLAR` Map) and `src/wat/assemble.js:24`
     (`stdlibParseCache` Map) are module-level but **content-addressed,
     append-only caches** (same key ⇒ same value, forever) — explicitly
     documented as intentionally cross-compile-persistent, cleared only for
     memory hygiene (`clearDollar()`/`clearStdlibParseCache()`, both wired
     into `beginSession()`, session.js:287-288). Not a correctness hazard
     under concurrency (idempotent writes to the same key), just a shared
     resource. Lower-severity than items above.
   - `ctx.js` itself: `_factStore` (now session-owned via
     `getFactStore()`/`resetFactStore()`, called from `beginSession()` —
     **already fixed**, audit P1 stage 5, per session.js's own doc), and
     `_featureSnapshot`/`_postAnalyze` (the FeaturePlan freeze tripwire —
     module-scope BY NECESSITY, since it must survive independent of
     whether a caller ever calls `beginSession()` — cleared at `reset()`
     itself, `ctx.js:274-275`).

3. **The fact-store `WeakMap`s** (`programFacts.walkCache`, `bodyFacts`,
   `bindingUses`, `mayBeUndefinedTrace`, `mapGetShapedTrace`,
   `presentValTrace` — `ctx.js:242-248`) are keyed on AST-node IDENTITY, so
   they're SAFE across sequential compiles of different programs (different
   node objects ⇒ no collision) even without a reset — the reset exists for
   memory hygiene under self-host's WeakMap→Map folding (session.js:207-209
   documents this exactly: "without the reset, a warm kernel instance would
   accumulate one entry per bodyRoot for its whole lifetime"). Not a
   reentrancy hazard for correctness, only for memory growth.

4. **`assertCtxInvariants`'s `PHASE_ORDER` state** (`ctx.transform.sessionPhase`,
   ctx.js:904) is itself ORDERED, session-scoped state living on `ctx` —
   asserts a linear phase sequence (`post-reset → post-prepare →
   post-compile`), which is correct only if exactly one compile is in
   flight. Interleaved/reentrant compiles would trip false invariant
   violations even where the underlying compile would have been correct,
   because the phase marker is shared.

**FINDING**: the reentrancy blockers are NOT primarily "ctx is one big
object" — `ctx` itself already resets cleanly. The real blockers are the
state that lives OUTSIDE ctx's documented reset path: prepare/index.js's 14
lets (biggest single offender — perf-motivated, explicit tradeoff already on
record) and module/regex.js's 4 lets (smaller, same shape). Folding these
into ctx (or a session object) and having ONE reset choreography (`beginSession`
already being that seam) is the highest-value, lowest-risk reentrancy fix and
is ORTHOGONAL to "phase views" — it's prerequisite plumbing, not the views
work itself.

## 4. The self-host constraint

`src/ctx.js` is itself compiled through jz: `scripts/self.js` (the self-host
kernel entry, `default export = compileSelf`) imports `{ ctx, reset,
initWarnings }` from `../src/ctx.js` (self.js:16), and
`scripts/selfhost-build.mjs` resolves `scripts/self.js`'s WHOLE module graph
(`resolveModuleGraph`, which necessarily pulls in ctx.js transitively via
`index.js`/`prepare/index.js`/etc.) and feeds it to `compile()`, producing
`dist/jz.wasm` — "the resulting wasm's `default(source)` is jz, compiled by
jz" (selfhost-build.mjs:15). So **every object-literal shape, closure, and
control-flow construct in ctx.js's own source is itself jz source code**,
subject to the same subset restrictions as any user program.

Verified subset restrictions relevant to a session-shape redesign:
- **No `Proxy` support**: grep for `'Proxy'`/`"Proxy"` across every
  `module/*.js` (the stdlib registration surface) returns zero hits — jz
  never registers a `Proxy` global at all. A CompileSession implemented as a
  `Proxy`-wrapped view (e.g. to lazily project a subtree) could not itself
  be expressed in the self-hosted kernel's own source, even setting aside
  whether a HOST-side Proxy view would be acceptable (native-only code
  outside ctx.js's self-hosted portion could use one — but ctx.js's own
  internals could not).
- **No object-literal/class accessor (`get`/`set`) syntax in the parser**:
  grep for `AccessorProperty`/getter-keyword handling in `src/parse.js` and
  `src/front.js` returns zero hits — the parser has no path that recognizes
  `{ get x() {...} }` or `class { get x() {...} }` as a construct at all.
  Confirms the task's framing precisely: a session-views design that leans
  on lazy getters for phase-scoped facades is not just "risky," it is
  **unparseable** in the subset ctx.js itself must compile through.
- **`registerGetter`'s own doc (ctx.js:150-162) is the direct precedent**,
  not a coincidence of naming: it exists because "the self-host kernel can't
  reliably read a dynamic property off a **closure returned via a dynamic-key
  lookup**" — a JS-source-level property-getter DISPATCH TABLE (for the
  compiled OUTPUT program's own `.prop` getters, e.g. `re.source`,
  `m.size`) had to move from a closure-attached boolean flag to a plain
  `Set` membership test, because "a closure tag silently read `undefined`
  and every getter fell through to `__dyn_get`." This is evidence about
  dynamic-key closure-property reads inside the self-hosted kernel being
  unreliable in general — the same failure mode would apply to any
  session-view design that tries to attach per-view accessor functions
  keyed dynamically, not just to the specific getter-dispatch table it was
  fixed for.
- **`derive()`'s own doc (ctx.js:104-111)** is a second, independent
  dict-shape-sensitivity precedent: `{ ...parent }` inherits
  `Object.prototype` under V8 (native jz.js) but NOT under the self-hosted
  kernel's own prototype-less objects — "a name-keyed lookup like
  `chain['valueOf']` returns the inherited method instead of undefined,"
  a **kernel/native SEMANTIC DIVERGENCE**, not just a perf concern.
  `derive()` fixes it with `Object.assign(Object.create(null), parent)`.
  Any new phase-view constructor (e.g. `funcView(ctx)`, `scopeView(ctx)`)
  that shallow-copies a subtree MUST use `derive()` (or an equivalent
  `Object.create(null)` pattern), never a bare object-spread `{...}`, or it
  reintroduces exactly this divergence for whatever dynamic-key lookups the
  view supports.

**Net implication for a views refactor**: phase-scoped views must be **plain,
prototype-less, statically-shaped destructured objects/dicts built with
`derive()`-style construction** — a `const view = { func: ctx.func, scope:
ctx.scope }` style facade (a flat subset re-export, still backed by the SAME
mutable subtree objects) is subset-safe. A `Proxy`-based lazy view, a
getter-accessor-based view, or any view whose OWN construction relies on
dynamic-key closure dispatch is not just stylistically wrong but **would not
compile** if that view constructor itself lives in ctx.js/session.js (the
self-hosted portion) rather than purely in host-only orchestration code
(index.js, which the kernel doesn't need to self-host since it's the driver,
not the compiler-under-compilation — though `scripts/self.js` IS effectively
a from-scratch reimplementation of the driver that DOES get self-hosted, so
any driver-shaped session logic that self.js also needs will hit the same
wall).

## 5. Minimal-change candidates, ranked by (value × safety)

Ordered cheapest-and-safest first. The FeaturePlan/linkDemand migration (landed,
.work/research.md §FeaturePlan freeze) is the load-bearing cost precedent: its
slices were (1) seed+declare+assert on the EXISTING bag — byte-identity gated,
zero call-site changes, (2) extraction of ~13 write sites into a new subtree +
updating their module-template readers, (3) a reader-contract grep sweep, (4) a
downstream gate retirement. Cost was dominated by slice 2 (finding and moving
every write site), not by the mechanism itself (adding a stratum + a tripwire
function is cheap — `setFeature()` is ~4 lines). That shape — "cheap enforcement
mechanism, cost is proportional to write-site COUNT, not subtree complexity" —
predicts the ranking below directly: rank by write-site count from §1/§2's
aggregate, not by subjective subtree importance.

**(a) Module-scope mutable state → session-owned, ONE reset choreography.**
   Fold prepare/index.js's 14 lets and module/regex.js's 4 lets into either
   `ctx` (a new `ctx.prepareState`/`ctx.regexParse` subtree) or a sibling
   object reset by `beginSession()` alongside `reset()`. Cost ≈ FeaturePlan
   slice-1 shape: mechanical, no external call-site changes (both are
   currently accessed only from within their own file), byte-identity
   gatable trivially (pure storage-location change). Value: closes §3's two
   biggest reentrancy gaps and collapses 3 independent reset choreographies
   (session.js's `beginSession`, prepare/index.js's `resetPrepState`,
   regex.js's inline reset) into 1 — the SAME "one owner" principle
   session.js's own docstring already states as its goal (line 2: "the ONE
   owner of per-compile lifecycle state"). NOT yet true today per this
   survey. Safety: HIGH (no reader changes, only where the write lives).

**(b) `linkDemand` write indirection (`setLinkDemand()`), mirroring `setFeature()`.**
   36 write sites across 9 files, all currently raw `ctx.linkDemand.x = true`.
   Adding the indirection function costs ~5 lines (ctx.js) + a mechanical
   find-replace of 36 call sites (same shape as FeaturePlan slice 2, but
   smaller — linkDemand already has no cross-phase drift risk since it's
   monotone false→true and read only post-emission, so the tripwire would
   assert WEAKER invariants than `setFeature`'s post-analyze freeze — likely
   just "never write before reset" or nothing at all, making this close to
   pure documentation-as-code rather than a real bug-catcher). Value: LOW-
   MEDIUM (closes a discipline gap, not a live bug). Safety: HIGH.

**(c) Per-phase read-only view objects — plain destructured facades (NOT
   Proxy/getters, per §4).** E.g. `emitView(ctx) = derive({ func: ctx.func,
   schema: ctx.schema, closure: ctx.closure, runtime: ctx.runtime, abi:
   ctx.abi, core: ctx.core })` passed to emit-phase functions instead of
   bare `ctx`. Value: documents+enforces the phase/subtree contract ctx.js's
   own header comment ALREADY states in prose (lines 34-48) as an actual
   type-level (or at least call-signature-level) boundary — turns a comment
   audit into a grep-able one (every function taking `emitView` instead of
   `ctx` cannot accidentally read `ctx.scope` past its intended phase).
   Cost is proportional to CALL-SITE COUNT per §1's aggregate: `func` (40
   files, 410 writes) is the wrong FIRST target — too large a blast radius,
   and views don't shrink `func`'s write fanout, they just relabel it (§2's
   `func` finding: any view exposing func is either the full mutable frame
   or the refactor has to decompose func first, which this survey does not
   scope). The already-disciplined subtrees (`abi`, `bridge`, `warnings`,
   `inspect`, `memory` — §2) are the SAFEST slice-1 candidates precisely
   because they have 0-1 writers already — a view wrapping them changes
   nothing about who writes, only who's ALLOWED to read, and there's
   nothing to break. Module/*.js's 16 DI-parameter files (§1) are the
   natural second wave: their call sites already accept an injected
   object, so swapping the argument from `ctx` to a phase view is a
   ONE-LINE change per file at the `setupCtx`/registration call site, zero
   changes inside each module file (they'd keep reading `ctx.core.emit`
   etc. off whatever's passed as their `ctx` parameter name).

**(d) The full `CompileSession` record** (program, analyses, passes, plans,
   target — per .work/research.md's Stage-4 framing). Highest value (closes
   §3 item 1's singleton problem AND generalizes (c) across every subtree,
   not just the disciplined ones) but cost is dominated by `func`'s 410
   write-sites / 40 files and `schema`'s 64/28 and `scope`'s 26/32 — by the
   FeaturePlan-slice-2 cost model, this is roughly 30-40× the size of the
   linkDemand extraction, before even reaching the harder question §2 flags
   for `func`: it may need to be DECOMPOSED (not just wrapped) before a view
   over it means anything, since today its writers span essentially every
   phase by design (it's the per-function working set, not a phase-scoped
   fact). Not a candidate for a first slice; the natural target for
   whichever slice tackles `func` specifically, informed by (a)-(c) landing
   first and the BindingId/FunctionPlan precedents (.work/research.md
   §Middle-end consolidation Stage 2) which already froze per-function plan
   data along similar lines (`FunctionPlan frozen with DBG enforcement —
   updateRep throws when frozen").

**Ordering recap: (a) prepare/regex module-state fold → (b) linkDemand
setter → (c) view facades over already-disciplined + DI-parameter subtrees →
(d) full CompileSession, gated on func's own decomposition.**

## COORDINATOR RULING (2026-08-09, binding)
The §5 ranking is ADOPTED as the campaign order. Slice (a) unified reset
choreography: prepare/index.js's resetPrepState + module/regex.js parser
state + vectorize.js debug flags + index.js compileTarget all wired through
ONE beginSession()/reset() path (module-scope perf-motivated lets may stay
module-scope — the requirement is single-choreography reset, not relocation).
Slice (b) linkDemand setter mirroring setFeature() (monotone tripwire).
Slice (c) plain destructured read-only facades (subset-safe: no Proxy, no
getters — the survey §4 constraint is absolute) over the 7 disciplined
subtrees + the DI-parameter seam for module files. Slice (d) full
CompileSession record is GATED on ctx.func decomposition — a separate
future campaign, not this one; do not attempt. Gates per slice: byte-identity
sweep + battery + kernel-parity + build ×2 + a NEW reentrancy probe (two
sequential compiles in one process, differing programs, assert no state
bleed — the thing slice (a) exists to make true).

## AS-LANDED — Slice (a) (2026-08-09)

SHA: `7ed9b1ce`.

**What shipped vs ruling.** `src/ctx.js` gained a `RESET_HOOKS` array +
`registerResetHook(fn)`, drained at the end of `reset()` — the seam every
entry point (`beginSession()`, AND raw-reset test harnesses like
test/types.js that call `reset()` directly, confirmed by grep of every
call site) already goes through. `prepare/index.js`'s `resetPrepState`,
`module/regex.js`'s literal-parser state (`src`/`idx`/`groupNum`/
`groupNames`), and `optimize/vectorize.js`'s why-not-simd arm/disarm flags
(`_whyNotActive`/`_whyNotReason`/`_relaxF32`/`_crPow`) all register through
it at module load.

`index.js`'s `compileTarget` deliberately did NOT go through `RESET_HOOKS`
— tracing every raw `reset()` call site showed test/types.js (which is
NOT excluded from the `JZ_TEST_TARGET=jz.wasm` kernel-target leg) calls
`reset()` directly, interleaved with `compile()`/`jz()` calls that must
keep routing through the kernel target for that whole test run. Folding
`compileTarget`'s reset into `RESET_HOOKS` would silently null the test
harness's override mid-run the first time ANY raw-reset test executed,
breaking `test:wasm` with no error, just silent fallback to the native
path. Instead, `src/session.js` grew a narrower, second registry —
`SESSION_RESET_HOOKS`/`registerSessionResetHook(fn)`, drained inside
`beginSession()` only — and `index.js` registers `compileTarget`'s clear
there. This is provably a no-op whenever it matters: `jz.compile` never
reaches `beginSession()` while `compileTarget` is set (it short-circuits
first), so the hook only ever fires when `compileTarget` is already null.
Deviation from the ruling's literal "ONE beginSession()/reset() path" —
flagged here rather than silently generalized, per this task's own
standing instruction not to ship a kernel-affecting change quietly.

**FINDING (self-host leg, the substantive one):** removing
`prepare()`'s own direct `resetPrepState()` call and relying solely on the
`RESET_HOOKS` drain (byte-identical, full-battery-clean, invariants-clean
on the NATIVE leg) crashed the self-hosted kernel — `dist/jz.wasm` built
from that tree traps with "memory access out of bounds" on kernel-parity's
and kernel-oracle's very FIRST compile call, not a warm/second-compile
issue. Bisected via a throwaway worktree, file-by-file: `module/regex.js`'s
and `optimize/vectorize.js`'s equivalent hooks (registered the identical
way, called only indirectly, never by direct name elsewhere) do NOT crash
the kernel, alone or together. Re-adding `prepare()`'s own direct
`resetPrepState()` call ALONGSIDE the registration (both paths, redundant)
made the crash disappear completely, confirmed on a full rebuild. Root
cause not chased further — this reads as a self-hosted-compiler edge case
around a large (14-assignment, ~78-read-site), heavily-closed-over
module-scope function becoming reachable ONLY through indirect
(array-stored, `for`-of-invoked) calls with no remaining direct call site
anywhere in the program, not a session-choreography defect (every real
caller already invoked `reset()` before `prepare()`, which is why the
native leg never showed a problem) — but that is a hypothesis, not a
confirmed compiler diagnosis, and is explicitly out of THIS campaign's
scope (session-choreography, not compiler-internals). Landed shape:
`prepare()` keeps its direct `resetPrepState()` call AND the
`registerResetHook(resetPrepState)` registration — both, not a
half-migration — since `resetPrepState` is idempotent and cheap, this
costs nothing and is proven safe by the same bisection.

**Reentrancy probe:** `test/session-reentrancy.js`, new. Two program
pairs picked to bleed through exactly the state this slice folded into one
choreography — regex-heavy (named groups, backrefs, alternation, flags)
→ regex-free, and prepare-state-heavy (deep arrow nesting, sibling-block
shadowing, static-const tracking, loop-captured let, reassigned top-level
binding, catch, destructuring) → minimal — compiled sequentially in one
process, both orderings, each program's warm-in-process bytes asserted
byte-equal to a compile of the SAME program in a brand-new node process
(`test/_fresh-compile-worker.mjs`). Result: **PASS**, 3/3 tests, 8/8
assertions, both orderings, both pairs.

**Gates:** 57-case/171-compile bench-corpus byte-identity vs a disposable
`git worktree` pinned at unmodified HEAD (`0c139eff`) — **0 diffs** (the 3
standard excluded cases — jessie/jz/watr — need extra module wiring this
harness didn't reproduce, same exclusion shape as prior sessions' "57
bench/* cases"). Full battery **3413/3421** (2 pre-existing fails,
unchanged: interval-walk codec bounds-check count, typed-RMW guard-count
pin). `JZ_DEBUG_INVARIANTS` battery **3414/3423** (same 2 + 1 known
audit-#12 idempotence-probe flake, unchanged). kernel-parity/kernel-oracle
**13/13** (469 assertions) against a freshly rebuilt, verified-fresh-mtime
`dist/jz.wasm`. `npm run build` ×2 — SHA-256 identical across both runs
(`dist/jz.js`, `dist/interop.js`, `dist/jz.wasm`). `test/selfhost.js`
under `JZ_DEBUG_INVARIANTS=1` — **21/21** (206 assertions, incl. 39 rounds
of same-instance warm reuse).

**Verdict: GREEN**, with two flagged deviations from a literal reading of
the ruling (compileTarget's narrower hook, prepare()'s redundant direct
call) — both load-bearing, both documented at their call sites, neither
changes the campaign's actual goal (one discoverable reset choreography,
reentrancy-probe-verified).

## AS-LANDED — Slice (b) (2026-08-09)

SHA: `2cd19e6c`.

**What shipped.** `setLinkDemand(key)` in `src/ctx.js`, mirroring
`setFeature()`'s shape exactly (same file, same pattern, adjacent code).
No value parameter — every one of the 36 existing write sites was already
a bare `= true` (monotone false→true by construction, confirmed by grep:
zero non-`true` writes exist), so the setter doesn't need one. Tripwire:
a new `_preAssemble` flag, set `true` at the EXISTING
`assertCtxInvariants('pre-assemble')` call site (no new call site added —
`ctx.linkDemand`'s own doc comment already identifies `pre-assemble` as
the DEMAND stratum's freeze point, verified phase-ordering: every writer
completes before it fires, `resolveIncludes()`/assemble read only after).
`setLinkDemand` throws under `JZ_DEBUG_INVARIANTS` if called once
`_preAssemble` is true — a REAL bug-catcher (a write past that point means
a reader already started consuming a fact about to change under it), not
"close to pure documentation-as-code" as §5's cost estimate speculated.

**Write-site migration:** 36 raw `ctx.linkDemand.x = true` assignments
across **10 files**, not the survey's own count of 9 — the survey's §1/§2
census undercounted `index.js`'s 2 sites (same low-single-digit fuzziness
the survey flagged for its own ctx-importer count). Per file:
`src/compile/emit-assign.js` (3), `src/compile/analyze.js` (1),
`src/compile/emit.js` (3), `module/typedarray.js` (16 — the sed migration
initially missed 3 digit-bearing keys, `f16`, twice more `f16`/nothing
else, because the first regex pass used `[A-Za-z]+` instead of
`[A-Za-z0-9]+`; caught and fixed before landing), `module/function.js`
(1), `module/core.js` (5), `module/string.js` (2), `module/crypto.js`
(1), `module/collection.js` (2), `index.js` (2). Verified post-migration:
`grep -rn "ctx\.linkDemand\.\w+ = true"` across src/ + module/ + index.js
returns zero hits.

**Gates:** identical shape and numbers to slice (a)'s (same combined
tree) — byte-identity **0 diffs** (171/171), full battery **3413/3421**
(same 2 pre-existing fails), `JZ_DEBUG_INVARIANTS` battery **3414/3423**
(same 2 + 1 known flake), kernel-parity/kernel-oracle **13/13** (469
assertions), `npm run build` ×2 SHA-256 identical, `test/selfhost.js`
under invariants **21/21**. Targeted smoke (features, feature-gating,
simd, objects, strings, external, wasi, array-methods, abi — the
linkDemand-adjacent files) run standalone pre-commit: 706/706 pass.

**Verdict: GREEN.** No design deviation — the setter's shape, the
tripwire's phase anchor, and the write-site migration all match the
ruling and the survey's own §5(b) estimate exactly; the only surprise was
the file-count-off-by-one, immaterial to the mechanism.

## Slice (c)/(d): not attempted this session
Slice (c) (read-only facades over the 7 disciplined subtrees + the
DI-parameter seam) and slice (d) (full CompileSession, gated on `ctx.func`
decomposition per the ruling) are unstarted — out of this session's scope.

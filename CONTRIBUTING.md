# Contributing to JZ

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # core suite
node bench/bench.mjs  # run benchmarks
```

### Shared watr optimizer

Subscript is pinned to public source revision `0f65c86` for surrogate-pair
escape decoding during self-hosting, on top of the 10.7.3 parser fixes.
Replace the archive pin with an npm release once it includes this fix.

`package.json` and the lockfile pin the public watr source archive at `33ec51b`.
It contains the 5.10.2 safety fixes and retains plain instruction arrays and
cloning. A clean install needs no sibling checkout. Switch to a published npm
version once it contains these changes; until then the archive's full commit
and integrity hash keep CI reproducible.

Generic local propagation and merging run in watr after linking, including
the fast tier. The duplicate JZ implementations and cleanup sweep are removed.
Guarded scalar updates are converted to selects in watr using Wasm types,
after JZ lowers the original branches with their settled representation facts.
Condition chaining and boolean simplification also run in watr, including the
fast tier; link no longer implements these generic body rewrites on the tape.
Watr pools costly scalar literals after folding and inlining, before outlining
prices repeated expressions.
Its shared cost estimator counts alignment and offset bytes even when WAT omits
them, so load reuse is judged against its encoded cost.
Integer zero tests use Wasm eqz in the shared identity sweep; inequality uses
two unary tests instead of a zero literal and comparison.
Consecutive constant shifts combine only when their separately masked counts
sum to less than the word width.
Single-use, small-function and wrapper inlining share construction, parameter
setup, local resets, renaming and returns. Read-only local arguments bypass
copied parameter storage when argument evaluation cannot write their source.
Unmapped numeric/flat callee locals retain their call frame.
Unwritten parameters with a shared tiny constant substitute directly at every
read, including loop reads, without creating a local or a cleanup sweep.
Public adapters use the ordinary small-function inline budget; larger workers
remain shared. Internal dispatch trampolines retain the speed-tier budget.
Named-function trampolines use direct-call argument coercion, so narrowed pointer
parameters extract their offset instead of numerically converting a NaN box.
Known-local arithmetic folds in the same propagation pass; JZ only selects
this policy with its existing `hoistConstantPool` option.
Exact cast identities have one owner in watr: JZ calls `simplifyCast` during
early SIMD preparation, and watr uses it in its final identity sweep. Narrow
stores discard irrelevant casts and masks. Integer constant pooling uses
canonical bits rather than source spellings and skips literals too cheap to pool.
The downstream watr workflow builds and tests with the same current JZ package.
See [PLAN.md](PLAN.md) for remaining gates and DSP evidence.

The summary's declaration tables own numeric binding IDs, local to that summary.
Kind and incoming-argument facts are indexed arrays; solver and read-only queries
reuse the same IDs. Scope resolution still uses names, but reading a resolved
binding needs no compound string key or second hash lookup.
Flow-sensitive assignment and refinement facts use those same IDs in sparse
collections, reset per function; branch rollback stores IDs as well. Dense
arrays for these sparse facts increased allocation without improving throughput.

Named functions stored in internal objects or bindings retain their identities
in the summary's existing closure sets. Calls through those values bind the same
parameters and result facts as direct calls. Unknown uses and host exposure still
open the facts; taking a function's address retains the boxed callable-value ABI.

LICM extraction is shared through watr's `hoistInvariants`: traversal, private-local
checks, structural deduplication and temporary typing have one owner. JZ supplies
per-loop invariance and speculation-safety proofs for its helper calls and memory
representations, plus profitability policy. Watr's standalone proof remains
conservative about memory and calls. Proofs are invocation-local callbacks over
Wasm instructions, never properties attached to instruction arrays. JZ still calls
the shared engine before and after address rewriting; watr calls it after inlining.
Those distinct maturity points remain necessary for current lowering patterns.
The shared engine counts local references once per function and updates that
census when deduplication removes copies or introduces a temporary. Each loop
checks private writes against it without rescanning the whole function.
JZ uses watr's instruction-effect classifier for every memory-write family;
unknown write targets block alias-dependent motion. Buffer origins follow
single-definition locals and closed scalar recurrences; other origins remain
unknown. Allocating
helpers cannot be speculated before zero-trip loops or crossed by allocator-global
reads.

Prepare uses one shape-consensus check for declarations and assignments.
Source shapes remain separate from layouts extended by property writes or
`Object.assign`: replacing a record cannot inherit the earlier instance's
extra fields. Replaced bindings reuse the existing allocation-provenance guard
to prevent layout extension; disagreeing shapes use ordinary schema dispatch.
The summary records lost schema identity, so dynamically readable BigInt fields
use the existing tagged storage. Representation planning retains object-field
initializers as it does array elements, including computed BigInt values.
Possibly absent arrays use the existing checked index helper before header reads.

The host boundary carries plain `jz:fields` data alongside schema names. The
summary supplies field families and typed/nested identities; schema analysis
supplies numeric refinements and records only discriminant constants actually
consulted by lowering. Host-exposed schemas use tagged BigInt storage, including
shapes shared by BigInts and numbers; private schemas whose identity stays known
retain their raw lanes.
Returned object literals allocate independently, since host writes can outlive
the call. Interop enforces
that snapshot on structured ingress and writes, and uses it to decode scalar
carriers. Retained arrays exposed to the host have open elements because their
handles carry no element contract. Fresh returned arrays keep their construction
proofs; typed buffers keep their storage policy. See the [host memory contract](README.md#host-memory-contract) for mutation
and allocation failure behavior.

JSON.parse shares decimal accumulation and rounding with Number/parseFloat;
its own scanner checks the stricter JSON grammar. Generic and shape-specialized
parsers share one whitespace loop, with an inline guard for compact input. The
scanner bounds each UTF-16 load and accepts only tab, LF, CR and space.
Integral significands bypass
the decimal conversion table. Parsed objects overwrite duplicate keys and order
array-index keys before registering a schema. The schema cache hashes decoded
keys, verifies their contents, and grows its backing table while preserving IDs.
Exhausting the pointer's schema-ID field raises a RangeError instead of corrupting
another object. The ordinary module clear resets the table and cache together.

URLSearchParams uses ordinary class lowering with shared methods and private
key/value arrays. Unused methods disappear through existing reachability analysis.
Its callback iterator rereads the live fields after each callback, including
when appending entries grows their backing arrays.

Array read-only/current-pointer policies and multi-site push counts reuse the
binding-use census. It distinguishes property reads from member calls, preserving
indexed access, optional calls, writes, aliases and captures as separate evidence.
The existing fixed-builder length proof also publishes reserved capacity into local
ValueReps. Allocation converts that logical count using the settled record layout;
push still updates visible length and returns its current value. Fixed builders
omit forwarding/growth, while multi-site record pushes share the existing slot
layout code. Conditional growth, exception handlers, escapes and induction/header
mutations reject the proof.

The interval interpreter also supplies call-argument and typed-store bounds.
Internal parameter ranges narrow only when every incoming call proves them;
exports, indirect calls, missing arguments and unknown writes retain checks.
The same ValueRep range feeds integer arithmetic and indexing after lowering.
Typed-store summaries account for element wrapping and fresh zeroed storage.
Truncated division preserves its quotient range only when it cannot wrap i32.
Structural index proofs require every occurrence to succeed. Loop versioning
groups cursor offsets by their shared extent and omits already-covered nest
guards; negative offsets participate in the lower bound.

Ephemeral dictionaries use the same zeroed header allocator as other collections.
Allocation and fixed probes share one capacity calculation; unrepresentable
domain sizes retain the ordinary growing table instead of overflowing a hint.
Table reuse invalidates enumeration keys before clearing its contents. Host
`memory.reset()` calls the compiled reset so heap rewind, cache invalidation and
durable-state healing have one owner; JS-only memory retains its fallback.

The size preset keeps indirect function-table calls instead of adding speculative
direct arms alongside their fallback. The speed preset retains that expansion.

### Body-fact freshness

`analyzeBody` caches observations, not an immutable semantic snapshot. Its
signature fingerprint covers only the current function signature. Every other
dependency has an explicit invalidation owner:

| Dependency changed | Invalidation before the next dependent read | Owner |
|---|---|---|
| Function body or specialization AST | `setFuncBody` / `reanalyzeBody` | Source rewrite and specialization passes |
| Current parameter/result signature | Live fingerprint; explicit seams during solving | `body-facts.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Function value/type/length overlays and caller facts | `reanalyzeBody`; `invalidateBodies` for affected callers | `narrow/caller-ctx.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Summary, global types/lengths, schema integer census | `invalidateAllBodyFacts` at publication/phase boundaries | `plan/index.js`, `compile/index.js` |
| Compile session | New fact store / `resetBodyFactsCache` | `session.js` |

Global invalidation clears the complete cache, including anonymous roots.
Signature checking does not authorize stale overlay reads. New passes use these
existing seams; they must not add another cache or rely on ambient facts staying
unchanged accidentally.

Historical `.work/` citations below refer to retired evidence, recoverable using
[.work/README.md](.work/README.md). [PLAN.md](PLAN.md) is the active product plan.

Compiler lifecycle diagnostics live in `src/debug.js`. `JZ_DEBUG_INVARIANTS=1`
enables phase, representation and mutation checks for development. Source builds
use one flag; the browser and self-hosted release builds specialize it before
import analysis, removing the diagnostic code. These checks report compiler bugs,
not source-program warnings. Phase consumers read the owned context fields directly;
wrapping those fields in temporary objects adds no protection.

## Code layout

```
jzify/          pre-compile desugar (index.js orchestrator + phase modules)
  names.js      temp-name factory
  bundler.js    esbuild export/interop folds + object-literal idioms
  classes.js    class + object-method `this` lowering, pseudo-classical/prototype folds, statics
  switch.js     switch fall-through lowering
  generators.js function*/yield state machines + iterator-helper loop fusion
  hoist-vars.js var hoisting; arguments.js — arguments/rest lowering
src/
  prepare/      validate, normalize, extract exports/imports (index.js)
  compile/      analyze → infer → plan → narrow → emit; ProgramIndex; program facts; driver (index.js)
  optimize/     WAT-array passes + vectorize.js; arena-rewind, sort-locals, low-word-mask are tape passes run by link
  link/         whole-module passes on the tape: treeshake, custom sections, throw-runtime prune, function order, local names (index.js)
  summary/      the program summary: one kind per binding, slot and result, a whole-program fixpoint refreshed after source rewrites
  ir/           tape.js, the IR tape (parallel typed arrays); the WAT-array helpers until emit builds the tape
  wat/          assemble.js, codegen.js (AST → jz source printer), optimize.js
  abi/          NaN-box ABI helpers (string, array, object, number)
  op-policy.js  shared jzify/prepare reject + class-error messages
  # shared leaves — cycle-free, imported across stages:
  ast.js static.js kind.js type.js param-reps.js
  ctx.js bridge.js reps.js ir.js autoload.js resolve.js
  layout-kinds.js  region-arena relocation arms per heap kind (executable registry; prose twin layout-kinds-doc.js)
module/         stdlib
layout.js       NaN-box bit layout + PTR.TYPED elem-aux codec (compiler-free, shared with module/)
interop.js      host↔wasm value marshalling: NaN-box decode/encode at the JS boundary (exports, imports, memory views)
transform.js    jzify as standalone source→source (`jz/transform`; parse → jzify → codegen)
err-codes.js    compile/runtime error-code registry (host decode of trapped error classes)
wasi.js         WASI shim for the standalone/CLI targets
cli.js          command-line driver (`jz` binary): flags → compile opts, file IO, --why-not-simd
```

**Folder policy:** one folder per pipeline *stage*, not per arbitrary concern. `jzify/` lives at repo root (pre-compiler transform, like `layout.js` / `cli.js`). Shared cycle-free leaves stay at `src/` root so `module/` imports stay short.

**Stdlib registration — two dialects, by design:** raw `ctx.core.stdlib[name] = body` / `ctx.core.emit[name] = fn` (or the `bind(name, fn)` sugar) is the DEFAULT for dep-free, arity-irrelevant handlers — the overwhelming majority of the stdlib (~580 sites vs ~35 `reg()` calls; this is real, not legacy-to-migrate). Call `inc('__dep', …)` inline in the handler body for any stdlib kernel it needs. `reg(name, deps, fn)` (→ `emitter()`, `src/ctx.js`) — or `wat(name, body)` for the WAT-kernel half, co-located via `reg(name, { deps, wat, emit })` — is REQUIRED whenever either mechanical property matters:
  - **deps must be auto-included, not hand-called.** `emitter()`'s wrapper runs `inc(...deps)` before every invocation of `fn`; anything that wraps/aliases the handler (`dual`, `.deps` propagation, a second name bound to the same function) inherits the guarantee for free. A raw handler's `inc()` call lives only in its own body — copy or wrap it and the dep silently drops.
  - **logical arity diverges from `fn.length`.** `emitter()`/`call()`/`method()` set `.argc` explicitly, which `emitArity()`'s fallback (`h?.argc ?? h?.length`) needs whenever a handler is built through a rest-param wrapper or otherwise doesn't report its true arity via `Function.length`. Plain raw handlers work fine on the `.length` fallback *only when the two agree* — that's the common case, hence still the default.

  The one hard, mechanical rule for either dialect: **never introduce a second write for a FLAT name already registered** — it used to silently overwrite the earlier handler (dropping `emitter()`'s auto-inc/argc guarantee when the earlier write was a `reg()`) with no error. It no longer can: `reg()`/`wat()`/`registerGetter()`/`bind()` (`src/ctx.js` `registerName`) refuse to register a FLAT name (no `:`) that's already occupied — by an earlier raw/`bind()` write *or* an earlier `reg()`/`wat()`/`registerGetter()` call, in either order, through either dialect — and throw immediately, naming both the module registering now and the module that got there first. A guarded `ctx.core.emit` handler clobbered by a *later, genuinely raw* (non-`bind()`) assignment — undetectable at the moment of that write, no Proxy in the self-compilable subset — is caught right after the clobbering module's `init()` returns (`verifyEmitIntegrity`, wired from `src/autoload.js` `includeModule`), by comparing the live table entry against the exact value reference `registerName` stored at registration time. **Type-qualified keys** (`.date:valueOf`, `.string:padStart`, …) are the one exemption: namespaced by design, one physical owner (the type's own module) per key, so `bind()` leaves them on the old unguarded raw write — cross-module collision there was never the hazard. What used to read as a legitimate "generic default, specific override" chain on FLAT names (e.g. `date.js`'s raw `.valueOf` over `string.js`'s `bind('.valueOf', …)`) was never actually that: it was this exact silent-collision class, and it corrupted `.valueOf()` on every unresolved-type receiver for as long as it shipped (`.work/archive/printer-trio.md`). All throw paths are exercised by `test/passes.js`'s stdlib duplicate-registration tests.

**kind vs type:** `kind.js` = value family (STRING, ARRAY, …). `type.js` = WASM numeric type (i32/f64), typed-array ctor detection, integer proofs, loop-unroll helpers (the pure PTR.TYPED aux codec lives in `layout.js`). **AST walks:** use `refsName`/`refsAny`/`some` from `ast.js` — don't hand-roll name scanners.

**ProgramIndex:** `src/compile/program-index.js` owns four disjoint numeric spaces: `sourceId` for prepared/imported functions, `variantId` for specializations, internal `graphId` for callables present when SCC reachability freezes, and `concreteId` for the final Wasm emission order, assigned once after variant identity closes (`finalizeConcreteFunctionIds` freezes `ctx.funcs.list`, so the registry carries existence, never order). At that close, `publishParameterAbi` transfers the settled parameter rows to concrete-ID slots and `programFacts.paramReps` is deleted; emission reads `parameterAbiOf`, never a name-keyed lattice. Analysis and emission follow `reachableForLowering`: a named function the frozen graph does not reach publishes no FunctionPlan and emits nothing, while prepare still rejects unsupported syntax in every body. `npm run test:reach` is the completeness gate for any change to the call-site census, roots, or edges. Use only the matching accessors (`sourceIdOf`/`sourceFunctionById`, `variantIdOf`/`variantFunctionById`, `graphFunctionIdOfName`/`graphFunctionById`, or `concreteIdOf`/`concreteFunctionById`/`concreteFunctionOrder`). Generic `functionById` and `functionIdOfName` do not exist. Every variant records one source ID; variants of variants normalize to that source. `materializeVariant` is the sole registration writer, and `finalizeVariantIdentities` closes the space after union-cursor specialization while asserting that signatures, parameter facts, and FunctionPlans are derived rather than shared. ProgramIndex also owns same-module member targets, address-taken bits, direct edges, roots (host-callable functions through the canonical `isExported`, which resolves aliases and bundle re-exports; the raw `func.exported` flag means only "declared with `export` in its own module" and is read solely by the inline-export-attribute sites in `emit-func.js` and `boundary-wrap.js`), SCC spans, reachability, and BigInt parameter/result boundaries for every callable: named sources and variants in the frozen ID arrays, anonymous closure/start identities in the append-only anonymous space (they materialize during emission, after variant identity closes). The boundary arrays carry the C1-C5b and Shape 6-9 conditions listed in `program-index.js`; RepresentationPlan owns body-local actions only. ProgramFacts carries a mutable `addressTakenNames` census only through index enrichment; ProgramIndex converts it to numeric bits and deletes the source-name key before narrowing. Every later reader uses `ProgramIndex.addressTaken`. Do not restore another function registry, member-target table, address-taken compatibility view, name-keyed target cache, or call-graph writer.

## Architecture

Current pipeline: `source → parse (subscript/jessie) → jzify (default-on; strict skips) → prepare → compile → optimize → link → watr (WAT→binary)`

**One shared optimizer, owned by watr (`~/projects/watr`).** Generic optimizer changes belong there, with tests in both projects. JZ supplies language-specific analysis, representation contracts, and lowering. The existing generic passes in `src/optimize/` are migration work: consolidate them into watr and delete JZ copies, rather than building a competing optimizer. Never patch only `node_modules`.

The tape (`src/ir/tape.js`) transports WAT through link. Settled program summaries own semantic facts; watr owns generic optimization. [PLAN.md](PLAN.md) prioritizes reliable builds and stateful audio DSP. Further IR or state refactors need a demonstrated defect, bottleneck, or deletion. Each migration slice deletes the authority it replaces.

Float32Array storage does not lower JavaScript arithmetic precision. Maps and
stencils choose their computation lanes together: f32 loads promote to f64x2,
arithmetic stays f64, and stores round to f32. Copies and sign operations can
retain f32x4 lanes. Narrow integer stores preserve the scalar conversion.

Numeric syntax has one evaluator in `static.js`. Module planning, local and
capture facts, integer proofs and template folding share it; callers retain
binding eligibility and storage limits. Module constants settle in `plan/scope.js`
before representation planning, with only unresolved declarations revisited.
The semantic summary is a snapshot stored on `ctx.summary`; it does not own the
mutable emission state beside it. Source rewrites require a fresh summary.

Closure calls capture the callee before argument effects and validate callability
after those effects. Generic, spread and member-slot calls share the same ABI
lowering in `module/function.js`; proven callable values omit the runtime check.

Fixed plain-array lengths flow from the existing builder analysis into local
and parameter ValueReps, then FunctionPlan owns them during emission. Spread,
conflicting growth, resizing, and escaping uses invalidate the proof. Equal
push counts across branches preserve it. Cold argument-free array builders stay callable
through inference; shared Watr inlining can remove their frame after lowering.
Cross-function FunctionPlan queries expose only the scalar facts and schema-ID
arrays their callers need. Scalars pass through; arrays are copied. There is no
recursive projection of arbitrary representation objects.
Record scalar replacement uses one validator for field access, nonescape and
whole-record replacement. Replacement values evaluate before any field changes;
aliases, captures, differing field sets and observed record values keep storage.

Strings store UTF-16LE code units; lengths and positions count units, while
allocation sizes and addresses count bytes. Short ASCII strings retain the
six-unit SSO representation. UTF-8 encoding belongs to byte APIs and Wasm text
metadata; host string marshalling preserves lone surrogates. Schema property
names use JSON escaping inside UTF-8 metadata to preserve every code unit.
Heap-string equality compares four code units per load with a code-unit tail;
substring views never require loads beyond their logical length.

Static data uses owned `Uint8Array` chunks (`src/static-data.js`). Producers write
bytes directly; relocation adjusts those bytes, and only WAT escaping converts
them to text. Never use `String.fromCharCode` as a binary serialization layer.
Substring interning shares one UTF-16 address calculation between copied slices
and views. Short ASCII slices return directly as SSO; the remaining copy path
always has a memory-backed source and copies whole code units.

Decimal parsing and shortest float formatting share the power-of-five generator
and its 828-byte seed table. A 245-byte correction stream restores all 651 exact
128-bit powers of ten needed by parsing. The generator returns two i64 lanes;
formatting reuses them directly instead of storing and reloading scratch memory.
No initialization state or second full power table is needed.
The shared unsigned 64×128 product supplies all three rounding limbs. Decimal
inputs whose significand and power of ten are exact f64 operands use one
multiply or divide; the full integer algorithm handles the remaining range.

Function-local layouts belong in `localReps`, carried by the function plan.
Do not publish inferred local or parameter schemas in `ctx.schema.vars`:
specialized variants reuse source binding names but can require different layouts.

Parameter initialization is owned by `jzify/arguments.js`. Ordinary functions
prepend its initializers to the body; generator factories run the same list
before creating the suspended machine. Iterator array parameters use lazy pulls
and close on early completion. Keep parameter effects outside the state machine.

Values use proven raw lanes or tagged carriers; heap values use NaN-boxing (see README). The legacy `ctx` store still carries compilation state. Consult its lifecycle ownership table in [`src/ctx.js`](src/ctx.js) before changing state; new persistent facts belong in ProgramIndex and frozen summaries, not another ambient store.

## Adding a stdlib method

1. Find or create the module file in `module/` (e.g. `module/string.js`)
2. Register the handler — plain `ctx.core.emit['name'] = fn` (`inc()` any deps inline) unless deps must auto-include or arity must be explicit, in which case `reg('name', deps, fn)` / `call` / `method` from `src/bridge.js` (see "Stdlib registration" above). WAT include deps via `deps({ … })`. Emit helpers: `flat`, `body`, `bool`, `idx`, `spread`.
3. If the handler's key is `.name` or `.kind:name` (a `.prop`-dispatched method/property, as opposed to a bare global-call name like `parseInt`), run `node scripts/gen-prop-modules.mjs` and commit the resulting `src/prop-modules.generated.js` diff — it's the derived table `includeForProperty` (`src/autoload.js`) uses to decide which modules a property NAME might auto-load at prepare() time, before value-type inference can say which module it'll actually dispatch to. `test/self-compile-includes.js`'s freshness test fails loudly (naming this command) if you forget.
4. Add tests in `test/`
5. Run `npm test`

## Adding an auto-vectorizer recognizer

Generic recognizer work belongs in watr. The discipline below also applies to the
existing JZ implementation while it migrates.

The lane vectorizer (`vectorizeLaneLocal` in [`src/optimize/vectorize.js`](src/optimize/vectorize.js))
lifts typed-array loops to WASM-SIMD. Recognizers are tried in order in its dispatch; each consumes the
shared `matchBlockLoop` descriptor and returns a wrapper or `null` — a `null` is fail-safe (the loop
stays scalar), so **never emit code you can't prove equivalent to the scalar loop.**

Discipline (non-negotiable — these run in the default `speed` build that ships to everyone):

- **Bit-exact.** Compile `{optimize:3}` vs `{optimize:3, noSimd:true}`, run N frames, compare output
  buffers byte-for-byte (0 diffs). **Seed RNG** (`randomSeed:K`) for any example using `Math.random` —
  two un-seeded instances diverge and look like a miscompile. Float reductions that reorder across lanes
  are ulp-divergent → gate at `optimize≥2`; per-lane maps/reductions reorder nothing and are exact.
- **Ratchet +0.** `npm run test:ratchet` must stay byte-identical — recognize only the intended shape;
  don't widen the default corpus path.
- **Run `npm run test:self`.** The dev suite runs on V8, but the self-compile build compiles JZ *with JZ*.
  A recognizer can be bit-exact on V8 yet make `dist/jz.wasm` fail validation
  (`i64.reinterpret_f64 expected f64, found i32`) — **the V8 suite will not catch this.**
  - *Cause & fix:* a top-level **self-recursive** helper taking the `ctx` object as a param — JZ's
    signature narrowing can't prove the recursive call passes an i32 pointer, so it leaves that one
    function's `ctx` boxed (`f64`) while every other has `ctx:i32`, and callers emit a bad reinterpret.
    Define ctx-using *recursive* lifters as **nested `function` declarations that capture `ctx`** (take
    only `expr`/`stmt` args), like `scanForLoadsStores`. No `ctx` param ⇒ nothing to mis-narrow. Also:
    don't reassign a parameter (use a local).
  - *Debug:* `compile(<self.js source>, {optimize:false, wat:true})`, map the failing `function #N` to a
    name by counting `(func $…` in order, then dump its param types — the odd `ctx:f64` is the smoking gun.

Coverage is not exhausted but is diminishing-returns vs reach work (see `.work/audit.md` §9): i32x4 cellular
automata (game-of-life/ising/rule30) and lyapunov's carried-recurrence outer-strip remain feasible;
gather/scatter loops (dla/sand/voronoi) are not — WASM-SIMD has no gather/scatter, so route them to scalar.

## Principles

- **Don't contort compiler source for microbenchmarks.** Readability wins in `src/`; optimize compiler time and retained memory only from measured, general evidence. Output speed and size remain the primary product budgets.
- **JZ source is JavaScript source.** Supported programs must parse and run as standard JavaScript. Parser acceptance of an ECMAScript early-error-invalid program is a bug/temporary hole, never a language extension or compatibility promise.
- **A finite speed dialect, not an open-ended escape hatch.** Compiled output follows the machine semantics explicitly listed under [“What differs from JS?”](README.md#what-differs-from-js): i32/i64 wrapping, unchecked typed-array access, and the other enumerated cases. Outside that list, preserve JavaScript answers, exceptions, evaluation order, and effects or reject. “A native compiler could do it” is not sufficient authority for a new divergence: update the public contract and add cross-tier exact tests before landing one. Never trade away a meaningful result's f64 accuracy (no mantissa trimming or arbitrary precision loss).
- **Minimal surface.** Every feature must justify its weight. If it can be a library, it should be.
- **No external runtime and no GC.** Needed JZ runtime operations are linked into the module; unused operations are omitted.

## Testing

### Source cleanup

`npm run lint:imports` checks unused imports in the root JavaScript modules,
`src/`, `jzify/`, and `module/`. Run `npm run lint:imports:fix` to remove them.
The ESLint configuration enables only this rule, so it does not reformat code
or remove variables. Keep initialization-only dependencies as bare imports
(`import './register.js'`); the fixer preserves those.

`npm run audit:files` uses Knip to find unreachable source modules. Package
exports and the CLI are discovered from `package.json`; `knip.json` also roots
the standalone scripts, tests, examples, benchmarks, and browser assets that
use compiler internals. Fixtures, generated output, and standalone programs
are outside the source-file deletion scope. When adding a new external loader,
include its entry point before trusting the report.

Review reported files for string-based loading and documented use before
deleting them. After that review, `npm run audit:files -- --fix --fix-type files
--allow-remove-files` removes the reported files. Run the tests below after
cleanup; an unused binding alone does not prove its module has no side effects.

### Test suites

Tests use [tst](https://github.com/dy/tst). Each file in `test/` is self-contained. Run all:

```sh
npm test
```

Run one file:

```sh
node test/strings.js
```

The suite runs once per compiler configuration (`npm run test:matrix`: default,
opt0, opt3, wasi; CI runs the four legs in parallel). A test that must hold at
several optimize levels writes `for (const optimize of levels(false, 2, 3))`
(`test/_matrix.js`): each leg runs its own level and the plain default leg also
runs O1, which no leg carries, so the matrix supplies the sweep instead of every
test compiling at every level on every leg. `JZ_TEST_SWEEP=1` runs the whole
list in one process. Files that build the kernel, spawn tooling, or pass every
option themselves are listed in `LEG_INVARIANT` / `OPT_INVARIANT` in
`test/index.js` and run on the default leg only; naming a file on the command
line runs it on any leg.

Shared helpers live in `test/util.js`: `run` (exports), `wat` (text),
`oracle(src)` (the same program evaluated by Node), `agree` (jz equals Node for
one call), `funcWat` (one function's WAT), and `cases(rows)`, which compiles a
table of `[label, arrowSource, want, ...args]` rows as one module. A compile is
almost all of a test's cost, so a family of one-assertion programs belongs in one
`cases` table, not one compile per assertion.

Release semantics also run `npm run test:262` and
`npm run test:262:builtins`. Negative-parse acceptance is an exact path set,
not a count ceiling: any change must update and explain
`test/test262-neg-accepts.json`; residual entries are blockers/inventory, not
language extensions.

## Performance & size invariant

JZ makes a load-bearing promise: **on the bench corpus, JZ wasm is at least as
fast and at least as small as the alternatives.** Concretely, enforced by
`test/bench.js` (run by CI on every push/PR — `.github/workflows/bench.yml`):

- **Speed** (`-O` speed-tuned build): JZ median ≤ V8 and AssemblyScript (`asc -O3`)
  on every comparable case, and ≤ them on geomean; ≤ Porffor's native artifact on
  every comparable case and geomean. The `porf-native` lane uses committed
  evidence because the 2026 Porffor rewrite has no wasm target. JZ wasm must
  be no larger than the corresponding Porffor native artifact per case and by
  geomean. *Live timing ratios are asserted off-CI only (local
  `npm run test:bench` on stable hardware); on CI they print informational
  because a shared 2-core runner reads identical builds up to 15× slower.
  Checksums, sizes, compile success, and the committed-evidence Porffor floor
  stay hard-gated on CI.*
- **Native parity** *(asserted only when `clang` is on PATH — i.e. locally; CI
  runners have no clang, so this pin is printed but not gated there)*: JZ wasm runs
  at `clang -O3` speed — geomean jz/C ≈ 0.86–0.98×
  (JZ *beats* native C on `poly`, `mat4`, `aos`, `tokenizer`, `sort`, ties
  `mandelbrot`). Two cases trail native and are pinned `near`, not as a parity
  claim: `biquad` is wasm-v1 ISA-bound (no scalar `fma` — hand-written WAT ties
  it too) and `json` is string-carrier bound. The geomean ceiling is the
  guarantee; the `near` per-case pins are regression backstops.
- **Size** (`optimize: 'size'` build): JZ wasm ≤ AssemblyScript (`asc -Oz --converge`)
  on every comparable case, and ≤ it on geomean. (Porffor left this axis with its
  wasm target; its native binary sizes read on the bench page's native band.)
- **Codegen slack**: `wasm-opt -Oz` should find little to remove in JZ's own
  output — whatever it shrinks is latent size headroom. Gated
  (`WASMOPT_SLACK_MIN=0.90` in `test/bench.js` — geomean ~3% slack on size
  builds, worst case ~9%; see `.work/wasm-opt-slack.md` for the per-class
  attribution); target is 0.95+, ratcheted down as codegen tightens.
- **Correctness floor**: `test/differential.js` fuzzes jz-compiled wasm against
  the same source run as plain JS — "smallest/fastest" never via a wrong answer.
- **Compiler-efficiency floor** *(v1 release blocker)*: full recursive jz×jz must
  produce bytes below wasm32's 4 GiB ceiling, then match or beat the pinned
  Porffor self-host on same-machine wall time and peak memory. A trap is a
  failure. Record Porffor's JS→C time and its full JS→native build time; JZ's
  executable-Wasm output sits between those stages. See `.work/audit.md` §10
  and the Porffor alpha 3 measurements in `.work/evidence.md`.

Run locally (needs `asc` and `wasm-opt` on PATH for the full picture; the
`porf-native` lane picks up a Porffor git checkout via `PORF_BIN`):

```sh
npm run test:bench   # the gate
npm run bench:size       # just the wasm-size table (jz vs AS -Oz, + wasm-opt slack)
npm run bench            # just the speed harness
```

**Ratchet, don't backslide.** `bench.js` carries per-case `win`/`tie`/`near`/`todo`
claims (against each competitor and against native C) and geomean ceilings. When
you make JZ beat a `todo` or close a `near` gap, promote it to `win`/`tie` in the
same PR; when you shrink codegen, tighten the relevant geomean ceiling and the
`wasm-opt` slack budget. A PR may not move any claim backward. If a change trades size for speed (or vice-versa) deliberately — e.g.
the unrolled/vectorized hot kernels — say so in the commit and adjust the
*size* budget, not the speed pin.

### Adding a bench case

1. `mkdir bench/<name>/` and add `bench/<name>/<name>.js` — valid JZ that
   `import`s `{ ... }` from `../_lib/benchlib.js`, exports `main`, and ends with
   `printResult(medianUs(samples), checksum, …)`. Use an existing case as a template.
2. For a fair size/speed comparison, add a self-contained `bench/<name>/<name>.as.ts`
   (AssemblyScript port — env imports `perfNow`/`logLine`, see `bench/bitwise/bitwise.as.ts`).
   Optional: `<name>.c` / `.rs` / `.go` / `.zig` for native baselines, `<name>.wat` for a hand-written reference.
3. Add the case to the `SPEED` and `SIZE` maps in `test/bench.js` (claims
   default to `todo` / `na`), and a `SIZE_BUDGET` backstop.
4. `npm run bench -- --cases=<name>` and `npm run bench:size -- <name>` to see where it lands.

Prefer cases that mirror real JZ target workloads (numeric/DSP/parsing/wasm-utils) —
the corpus *is* the guarantee, so widen it toward the code you actually ship.

## Commits

Small, focused commits. Describe what and why, not how.

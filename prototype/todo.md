# Staged compiler migration

Superseded by `PLAN.md` and `spec/`: the compact prototype becomes the core and the migration below is closed. This file stays as the verification record of the slices that landed, until phase 5 removes it.

## Decision

Build the compiler around one frozen program index and one function-local lowering lifetime. Keep watr as the optimizer and binary owner. Preserve the current JZ dialect exactly. Do not add language coverage while changing the architecture.

This is a migration, not a clean-room rewrite. A prototype slice may prove a representation, but production adopts it only by replacing one existing authority and deleting that authority in the same change.

Baseline:

- production semantics: branch base `2afcb255` and every correctness fix already on the prototype branch
- prototype architecture start: `b6cef777`
- backend: published `watr@5.10.1`
- direct binary encoder: frozen lower-bound control only

## Product boundary

The target is the strict set JZ accepts today. No proposal in this plan expands JavaScript support. For every existing accepted program, the migration must preserve:

- result bits where the dialect promises them
- exceptions and their observable class
- source evaluation order and effects
- single evaluation of receivers, keys, arguments, and coercions
- native, kernel, and self-host behavior
- output speed and size claims

Unsupported syntax or dynamic shapes reject. No fallback chooses between old and new compilers from source shape.

## Pipeline

```text
resolve graph
  parse each module
  optional compatibility lowering
  validate and normalize
  freeze normalized program

lower
  build ProgramIndex
  mark conservative reachability
  for each reachable function
    allocate scratch
    infer local representations, ranges, aliases, and loop facts
    canonicalize source loops
    emit scalar WAT
    simplify pointer operations and run LICM
    vectorize
    finalize function WAT
    release scratch
  assemble exports, data, start, closures, and reachable stdlib

optional watr optimize, selected by the compile profile
watr compile or print
```

`lower` is one public stage with two internal lifetimes. `ProgramIndex` survives the module. Function analysis does not.

## Ownership contracts

### Prepared program

Owns:

- normalized module ASTs
- source locations needed for diagnostics
- resolved lexical declarations and imports

Does not own:

- inferred representations
- call targets
- reachability
- WAT
- stdlib link demand discovered during emission

After preparation, no optimization mutates the AST. A canonical syntax rewrite belongs in prepare. A profitability-driven rewrite belongs in function lowering.

### ProgramIndex

Owns stable numeric IDs and persistent cross-function facts:

- functions, exports, imports, globals, schemas, types, data owners, and bindings
- direct and conservative dynamic call edges
- roots, SCCs, and reachability
- function signatures and ABI representations
- closure shape and capture summaries
- global write and purity summaries
- persistent object and storage layouts

Names remain only for source lookup, export spelling, and diagnostics. No later stage assigns another function or type identity.

Use flat pools and parallel numeric arrays. Optional fact families allocate only when the source reaches that feature. A numeric program index does not justify a second representation side map.

### Function scratch

Owns only one function's transient state:

- local binding IDs and representation refinements
- integer and range facts
- aliases and relocation proofs
- loop descriptors and transformations
- temporary instruction tape or WAT body
- optimizer worklists and counters

One explicit reset releases it. Scratch high-water must plateau after the largest function.

### Final module

Owns:

- finalized WAT functions
- reachable stdlib WAT
- exports, imports, globals, memory, tables, data, and start

The first implementation may retain finalized WAT until watr runs. Streaming or owned watr APIs are out of scope until measurements identify this retained tree as the remaining blocker.

### watr

Owns:

- generic WAT optimization
- WAT validation and normalization
- opcode and immediate encoding
- Wasm sections, LEB encoding, and final bytes

JZ does not implement a second production Wasm encoder. The direct encoder remains feature-frozen as an oracle and lower-bound measurement.

## Hard rules

1. One fact has one writer.
2. Replacing an authority deletes its previous writer in the same slice.
3. Reachability precedes expensive body analysis.
4. No whole-program body facts survive when a compact summary is enough.
5. No source-pattern fast path selects the prototype.
6. No benchmark source changes make inference easier.
7. No backend change lands with a representation or vectorizer change.
8. No optimizer move lands without exact semantic and output evidence.
9. No generated artifact is committed.
10. A clean rejection is preferable to an unproved lowering.

## Rabbit-hole budget

Architecture work stops accumulating unrelated feature repairs.

- A migration slice gets at most two working days before it must produce a passing replacement, be split smaller, or be abandoned.
- A failure in Base64, strings, JSON, regex, host marshalling, or another runtime family gets a minimal reproducer and a separate issue lane. It does not expand the compact core.
- The old production path remains authoritative until the replacement passes the exact corpus for that slice.
- A compatibility adapter may translate an existing normalized form. It may not create a second semantic implementation.
- A blocker can stop promotion. It cannot justify accepting a wrong value or weakening a gate.
- Investigation notes record the first failing source, compiler hash, phase, and last known good output. Do not spend a week rediscovering the same boundary.

## Gates for every promoted slice

### Correctness

- focused differential tests against JavaScript
- current native and kernel tests for the touched feature family
- exact negative-syntax ledger unchanged unless a parser fix explains each path
- A to A to B compiler reuse
- cold and warm compilation equality

### Representation

- one numeric ID authority
- one representation decision authority
- no identity-keyed side table added as a bridge
- no old writer left reachable

### Output

- WAT structural equality where the migration claims a refactor only
- otherwise byte-level semantic oracle and an explained WAT diff
- required `v128` remains present on pinned general SIMD kernels
- no new dynamic fallback helper in optimized kernels

### Efficiency

- source and compiler hashes recorded
- 128, 512, and 2,048-function graph slope
- phase allocation and retained heap
- largest function scratch high-water
- compiler artifact and every prototype compile case remain at least 2x better than the current compiler

### Promotion

- focused tests
- `npm test`
- `npm run test:matrix`
- `npm run test:self`
- recursive self-check after a fresh build when the production pipeline changes
- benchmark gates after correctness and architecture freeze

The isolated prototype continues to run only through:

```sh
node test/compact-prototype.js
node prototype/compact/bench.mjs
```

Do not register it in `test/index.js` or `package.json`.

## Milestones

### M0. Stage spine on the strict numeric subset

Status: implemented on the prototype branch.

- [x] split prepare, ProgramIndex, per-function lower, and backend modules
- [x] make `compiler.js` an orchestration-only entry point
- [x] route prototype output through current watr compile and its explicit optimize profile
- [x] retain the direct encoder as a frozen control
- [x] reset watr name state once per optimized compilation
- [x] keep one numeric classifier for accepted source operators
- [x] reject unsupported syntax before backend encoding
- [x] pin nested-loop scratch ownership and A to A to B determinism

Exit proof:

- staged and direct controls agree semantically on the compact corpus
- no compile state is held in module globals
- current compact tests pass

### M1. Numeric ProgramIndex and reachability

Status: first slice implemented; scaling evidence remains.

- [x] assign numeric source function and binding IDs
- [x] build flat direct-call edge storage
- [x] mark exports and their transitive callees reachable
- [x] assign final Wasm function and type IDs before lowering
- [x] omit unreachable function bodies
- [x] emit numeric function and type references to WAT
- [x] retain lower-time name lookup after measurement found no material cost; do not add a persistent tape
- [x] generate source-hashed 128, 512, and 2,048-function graphs
- [x] record parse, index, lower, watr, and output memory
- [x] prove linear total growth and plateauing scratch

Stop condition: if indexing itself exceeds 10 percent above the direct control peak, attribute the exact pool before adding syntax.

### M1a. Shared scalar-core gate

Status: implemented on the isolated prototype.

- [x] move 26 unmodified main-suite sources into one data-only corpus
- [x] make statements, pre-eval, ABI, minimal-output, differential, and determinism tests consume that corpus
- [x] execute 30 pinned calls through the raw compact ABI
- [x] move exported-parameter ABI policy from prepare into ProgramIndex
- [x] keep JavaScript coercion guards as the default contract
- [x] add an explicit typed-host raw f64 contract for unguarded numeric sources
- [x] accept empty modules and modules with no reachable export
- [x] fold constant arithmetic, constant branches, and `while(false)` during lowering
- [x] validate unsupported and unresolved source inside constant-dead code
- [x] pin raw scalar A to A to B in both optimization modes
- [x] rerun graph scaling without changing output hashes or scratch growth

Dynamic `%` and `**` remain rejected. Only fully constant forms fold. The raw ABI is not a JavaScript coercion fallback.

Verification for this slice:

- `npm test`: 3,894 pass, 1 skip
- `npm run test:opt3`: 3,894 pass, 1 skip
- `npm run test:wasi`: 3,893 pass, 1 skip
- compact prototype after typed DSP: 26 tests and 629 assertions
- self-compiled compact benchmark: threshold pass, including raw A to A to B, integer and typed kernels, and constant `%` and `**`

The opt0 matrix leg remains red on the standalone `test/date.js` shared-dispatch `.valueOf()` case that predates this prototype slice. Functional self-compile passed 22 tests and 212 assertions; its separate performance process remains red because `scripts/self.js` reads an undefined `__heap_mark`. Both failures stay outside the compact feature lane.

### M1b. Scalar control completion

Status: implemented on the isolated prototype.

- [x] add numeric function-local control IDs and lexical target records
- [x] lower labeled and unlabeled break and continue through named WAT targets
- [x] make `for` continue execute the step and `do` continue execute the condition
- [x] support omitted `for` initialization, condition, and step
- [x] admit infinite loops only when completion analysis proves no fallthrough
- [x] support prefix and postfix update values without repeated source evaluation
- [x] support ordered comma expressions and grouped comma call arguments
- [x] support value-preserving numeric `&&` and `||` with reusable temporary locals
- [x] specialize logical conditions to i32 without boxing comparison operands
- [x] record maximum control depth and temporary-local demand in function scratch
- [x] run every control case before and after watr optimization

Watr 5.10.1 CSE does not invalidate expressions that read numeric local indices after a numeric-index write. The compact lowerer now presents local names derived from numeric binding IDs at the optimizer boundary, preserving numeric authority and byte-identical binaries. The general watr fix and regression are committed in sibling revision `b53c92c`. It remains unpublished because watr's separate Wasm-hosted test gate is red on its pre-existing unknown-instruction error-message case.

### M1c. Scalar integer representations

Status: implemented on the isolated prototype.

- [x] add f64, signed-i32, and unsigned-i32 representation IDs
- [x] infer internal direct-call result representations before final type IDs
- [x] infer local representation and range facts in disposable function scratch
- [x] keep JavaScript and raw host ABI parameters and exports physically f64
- [x] lower `&`, `|`, `^`, `~`, `<<`, `>>`, `>>>`, and compound assignments
- [x] lower `Math.imul` and `Math.clz32`
- [x] implement exact `ToInt32` and `ToUint32` for every f64 bit pattern
- [x] assign one ProgramIndex identity and share unknown conversion through that module-owned helper
- [x] keep finalized WAT free of representation and range metadata
- [x] consume unchanged rows from unsigned, math, statements, and differential tests
- [x] preserve graph output hashes and one-slot scratch on f64-only graphs

Comparison values remain rejected outside condition positions. Dynamic `%` and `**` remain rejected. The exact bitwise benchmark row emits 212 bytes versus production's 120 bytes, so this slice is proven semantically but is not eligible for production promotion yet. Typed-memory range and storage proofs must remove the general helper from proven kernels without weakening unknown-value semantics.

### M1d. Float64Array DSP proof

Status: implemented on the isolated prototype. Standalone feature expansion stops here.

- [x] prepare fixed module-level `Float64Array` owners, full aliases, and `subarray(0)` views
- [x] assign storage bases, owner IDs, alias groups, element widths, and relocation states in ProgramIndex
- [x] allocate storage fact families only when source declares typed storage
- [x] record direct storage reads and writes plus transitive function purity
- [x] validate every source function, including unreachable bodies, for proven in-range access
- [x] lower f64 loads and stores through raw i32 pointers
- [x] hoist scalar loop bases and advance pointer induction by eight bytes
- [x] vectorize pure maps with f64x2 arithmetic and sixteen-byte pointer induction
- [x] hoist invariant scalar splats and emit odd-length scalar cleanup
- [x] preserve byte-identical scalar and SIMD memory before and after watr optimization
- [x] keep alias, relocation, range, local-effect, and global-write vetoes scalar
- [x] pin typed A to A to B reuse in both optimization modes
- [x] preserve every generated graph output hash and one-slot scratch on storage-free graphs

Runtime direction on a 4,097-element map is 4.69x SIMD over scalar, with identical result and 65,552 memory bytes. The self-hosted typed compile row is 15.97x faster and emits 287 bytes versus production's 568 bytes. The compact artifact is 2,234,176 bytes versus 14,415,726 bytes. These timings were gathered on swapped machines and do not certify release performance.

The exact integer row remains a visible 212-byte loss versus production's 120 bytes. That per-case loss blocks promotion of the integer lowering even though the typed row wins. Do not weaken exact conversion to close it.

### Prototype review hardening

- [x] replace the overlapping result-representation and local-native classifiers with one shared expression fact kernel
- [x] test both signs and multiple mantissas around IEEE exponent fields 1076 and 1107
- [x] document signed WAT literals for modulo-2^32 storage bases
- [x] keep the three subset grammar walks frozen instead of growing another dispatch framework
- [x] keep the direct encoder independent
- [x] retain measured lower-time name scans and reject a persistent numeric instruction tape

Production migration reuses the normalized production program and existing emitter. It does not transplant the compact subset's grammar walks or its vestigial value-wrapper call shape.

### M2. Production identity migration

- [x] define the production ProgramIndex lifecycle on `ctx.plans`
- [x] assign stable numeric IDs to prepared and imported functions
- [x] migrate same-module member targets to numeric IDs
- [x] redirect every member-target reader through `resolveMemberSourceId` and `sourceFunctionById`
- [x] delete the superseded CallTargetIndex file, maps, API, and writer
- [x] preserve all 568 production refactor-oracle outputs byte for byte
- [x] move direct call edges and roots from the narrowing reachability filter into ProgramIndex
- [x] add conservative address-taken roots and SCC-condensed reachability summaries
- [x] transfer the mutable address-taken census to numeric ProgramIndex bits and a read-only compatibility view
- [x] separate source, variant, and graph IDs with no generic integer accessor
- [x] register all five specialization families through ProgramIndex and normalize variants of variants to one source ID
- [x] assert variant signatures, parameter facts, and FunctionPlans are derived rather than shared
- [x] delete the source-name address-taken census at ProgramIndex build and route every later reader to numeric bits
- [x] assign final concrete Wasm function IDs after variant identity closes
- [ ] assign final type, global, schema, and data IDs once

The type/global/schema/data close is evidence-triggered: schema mint, static-data intern, the globals snapshot, and the $ftN finalizer are each single-writer today, so a numeric ProgramIndex close without a consumer would only add a parallel path. It lands with M4 lowering or M6 assembly, the first stage that needs those IDs before emission.

First production slice verification:

- native: 3,895 pass, 1 skip
- opt3: 3,895 pass, 1 skip
- WASI: 3,894 pass, 1 skip
- functional self-compile: 22 tests and 212 assertions
- refactor oracle: all 568 outputs byte-identical to `54956f0e`
- recursive self-compile: 321 modules, 6,840,880 input bytes, 14,016,983 output bytes, 4,106,338,664 heap bytes, 188,628,632 bytes headroom

The opt0 leg reaches the same pre-existing shared-dispatch `Date.valueOf()` failure after 3,894 passes and one skip. Recursive completion remains green, but its memory efficiency remains red. Do not migrate representations in the same change.

Second production slice verification:

- direct edges and SCC spans use flat CSR, with no retained per-caller or per-component buckets
- the prior nested-bucket attempt was rejected after warm self-host round two trapped on a two-argument direct call
- a 12-function independent transitive closure agrees with every ProgramIndex SCC pair and reachable ID
- lifted-value release runs before roots freeze; ProgramIndex then deletes the source-name census and owns every later address-taken read
- native: 3,896 pass, 1 skip
- opt3: 3,896 pass, 1 skip
- WASI: 3,895 pass, 1 skip
- functional self-compile: 23 tests and 224 assertions, including four compile-clear direct-call rounds
- refactor oracle: all 568 outputs remain byte-identical across the direct-edge and SCC slices
- recursive self-compile: 321 modules, 6,849,173 input bytes, 14,042,851 output bytes, 4,111,732,856 heap bytes, 183,234,440 bytes headroom
- compact threshold: pass at 2,256,496 bytes versus the 14,483,762-byte production compiler

Third production slice verification:

- source IDs, variant IDs, and graph IDs have separate arrays and accessors; generic integer accessors are absent
- fixed-rest, typed-ctor, VAL-kind, union-cursor, and typed-guard variants register through one materializer
- a variant of a variant resolves to the original source ID
- variant signatures, parameter facts, and FunctionPlans are asserted distinct from source facts before emission
- native: 3,898 pass, 1 skip
- opt3: 3,898 pass, 1 skip
- WASI: 3,897 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- functional self-compile: 23 tests and 224 assertions, including forty compile-clear rounds
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,856,720 input bytes, 14,061,026 output bytes, 4,115,653,840 heap bytes, 179,313,456 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,501,939-byte production compiler

Fourth production slice verification:

- ProgramFacts uses `addressTakenNames` only as a pre-index source census
- ProgramIndex converts that census to numeric bits and removes the key before narrowing
- every narrowing, representation, closure, and slot-hazard reader now uses `ProgramIndex.addressTaken`
- native: 3,898 pass, 1 skip
- opt3: 3,898 pass, 1 skip
- WASI: 3,897 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- functional self-compile: 23 tests and 224 assertions, including forty compile-clear rounds
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,856,174 input bytes, 14,061,598 output bytes, 4,116,258,840 heap bytes, 178,708,456 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,502,495-byte production compiler

Fifth production slice verification:

- concrete Wasm function IDs are assigned once after variant identity closes; `finalizeConcreteFunctionIds` freezes `ctx.funcs.list`, so the registry carries existence, never order
- function emission, boundary-wrapper synthesis, and late export metadata iterate the frozen concrete order through explicit per-space accessors; no generic accessor exists
- native: 3,901 pass, 1 skip
- opt3: 3,901 pass, 1 skip
- WASI: 3,900 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,864,583 input bytes, 14,078,604 output bytes, 4,119,704,568 heap bytes, 175,262,728 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,519,509-byte production compiler

Sixth production slice verification (attributed byte diff):

- one host-callability predicate: `isExportedIn` in `func-exports.js` resolves the syntactic flag plus `ctx.funcs.exports` alias and re-export targets; ProgramIndex roots, narrowing coverage, host-ABI gates, inlining, hazard and literal censuses, and the active-function frame read it, and the representation-plan copy delegates to it
- the raw `func.exported` flag survives only where the syntactic fact is the question, the inline export-attribute sites in `emit-func.js` and `boundary-wrap.js`, pinned by a source scan over `src` and `module`
- reproducer: the watr bundle carried 5 re-exported entry points (`watr`, `compile`, `parse`, `print`, `sourceMapURL`) with `exported=false`, three of them index-unreachable; a bundle re-export pin now asserts the target and a callee reached only through it are roots
- refactor oracle: 564 outputs byte-identical; the 4 watr rows differ by +120, +155, +252, and +128 bytes at O0, O2, O3, and size. Attribution: the re-exported entry points' call sites re-enter the lattice; `m6_template$compile.backend` widens i32 to f64 because `m6_template$watr`'s site now joins the consensus (the old i32 came from a census that had dropped that caller), `m6_template$watr.backend` narrows f64 to i32 on the evidence it now has, and one extra hoisted constant renumbers 57 otherwise-unchanged functions
- native: 3,903 pass, 1 skip
- opt3: 3,903 pass, 1 skip
- WASI: 3,902 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- recursive self-compile: 321 modules, 6,868,457 input bytes, 14,082,566 output bytes, 4,121,053,816 heap bytes, 173,913,480 bytes headroom; elapsed unchanged at 30,953 ms
- compact threshold: pass at 2,256,528 bytes versus the 14,523,519-byte production compiler

Seventh production slice verification (attributed byte diff):

- `.`-member calls on bare-name receivers are censused during the facts walk (`memberCallSites`, module-init sites included) and resolved at index build through `resolveMemberSourceId` into direct-call graph edges, with module-scope member calls as roots; the census key retires at the build
- nested receivers are excluded: a named function stored in a nested literal is address-taken and already a root
- pins: a member-property call is an edge, a callee reached only inside the property body is reachable, a module-scope member call roots its target, and the census key is deleted after the build
- watr probe at O3: index-unreachable emitted functions fell from 7 to 2; the residual pair rides `encode[t].parse(...)`, recorded in the next-slice section
- refactor oracle: 561 outputs byte-identical; 7 watr-derived rows shrink by 25 to 970 bytes. Attribution: exactly one function changes, `m1_encode$cleanInt` (402 to 369 lines). Its callers `i32.parse` and `i64.parse` were index-unreachable, so their `cleanInt(n)` sites had been dropped from the lattice; with the edges those sites return and `v` narrows on complete evidence
- native: 3,904 pass, 1 skip
- opt3: 3,904 pass, 1 skip
- WASI: 3,903 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- recursive self-compile: 321 modules, 6,871,110 input bytes, 14,089,750 output bytes, 4,122,542,760 heap bytes, 172,424,536 bytes headroom; elapsed 31,265 ms
- compact threshold: pass at 2,256,498 bytes versus the 14,530,671-byte production compiler; the staged artifact shrank 30 bytes on the same complete-evidence effect

Eighth production slice verification (attributed byte diff):

- namespace-computed dispatch (`ns[k](args)`, `ns[k].prop(args)`) is censused as `memberDispatchSites` on the lowered `?:` chains and synthesized at index build into one direct call site per resolved arm; inside inline dispatch-table arrows the computed-dispatch hop synthesizes the same two forms, and every resolved inner call now records a graph edge even when its lattice site is declined on an arity shortfall (bare-name inner calls included, which lost the edge before)
- pins: a member call on the lowered chain reaches each arm's member target; an arm called with an arity shortfall inside an inline dispatch member keeps its graph edge
- watr probe at O3: zero emitted-but-unreachable functions (from 2); the eight index-dead functions are all treeshaken
- refactor oracle: 560 outputs byte-identical; 8 watr-derived rows shrink by 6 bytes each. Attribution: `m0_compile$parseUint` and `m1_encode$f32` each turn a `(result i64)` block with reinterpret round-trips into `(result f64)` once a dispatch-synthesized site supplies numeric kind evidence for a parameter
- native: 3,905 pass, 1 skip
- opt3: 3,905 pass, 1 skip
- WASI: 3,904 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- recursive self-compile: 321 modules, 6,875,608 input bytes, 14,100,810 output bytes, 4,125,719,984 heap bytes, 169,247,312 bytes headroom; elapsed 31,308 ms
- compact threshold: pass at 2,256,492 bytes versus the 14,541,732-byte production compiler
- compiler artifact +11,061 bytes: the compiler's own dispatch-table sites now feed its lattice, widening parameters that had narrowed on partial evidence

Ninth production slice verification (attributed byte diff):

- ProgramIndex reachability closes on the whole refactor-oracle corpus: `npm run test:reach` (`scripts/reachability-probe.mjs`) compiles all 142 specimens at O3 and reports zero emitted-but-unreachable functions (jessie had 14 after the dispatch slice)
- classes closed: every lifted implementation of a multi-written function property (`ctx.funcs.multiProp` now maps each key to its lifts) is address-taken and rooted; `?.()` calls census like `()`; a function reference stored by a module-init write roots its target without becoming address-taken; default-parameter expressions are walked as their function's own facts (subscript's `dispatch(ops, tail, fn = (a, ...) => { ... loc(r, from) ... })`)
- pins: one invariant test per class, four in all
- refactor oracle: 564 outputs byte-identical; the 4 jessie rows grow by 3 to 10 bytes. Attribution: the multi-written `parse.id` family; the first implementation's result widens i32 to f64 to the uniform slot ABI now that it is address-taken, the second drops a redundant convert, and the dispatch trampoline gains the boolean normalization, so both implementations behind one mutable slot share one result ABI
- native: 3,906 pass, 1 skip
- opt3: 3,906 pass, 1 skip
- WASI: 3,905 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- recursive self-compile: 321 modules, 6,877,828 input bytes, 14,101,637 output bytes, 4,125,883,160 heap bytes, 169,084,136 bytes headroom; elapsed 31,760 ms
- compact threshold: pass at 2,256,358 bytes versus the 14,542,559-byte production compiler

Per-slice recursive and artifact ratchet:

| Production migration slice | Compiler bytes | Recursive heap bytes | Headroom bytes | Change from prior |
| --- | ---: | ---: | ---: | ---: |
| member source IDs | 14,457,881 | 4,106,338,664 | 188,628,632 | baseline |
| direct graph, SCCs, address-taken | 14,483,762 | 4,111,732,856 | 183,234,440 | +25,881 bytes, -5,394,192 headroom |
| source and variant ID split | 14,501,939 | 4,115,653,840 | 179,313,456 | +18,177 bytes, -3,920,984 headroom |
| delete address-taken compatibility | 14,502,495 | 4,116,258,840 | 178,708,456 | +556 bytes, -605,000 headroom |
| named BigInt ABI boundaries | 14,509,328 | 4,117,821,616 | 177,145,680 | +6,833 bytes, -1,562,776 headroom |
| anonymous BigInt boundaries | 14,509,947 | 4,117,854,848 | 177,112,448 | +619 bytes, -33,232 headroom |
| concrete Wasm function IDs | 14,519,509 | 4,119,704,568 | 175,262,728 | +9,562 bytes, -1,849,720 headroom |
| parameter-ABI emission rows | 14,522,343 | 4,120,236,904 | 174,730,392 | +2,834 bytes, -532,336 headroom |
| SRoA collect-during-analyze | 14,523,120 | 4,120,384,696 | 174,582,600 | +777 bytes, -147,792 headroom |
| canonical export roots | 14,523,519 | 4,121,053,816 | 173,913,480 | +399 bytes, -669,120 headroom |
| member-call edges | 14,530,671 | 4,122,542,760 | 172,424,536 | +7,152 bytes, -1,488,944 headroom |
| namespace dispatch sites | 14,541,732 | 4,125,719,984 | 169,247,312 | +11,061 bytes, -3,177,224 headroom |
| corpus reachability closure | 14,542,559 | 4,125,883,160 | 169,084,136 | +827 bytes, -163,176 headroom |
| reachability gate | 14,415,726 | 4,090,501,072 | 204,466,224 | -126,833 bytes, +35,382,088 headroom |

A slice that consumes 50 MiB of recursive headroom is an attributed finding before promotion, not deferred debt. Compiler artifact growth is recorded in the same table even when correctness output is unchanged.

### M3. Representation and typed storage

Migrate one decision family at a time:

1. [x] named-function BigInt parameter and result boundaries
2. [x] anonymous closure/start BigInt boundaries
3. [ ] non-BigInt parameter and result ABI (first slice landed: emission parameter rows transfer to concrete-ID slots at close and `programFacts.paramReps` dies there; the lattice remains name-keyed inside plan, and result ABI remains on the narrowed signature)
4. [ ] local numeric versus pointer representation
5. [ ] typed storage constructor and element width
6. [ ] pointer relocation and never-grown facts
7. [ ] alias groups
8. [ ] body-local BigInt actions
9. [ ] closure capture representation

For each family:

- [ ] copy the producer's C1-C5b and shape #6-#9 soundness conditions into the ProgramIndex field documentation
- [ ] run the complete `test/data.js` pin set through both native and kernel targets
- [ ] add numeric ProgramIndex or function-scratch fields
- [ ] redirect every reader
- [ ] delete the old plan writer and identity side tables
- [ ] run focused coercion, TypedArray, BigInt, closure, and host-boundary tests
- [ ] pin f64, i32 pointer, and i64 host-carrier WAT shapes

Representation migration is complete only when `RepresentationPlan`, `TypedStoragePlan`, and parameter representation maps have either become views of ProgramIndex or have been deleted. There must not be two authorities during a release candidate.

Before the first representation slice that intentionally changes bytes, record the expected WAT decision change, its producer, and its affected oracle rows. Promotion then requires an attributed oracle diff, the full native/opt3/WASI battery, kernel `test/data.js`, and the ledger pins. A dirty oracle without that attribution remains a failure.

Named-function BigInt boundary slice verification:

- ProgramIndex source and variant arrays own named parameter/result boundary records
- RepresentationPlan records for named functions retain body facts only; anonymous closure/start boundaries remain there without identity overlap
- C1-C5b and Shape 6-9 soundness conditions are copied onto the ProgramIndex boundary family
- direct call argument readers now carry the callee identity rather than recovering authority from a parameter-array object
- native: 3,899 pass, 1 skip
- opt3: 3,899 pass, 1 skip
- WASI: 3,898 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,860,013 input bytes, 14,068,399 output bytes, 4,117,821,616 heap bytes, 177,145,680 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,509,328-byte production compiler

Anonymous closure/start BigInt boundary slice verification:

- ProgramIndex owns every parameter/result boundary; anonymous closure bodies and the synthetic start frame publish into an append-only anonymous space that opens after variant identity closes
- the identity-keyed RepresentationPlan boundary writer is deleted; records carry body facts only, and a source scan pins the absence of any boundary-field assignment
- duplicate anonymous publish throws, an indexed identity never aliases the anonymous space, and a missing ProgramIndex fails the publish immediately
- native: 3,900 pass, 1 skip
- opt3: 3,900 pass, 1 skip
- WASI: 3,899 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,861,127 input bytes, 14,069,042 output bytes, 4,117,854,848 heap bytes, 177,112,448 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,509,947-byte production compiler

Non-BigInt parameter-ABI emission slice verification:

- `publishParameterAbi` transfers the settled parameter rows to concrete-ID slots at close; `programFacts.paramReps` dies there through the retired-key pattern (a static-key delete is rejected by the self-hosted build, by design)
- emission reads `parameterAbiOf`; a source scan pins `emit-func.js` free of the analysis lattice
- native: 3,901 pass, 1 skip
- opt3: 3,901 pass, 1 skip
- WASI: 3,900 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,865,967 input bytes, 14,081,405 output bytes, 4,120,236,904 heap bytes, 174,730,392 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,522,343-byte production compiler

### M4. Function-at-a-time lowering

- [x] split correctness validation from expensive optimization analysis (validation rejects at prepare, before any analysis; the gate below skips analysis, never validation)
- [x] validate unsupported syntax in all functions, including unreachable ones
- [x] analyze only reachable bodies
- [ ] lower one function through the existing scalar WAT emitter
- [ ] transfer its finalized body to module ownership
- [ ] reset all local facts, plans, worklists, and temporary IR
- [ ] prove no FunctionPlan or AST identity map survives the reset
- [ ] compile once in canonical function order and once in reverse lowering order, then assert byte identity after canonical assembly
- [ ] remove all-functions analyze-then-emit storage

Initial promotion must preserve emitted WAT. Do not redesign the emitter while changing its lifetime.

Reachability gate slice verification (attributed byte diff):

- `reachableForLowering` (ProgramIndex) gates `analyzeFuncs`, union-cursor clone analysis, and function emission: a named function the frozen graph does not reach publishes no FunctionPlan and emits nothing; raw WAT functions always lower and a late variant follows its source
- validation is untouched: unsupported syntax in an unreachable body still rejects at prepare, pinned at both optimize levels
- the host last-error channel follows the source: `hasThrow` is a program fact, so a `throw` in a never-lowered function still declares and exports `__jz_last_err_bits`
- escape classes closed for the gate: a function-property read in value position takes the member's address and roots the base; a truthiness-test read (`&&`, `||`, `!`, `?:`, `if`, `while`, `do`, `for`, `??`) roots without taking the address; a write target reads nothing; `ns.prop?.(args)` roots base and member; a global-devirtualized arrow takes the address; any function reference in a value position of a module-init statement is a root
- `npm run test:reach`: 142 specimens, zero compile errors, zero unsound functions
- refactor oracle: 297 of 568 outputs differ, 244 smaller, 53 same size (renumbering), none larger, no error-class change; 730,740 bytes removed across the corpus
- `test/parser-bugs.js`'s quiescence pin now exercises `Promise.try`, so the drain helper it asserts is live; a dead runtime helper leaves no trace, like any dead function
- native: 3,908 pass, 1 skip
- opt3: 3,908 pass, 1 skip
- WASI: 3,907 pass, 1 skip
- opt0: 3,907 pass with only the recorded `Date.valueOf()` shared-dispatch failure
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- recursive self-compile: 321 modules, 6,884,118 input bytes, 13,974,679 output bytes, 4,090,501,072 heap bytes, 204,466,224 bytes headroom (35,382,088 more); elapsed 31,359 ms
- compact threshold: pass at 2,234,176 bytes (22,182 fewer) versus the 14,415,726-byte production compiler (126,833 fewer)

### M5. Loop optimization and SIMD

- [ ] express required module facts as compact summaries before body lowering (first slice landed: structInline and unionInline collect per-function summaries inside the analyze loop and decide from summaries alone; no FunctionPlan or body is read after that loop)
- [ ] move source loop transforms into function lowering
- [ ] run scalar pointer cleanup and LICM on the current WAT shape
- [ ] run the existing vectorizer before function finalization
- [ ] retain pure-call and global-write summaries without retaining other bodies
- [ ] pin typed-array self-map, reduction, SLP, alias veto, and relocation veto kernels
- [ ] preserve bit-exact SIMD versus scalar output where required

No DSP-only compiler path is allowed. Every proof must describe a general program shape.

SRoA summary-collection slice verification:

- `structInlinePass`/`unionInlinePass` collect per-function facts inside the analyze loop, right after each plan publishes; the finish step reads only collected summaries, module inits, and schema censuses
- every fact the collectors read (callee array facts, paramReps rows, schema censuses, constInts) settles before the analyze loop, so collection sees exactly what the retired post-analyze sweeps saw
- native: 3,901 pass, 1 skip
- opt3: 3,901 pass, 1 skip
- WASI: 3,900 pass, 1 skip
- kernel-target `test/data.js`: 210 tests and 1,162 assertions
- kernel oracle: 15 tests and 738 assertions
- functional self-compile: 23 tests and 224 assertions
- refactor oracle: all 568 outputs remain byte-identical
- recursive self-compile: 321 modules, 6,867,285 input bytes, 14,082,167 output bytes, 4,120,384,696 heap bytes, 174,582,600 bytes headroom
- compact threshold: pass at 2,256,528 bytes versus the 14,523,120-byte production compiler

### M6. Module assembly

- [ ] make stdlib dependencies declarative before emission where possible
- [ ] compute reachable stdlib from ProgramIndex and finalized body demand
- [ ] finalize closures without discovery waves over retained bodies
- [ ] attach data to explicit owners
- [ ] assemble start, imports, exports, globals, memory, tables, and data once
- [ ] remove late fact discovery from emit
- [ ] keep snapshotting disabled or single-image where a second full encode has no measured value

### M7. Remove transitional architecture

- [ ] delete whole-program FunctionPlan retention
- [ ] delete checkpoint, park, unpark, and rehydration machinery
- [ ] delete source rewriting of watr
- [ ] delete duplicate codecs
- [ ] keep the direct encoder only under the isolated prototype, or remove it after the final backend attribution
- [ ] update `CONTRIBUTING.md` and stage contracts to describe the surviving pipeline

### M8. Release evidence

After architecture and correctness freeze:

- [ ] full test matrix
- [ ] test262 language and builtins
- [ ] native and kernel parity
- [ ] functional self-compile
- [ ] recursive self-compile from a fresh build
- [ ] fixpoint and reuse
- [ ] strict per-case size leadership
- [ ] stable-machine speed evidence
- [ ] pinned Porffor comparison

No timing gathered on a swapped or loaded machine certifies release performance.

## Current prototype files

```text
prototype/compact/compiler.js       stage orchestrator
prototype/compact/prepare.js        strict front-end boundary
prototype/compact/program-index.js  numeric persistent authority
prototype/compact/reps.js           scalar representation IDs
prototype/compact/ops.js            source-operator classifier authority
prototype/compact/constants.js      scalar constant-evaluation authority
prototype/compact/lower.js          function-local scalar WAT lowering
prototype/compact/backend.js        unchanged watr boundary
prototype/compact/direct.js         frozen direct-binary control
prototype/compact/graph-bench.mjs   source-hashed graph allocation experiment
prototype/compact/dsp-bench.mjs     typed-map runtime direction
prototype/compact/dsp-evidence.md   typed correctness and performance record
prototype/compact/bench.mjs         artifact and compile comparison
```

The current ProgramIndex still retains body ASTs and source names. Lowering still performs name lookup for locals and calls. Final WAT functions remain live until whole-module watr optimization. These are explicit debts, not hidden claims.

## Immediate next slice

Identity is closed and emission consumes ProgramIndex parameter-ABI rows. M4 sequencing, with probe evidence recorded 2026-09-01:

1. The reachability gate has landed: analysis and emission follow ProgramIndex reachability, validation stays at prepare, and `npm run test:reach` (`scripts/reachability-probe.mjs`) is the completeness gate for every later census change (142 specimens, zero compile errors, zero unsound functions). Its attributed diff removed 730,740 bytes across the corpus and 126,833 bytes from the compiler artifact.
2. The byte-preserving M4 lifetime slice (analyze, lower, transfer, reset per function) is closer: structInline and unionInline now collect per-function summaries inside the analyze loop and decide from summaries alone. Remaining between analyze and emit: union-cursor cloning (whole-program specialization over the settled registry) and the identity/ABI closes, all of which need only an analyze-complete barrier, not retained plans or bodies.
3. Remaining M3 families stay open behind these: local and typed-storage decisions already have single per-function authorities minted at analyze time; their re-homing lands with the M4 lifetime change that shortens their lifetimes.

Do not add more prototype syntax. The completed graph experiment is recorded in `compact/graph-evidence.md`. It found byte-identical output, linear retained growth, and plateauing function scratch. Lower-time name lookup was not material. Finalized WAT was the largest staged-only owner, so an owned watr API remains an evidence-triggered backend lane rather than a reason to add a numeric body tape.

## Expert test

The stage structure is sound. Experts would reject two possible interpretations of it:

- rebuilding all current JZ semantics from scratch inside the prototype
- treating clean architecture as permission to invent abstractions before measurements require them

The defensible plan is narrower: preserve the current language and output, install one stable identity authority, shorten lifetimes, and keep watr fixed. Each slice must remove existing machinery. If a slice only adds a cleaner parallel path, it has failed the architecture goal.

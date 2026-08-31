# Staged compiler migration

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
- [ ] replace lower-time name lookup with a per-function numeric instruction tape
- [ ] generate source-hashed 128, 512, and 2,048-function graphs
- [ ] record parse, index, lower, watr, and output memory
- [ ] prove linear total growth and plateauing scratch

Stop condition: if indexing itself exceeds 10 percent above the direct control peak, attribute the exact pool before adding syntax.

### M2. Production identity migration

- [ ] define production ProgramIndex field constants and lifecycle contract
- [ ] migrate frozen CallTargetIndex IDs and edges into it
- [ ] delete the superseded call-target maps and writers
- [ ] add conservative dynamic-call roots and SCC summaries
- [ ] assign final function, type, global, schema, and data IDs once
- [ ] preserve production WAT byte-for-byte for this identity-only slice

Do not migrate representations in the same change.

### M3. Representation and typed storage

Migrate one decision family at a time:

1. parameter and result ABI
2. local numeric versus pointer representation
3. typed storage constructor and element width
4. pointer relocation and never-grown facts
5. alias groups
6. BigInt boundary actions
7. closure capture representation

For each family:

- [ ] add numeric ProgramIndex or function-scratch fields
- [ ] redirect every reader
- [ ] delete the old plan writer and identity side tables
- [ ] run focused coercion, TypedArray, BigInt, closure, and host-boundary tests
- [ ] pin f64, i32 pointer, and i64 host-carrier WAT shapes

Representation migration is complete only when `RepresentationPlan`, `TypedStoragePlan`, and parameter representation maps have either become views of ProgramIndex or have been deleted. There must not be two authorities during a release candidate.

### M4. Function-at-a-time lowering

- [ ] split correctness validation from expensive optimization analysis
- [ ] validate unsupported syntax in all functions, including unreachable ones
- [ ] analyze only reachable bodies
- [ ] lower one function through the existing scalar WAT emitter
- [ ] transfer its finalized body to module ownership
- [ ] reset all local facts, plans, worklists, and temporary IR
- [ ] prove no FunctionPlan or AST identity map survives the reset
- [ ] remove all-functions analyze-then-emit storage

Initial promotion must preserve emitted WAT. Do not redesign the emitter while changing its lifetime.

### M5. Loop optimization and SIMD

- [ ] express required module facts as compact summaries before body lowering
- [ ] move source loop transforms into function lowering
- [ ] run scalar pointer cleanup and LICM on the current WAT shape
- [ ] run the existing vectorizer before function finalization
- [ ] retain pure-call and global-write summaries without retaining other bodies
- [ ] pin typed-array self-map, reduction, SLP, alias veto, and relocation veto kernels
- [ ] preserve bit-exact SIMD versus scalar output where required

No DSP-only compiler path is allowed. Every proof must describe a general program shape.

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
prototype/compact/ops.js            source-operator classifier authority
prototype/compact/lower.js          function-local scalar WAT lowering
prototype/compact/backend.js        unchanged watr boundary
prototype/compact/direct.js         frozen direct-binary control
prototype/compact/bench.mjs         artifact and compile comparison
```

The current ProgramIndex still retains body ASTs and source names. Lowering still performs name lookup for locals and calls. Final WAT functions remain live until whole-module watr optimization. These are explicit debts, not hidden claims.

## Immediate next slice

Implement the generated graph experiment before adding any source feature:

1. Generate equal-shape direct-call graphs at 128, 512, and 2,048 functions.
2. Compile each with the staged watr backend and frozen direct control.
3. Verify result equality, emitted module validity, and reachable-body counts.
4. Record source hash, compiler hash, output hash, phase time, heap after phase GC, and max function scratch.
5. Replace lower-time call-name resolution with a numeric per-function tape only if measurements show that retained lookup or repeated traversal matters.

The experiment decides the next allocation owner. It does not decide a preferred backend in advance.

## Expert test

The stage structure is sound. Experts would reject two possible interpretations of it:

- rebuilding all current JZ semantics from scratch inside the prototype
- treating clean architecture as permission to invent abstractions before measurements require them

The defensible plan is narrower: preserve the current language and output, install one stable identity authority, shorten lifetimes, and keep watr fixed. Each slice must remove existing machinery. If a slice only adds a cleaner parallel path, it has failed the architecture goal.

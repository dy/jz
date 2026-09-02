# JZ core plan

## Decision

The compact prototype is the compiler. It grows into the core under `core/`, ships as the compiler when it passes the good-parts corpus, and the current `src/` pipeline retires then. The prototype is not a sub-product from this point: it has its own tests, its own gates, and its own release path from phase 1 on.

The product is good-parts JS: a documented subset of JavaScript compiled to efficient, small, safe wasm, on one lattice of kinds. Typed functions carry static kinds with no boxing; a function that needs the tagged `any` kind is boxed and calls a small runtime written in jz for those operations. The tier of every function is decided by rule and reported, never guessed per value. Memory is regions with a deterministic release, no collector. Divergence from JS is rejected or reported at compile time, never silent.

The specs in `spec/` define the product. This file sequences the work. `prototype/todo.md` is the record of the retired migration plan and stays only as evidence until phase 5.

## What transfers from the current compiler

- `test/`: the corpus that defines the good-parts subset empirically. Ported in subset order (phase 4), never bulk-copied.
- `module/*.js` WAT templates: the reference behavior for the runtime rewritten in jz (phase 2).
- `bench/` and `examples/`: the performance evidence set, used as regression gates against ourselves.
- `scripts/reachability-probe.mjs` and the eight call-graph classes it pinned: the completeness gate for the core's call graph.
- `prototype/compact/`: the seed of `core/` (no global compile state, per-function scratch, numeric identity index, watr backend).

Code outside these does not transfer. Where a behavior is needed, the corpus defines it and the core reimplements it on the IR.

## Phases

Each phase ends with an exit proof. No phase starts before the previous exit proof holds. A slice inside a phase is at most two working days, lands with its differential tests, and deletes what it replaces.

### Phase 0. Product specification

- [x] `spec/subset.md`: the kinds and their contracts, the runtime, what is rejected, and the divergence policy.
- [x] `spec/tiers.md`: one lattice with `any` as top, the tier rule, the signature fixpoint, and the tier report.
- [x] `spec/boundary.md`: the typed/boxed boundary and the two host ABIs.
- [x] `spec/memory.md`: regions with per-call release, the session region, named regions; one linear-memory target.

Exit proof: every current test file maps to typed kinds, runtime kinds and `any`, compiler evidence, or rejection in `spec/subset.md`, and every README "what differs from JS" item is a corrected behavior, a contract, or a reported divergence.

### Phase 1. Typed core with an IR

Move `prototype/compact/` to `core/` and give it the IR. Two halves, each with its own exit proof.

#### 1a. The IR at parity (weeks 1 to 6)

- [ ] `core/` with its own test entry in `test/index.js`, its bench, and its gates from the first commit
- [ ] one typed IR: SSA with a CFG and one lattice (`f64`, `i32`, `i64`, `v128`, `str`, `typedarray T`, `struct S`, `array T`, `dict V`, `closure C`, `any`)
- [ ] every optimization (LICM, CSE, vectorization, pointer simplification) is dataflow on the IR; the WAT-array matchers are not ported
- [ ] i32 parameters and results carried as i32; the exact-conversion helper appears only where JS semantics require ToInt32 of an f64
- [ ] acorn as the parser; the early-errors checker and the accept ledger are not ported
- [ ] watr stays the encoder and final peephole

Exit proof: the compact corpus and the numeric bench cases compile through the IR; the bitwise row beats 120 bytes; the typed SIMD row keeps its 287-byte, 4.69x win; peak compile memory is linear in function count.

#### 1b. Storage, closures, regions (weeks 7 to 12)

- [ ] typed arrays of every element type, structs with unboxed fields, closures over those; each with a named differential test file in `test/core/`
- [ ] regions: per-call release, escape analysis on the IR, the session region, named regions; the tier report lists what each function lets escape
- [ ] the call graph is complete by construction, gated by the reachability probe over the core corpus
- [ ] the leak tripwire: a long-running loop over the flagship's node graph holds its memory flat; the test is the exit criterion for regions

Exit proof: the typed-kinds corpus (`spec/subset.md`) compiles through the IR with its differential tests, the leak tripwire holds, and the reachability probe is zero. If the escape analysis rejects a construct the corpus needs, the fallback is named in `spec/memory.md` before phase 2 starts, not discovered in phase 4.

### Phase 2. Runtime in jz on regions

- [ ] strings with UTF-16 code-unit semantics in region storage, js-string builtins at host crossings
- [ ] `array T`, `dict V`, `Map`, `Set`, JSON, Number, Math, Date (UTC), RegExp subset; per-container free lists so a long-lived container reuses its own cells
- [ ] the `any` operations: tagging, kind checks, and the good-parts operators over the subset kinds
- [ ] every runtime function is jz source compiled by the core; a runtime function the core compiles badly is a core inference gap and goes on the roadmap
- [ ] the WAT template registry, its two registration dialects, and its integrity verifier are not ported

Exit proof: the runtime passes its own differential tests against JS, and the core's compile of the runtime is at least as small as the equivalent WAT template family.

### Phase 3. Boxed functions and the tier report

- [ ] boxed-function lowering: `any` operators to runtime calls, tagging and kind checks at the boundary per `spec/boundary.md`
- [ ] the tier report: per function, its tier, the first site that decided it, and what would change it
- [ ] the guarded and typed host ABIs per `spec/boundary.md`
- [ ] async, generators, and classes as specified

Exit proof: a program mixing typed and boxed functions compiles with a report that names every boundary crossing and every escaping allocation, and the report is stable across compiles.

### Phase 4. The good-parts corpus

- [ ] port `test/` in subset order: numeric, typed storage, structs, closures, strings, objects, collections, JSON, async, classes, modules, host interop
- [ ] every ported test is a differential test against JS where the subset promises JS semantics, and a contract test where the typed tier defines the behavior
- [ ] web-audio-api compiles as the flagship: a long-lived node graph in the session region, DSP kernels typed with nothing escaping, static accessors on fixed shapes as methods, the report showing the boundary and the regions
- [ ] regression gates against ourselves on `bench/`; no competitor claims in CI or the README

Exit proof: the ported corpus passes, the flagship compiles and runs its own tests, and every remaining old-compiler test is either ported, mapped to a rejection, or deleted with a reason.

### Phase 5. Retirement

- [ ] `core/` becomes `src/`; the old `src/`, `module/`, `jzify/` templates, and `prototype/` are deleted
- [ ] `.work/` leaves the repository; `PLAN.md` and `spec/` are the only planning prose
- [ ] the last release of the old compiler is tagged for users who need the retired surface
- [ ] README describes the two tiers, the subset, and the numbers under their stated contracts

Exit proof: one compiler, one IR, one runtime language, one spec.

## Gates for every slice

- differential tests against JS for every promised JS semantics
- contract tests for every typed-tier behavior
- the reachability probe at zero on the core corpus after any call-graph change
- byte identity for refactor-only slices; an attributed diff otherwise
- peak memory and compile time recorded per slice, gated against the previous slice
- one external review at each phase exit; the architecture audit re-runs at the phase 3 exit

Self-compilation is a demo. It never gates a slice and never dictates source style.

## Numbers

Report numbers only under their stated contract: guarded ABI or typed ABI, typed or boxed function. Baselines are hand-written wasm and AssemblyScript on the same kernels, and JS on the same programs. Ratios against the retired compiler are transition evidence, not product numbers.

## Working discipline

- The spec answers "is this in the subset". A change that needs more prose than a spec edit is the wrong change.
- A commit is a rule, a runtime function, or a corpus slice, with its tests. Twenty commits a day is a symptom, not a pace.
- Contributors enter through the runtime (jz source plus differential tests) and the tier report, not through compiler internals.
- The migration slices on `main` stay as they are; the old compiler receives maintenance fixes only. `scripts/src-freeze.mjs` counts non-fix commits under `src/` since the freeze and fails above zero; it runs in CI.
- Tripwires: `core/` with its test entry by week 1; the IR compiling the compact corpus by week 6; the leak tripwire test passing by week 12; a kernel figure under the typed ABI on the README by week 14. A missed tripwire is a plan review, not a note.

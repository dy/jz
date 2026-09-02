# JZ core plan

## Decision

The compact prototype is the compiler. It grows into the core under `core/`, ships as the compiler when it passes the good-parts corpus, and the current `src/` pipeline retires then. The prototype is not a sub-product from this point: it has its own tests, its own gates, and its own release path from phase 1 on.

The product is good-parts JS: a documented subset of JavaScript compiled to efficient, small, safe wasm, in two explicit tiers. The typed tier compiles numeric and fixed-shape code with static types and no boxing. The dynamic tier compiles the rest with JS semantics through a runtime written in jz. The tier of every function is decided by rule and reported, never guessed per value. Divergence from JS is rejected or reported at compile time, never silent.

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

- [x] `spec/subset.md`: what is in the dynamic tier, what is in the typed tier, what is rejected, and the divergence policy.
- [x] `spec/tiers.md`: the tier assignment rule, the signature fixpoint, and the tier report.
- [x] `spec/boundary.md`: the typed/dynamic boundary and the two host ABIs.
- [x] `spec/memory.md`: wasm GC for the dynamic tier, linear memory for typed storage, the GC-less target.

Exit proof: every current test file maps to one of in-dynamic, in-typed, or rejected in `spec/subset.md`, and every README "what differs from JS" item is either a typed-tier contract or a reported divergence.

### Phase 1. Typed core with an IR

Move `prototype/compact/` to `core/` and give it the IR.

- [ ] one typed IR: SSA with a CFG and one lattice (i32, i64, f64, v128, ptr T, struct S, typedarray T, closure C)
- [ ] every optimization (LICM, CSE, vectorization, pointer simplification) is dataflow on the IR; the WAT-array matchers are not ported
- [ ] i32 parameters and results carried as i32; the exact-conversion helper appears only where JS semantics require ToInt32 of an f64
- [ ] typed arrays of every element type, structs with unboxed fields, closures over those
- [ ] acorn as the parser; the early-errors checker and the accept ledger are not ported
- [ ] the call graph is complete by construction, gated by the reachability probe over the core corpus
- [ ] watr stays the encoder and final peephole

Exit proof: the compact corpus and the numeric bench cases compile through the IR; the bitwise row beats 120 bytes; the typed SIMD row keeps its 287-byte, 4.69x win; peak compile memory is linear in function count.

### Phase 2. Runtime in jz on wasm GC

- [ ] strings as GC i16 arrays with js-string builtins at host crossings, JS length and indexing semantics
- [ ] arrays, objects with static shapes and a dictionary fallback, closures, Map, Set, JSON, Number, Math, Date (UTC), RegExp subset
- [ ] every runtime function is jz source compiled by the core; a runtime function the core compiles badly is a core inference gap and goes on the roadmap
- [ ] the WAT template registry, its two registration dialects, and its integrity verifier are not ported

Exit proof: the runtime passes its own differential tests against JS, and the core's compile of the runtime is at least as small as the equivalent WAT template family.

### Phase 3. Dynamic tier and the tier report

- [ ] dynamic-tier lowering: generic operators to runtime calls, boxing and unboxing at the boundary per `spec/boundary.md`
- [ ] the tier report: per function, its tier, the first site that decided it, and what would change it
- [ ] the guarded and typed host ABIs per `spec/boundary.md`
- [ ] async, generators, and classes as specified

Exit proof: a program mixing both tiers compiles with a report that names every boundary crossing, and the report is stable across compiles.

### Phase 4. The good-parts corpus

- [ ] port `test/` in subset order: numeric, typed storage, structs, closures, strings, objects, collections, JSON, async, classes, modules, host interop
- [ ] every ported test is a differential test against JS where the subset promises JS semantics, and a contract test where the typed tier defines the behavior
- [ ] web-audio-api compiles as the flagship: a long-lived node graph in the dynamic tier, DSP kernels in the typed tier, the report showing the boundary
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

Self-compilation is a demo. It never gates a slice and never dictates source style.

## Numbers

Report numbers only under their stated contract: guarded ABI or typed ABI, dynamic tier or typed tier, target `gc` or `nogc`. Baselines are hand-written wasm and AssemblyScript on the same kernels, and JS on the same programs. Ratios against the retired compiler are transition evidence, not product numbers.

## Working discipline

- The spec answers "is this in the subset". A change that needs more prose than a spec edit is the wrong change.
- A commit is a rule, a runtime function, or a corpus slice, with its tests. Twenty commits a day is a symptom, not a pace.
- Contributors enter through the runtime (jz source plus differential tests) and the tier report, not through compiler internals.
- The migration slices on `main` stay as they are; the old compiler receives maintenance fixes only.

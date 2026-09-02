# JZ core plan

## Decision

JZ compiles good-parts JS to efficient, small, safe wasm on one lattice of kinds. Typed functions carry static kinds with no boxing; a function that needs the tagged `any` kind is boxed and calls a small runtime written in jz for those operations. The tier of every function is decided by rule and reported, never guessed per value. Memory is regions with a deterministic release, no collector. Divergence from JS is rejected or reported at compile time, never silent.

The compiler is `src/`. The compact prototype (2026-08) proved the staged pipeline: no global compile state, per-function scratch, a numeric ProgramIndex with reachability before lowering, one function at a time into watr. Those stages were migrated into `src/` slice by slice (M0 to M8, the reachability gate last) and the prototype was retired on 2026-09-02 once production matched or beat it on every row it compiled; its corpus (`test/_scalar-core-cases.js`) and its bench rows (`test/minimal-output.js`) are production gates. Its remaining lead, compile speed on 40-byte inputs and a 6.45x smaller self-hosted artifact for a 74-source subset, is not a number any user of the compiler sees. The specs in `spec/` define the product. This file sequences the work.

## v1: the ledger at zero

v1 is a measurement, not a milestone: `scripts/v1-ledger.mjs` over `bench/results.json` prints every row where a wasm lane with parity runs faster than jz, and every row where AssemblyScript emits fewer bytes. v1 ships when it prints nothing. The last full run (2026-08-27, before this session's work) has 22 red speed rows (worst: trace 1.56x vs c-wasm, shapes 1.43x vs AS, sdf 1.29x, sort 1.21x, glyfparse 1.17x; twelve within 5%) and 24 red size rows (worst: wordcount 4.71x, shapes 1.78x, fft 1.36x, resample 1.32x, tokenizer 1.35x, slices 1.30x; ten within 5%). Each red row is a codegen class in `src/`, closed with its differential test and its ratchet; the bench file is refreshed with `bench/bench.mjs --targets=jz,<lane> --json --merge` after each close.

What this session established and closed on the way:

- [x] numeric export boundary: the `x = +x` guard is free, the wrapper hands `f64` slots the host value raw so the JS-API's ToNumber is the coercion, every box-capable parameter rides the `i64` lane
- [x] constant-length module typed arrays are static storage: no allocator, no start function, memarg addressing; typed row 568 to 220 bytes, examples corpus −232 KB
- [x] numeric array-like export parameters arrive as `Float64Array` and copy back when written (the wrapper never copied writes back before); the body and its callees read typed storage; a probe 23,822 to 791 bytes
- [x] real programs: `scripts/library-census.mjs`; color-space whole and 28 of 37 audio packages compile after 16 fixed classes; remaining rejections are object rest on unknown shapes, `try` across `await`, top-level `await`; web-audio-api needs class accessors (phase 4)
- [x] `scripts/compile-budget.mjs` against the 0.9.2 tag: library bytes +2 to 13%, compile time +14 to 34%, cumulative correctness on unknown receivers (real Error objects, the `.set` dispatch fork, erased-provenance rejection); 70% of compile time is watr scaling with emitted WAT
- [x] size rows closed as codegen classes (2026-09-02, `.work/ledger-performance.md` §7): tokenizer, resample, noise, raytrace, delayline, glyfparse; each a general lowering with its differential test and byte ratchet in `test/minimal-output.js` (multi-cell push slots, power-of-two field bounds in the interval prover, owned typed views, local-lambda splicing with uint32 draws, long-literal concat twins, factory result lengths, a leaner `__memgrow`, the size tier's plain string walks and twin subsumption at link, condition chains, own-name-current arrays, one cursor budget for both range channels)
- [x] what an expert flagged and what closed it: runtime bodies specialized by call-site facts with no link-time collapse (twins now declare their general form; the size tier links one body), speed-tier walks linked at every tier (`leanRuntime`), `&&`/`||` lowered as value diamonds in condition positions (branch chains; trace 1.49x → 1.03x vs C), a ToInt32 that did not distribute over `select` (the i32 ring; glyfparse 1.25x → 1.10x vs C), every array read chasing forwarding (own-name-current), two cursor budgets that disagreed (one `maxAdvanceBudget`), an in-place replace store that wrote through a null cursor at one tier (a null test, the generic extend on a miss)
- [ ] the size rows still red (jz B vs AS B): shapes 1884 (1695) and fft 1959 (1758): the butterfly and the union push need the power-of-two stride relation the prover cannot express; wordcount 3725 (3480): the dictionary probe's ephemeral reuse arm and the inlined dictionary count against AS's Map primitives; bezfit 3290 (3017), sdf 2303 (2209), slices 1730 (1657), lz 1928 (1910), immutable 1490 (1481): within 10%, the harness's inlined setup dominates
- [ ] the speed rows from the quiet run (2026-09-02, `--paired` where it mattered): trace 1.03x and glyfparse 1.10x vs C after the closes above; shapes 1.23x vs AS, sort 1.21x vs zig, sdf 1.20x vs C (edt1d's data-dependent `k` cursor keeps its checks), synth 1.15x vs moonbit, delayline 1.11x vs rust; twelve rows within 5% need the paired verdict
- [ ] the conditional row's NaN canonicalization on `-x` (82 vs 61 bytes) drops under the typed ABI (phase 3)
- [ ] `optimize: 'size'` emits 24% less than the default on parser-like code (jessie 87,584 against 115,508): the default profile's speed-for-size trades become receiver-aware or `size` becomes the library default
- [ ] README numbers restated under their contract (typed or guarded ABI); tag 1.0.0 when the ledger is empty

## What transfers from the current compiler

- `test/`: the corpus that defines the good-parts subset empirically. Ported in subset order (phase 4), never bulk-copied.
- `module/*.js` WAT templates: the reference behavior for the runtime rewritten in jz (phase 2).
- `bench/` and `examples/`: the performance evidence set, used as regression gates against ourselves.
- `scripts/reachability-probe.mjs` and the eight call-graph classes it pinned: the completeness gate for the core's call graph.

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

Grow `core/` out of the migrated `src/` stages and give it the IR. Two halves, each with its own exit proof.

#### 1a. The IR at parity (weeks 1 to 6)

- [ ] `core/` with its own test entry in `test/index.js`, its bench, and its gates from the first commit; the v1 ledger stays the outer gate
- [ ] one typed IR: SSA with a CFG and one lattice (`f64`, `i32`, `i64`, `v128`, `str`, `typedarray T`, `struct S`, `array T`, `dict V`, `closure C`, `any`)
- [ ] every optimization (LICM, CSE, vectorization, pointer simplification) is dataflow on the IR; the WAT-array matchers are not ported
- [ ] i32 parameters and results carried as i32; the exact-conversion helper appears only where JS semantics require ToInt32 of an f64
- [ ] acorn as the parser; the early-errors checker and the accept ledger are not ported
- [ ] watr stays the encoder and final peephole
- [ ] one range analysis on the IR replaces the five integer-range channels the v1 size closes had to touch in parallel (`constIntExpr`, `intExprRange`, the interval prover's own evaluator, `narrowUint32`, the `.unsigned` IR flag); the power-of-two field rule and the uint32 remainder rule become cases of it, and `exprType`'s mirror of emit's `%` rule (two places that agree by discipline) disappears because a storage type is a property of the IR value
- [ ] one function summary per function (parameter kinds, constants, lengths, schemas; result kind, aux, length, range) replaces the spread of `paramReps` fields, `sig.ptrKind`/`ptrAux`/`typedLen` and `valResult`; the factory-length fact and glyfparse's missing return range are its first two consumers
- [ ] a compiler decision never runs a transcendental: the field bound went through `Math.log2` and diverged by one ulp between the native and the self-hosted compiler (kernel parity caught it); integer arithmetic only
- [ ] a congruence domain for the stride relation (`i` a multiple of `len`, `len | n`): the radix-2 butterfly is the exit specimen

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
- [ ] a runtime function specializes by its call-site facts through the ordinary inliner, never by a hand-written twin: `__str_concat` carries six template twins today (`_raw`, `_fresh`, `_raw_fresh`, `_long`, `_fresh_long`); the exit proof compiles the concat family from one jz source and matches each twin's bytes at its call sites, and the `-Os` walks (`__str_eq`, `__str_hash`) are the size profile of that same source
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

- [ ] `core/` becomes `src/`; the old `src/`, `module/`, and `jzify/` templates are deleted
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
- Until the ledger is empty, `src/` is where v1 rows close. From the first `core/` commit the old compiler receives maintenance fixes only: `scripts/src-freeze.mjs` counts non-fix commits under `src/` since that commit and fails above zero; it runs in CI.
- Tripwires: `core/` with its test entry by week 1; the IR compiling the compact corpus by week 6; the leak tripwire test passing by week 12; a kernel figure under the typed ABI on the README by week 14. A missed tripwire is a plan review, not a note.

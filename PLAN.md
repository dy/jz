# JZ core plan

## Decision

JZ compiles good-parts JS to fast, small, safe wasm on one lattice of kinds. A typed function carries static kinds with no boxing; a function that needs the tagged `any` kind is boxed and calls a runtime written in jz. The tier of every function is decided by rule and reported, never guessed per value. Memory is regions with a deterministic release, no collector. Divergence from JS is rejected or reported at compile time, never silent.

There is one compiler, `src/`, and it is rebuilt in place. Each step below replaces one subsystem with its canonical form and deletes what it replaced, gated by the test corpus, the bench rows and the reachability probe. A step that keeps the old path "for now" is not done. No second compiler, no `core/`, no frozen `src/`. The compact prototype (retired 2026-09-02, `c7616d6e~1`) is the seed for the representation, not for a second lowering: numeric ids, parallel typed arrays, per-function scratch, no shared compile state.

## The pipeline

1. **Front**: parse → normalize (jzify, the only AST rewrite, one canonical form) → prepare (reject, extract) → ProgramIndex (numeric ids, reachability, summaries). In the prototype's shape today; keep and trim.
2. **Kinds**: one lattice (`f64 i32 i64 v128 str typed T struct S array T dict V closure C any`), one fixpoint over function summaries: parameter and result kinds, field schemas with every field kind (typed arrays, closures, nested structs), escape. A class is a struct with typed methods over a `this` schema.
3. **Lower**: AST → typed IR, one function at a time, scratch only. The IR is a tape of parallel typed arrays (op, result type, kind, children, immediates, facts); `any` is explicit box and unbox instructions calling the runtime.
4. **Optimize**: range, LICM, CSE, kind unswitch, vectorize as dataflow over the tape under one scheduler with declared dependencies. Deterministic. No recognizer per idiom.
5. **Emit**: tape → watr encoder. watr does no semantic optimization.
6. **Runtime**: jz source (`src/std`), compiled by the same pipeline, linked by reachability, specialized by the inliner. No WAT templates.

State: a Program (persistent, numeric arrays) and a function scratch. No `ctx`. A verifier pass checks the tape in debug builds; every pass is a pure function of (Program, function); each pass carries its soundness note; the tier report names, per function, its tier and the site that decided it.

## Steps

Each step lands byte-identical on `test/minimal-output.js` and the bench rows, or with an attributed diff; the reachability probe stays at zero; peak memory and compile time are recorded and gated against the previous step.

1. **Freeze the ledger.** No bench-row closes, no library-census fixes, no README numbers until the pipeline is one. The open rows are within 1.24x; the class shape is 25x.
2. **The tape.** Done. The IR tape (`src/ir/tape.js`) enters the pipeline after the last WAT-array pass: link (`src/link`) decodes the assembled module onto it and encodes it back for watr. The mechanical passes are on the tape with their array versions deleted: treeshake, the custom sections, the throw-runtime prune, the function order, the local-name strip, the constant pool, the arena rewind, the low-word mask fold, the local order. What remains in `src/optimize` is the analytic optimizer (LICM, CSE, the peephole family, the vectorizer): recognizers over WAT arrays that are not ported but rewritten, in step 4, once the tape carries kinds.
3. **One kind fixpoint, emit onto the tape.** The program summary (`src/summary`) is the fixpoint: one kind per binding, slot and result over the whole program, computed at compile entry. Done: the lattice and the fixpoint; a class declares every field its constructor assigns, so an instance keeps one shape (`jzify/classes.js`); the summary answers the slot's typed constructor and value kind, the kind fact of a parameter's fields, and the pointer kind of a local a typed field read initializes. A class method's loop over a typed field lowers to typed storage (`class Gain`: 27.5 ms → 2.6 ms, the record through a parameter 11.9 → 0.9 ms; the flagship's 5 s render 65 → 25 ms against V8's 3, its size unchanged at 805 KB). The representation follows the summary where a census fell short: a call-site argument's schema, a closure parameter's kind, an array's element schema, a call result's kind, and numeric demand (a binding or slot with a ToNumber read and no other; a demanded parameter of an exported function arrives as f64, the host's ToNumber being the program's own coercion), so an exported `class Gain` is 1,907 B against AssemblyScript's 998 (700 of them the polymorphic typed-array constructor for a host-supplied length, which may also be an array to copy) and a factory's record 1,596 B; a method called through an array of instances (`bench/gainclass`, the ledger's first class row) runs in 76 µs against V8's 214 and AS's 607, at 2,363 B against AS's 1,903. Next: classes as structs with shared methods (`class P { x; y; len() }` allocates a closure per instance: 10 ms against 2.9), derived classes (the flagship's nodes extend EventTarget and keep their dynamic shape), then the summary replaces `plan/`, `analyze/`, `narrow/`, `program-facts`, `representation-plan`, `kind/`, `type/`, `infer` consumer by consumer; the five integer-range channels (`constIntExpr`, `intExprRange`, the interval prover's evaluator, `narrowUint32`, `.unsigned`) become one range domain. Emit builds the tape directly from the summary, which deletes the WAT-array helpers (`src/ir/*`), the expando facts (`.type`, `.ptrKind`, `.valKind`, `.unsigned`, `.typedLen`, `.schemaSid`, `.saArr`, `.range`) and the decoder. Gate: the record probes (`{buf: Float32Array, gain}` through a factory, `class Gain { buf; gain; process() }`, `class P { x; y; len() }`) at or under AssemblyScript's bytes and at or above V8's speed, as ledger rows.
4. **Optimizer as dataflow.** Range, LICM, CSE, kind unswitch and vectorize written once on the tape against real kinds, under one scheduler; watr's optimize pass off. Deletes the `src/optimize` recognizers. Gate: the bench rows at or under their current bytes and at or above their current speed.
5. **Runtime in jz.** Each `module/*.js` family becomes jz source with a differential test against JS; twins come from the inliner. Deletes `module/`, the template registry and its two registration dialects. Gate per family: bytes at or under the template family's.
6. **No `ctx`.** Falls out as each pass takes explicit inputs; the last commit deletes `ctx.js`. Gate: two interleaved compiles; peak memory linear in function count.
7. **The charter.** The five silent divergences fixed or rejected (`==` on object operands, methods and accessor slots in enumeration, code before `super()`, integer-first key order); the tier report; README numbers under their shape contract. Self-compilation is a demo: it never gates a step and never dictates source style.

## Numbers to hit

- compiler at or under 35K lines plus the runtime in jz, from 108K
- self-hosted `dist/jz.wasm` under 3 MB, from 14.7 MB; recursive self-compile well under the wasm32 ceiling (4.10 GB of 4.29 GB today)
- the record probes at or under AssemblyScript's bytes and at or above V8's speed (today 1,907 B against 998 B and faster; `bench/gainclass` 2,363 B against 1,903 B and 2.8x faster than V8)
- web-audio-api in its own size class on the typed tier (today 805 KB from 246 KB of source, 8x slower than V8)
- the bench ledger (`scripts/v1-ledger.mjs`) empty; then 1.0.0

Report a number only under its contract: typed or guarded ABI, typed or boxed function, the input shape it was measured on.

## Working discipline

- The spec answers "is this in the subset". A change that needs more prose than a spec edit is the wrong change.
- A commit is a rule, a runtime function, or a corpus slice, with its tests. Twenty commits a day is a symptom, not a pace.
- Every promised JS semantics has a differential test; every typed-tier behavior has a contract test.
- Contributors enter through the runtime (jz source plus differential tests) and the tier report, not through compiler internals.
- One external review at each step's exit.

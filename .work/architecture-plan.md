# JZ middle-end consolidation plan

From the 2026-07-20 architecture audit, reconciled with this campaign's findings
(the audit's four P0s each manifested as a live bug this week: bare-name schema
identity → the collision miscompiles; unregistered passes → the reference-tier
gap; rerun sequencing → the assumption-ownership break; emit-time inference →
the vars-channel leak). The plan orders work so each step makes the next
mechanical, never cosmetic-first.

The essence to protect: annotation-free valid JS → small, predictable,
runtime-free wasm with a stable ABI; one layout authority; self-hosting;
the closed ValueRep/param-lattice foundations; the test/bench discipline.

## Answers to the audit's open questions (proposed; the standing decisions
already imply them)

1. "First WASM" = STRICT statistical leader (paired-ABBA median < 1.00) per
   case; the 5% band is the *regression* tolerance, never the claim (Q1
   discipline from the bench-protocol decisions). Report three tiers:
   strict-lead / parity-band / red — the bench page and gates already carry
   the data for this split.
2. Self-hosting must NOT constrain compiler-source style. Every workaround
   marker becomes a native-vs-kernel differential test; the underlying
   miscompile class blocks V1 (they are user-visible classes by definition —
   three were fixed this week by exactly this route).
3. Downstream native (wasm2c/w2c2) is first-class: it gets a target
   legalization profile (traps, guard pages, EH gating) inside the pipeline,
   not an external script chain. CI wires it when the profile exists —
   never before (silent skew is worse than absence).
4. Consolidation proceeds in bounded stages interleaved with surface work —
   each stage lands green-battery like any unit; no long-lived branch.

## Stage 0 — Pass registry + formatting invariance (the audit's "next move")

One declarative registry `{ name, stage, kind, levels, default }` for every
transformation flag — including today's unregistered ones (loadCSE,
intDivLower, forInUnroll, versionTypedBounds, hoistConstLit, rationalConst,
unrollScalarChain, the `=== true` speed-tier set). Mechanics:

- `enabled('pass')` accessor; reading an unregistered name THROWS in tests.
- O0/false = every `kind: optimization|tuning` pass off — asserted by a test
  that walks the registry and greps each call site's guard form.
- Delete raw `code.length` tuning (the 5 KB-comment 2.9× size repro). If a
  compile-budget policy stays, key it on post-parse node count and surface it
  as an explicit preset knob in the registry.
- Formatting-invariance gate: compile N representative sources with and
  without comment/whitespace padding; assert byte-identical output at every
  preset. (Also kills the literal-NUL grep hazard file-wide: emit the NUL as
  an escape.)
- Fix `ctx.warnings` array shape so snapshot warnings actually surface.

Exit: one authority for "what runs at level L"; fuzz matrix reads the registry
instead of a hand-list.

## Stage 1 — BindingId (kills the whole bare-name class)
## STATUS: 1a+1b LANDED 4a0102d2 (totality + census collapse). 1c RESOLVED
## BY CONSEQUENCE: assumedBounds keys now embed binding-unique deterministic
## names (the rename fragility class is unrepresentable — the biquad break's
## root); clone substitution transfers proofs explicitly via
## stampClonedIdxProof (sound: substitution only shrinks value sets), and the
## α-rename byte-identity pin covers the whole proof channel. The
## (BindingId, canonical-idx) reformulation folds into Stage 2's frozen
## FunctionPlan (proofs become plan data). 1d (display) landed as the
## encoding-agnostic strip. Open debt: the kernel string-param class
## (ledger 2026-07-21c, 2 guarded pins).

Prepare assigns every binding a stable id (alpha-rename internally:
`name#fnId#serial`; bare names survive only in exports/diagnostics/name
section). Then:

- `schema.vars/poisoned/varsBarred/assignSid/declInitUnknown/ownerStack/
  bindSites` collapse into ONE map keyed by BindingId — poison means
  "conflicting values of THIS binding", collision logic deletes outright
  (≈200 lines of containment removed, three miscompile classes become
  unrepresentable).
- `assumedBounds`' AST-JSON keys become (BindingId, canonical-index) keys —
  the clone/rename fragility class (this week's biquad break) dies; the
  const-hull channel stays as the value-level complement.
- The α-rename invariance pin extends to a fuzz mode: rename every binding,
  assert byte-identical output.

Risk control: do the rename in prepare where shadow-renaming already exists;
land behind a registry flag with a differential leg (renamed vs not) before
flipping default.

## Stage 2 — One fact solver, frozen plans

Replace the rerun choreography (runFixpoint ×2, 13 plan-time refresh points,
28 analyzeBody call sites, emit-time rep updates) with:

- A monotone product-lattice worklist over the EXISTING fact domains
  (ValueRep × paramReps × typedLen × schema sets × ranges × escape/effects) —
  the lattices are already designed; the change is ownership and scheduling,
  not the math.
- Transformations declare `invalidates: [domains × functions]`; the solver
  recomputes only affected entries. "Run twice" becomes "the worklist isn't
  empty yet".
- Emit consumes a frozen FunctionPlan (reps, slots, proofs, loop specs) and
  never writes durable facts. The three audit-cited emit-time writers move
  into plan finalization. `analyzeBody` cache dies with its invalidation
  comments.

Exit: `grep 'updateRep\|schema\.vars\.set' src/compile/emit.js module/` → 0.

## Stage 3 — Loop model as the vectorizer's substrate

`loop-model.js` grows into the canonical per-loop record: IVs + trip ranges,
affine accesses (the affineIdxOfIV language, incl. scaled-IV), dependence
sets (from solver aliasing), reductions/recurrences (incl. the serial-chain
class), masks/effects, profitability. The 6.8k-line recognizer chain
re-targets: each named recognizer (blur/butterfly/…) becomes a CLASSIFIER
into generic transforms — map / reduce / predicated map / strip-mine / SLP /
stencil / recurrence-unroll / serial-chain-pair. First-match-wins ordering
becomes class dispatch; the pre-canonicalization pass dissolves into the
model builder. Versioning (typed-bounds guards) reads the same model — one
extent computation for guard, vectorizer, and unrollers.

## Stage 4 — Session + final-optimizer contract

- `CompileSession { program, analyses, passes, plans, target }`; phase-scoped
  views instead of 61-importer mutable `ctx`. Mechanical once Stages 1–2 own
  the data.
- Post-watr rewrites (hoistGlobalPtrOffset, hoistStableGlobalConstLoads,
  guardMaskedVectorSuffix) move BEFORE the final watr run (or register as
  watr plugins); snapshot init moves before it too. `audit:fixpoint`
  hard-fails on any hot-loop delta.
- Target legalization profiles: v8 (current), wasmtime, wasm2c (no-EH, trap
  semantics, guard-page assumptions) — selected per target row; the native
  lane's script chain folds into the profile.

## Stage 5 — Claims + hygiene

- Bench gate three-tier claims (strict/parity/red) + jz-w2c as a regression
  target + "any JIT" gate incl. JSC/Bun/Deno once rows are stable.
- Self-host workaround sweep: each marker → differential test → root fix →
  marker deleted (the kernel-fragility ledger entries are the seed list).
- Duplication sweep (assignment-op sets, clone helpers, name scanners) and
  doc-drift corrections — LAST, when the moves above make them one-line
  deletions instead of refactors.

## Sequencing note

Stage 0 is a day-scale unit and unblocks honest measurement of everything
after. Stage 1 is the highest-leverage correctness change (every name-keyed
incident this week lands in its blast radius). Stages 2–3 are the big ones —
each shippable in slices (solver first for ValueRep only, then domains one by
one; loop model first for the versioning path, then vectorizer classes).
Battery discipline unchanged: native + kernel + O0/O3/wasi + selfhost + fuzz
per landing, pins for every fixed class.

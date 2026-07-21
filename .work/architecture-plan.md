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
## CRITICAL PATH REFINED (2026-07-21f): the kernel knife-edge needs the
## EXACT-2a combination + full-suite kernel state — dead-const and halved
## variants are green, so SMALL analyze/reps changes land safely and Stage 2
## is NOT blocked (every slice still validates via the full battery). The
## latent kernel class (JSON/jsonConstString neighborhood, plausibly one
## root with the string-param class) is parked with a deterministic
## reproduction recipe (ledger 2026-07-21f); burn it down as its own unit.
## STATUS: slice 1 LANDED 7e570e58 — change-driven fixpoint (latticeMeet
## signal through every meet; all 5 callsite-lattice sweeps converge instead
## of fixed-count guesses). SLICE 2 DESIGN (inventoried 2026-07-21): 27
## analyzeBody call sites (narrow 11, program-facts 4, compile/index 3,
## literals/inplace-store 2 each, assemble/plan-scope 1); the body-facts
## cache is "intentionally staleable" with invalidateLocalsCache placed at
## phase boundaries by hand. Slice 2 = DECLARED invalidation: (a) one
## `invalidateBodyFacts(body, reason)` entry point; (b) every ctx mutation
## that can stale a body's facts (rep updates during narrowing, schema
## binds, typedLen changes) routes through it with the reason string;
## (c) the phase-boundary blanket invalidations become coverage ASSERTIONS
## (a debug mode records which bodies were invalidated by declaration vs
## blanket — a blanket-only invalidation is a missing declaration);
## (d) exit = the blanket calls delete. Slice 3 = per-domain worklists over
## the declared edges (the full solver); slice 4 = frozen FunctionPlan
## consumed by emit (the three emit-time writers move to plan finalization,
## assumption keys become plan data — subsumes old Stage-1c reformulation).

## SLICE 3 DOMAIN MAP (2026-07-21, from this campaign's surveys — the
## implementation contract; each domain becomes a pure function of its
## declared inputs, computed by one worklist):
##   D1 paramReps      owner narrow.js runCallsiteLattice (CONVERGED since
##      slice 1); inputs: callSites × caller bodyFacts × defaults; edges:
##      callee param ← caller args.
##   D2 bodyFacts      owner analyze.js analyzeBody (the staleable cache);
##      inputs: body AST × localReps(val/typedCtor) × schema sets ×
##      globalValTypes; THE flaky-arena WeakMap lives here — slice 3
##      replaces the cache with solver-owned storage keyed (funcName,
##      domain), removing the WeakMap-arena interaction entirely (also the
##      leading theory for the kernel knife-edge class — the solver may
##      fix it by construction).
##   D3 localReps      owners: plan.js seeding + analyze boxing + narrow
##      enrichment + THREE emit-time writers (audit); slice 4 moves emit
##      writers to plan finalization.
##   D4 typedLen/schema/constStr channels   owners: prepare census (now
##      per-binding post-1b) + plan/scope const provenance; module-scoped,
##      write-once-ish — natural solver seeds.
##   D5 ranges         owner static.js intExprRange (canonical since the
##      range wave) — pure already; reads D3.range reps.
##   ORDER: D4 → D2 → D1 → D3-enrichment → (fixpoint D1/D2/D3) → freeze
##   FunctionPlan → emit reads plans only. Slice 3a = D2 ownership move
##   (solver storage, no WeakMap) — LANDED 878d3685; 3b = D1 onto the
##   worklist — LANDED b01dbfb2 (applySiteRules + caller-indexed
##   edge-driven re-enqueue; confluent, order-independent); 3c = D3
##   emit-writer relocation (slice 4's door). 3c CENSUS + CLASSIFICATION
##   (2026-07-21, site-by-site read): 14 sites split into TWO KINDS —
##   (a) EMISSION-LOCAL TEMP SEEDS (core.js ?.[]/?.() evalOnce temps ×2,
##       array.js fresh temps ×2, object.js:86 HASH seed): the written
##       name is MINTED DURING EMISSION and lives one expression — these
##       are not durable-fact writes at all; migrate them to the
##       transient localValTypesOverlay channel (tier #2, torn down with
##       scope). PREREQ: guarantee the overlay is installed for the
##       whole emission of every function (today it is context-dependent
##       — emit.js:1852 guards on null), and audit the ptr/typedElem
##       side-channels these temps also seed (typedElem.set at core:1566
##       needs a transient twin).
##   (b) GENUINE DISCOVERY WRITES (emit.js decl ptrKind-inheritance
##       cluster ×5-6 ~1581-1602, object.js Object.assign schema binds
##       ×3): the fact is discovered from the EMITTED init's shape.
##       Relocation = a pre-emit exprPtrKind/schema predictor — which is
##       exactly closing the valTypeOf-vs-emit gap (destructure temps,
##       assign results). This IS slice 4's substance: FunctionPlan
##       finalization computes these facts via the predictor; emit
##       ASSERTS agreement instead of writing. Exit grep unchanged.

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

## SLICE 4 PREDICTOR SPEC (2026-07-21, opening contract for the 11 remaining
## discovery writers): a pure pre-emit `declInitFacts(name, init)` computed at
## plan finalization, covering exactly the emit-observed gaps:
##   P1 ptrKind/ptrAux inheritance for decl inits that emit to unboxed
##      pointers (destructure temps `__d0 = v`, pointer-ABI RHS): predict
##      from repOf(rhsName).ptrKind / known-builtin results — the same
##      sources emit's val.ptrKind ultimately derives from; emit ASSERTS
##      agreement (JZ_DEBUG_INVARIANTS) instead of writing.
##   P2 CLOSURE funcIdx (emit.js ~1602): available at plan time from the
##      closure table once direct-closure resolution runs pre-emit — order
##      the plan phase after closure minting.
##   P3 Object.assign/spread schema results (object.js ×3, emit.js:2486
##      spread val): predict via the existing staticObjectProps/spread
##      union machinery in analyze (already computes shapes for other
##      consumers — reuse, don't duplicate).
##   P4 hash conversion (object.js:86): a REAL lifecycle transition —
##      model as a plan-time binding-state edge (binding becomes HASH at
##      stmt S), not a predictor case.
##   METHOD per site: implement predictor case → emit asserts equality
##   under JZ_DEBUG_INVARIANTS across the full suite → flip the write to
##   plan finalization → delete the emit write. One battery per site
##   cluster; the exit grep is the finish line, opening the frozen
##   FunctionPlan (emit reads plans only).

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

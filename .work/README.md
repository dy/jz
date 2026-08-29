# .work — working documents index

## Living (the plan)
- `handoff-2026-08-22.md` — THE cross-session plan: state, remaining queue,
  process rules, reference-refresh commands. Dated name, current content.
- `v1-architecture-campaign.md` — active campaign record + 4 GiB strategies
  (streaming encoder vs region release-behind-the-cursor).
- `research.md` — append-only evidence ledger (measurements, attributions).
- `adr-0001-bigint-representation.md` — the architecture decision record.
- `todo.md`, `todo-original.md` — session/user working notes.
- `memcheck-results.csv` — memory-goal evidence (regenerated at reference
  refresh).
- `porffor-alpha3-audit.md`: Porffor source/self-host comparison, compiler-core
  adapter contract, and ranked transferable optimizations.

## Refactor ledgers — pipeline minimality (every slice byte-identical under `refactor-oracle.md`)
`refactor-oracle.md` (the gate: 140 specs × 4 levels), `vectorize-split.md`,
`optimize-split.md`, `analyze-traversals.md`, `program-facts-split.md` (§7
facts lifecycle), `representation-plan-split.md`, `type-split.md`,
`assemble-outliers.md`, `ir-split.md`, `stdlib-generators.md`,
`stdlib-math.md`, `stdlib-string-array.md` — landed. `emit-split.md`,
`narrow-split.md`, `prepare-split.md` — structure maps (base b900cd09; line
numbers stale, family plans current), splits not yet cut.

## Historical but cited from code comments (do not move; citations would dangle)
carrier-representation-design, lattice-design, bigint-retirement-design,
printer-trio, compile-session-design, closure-plan-design, ctxfunc-survey,
compat-handoff (§BigInt superseded by ADR-0001), dyn-reach-slice,
context-sensitivity-survey, session-survey, vectorizer-generality-design,
walk-count-design, phase-c-unification (Shape pins reference it),
marketing/strategy/ecosystem (product docs — user's).

## archive/ — executed or superseded, zero code references
representation-plan-v2-design (ratified into ADR-0001),
pipeline-audit-2026-08-20, heap-epoch-design, retained-set-census,
feature-reach-census.

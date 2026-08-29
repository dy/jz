# .work — working documents index

## Living
- `plan.md` — THE plan: current state, seven-gate scorecard, 4 GiB
  strategies, remaining queue, process rules, reference-refresh commands.
- `audit.md` — v1 readiness (CI truth table, per-case leadership,
  self-compile) + core simplification (measured shape, expert review,
  simplification plan) + Porffor adapter/ranked optimizations; one gap table.
- `evidence.md` — append-only measurement ledger (was `research.md`).
- `memcheck-results.csv` — memory-goal evidence in CSV, next to evidence.md.
- `ledger-correctness.md` — every wrong-value family: symptom, root
  cause, fix or pin, gate.
- `ledger-performance.md` — size/speed/memory/compile-time campaigns.
- `ledger-refactor.md` — the pipeline-minimality record: every split,
  retirement, and traversal-combinator conversion.
- `adr-0001-bigint-representation.md` — the architecture decision record.
- `todo-original.md` — the owner's own working notes; not touched.

## Pending fold-in (other agents mid-flight — do not move or merge)
- `emit-split.md`, `prepare-split.md` — structure maps for splits not yet
  cut; fold into `ledger-refactor.md` once landed.
- `wasm-opt-slack.md` — not present in this snapshot; fold into
  `ledger-performance.md` when it lands.
- `perf/self-compile-memory`'s own notes — branch is live (see `plan.md`)
  but has landed no `.work` file yet; fold into `ledger-performance.md`.

## Product docs (the owner's, untouched)
- `marketing.md`, `strategy.md`, `ecosystem.md` — audience, positioning,
  expansion map.

## `archive/`
Superseded and purely historical sources: every session log and design
doc the living docs above were built from, plus the split/family "notes"
files that fed `ledger-refactor.md`/`ledger-correctness.md`. Kept for the
trail, not for citation — code comments now cite the living docs.

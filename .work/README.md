# .work: working documents index

## Living
- `plan.md`: THE plan: current state, seven-gate scorecard, 4 GiB
  strategies, remaining queue, process rules, reference-refresh commands.
- `audit.md`: v1 readiness (CI truth table, per-case leadership,
  self-compile) + core simplification (measured shape, expert review,
  simplification plan) + Porffor adapter/ranked optimizations; one gap table.
- `evidence.md`: append-only measurement ledger (formerly `research.md`).
- `memcheck-results.csv`: memory-goal evidence in CSV, next to evidence.md.
- `ledger-correctness.md`: every wrong-value family: symptom, root
  cause, fix or pin, gate.
- `ledger-performance.md`: size/speed/memory/compile-time campaigns.
- `ledger-refactor.md`: the pipeline-minimality record: every split,
  retirement, and traversal-combinator conversion.
- `adr-0001-bigint-representation.md`: the architecture decision record.
- `todo-original.md`: the owner's own working notes; retained.

## Pending fold-in at branch base `dd92662e`
- `emit-split.md`, `prepare-split.md`: structure maps for splits not yet
  cut; fold them into `ledger-refactor.md` after landing.
- `wasm-opt-slack.md`: absent from this branch base; fold it into
  `ledger-performance.md` if the coordinator later lands it.
- Self-compile-memory notes: no `.work` file exists in this branch base;
  fold any later landed note into `ledger-performance.md`.

## Owner product docs
- `marketing.md`, `strategy.md`, `ecosystem.md`: audience, positioning,
  expansion map. Their content is outside this consolidation.

## `archive/`
Superseded and historical sources, including the session logs and design
documents used to build the living set. Current status belongs in the
living files. Exact historical section citations may point into the
archive so their original anchors and evidence remain available.

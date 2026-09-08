# Working notes

[../PLAN.md](../PLAN.md) is the only active plan. The product goal is
JS → Wasm → VST for audiojs.dev, with a replaceable compiler.

The 102 campaign, audit, evidence and archive Markdown files were retired on
2026-09-08. They mixed historical failures, completed work and optional
architecture with release requirements. They remain in Git history; do not
restore them as competing plans.

To recover any former file (including the previous PLAN.md):

```sh
git show 66e72c46:.work/evidence.md
git show 66e72c46:PLAN.md
```

Old source comments citing a retired .work path refer to that historical
snapshot. Raw data and unapplied patches remain available; a saved patch is
not an instruction to merge it.

Retained reference notes:

- [BigInt representation decision](adr-0001-bigint-representation.md): existing semantic constraints.
- [Original owner notes](todo-original.md): historical ideas, not release gates.
- [Strategy](strategy.md), [marketing](marketing.md), [ecosystem](ecosystem.md): owner product notes, subordinate to the current goal.

Keep new correctness cases in tests and measurements beside their benchmark.
Explain changes in commits. Add a document only when an enduring contract needs
one; do not accumulate new session transcripts here.

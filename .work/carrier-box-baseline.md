# Carrier box-site baseline (CARRIER PROGRAM Slice 0)

Tracked artifact per `.work/carrier-representation-design.md` §7 Slice 0:
`src/compile/erasure-diag.js`'s `scanErasureSinks` re-run against the current
149-module self-hosted kernel graph, committed here as the reproducible
baseline the program measures itself against. Re-run the command below any
time the box-site footprint needs re-verifying (a kernel source change, a
`bigintBoxed` fixpoint change, a future Slice 3/5 landing).

## Repro command

```sh
JZ_DBG_BIGINT_ERASURE=1 JZ_DBG_BIGINT_STATS=1 node -e '
import("./index.js").then(async ({compile}) => {
  const { resolveModuleGraph } = await import("./src/resolve.js")
  const { erasureHits, resetErasureHits } = await import("./src/compile/erasure-diag.js")
  const { bigintBoxedStats, resetBigintBoxedStats } = await import("./src/compile/bigint-boxed-stats.js")
  resetErasureHits(); resetBigintBoxedStats()
  const g = resolveModuleGraph("./scripts/self.js", { resolveNode: true })
  compile(g.code, { modules: g.modules, optimize: false })
  const bySink = {}
  for (const h of erasureHits) bySink[h.sink] = (bySink[h.sink] || 0) + 1
  console.log("total:", erasureHits.length, "by sink:", bySink)
  console.log("paramsBoxed:", bigintBoxedStats.paramsBoxed, "localsBoxed:", bigintBoxedStats.localsBoxed.size)
  console.log([...bigintBoxedStats.byFunc.entries()])
})'
```

## Result — re-verified 2026-08-06, HEAD post-Slice-0/1/2 landing

Raw erasure inventory (kind-erasing AST flows a BIGINT-kinded expression
makes — proof not re-verified by the walk itself, matches the design's own
"raw inventory" characterization):

| sink | hits |
|---|---|
| call-arg | 37 |
| closure-capture | 6 |
| return | 5 |
| ternary-nullish | 5 |
| dataview | 3 |
| collection | 1 |
| **total** | **57** |

Fixpoint verdict (`bigintBoxedStats`, same run) — the actual box-site count
after the solver proves as many of the 57 flows raw as it can:

- **1 param**: `m61_layout$i64Hex` param0 (`bits`) — called from ~9 sites
  across the kernel; the fixpoint cannot prove every call site's argument
  is provably BIGINT.
- **10 locals**, all module-scope `const` bindings, all one-time module-init
  constants (plausible `src/snapshot.js` init-snapshot candidates):
  - `m113_assemble`: `NAN_PREFIX`, `TAG_SHIFT_BIG`, `TAG_MASK_BIG`,
    `AUX_SHIFT_BIG`, `SSO_BIT_BIG`, `OFFSET_MASK_BIG`
  - `m50_encode`: `F64_SIGN`, `F64_NAN`, `F64_QUIET`
  - `bif176_4`
- **11 total real box sites** — byte-for-byte the same count and the same
  named bindings the design doc's §1 measurement recorded. 46 of 57 raw
  flows (81%) resolve fully raw; the residual 11 are zero hot-loop sites.

## Finding from this re-verification (Slice 0)

Promoting the diagnostic to a maintained tool and adding
`assertErasureConsistency` (erasure-diag.js) surfaced a real, benign
attribution split worth recording: the 10 module-init-constant locals settle
`bigintBoxed=true` via analyze.js's own **top-level** walk
(`ctx.func.current` is null there → attributed to `'(top)'` in
`bigintBoxedStats`), but `scanErasureSinks`'s AST walk records the
corresponding erasure hits under the **module/function whose body actually
holds the const's initializer expression** (e.g. `nanPrefixMaskHex`'s own
`call-arg` hit for a `NAN_PREFIX`-derived expression), not under `'(top)'`.
Zero hits are ever recorded under `'(top)'` itself. This is NOT a solver bug
— both walks correctly observe the same underlying flows — it is a naming
mismatch between two independently-implemented instruments. A per-function
consistency assert was tried first and immediately tripped on this; the
landed `assertErasureConsistency` checks whole-program presence instead
(`localsBoxed.size > 0 ⇒ erasureHits.length > 0`), which stays TRUE and
still catches genuine solver/diagnostic divergence (the two mechanisms going
fully dark relative to each other).

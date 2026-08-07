# FeaturePlan freeze — stratified feature facts with boundary enforcement
(audit-#13 critical-path item 2; owner: coordinator, in-thread design)

## What exists today (surveyed 2026-08-07, exact sites)
`ctx.features` (src/ctx.js:628) is one mutable bag written across FOUR phases
and read across three, with the ordering contract documented only in comments
(module/collection.js:1101 "evaluated lazily at resolveIncludes() time — after
emission has finalized ctx.features") and enforced by nothing. The ledger has
already paid for this class once: the `ctx.features.bigint` module-inclusion-
ORDERING hazard, and the absent-dyn-key kernel misfire that forced bigint's
"MUST be seeded" note (ctx.js:635-639).

Writers by phase (the real census — audit-#13's "~41" counts reads too):
- SESSION (opts/reset): `sso` (default true, ctx.js), `blockingTimers`
  (index.js:486 from opts.nativeTimers).
- PREPARE (whole-program prescan, order-independent by construction):
  `bigint`, `error`, `errorClasses` (src/prepare/index.js:1159/1186/1216-17),
  `timers` (src/autoload.js:211).
- ANALYZE: `typedView` (src/compile/analyze.js:151).
- EMISSION (accumulated at emit sites): `external` ×6 (emit.js:3938/3997/7184,
  emit-assign.js:547/956/977), `typedarray` (module/core.js:1537/1573 emit
  hooks + collection-construction sites), `set`/`map` (collection.js
  construction sites), `closure`, `f16` (module/typedarray.js:412/1141/1258).

Readers by phase:
- EMISSION reads only SESSION+PREPARE+ANALYZE strata today (`bigint` emit.js:551
  + ir.js:1430, `sso` emit.js:3011/3027, `error`/`errorClasses` ir.js:1525-26 +
  emit.js instanceof, `typedView` vectorize.js:7112). Sound — but unenforced.
- resolveIncludes/template factories read everything (external/typedarray/f16/
  sso/bigint arms in module/*.js) — runs AFTER emission, so emission-stratum
  flags are final. Sound — but unenforced.
- ASSEMBLE reads `timers`/`blockingTimers` (wat/assemble.js:372/380).

## Findings (violations of the existing contract, found by this survey)
1. **Unseeded keys**: `f16`, `clamped`, `typedView` are written/read but ABSENT
   from the ctx.js:628 init. This violates the init's own MUST ("MUST be
   seeded, not an absent key") — the exact absent-dyn-key shape that misfired
   truthy in the self-hosted kernel for `bigint` (subnormal-export bug,
   data.js pins). Also a dict-shape mutation cost: late key insertion changes
   the features object's shape mid-compile.
2. `errorClasses` lazily `??=`-minted (prepare) — seeded as `null`, shape-
   stable, acceptable; document it as the one non-boolean.
3. No enforcement anywhere that a future emission-time READ of an emission-
   stratum flag (order-dependent!) gets caught. The bigint ordering hazard
   was exactly this; it recurs silently on the next contributor.

## The design: strata + seeding + boundary snapshots (no new machinery class)
Features are FACTS with a phase of settlement. Declare it:

- `SESSION` = {sso, blockingTimers} — settled at reset from opts.
- `PROGRAM` = {bigint, error, errorClasses, timers} — settled by prepare's
  whole-program prescan; order-independent by construction.
- `ANALYSIS` = {typedView} — settled by analyze.
- `DEMAND` = {external, typedarray, set, map, closure, f16, clamped} —
  accumulated monotonically (false→true only) during emission; readable only
  at resolveIncludes()+ (i.e. post-emission).

Enforcement is the EXISTING assertCtxInvariants pattern (ctx.js:661, phase-
tagged, JZ_DEBUG_INVARIANTS-gated, subset-safe — no Proxy, the kernel compiles
this file): snapshot the SESSION+PROGRAM strata at `post-prepare`, snapshot
+ANALYSIS at `post-analyze`; at `pre-assemble` assert all three snapshots
unchanged and every key present (no shape drift). A settled stratum that
changed = a phase violation named at the boundary, not a distant misfire.
DEMAND needs no snapshot — monotone accumulation is its contract; assert only
monotonicity if cheap (skip if not).

Reader contract (documented at the init, checked by the survey greps as the
review gate, not runtime): emission may read SESSION|PROGRAM|ANALYSIS;
resolveIncludes and assemble may read all.

## Slices
1. **Seed + declare + assert** — add f16/clamped/typedView to the init with
   stratum comments; restructure the init comment into the four strata;
   extend assertCtxInvariants with the snapshot checks. Gate: byte-identity
   on the size-sweep corpus (seeding changes dict shape — if kernel bytes
   move, that is a FINDING about shape-sensitivity, report don't paper),
   battery, kernel parity.
2. **Reader-contract sweep** — grep-audit every `ctx.features.` read, classify
   by phase, annotate violations found (expect zero live ones; any found is
   a real latent bug of the bigint-ordering class).
3. **Post-carrier retirement** — when carrier Slice 5 lands, `bigint`'s
   toNumF64 semantic gate dies (carrier design §5); `bigint` REMAINS a
   PROGRAM-stratum size gate for stdlib arms ($__typeof/$__is_truthy/
   $__to_num bigint arms). No stratification change — only the reader list
   shrinks. This is the convergence audit-#13 names.

## Non-goals
No FeaturePlan object/indirection layer — the bag stays a flat seeded dict
(kernel dict-shape friendliness; the strata are a CONTRACT, not a runtime
structure). No behavior change in any slice before 3.

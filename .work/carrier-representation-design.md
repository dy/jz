# Universal carrier representation — design (audit #12 mandate)

Read-only deliverable, HEAD 355a91c7 (2026-08-06). Answers audit #12's core
finding and its P0-4 corollary:

> "Required architecture: selective tagged boxing or a parallel runtime tag
> at every ambiguous join/storage/call/boundary. Raw i64 may remain unboxed
> only while statically proven. Then represent `Present<K> | Undefined`
> directly and delete magnitude-based semantic guesses."
> "Solve carrier representation, then build the complete module graph and
> freeze a FeaturePlan before any module template or stdlib dependency is
> materialized." (P0-4)

This doc is the seventh pass at the BigInt-carrier half of the problem
(rounds 1–6, `.work/archive/bigint-round3-design.md`) and the first to
reconcile it with the OTHER half that has actually shipped since the
parking decision: `mayBeUndefined`/`presentVal`
(`.work/represented-maybe-undefined-design.md`). It does not re-open the
parking decision — it re-measures it, against today's tree, with numbers
this session collected live, and hands the user a build-vs-keep-parked
call with those numbers attached.

## 1. Status quo, measured today, not assumed

**The round-3 solver fact exists and is dormant — verified, not just
read off the source.** `bigintBoxed` is a real `REP_FIELDS` entry
(`src/reps.js:84-92,256`), computed by two live producers — the intra-body
W-sink walk (`src/compile/analyze.js:681`, `markBigintSink`) and the
inter-function call-site/return fixpoint (`src/compile/narrow.js:2315-2378`,
`bigintBoxedVerdict`, with a fixpoint-completeness assert at :2377-2378 and
param-seeding at `src/compile/index.js:1443-1446`). A diagnostic-only stats
collector (`src/compile/bigint-boxed-stats.js`, `JZ_DBG_BIGINT_STATS`-gated,
"not part of the production compile path" per its own header) counts the
verdicts. **Nothing consumes the fact to change codegen**: `grep -rn
bigintBoxed src/compile/emit.js src/ir.js layout.js` — zero hits outside
`reps.js`/`analyze.js`/`narrow.js`/`bigint-boxed-stats.js`. No `boxBigInt`/
`unboxBigInt` function exists in `src/ir.js`; no `PTR.BIGINT` tag exists in
`layout.js`'s `PTR` table. The fact is computed, fixpoint-verified,
statistics-collected — and thrown away.

**PTR.BIGINT=5 is still free.** `layout.js:27-39`'s `PTR` table: `ATOM:0,
ARRAY:1, BUFFER:2, TYPED:3, STRING:4, OBJECT:6, HASH:7, SET:8, MAP:9,
CLOSURE:10, EXTERNAL:11` — tag 5 (and 12–15) unassigned, `LAYOUT.TAG_MASK:
0xF` (4 bits, room for 16). Round-3's slot reservation still holds
unconditionally.

**Live probe against today's bigger kernel (this session, read-only, no
build/dist write)**: `src/compile/erasure-diag.js`'s `scanErasureSinks` is
wired at `src/compile/index.js:2334` (runs per-function during
`analyzeFuncs`, `JZ_DBG_BIGINT_ERASURE`-gated) — the exact §4.2 diagnostic
round-3 specified as "Implementation order step 1: build the erasure-graph
walk as a DIAGNOSTIC first ... run over corpus + kernel graph." It had never
been run against the real 149-module self-host graph. Sanity-checked first
against 6 synthetic W-sink repros (dict/Map store, return, ternary-nullish,
closure capture — all fire correctly; pure arithmetic `x + 1n` correctly
fires zero) then run for real:

```
JZ_DBG_BIGINT_ERASURE=1 JZ_DBG_BIGINT_STATS=1 node -e '
  compile(resolveModuleGraph("scripts/self.js", {resolveNode:true}).code /* + modules */,
          {optimize:false})'
```

Result: **57 erasure hits across the whole self-hosted kernel** (149
modules — `call-arg` 37, `closure-capture` 6, `return` 5, `ternary-nullish`
5, `dataview` 3, `collection` 1). These are the *raw inventory* (flows a
BIGINT-kinded expression makes into a kind-erasing site — proof not
re-verified, per the diagnostic's own doc comment). The *actual* fixpoint
verdict (`bigintBoxedStats`, same run): **1 param + 10 locals settle
`bigintBoxed=true`**, everywhere else in the 57-hit inventory resolves raw.
The 10 boxed locals are ALL module-scope `const` bindings in
`m113_assemble` (`NAN_PREFIX`, `TAG_SHIFT_BIG`, `TAG_MASK_BIG`,
`AUX_SHIFT_BIG`, `SSO_BIT_BIG`, `OFFSET_MASK_BIG`) and `m50_encode`
(`F64_SIGN`, `F64_NAN`, `F64_QUIET`) plus one `bif176_4` — one-time
module-init constants, not hot-loop values, and plausible
`src/snapshot.js` init-snapshot candidates (the build already snapshots
module-init state ahead of `_start`, per `scripts/build-dist.mjs`'s own
comment). The 1 boxed param is `m61_layout$i64Hex`'s `param0` (`bits`) —
`i64Hex` is called from ~9 sites across the kernel; the fixpoint could not
prove EVERY call site's argument is provably BIGINT, so it boxes exactly
that one function's entry, nowhere else.

This directly falsifies round-3's own hand-wavy claim ("layout.js ptrBits
… Their reach-set is pure local arithmetic → bigintBoxed=false → 100% raw
forever") in its DETAIL — layout.js's own `ptrBits`/`i64Hex` family DOES
generate erasure hits (34 of 57, mostly `call-arg`) — but CONFIRMS its
CONCLUSION: the fixpoint resolves all but one of those flows to provably
uniform, so `objectSchemaGuardHex`/`nanPrefixMaskHex`/`atomNanHex`/
`ssoBitI64Hex`/`sliceBitI64Hex`/`hcacheBitI64Hex`/`ptrNanHex`/`ptrBoxPrefixBigInt`/
`ptrBits` itself stay 100% raw despite having erasure hits recorded; only
`i64Hex`'s own param boxes. **The self-hosting wall's actual footprint,
measured against the current 149-module tree, is 11 sites, of which 10
are one-time constants and 1 is a single non-hot-path helper's entry
param** — not "somewhere in the kernel," a named, small, mostly-cold set.

**The magnitude heuristic — the thing the mandate names for deletion —
has 6 live implementation sites today** (not counting the ~9 places
that merely cite/consume the flag that gates them):

1. `src/compile/emit.js:536-545` — `TYPEOF.bigint`'s own arm: finite,
   nonzero, subnormal `abs` ⇒ "bigint".
2. `src/compile/emit.js:4392-4396` (`isBigIntCarrierBits`) consumed by
   `bigIntJointDispatch`'s `flagIR` (`:4425-4436`) — audit-#10's own
   runtime-domain dispatch (§19 below), itself built ON TOP of the
   heuristic for the one case (`null`-domain: a never-reassigned param of
   an exported function) it treats as safe to runtime-probe.
3. `module/number.js:1547-1568` — `$__to_num`'s two arms: the
   `ctx.features.bigint`-gated branch applies the heuristic; the
   else-branch (program provably never constructs a BigInt) skips it —
   both exist SOLELY because the heuristic itself is unsound and needs
   whole-program scoping to avoid corrupting subnormal Number literals
   (the `audit-#11 P0-1` fix, `test/data.js:46-80`, both now closed by
   this scoping — see §5's kill-list for why the scoping itself becomes
   unnecessary, not just correct).
4. `src/ir.js:1200-1230` — `toNumF64`'s inline fast path, same
   `ctx.features.bigint`-gated magnitude check, the hot-path twin of (3).
5. `module/core.js:73-123` (`$__eq`) — line 80's own comment: "a
   non-canonical `0xFFF8..` pattern can only be a negative BigInt
   carrier — bit-identical to itself and correctly equal." Sound only
   because `__eq`'s fast path never needs to DISTINGUISH BigInt from
   anything else, just detect bit-identity — but this is the exact
   "sign-bit disjointness covers only negative raws" gap round-3 §2
   R-recovery item 4 named; no positive-value or cross-representation
   BigInt comparison is handled correctly by design here, it's a
   accident of the fast path never being asked to.
6. `interop.js:134` (`isBox`) + its 4 consumers (`:213,407,515,801,806`)
   — the export/interop decode boundary's own bit-SHAPE heuristic
   (round-3's R6, "the same shape-heuristic class" as the others).

**Two live KNOWN-FAIL rows are direct, unfixed consequences of the
dormant fact**, both in `test/dyn-keys.js`, both explicitly naming the
gap: line 1131 ("architecturally out of reach — needs new boundary-boxing
infra, §6 presentKindUnboxed/bigintBoxed, not this design") — a
zero-evidence dynamic-param BigInt PAIR silently returns `typeof
'number'` instead of `'bigint'`; line 1309 ("found landing §16→§18, out
of scope") — a param-hop through a callee gets the right `typeof` (this
session's own kind-5 sentinel machinery gets that far) but the WRONG
VALUE (`r !== -5n`, pinned as a documented wrongness, not a crash).
Two more documented divergences close as a side effect of real boxing:
the bitwise both-absent `0n`-vs-`0` carrier-bits collision
(`.work/represented-maybe-undefined-design.md` §19's own "documented
gap" row) and the mixed-kind-Map negative control (§13, "honestly pinned
as the DOCUMENTED, UNFIXED behavior").

**`ctx.features.bigint`'s ordering fragility is a live, present-day bug
class, not a hypothetical.** `.work/todo.md`'s tail entry (2026-08-05/06,
"ordering-scan fix … BANK, not fix") found LIVE that `src/prepare/
index.js`'s single-pass `prep()` scan for `ctx.features.bigint` (set at
`:1159`) is order-dependent across the resolved module graph — fixing an
unrelated ordering bug flipped the flag from `false` to `true` for the
compiler's OWN self-hosted build (because `layout.js`'s `i64Hex` uses real
BigInt syntax, previously masked from the scan by iteration order), which
then flipped the `ctx.features.bigint`-gated magnitude heuristic (site 3/4
above) kernel-wide and traded one narrow bug (a JSON property-key parse)
for a broader one (any subnormal Number anywhere in a kernel-compiled
program). The session that found this explicitly named it a "TRUE FIX …
(b) redesign the carrier disambiguation off a single whole-program
boolean … the compiler-as-a-program and compiler-as-a-target are the SAME
flag today" — i.e. named exactly the P0-4 FeaturePlan gap, from the
BigInt-carrier side, independently of this doc.

## 2. History metabolized

- **Round 1 (always-box)**: correct, warm-blocked — measured
  1.012–1.023× against the era's 0.99× cap (bigint-round3-design.md:3-7).
  Failure mode: boxed EVERY BigInt binding unconditionally, including
  provably-raw arithmetic-only ones, paying real heap allocation in hot
  loops that never needed it.
- **Round 2 (boundary boxing + runtime tag-check fallback)**: UNSOUND, not
  just imperfect. The self-hosting wall: `layout.js`'s `ptrBits`
  (`:70-74`) and `src/wat/assemble.js` build genuinely NaN-box-SHAPED bit
  patterns as raw BIGINT DATA (their own job is to construct pointer
  encodings) — a runtime tag-check reading those bits at a kind-erased
  site cannot tell "this is a real boxed pointer" from "this is bigint
  data that happens to look like one," because round 2's fallback
  re-derives box-vs-raw FROM the bits themselves, at the point of
  consumption, instead of deciding at the point of write.
- **Round 3 (solver-owned `bigintBoxed`, raw iff proven)**: the SOUND
  design — compute the fact structurally (never re-derive from bit
  shape), enforce it at write (box before the ambiguous flow), read it
  at use (tag dispatch, never magnitude). Landed the FACT (analyze.js/
  narrow.js fixpoint, §1 above) but never landed the CONSUMER side
  (boxBigInt/unboxBigInt/PTR.BIGINT/R-recovery tag arms). The user then
  PARKED it: "keep that limitation" (ledger reference, `.work/todo.md`
  "ROUND 2 WALL" entries).
- **The 84-site BigInt-scrub analysis** (commit-era 4bcb8bc0, `.work/
  archive-todo-2026-07.md`/`archive-todo-2026-08.md`): an ALTERNATIVE
  approach — make the compiler's own self-hosted source BigInt-free, so
  `ctx.features.bigint` can never be order-dependently confused by the
  compiler's own plumbing. Found 21 files with real BigInt syntax
  reachable from `scripts/self.js`, 17 genuine (4 false positives:
  `src/bignum.js`, `src/compile/index.js`, `src/prepare/index.js`,
  `src/snapshot.js`), ~150 occurrences, spanning IEEE754 mantissa/exponent
  bit-tricks (`src/prepare/math-kernel.js` — "genuinely hard to do without
  BigInt for exact-bit IEEE754 folding"), BigInt-typed-array support, and
  native `BigInt()` global semantics. Declared DEAD as a strategy: even a
  full scrub only fixes ~15-20 of 84 trigger shapes from `layout.js`
  alone; the remainder needs authoritative-reference-grade rewrites of
  numeric kernels for zero architectural gain — it doesn't even solve the
  underlying problem (the compiler-as-program/compiler-as-target identity
  conflation persists regardless of how BigInt-free the source is,
  because a FUTURE program-under-compilation can always construct one).
  This design does not need it: round-3's fixpoint proves flows raw AT
  THEIR OWN CALL SITES, independent of how many raw BigInt literals exist
  elsewhere in the compiler's source — the erasure-diag probe (§1) is the
  live proof, run against the CURRENT (post-scrub-abandonment) tree.
- **`represented-maybe-undefined-design.md` (audit #9–#11)**: built the
  OTHER half of the mandate — `mayBeUndefined`/`presentVal` REP_FIELDS,
  propagated through decl/param/return/capture via the SAME
  `narrow.js` call-site-fixpoint machinery `nullable`/`bigintBoxed`
  pioneered (reps.js:96-196 cites both as precedent, explicitly). Six
  slices landed (§9-§19 of that doc), closing every non-BigInt-specific
  container-read ambiguity. For the BigInt-specific residual it could not
  close by representation, it built a WORKAROUND instead of the real
  fix: the kind 1–5 sentinel export-lane ABI (`compile/index.js
  _resultBigintSentinel`/`synthesizeBoundaryWrappers`'s `s` marker,
  `interop.js decodeBigintSentinel` + `BIGINT_SENTINEL_BITS`/`VALUES`) —
  its own §13 closing line calls the alternative "a properly-boxed
  dynamic BigInt be self-describing everywhere, collapsing this whole
  sentinel-lane mechanism into 'just works'" and names it "a strictly
  larger undertaking than this slice's lane-only fix," i.e. exactly this
  design, deferred, not rejected. Audit #10's joint runtime-domain
  dispatch (§19) closed the LAST reachable case with ANOTHER
  magnitude-heuristic mechanism (`isBigIntCarrierBits`), and its own
  closing note names the two residuals THIS design closes (§1's
  KNOWN-FAILs) as needing "new boundary-boxing infrastructure … an
  independent, larger undertaking."

## 3. Why this attempt lands where those failed

Three concrete things changed since the parking decision, not just time
passing:

1. **The represented-fact machinery is now proven in production**, not
   theoretical. `mayBeUndefined`/`presentVal` shipped through six real
   slices, each independently green, using the EXACT propagation
   discipline (`REP_FIELDS`, `updateRep`'s typo-guard, `narrow.js`'s
   `runCallsiteLattice` OR-fold vs poison-fold distinction, `DBG_REPS`
   assertion mode) this design's read side needs — reps.js:96-196 already
   documents `bigintBoxed` and `nullable` as the PRECEDENT for
   `mayBeUndefined`, not the other way around; the fixpoint's soundness
   at whole-program scale is no longer a bet, it's observed behavior
   across dozens of landed correctness slices.
2. **The self-hosting wall is now measured, not hypothesized.** Round 3's
   confidence that "layout.js/assemble.js stay 100% raw" was asserted
   without running the diagnostic it specified. This session ran it
   (§1): 57 raw flow sites in the CURRENT, bigger (149-module) kernel,
   of which the fixpoint proves all but 11 sound, and those 11 are
   overwhelmingly one-time module-init constants, not hot-path data.
   Round 1's failure mode (blanket boxing cost) cannot recur structurally
   — round 3 never boxes a solver-proven-uniform value — and the
   measured proof rate (46/57 = 81% of raw flows fully resolved, the
   remainder concentrated in exactly one cold helper) is the actual
   number to weigh against warm cost, not a guess.
3. **The audit trail is concrete and file:line-enumerable, not
   diffuse.** Twelve audits (#1–#12) have progressively narrowed the
   BigInt-carrier residual from "somewhere in the codebase" to two named
   `test/dyn-keys.js` KNOWN-FAIL rows with exact repros, plus the
   FeaturePlan blocker's own root-cause session naming the whole-program
   `ctx.features.bigint` flag as the specific mechanism that needs
   replacing. The kill-list (§5) is not aspirational — every entry is a
   grep result against the current tree.

## 4. The representation choice

**Heap-boxed `PTR.BIGINT` (tag 5), per round-3, not a parallel tag bit.**

A parallel out-of-band tag would need to travel alongside every i64/f64
storage cell everywhere a BigInt value CAN live — locals, stack slots,
heap fields, globals, call args/returns — none of which have a spare bit
today (the NaN-box carrier IS the full 64 bits; a plain numeric i64/f64
local has none to spare). Realizing it means either doubling every such
storage location's width (a strictly larger, permanent cost than
selective boxing pays even in the worst case) or a shadow side-table
keyed by binding identity (which reintroduces the self-hosting wall in a
new shape: the side-table itself becomes data the compiler's own source
manipulates, the same category of problem round 2 hit with `ptrBits`'
output, just relocated). Neither survives contact with "the compiler
compiles its own source, whose values ARE the compiler's data."

Heap-boxed `PTR.BIGINT` reuses the mechanism EVERY other heap-kinded value
already uses (`STRING`/`ARRAY`/`OBJECT`/`HASH`/`SET`/`MAP`/`CLOSURE`
already box via this exact tag-in-NaN-box scheme, `layout.js:26-39`,
`LAYOUT.TAG_SHIFT/TAG_MASK`). Zero new storage primitive, zero new
runtime concept — `mkPtrIR`/`__ptr_type`/`__ptr_offset` all already exist
and already dispatch this way for six other kinds. It only pays at
points the solver cannot prove raw is safe.

**Self-hosting-wall answer, verified against today's kernel (§1), not
assumed**: the fixpoint proves 46 of 57 real-program erasure flows fully
raw already; the residual 11 sites (10 one-time module-init constants,
plausibly snapshot-foldable per `src/snapshot.js`'s existing init-time
pre-eval mechanism the build already uses, and 1 cold helper's entry
param) are the ENTIRE boxing footprint measured against the current
149-module self-hosted compiler. Round 2's wall was: a runtime tag check
at a CONSUMPTION site, reading bits `layout.js`/`assemble.js` construct
as genuine box-shaped data, cannot distinguish "real pointer" from
"BigInt bits that alias a pointer's shape." Round 3 structurally cannot
hit this: no read site ever inspects bit SHAPE to decide box-vs-raw —
every kind-erased reader dispatches on the 4-bit tag alone, which is
exact BECAUSE the write side (the fixpoint-gated `boxBigInt` insertion)
guarantees no unboxed-but-box-shaped bigint content can reach a slot a
later reader would tag-dispatch on. `layout.js`'s own `ptrBits`/`i64Hex`
DO produce box-shaped bit patterns (§1's 34 hits) — but they are provably
CONSUMED ONLY as arithmetic/formatting inputs (never stored into a
dict/array/Map/closure-capture/export slot without being re-derived),
so the fixpoint correctly proves them raw and no read site ever has to
guess what they are.

## 5. Present\<K\>\|Undefined unification + kill-list

The boxed carrier makes represented-undefined vs present-BigInt
runtime-distinguishable by the SAME tag-dispatch mechanism every other
kind already uses — `presentVal`'s BIGINT arm (reps.js:135-196) stops
being an approximate, opt-in, poison-on-disagreement census claim and
becomes an exact, tag-verifiable fact like every other `presentVal`/`val`
kind. This is the direct mechanism the mandate names: "represent
`Present<K> | Undefined` directly."

**What this design deletes, enumerated against the current tree:**

| # | Site | What deletes / becomes unconditional |
|---|---|---|
| 1 | `compile/index.js` `_resultBigintSentinel` producer + `synthesizeBoundaryWrappers`'s `s`-marker lane | Entire kind 1–5 sentinel export-lane mechanism — a boxed BigInt decodes via its own `PTR.BIGINT` tag like every other heap export, no lane needed |
| 2 | `interop.js decodeBigintSentinel` + `BIGINT_SENTINEL_BITS`/`VALUES` table, 3 call-site decode branches | Same — deleted with (1) |
| 3 | `kind.js censusBigintSentinelKind` (kinds 1-3), `censusBigintBinaryVT`, `BIGINT_JOINT_BINARY_OPS` gen | The whole audit-#10 joint-dispatch apparatus this design's own §19 built — becomes unconditional real tag dispatch, not runtime-probed |
| 4 | `emit.js bigIntDomain`/`isBigIntCarrierBits`/`bigIntDomainsCanMix`/`bigIntJointDispatch` (~140 lines, `:4340-4460`+wiring at 9 binary ops) | Superseded — every operand's BigInt-ness is a tag check, not a domain guess |
| 5 | `emit.js TYPEOF.bigint` magnitude arm (`:536-545`) | Real `__ptr_type(v) == PTR.BIGINT` check |
| 6 | `module/number.js $__to_num`'s two `ctx.features.bigint`-gated arms (`:1547-1568`) | One arm, tag-checked, no whole-program scoping needed |
| 7 | `src/ir.js toNumF64`'s `ctx.features.bigint`-gated inline fast path (`:1200-1230`) | Same — tag check replaces magnitude+flag |
| 8 | `module/core.js $__eq`'s implicit negative-BigInt tolerance (`:80`) | Real `PTR.BIGINT` deref-compare arm (round-3 §2 R-recovery item 4) |
| 9 | `interop.js isBox()` (`:134`) + BigInt-specific paths at its 4 consumers (`:213,407,515,801,806`) | Tag-based decode, no shape-heuristic |
| 10 | `ctx.features.bigint` itself (`src/prepare/index.js:1159` producer; `src/ir.js:1216`, `module/number.js:1547` — its ONLY two consumers) | Dead: its sole purpose was scoping the magnitude heuristic's cost. Deleting it also deletes the ordering-fragility bug (§1) at the root, not just its symptom |
| 11 | `test/dyn-keys.js:1131` KNOWN-FAIL (zero-evidence dynamic-param pair, wrong `typeof`) | Flips green |
| 12 | `test/dyn-keys.js:1309` KNOWN-FAIL (param-hop, right type/wrong value) | Flips green |
| 13 | `.work/represented-maybe-undefined-design.md` §19's documented bitwise `0n`-vs-`0` gap | Closes (both operands are tag-checkable, no carrier-bits collision) |
| 14 | §13's mixed-kind-Map negative control (documented, unfixed) | Closes (every value in a mixed-kind Map decodes by its own tag, not a whole-receiver census claim) |
| 15 | `test/data.js:46-80`'s subnormal-literal / 2^52-1 curated-then-fixed rows | Stay fixed, but the FIX no longer depends on `ctx.features.bigint`'s scan order — the fragility class these tests exist to pin dies at the root, not just at these two literals |

**Not touched, explicitly**: `mayBeUndefined`/`presentVal` themselves
(§2's non-BigInt slices) — this design is the BIGINT-specific
completion of that machinery, not a replacement for it. `__to_bigint`'s
separate, narrower pass-through gap (round-3 risk 4, still unaddressed,
still explicitly out of scope) and `__same_value_zero`/`__map_hash`'s
missing BigInt arm (round-3 R-recovery item 5 — no arm exists today,
confirmed still true by grep; ADD one, don't just retag).

## 6. FeaturePlan (P0-4) — the follow-on stage

**Why this must come SECOND, mechanically, not just by mandate fiat**:
`ctx.features.bigint` is item 10 in §5's kill-list — freezing a
FeaturePlan that includes it BEFORE carriers are sound would freeze a
flag whose only purpose (scoping a magnitude heuristic's cost) is about
to disappear. Landing carriers first shrinks the flag set FeaturePlan
needs to freeze, and removes the one flag whose CORRECTNESS (not just
performance) depends on scan order — the exact bug the ordering-scan
session found.

**Problem, restated precisely**: `ctx.features` (`src/ctx.js:626-639`) is
a mutable bag of booleans — `external, sso, typedarray, set, map,
closure, bigint, timers, blockingTimers` plus `errorClasses` — set
ad-hoc: some by `prep()`'s single early per-node scan (`bigint`, `error`
via `src/prepare/index.js`), others organically as functions are analyzed
and modules pulled in (`typedarray`/`set`/`map`/`closure` "set on
construction," `timers` "set by prepare.js when timer module is
included"). Every reader downstream of a writer sees a correct value;
every reader that runs BEFORE some writer that would have flipped it does
not — this is precisely the class of bug the ordering-scan investigation
found live for `bigint` (§1) and is architecturally possible for every
other flag in the bag, not proven absent for the others, merely
unobserved so far.

**Design** (the `architecture-plan.md` Stage 2 "frozen FunctionPlan"
precedent is the direct template — same predictor→assert→flip→delete
slicing discipline that landed `ctx.func.repsFrozen` +
`JZ_DEBUG_INVARIANTS` enforcement for `ValueRep`, `architecture-
plan.md:176-231`): one pass over the FULL resolved module graph
(`src/resolve.js resolveModuleGraph` already produces this — `g.modules`,
already used by `build-dist.mjs`/this session's own probe) computes EVERY
`ctx.features.*` flag as one frozen, order-independent fact BEFORE any
module template (`ctx.core.stdlib[...]` bodies) or stdlib dependency
(`inc()`-triggered `ctx.core.includes`) is materialized. Concretely: walk
`g.code` + every `g.modules[...]` entry once, in the SAME
graph-closure sense `prep()`'s node-order scan currently only covers
the entry module's own AST (the exact gap the ordering bug exploited —
`layout.js`'s contribution was masked by iteration order because it's a
DEPENDENCY, not the entry source). `ctx.func.repsFrozen`'s enforcement
pattern (throw under `JZ_DEBUG_INVARIANTS` if any code path still WRITES
a `ctx.features.*` flag after the freeze point) is the direct transplant
for this: assert-first, delete-writer-second, same discipline that closed
Stage 2.

**Sequencing**: this stage is out of THIS design's charter — named here
per the mandate's own ordering, sized against the simplified flag set
carrier-boxing leaves behind (§5 item 10 gone; `error`/`errorClasses`
already mirror the same "prep() scan, order-independence documented in
its own comment" pattern per `src/prepare/index.js:1160-1168` and would
be the FeaturePlan design's next audit target, not this one's).

## 7. Migration slices — each independently green, each with a warm checkpoint

The historical killer (round 1) was warm cost from boxing values the
solver never needed to box. `test/selfhost-perf.js`'s `WARM_CAP` is
`1.03×` today (re-baselined UP from `0.99×` on 2026-08-01 — `:80-100` —
to absorb ~90 commits of unrelated correctness machinery; documented
current margin ~1.00–1.02×, i.e. **already thin, ~1-3% headroom** before
this design adds anything). Every slice below states its own gate
against this specific number, not just "run the battery."

**Slice 0 — diagnostic promotion (near-zero risk).** Turn
`scanErasureSinks` from an observation-only counter into round-3 §4.2's
real erasure-graph ASSERT: once `boxBigInt` exists (Slice 1), assert
every recorded W-sink flow's value subtree roots at `boxBigInt(...)` or a
proven-non-bigint operand, under `JZ_DEBUG_INVARIANTS`. Lands as a
SPECIFICATION before any consumer exists (matches round-3's own
"Implementation order" step 1: diagnostic first, empirically cross-check,
then wire consumption). Warm checkpoint: **zero** — DBG-gated, byte-
identical off-flag.

**Slice 1 — `PTR.BIGINT` + box/unbox primitives, additive only.**
`layout.js:27-39` `PTR.BIGINT = 5`. `src/ir.js`, beside `asI64`/`fromI64`
(`:326-338` per round-3 §3.4): `boxBigInt` (alloc 8B + `i64.store` +
`mkPtrIR`), `unboxBigInt` (`ptrOffsetIR` + `i64.load` — safe, `PTR.BIGINT`
not in `FORWARDING_MASK`), `isProvenBoxedBigint` (reads the now-consumed
`bigintBoxed` fact). Zero call sites reference these yet. Warm checkpoint:
**zero** — dead code, unreachable from any emission path.

**Slice 2 — W-sink def-side wiring (the first slice that can allocate).**
Wire the 9 W-sinks (round-3 §2: object/dyn-prop store, array-elem store
non-uniform, Set/Map, call-arg/return without uniform proof, closure
capture, ternary-nullish merge, export/interop, atomics/DataView,
string-coercion fallback) to box `iff bigintBoxed` — the fact ALREADY
computed, consumed for the first time. **This is the slice round 1's
failure mode could reappear at, if the fact is wrong rather than the
consumption**. Gate, explicit and non-negotiable per the mandate's own
instruction: `perf-ratchet` 10/10 at +0 delta AND a fresh `warm self-host
geomean ≤ 1.03×` measurement taken SPECIFICALLY after this slice (not
deferred to the end) — §1's measured 11-site footprint predicts near-zero
marginal cost; this slice is where that prediction gets falsified or
confirmed for real, against actual codegen, not the diagnostic's
projection.

**Slice 3 — R-recovery (read side, highest risk, WAT surgery).** Per
round-6's blueprint order: `$__eq` `PTR.BIGINT` deref-compare arm FIRST
(hottest helper, `module/core.js:73-123`), parity-gated alone before
touching anything else; then `$__is_truthy` + its `optimize/index.js`
peephole twin; `$__same_value_zero`/`$__map_hash` NEW arms (none exist
today, confirmed §5); `module/number.js` bigint `toString`/`asIntN`/
`asUintN` via the new `unboxBigInt`; `interop.js` `type===5` decode arm;
`TYPEOF.bigint`'s tag check landed ALONGSIDE (not replacing yet) the
magnitude fallback. Land per-arm with its own kernel-parity/kernel-oracle
gate; keep the OLD magnitude arms present-but-dead until every R-recovery
arm is independently verified (round-3's "land all-or-nothing" warning —
reinterpreted here as "verify all arms before DELETING the fallback," not
"land zero arms until all exist"). Warm checkpoint: read-side tag
dispatch replaces a magnitude compare — expect neutral-to-positive
(a tag check is cheaper than the 3-instruction subnormal test it
replaces), verify, don't assume.

**Slice 4 — FeaturePlan (§6), independent follow-on.** Out of this
design's own charter; named for sequencing only.

**Slice 5 — kill-list deletion.** Delete §5's 10 magnitude/sentinel
sites once Slice 3's arms are ALL verified; flip the 2 KNOWN-FAIL rows
and the 2 documented-gap rows to green pins. Full discipline matching
every prior landed slice in this codebase: native + kernel (O0/O2/O3) +
wasi + selfhost + fuzz (2000×4) + fresh build ×2 byte-identity + warm/
fresh perf gates, foreground chunks per the project's own battery
convention.

## 8. Decision: build vs keep-parked

**Cost.**
- Round 1's measured warm cost (1.012–1.023× against the era's 0.99× cap)
  is NOT this design's cost — it measured always-boxing, the wrong
  shape. Not a valid estimate for round 3.
- Round 3's actual footprint, measured THIS session against the CURRENT,
  bigger (149-module) self-hosted kernel: 57 raw BigInt flow sites total;
  the solver's own already-landed, already-tested fixpoint (its own
  33/33 kernel-parity + 451/451 kernel-oracle battery already exercises
  it as pure observation) proves 46 of them fully raw, leaving **11 real
  box sites — 10 one-time module-init constants (snapshot-foldable) and
  1 cold helper's entry param. Zero hot-loop box sites measured.**
- Current warm margin is thin (~1.00–1.02× against a 1.03× cap, per
  `selfhost-perf.js`'s own documented history of ~90 commits of
  correctness-machinery cost already eating most of the original
  0.99×-era headroom) — Slice 2 is where this gets tested for real, not
  assumed safe because the count is small.
- Engineering cost: 5 independently-green slices, the highest-risk one
  (Slice 3, R-recovery WAT surgery) already scoped site-by-site by
  round-6's blueprint — bounded, not open-ended.

**Benefit.**
- Closes 4 live wrong-value rows with exact repros
  (`test/dyn-keys.js:1131,1309`, the bitwise `0n`-vs-`0` gap, the
  mixed-kind-Map negative control).
- Deletes 10 kill-list mechanisms (§5) — the entire kind 1–5 sentinel
  export-lane ABI, the ~140-line audit-#10 joint-dispatch apparatus, 6
  magnitude-heuristic implementation sites, and `ctx.features.bigint`
  itself (2 consumers, 1 producer, and the ordering-fragility bug it
  carries — a correctness hazard independent of this design's own
  motivation, found live by an unrelated session).
- Unblocks P0-4's FeaturePlan with a smaller, more honest flag set (no
  flag whose correctness — not just performance — depends on
  whole-module-graph scan order).
- Retires the 84-site BigInt-scrub as a dead alternative permanently —
  this design doesn't need the compiler's own source to be BigInt-free;
  the fixpoint proves flows raw at their own sites regardless.

**Recommendation**: land it, starting with Slices 0–2 as a bounded first
commitment — additive/dormant-consuming, near-zero risk on their own
terms, with the mandate's own historical-killer check (a real warm
measurement) taken at the END of Slice 2 specifically, before committing
to Slice 3's higher-risk WAT surgery. The 2026-07-29 parking decision
("keep that limitation") predates all three changes in §3: the
represented-fact machinery's production track record, this session's
measured (not assumed) box-site count, and the concrete four-row
wrong-value inventory plus the FeaturePlan blocker now depending on it.
The number that should move the decision is §1/§8's measured 11 — not
round 1's 1.012–1.023×, which this design was never going to repeat.

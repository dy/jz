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
(rounds 1–6, deleted round-3 design doc — history in `.work/todo.md`
§deletion-sweep, this doc supersedes it) and the first to
reconcile it with the OTHER half that has actually shipped since the
parking decision: `mayBeUndefined`/`presentVal` (deleted design doc,
history in `.work/todo.md` §deletion-sweep). It does not re-open the
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
the bitwise both-absent `0n`-vs-`0` carrier-bits collision (deleted design
doc's §19 "documented gap" row, history in `.work/todo.md` §deletion-sweep)
and the mixed-kind-Map negative control (§13, "honestly pinned
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
  1.012–1.023× against the era's 0.99× cap (deleted round-3 design doc,
  history in `.work/todo.md` §deletion-sweep).
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
- **The presentVal design** (deleted doc, history in `.work/todo.md`
  §deletion-sweep, audit #9–#11): built the
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
| 13 | Deleted presentVal design's §19 documented bitwise `0n`-vs-`0` gap (history in `.work/todo.md` §deletion-sweep) | Closes (both operands are tag-checkable, no carrier-bits collision) |
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

## 9. Slices 0–2 — as landed (2026-08-06)

Landed per the user's explicit bound: Slices 0–2 only. Slice 3 (R-recovery,
the read side where runtime behavior changes) is untouched — every default
build stays byte-identical, proven below, not assumed.

**Slice 0 — diagnostic promotion.** `src/compile/erasure-diag.js` promoted
(doc header) to a maintained tool; re-run against the current 149-module
kernel graph reproduced §1's exact numbers (57 hits — call-arg 37,
closure-capture 6, return 5, ternary-nullish 5, dataview 3, collection 1;
fixpoint verdict 11 real box sites, same named bindings). Committed as
`.work/carrier-box-baseline.md` (repro command + result table + one finding).
Added `assertErasureConsistency` (JZ_DEBUG_INVARIANTS-gated, no-op
off-flag): a real erasure-graph soundness cross-check, but WHOLE-PROGRAM
("some local settled boxed, but the walk recorded zero hits anywhere ⇒
solver/diagnostic have gone dark relative to each other"), not per-function
as this section's own §7 text first suggested — a per-function form was
tried and immediately, correctly, tripped on a genuine but BENIGN
attribution split: the 10 module-init-constant locals settle `bigintBoxed`
via analyze.js's top-level walk (attributed to `'(top)'`), while
`scanErasureSinks` attributes their corresponding hits to the
module/function whose body holds the const's own initializer expression —
two independently-implemented instruments naming the same flow differently,
not a solver bug. Documented in both the code comment and the baseline file.

**Slice 1 — box/unbox primitives.** `layout.js` `PTR.BIGINT = 5` (confirmed
still free). `src/ir.js`, beside `asI64`/`fromI64`: `boxBigInt` (alloc 8B via
`__alloc` + `i64.store` + `mkPtrIR` — NOT `__alloc_hdr`; a bare 8-byte cell
per this section's own "8-byte i64 heap cell" line, no len/cap header a
scalar box never needs), `unboxBigInt` (`ptrOffsetIR` + `i64.load`),
`isProvenBoxedBigint(name)` (reads `repOf(name)?.bigintBoxed`),
`needsBigintBox(node)` (bare name → the rep; any other BIGINT-kinded
expression → box unconditionally, matching analyze.js's own "inline
expressions box at emission time, no rep needed" comment). Zero call sites
reference these unconditionally — `carrierF64`/`coerceArg`/`'return'`/`'?:'`
all gate the new branch behind `CARRIER_BOX` (Slice 2). Test-only
`__box_bigint`/`__unbox_bigint` jz-source intrinsics added to
`module/core.js` (mirroring the existing `__mkptr`/`__ptr_type`/
`__ptr_offset` debug-intrinsic family) for unit-level pins in
`test/pointers.js`: box→unbox roundtrip at 0, small ±values, i64 max
(2^63−1), i64 min (−2^63), a value whose bits alias a genuine NaN-box shape
(round-2's own wall, re-run through the new box/unbox pair), non-interning
(two boxes of the same value get distinct heap cells), and PTR.BIGINT's tag
disjointness from the other 11 live tags. 8/8 pass.

**Slice 2 — W-sink def-side wiring, flag-gated (the design was ambiguous on
staging; flag-gated was chosen as the safest reading, per the task's own
explicit fallback instruction).** `JZ_CARRIER_BOX` / `CARRIER_BOX` added
beside `DBG_INVARIANTS` in `src/ctx.js`, default OFF. Wired, all
`CARRIER_BOX`-gated:
- `carrierF64` (`src/ir.js`) — the design's own single W-sink choke-point
  for boxed-value storage positions (confirmed from `.work/todo.md`'s
  "ROUND 5 WALL" entry, which independently named this exact function as
  the chokepoint an earlier, reverted attempt used). Covers dyn-prop/
  array-elem/Set/Map store and closure-capture (all route through
  `bridge.js`'s `storedValue`, which is `carrierF64`'s only caller besides
  a few in-file duplicates) — the `collection` and `closure-capture` sinks.
- `coerceArg` (`src/compile/emit.js`) — call-arg into a KNOWN user function
  whose param settled `bigintBoxed=true` (narrow.js's own call-site half of
  the invariant, already stamped onto `sig.params`). Covers the `call-arg`
  sink for resolved callees — the empirically load-bearing case: the
  measured tree's one real boxed param (`m61_layout$i64Hex` param0) is
  exactly this shape.
- `'return'` (`src/compile/emit.js`) — extends the existing (but
  bool-mixed-only) `carrierF64` call at the return site to also fire for a
  uniform (non-mixed) return whose value is independently proven
  `bigintBoxed` by some OTHER sink in the same body. NOT a new fact: grep
  confirms analyze.js's W-sink walk has no `op==='return'` producer at all,
  so this only fires when the fact already holds for an unrelated reason —
  extending the producer itself is out of this task's additive-only bound.
- `'?:'` (`src/compile/emit.js`) — mirrors kind.js `VT['?:']`'s own
  BIGINT+nullish-literal rule exactly (same condition, same file's own
  precedent), always via `if`/`else` control flow (never `select`, which
  would eagerly allocate the box on the untaken branch — the documented
  root cause of round 2's own "ternary-beside-nullish wrongly boxed" bug).

**Two real bugs found and fixed during this slice's own development** (the
mandate's own historical-killer check working as intended — caught by a
flagged-build probe before landing, not after):
1. **Param double-box.** A `bigintBoxed=true` PARAM already arrives boxed
   from the caller (`coerceArg` boxes it AT THE CALL SITE) — narrow.js's own
   comment says exactly this: "consulted by the call-site emitter, not by
   the callee body … the callee simply carries an opaque pointer through."
   The first cut of `isProvenBoxedBigint` didn't encode that: `(x) => x`
   (an identity function called once with a real BigInt) re-boxed the
   ALREADY-boxed param on return — a box wrapping a pointer's own bits as if
   they were a fresh bigint payload. Fixed at the single shared predicate
   (`isProvenBoxedBigint`, `src/ir.js`): excludes the current function's own
   params from the "still holds raw bits" claim.
2. **Ternary double-box.** `needsBigintBox`'s "any non-bare-name BIGINT node
   boxes unconditionally" fallback (sound for plain arithmetic, e.g.
   `return y + 1n`) was ALSO applied to `'?:'` nodes by `'return'`/
   `carrierF64` — but a ternary-nullish merge already has its OWN dedicated,
   more precise wiring (arm-only, `if`/`else`-gated) that is the sole
   authority for that AST shape. `(cond, x) => cond ? x : null` reboxed the
   '?:' handler's own already-correct output. Fixed by excluding `'?:'`
   nodes from `needsBigintBox`'s unconditional fallback — every OTHER
   consumer now defers fully to the ternary emitter's own decision.

Both were caught by hand-built repros compiled under `JZ_CARRIER_BOX=1` and
inspecting the emitted WAT during this session, BEFORE the kernel-scale
probe below — exactly the "verify, don't assume" discipline §7 asks for.
Post-fix, the same repros box correctly (single allocation, non-boxed
params pass through unchanged, ternary handler's decision is authoritative)
and all default-build gates were re-run clean (kernel-parity 33/33,
kernel-oracle 451/451, perf-ratchet 10/10, full battery unchanged).

**Explicitly NOT wired, scoping decision for the coordinator's review:**
`dataview` and `export/interop`. DataView.setBig(U)Int64's value argument is
a raw-bytes CONSUMER (SetViewValue writes raw i64 bits into buffer memory,
not a NaN-boxed slot) — if its source name is ever `bigintBoxed=true`, that
name needs UNBOXING at this read, which is Slice 3's job, not a def-side box
point; confirmed empirically too (zero of the 11 real box sites are
dataview-sourced). Export/interop touches the kind 1–5 sentinel-lane ABI
this design's own §5 kill-list reserves for Slice 5 deletion, and
`erasure-diag.js` never tracked an `export` sink category to verify against
— out of bounds for an additive, diagnostic-verifiable slice.

**Gates, DEFAULT build (CARRIER_BOX unset):**
- kernel-parity: 33/33 byte-identical (O0/O2/O3 × 11 examples).
- kernel-oracle: 11/11 suites, 451/451 assertions.
- perf-ratchet: 10/10 at +0 delta.
- full battery (`node test/index.js`): 3354/3362 pass, 2 pre-existing
  failures unrelated to this work (test/optimizer.js bounds-check-guard
  counts — reproduced identically on a clean HEAD worktree before this
  session's changes), 6 skip — same as baseline.
- selfhost.js: 21/21.
- fuzz: 2000 programs × opt {0,1,2,3}, 0 divergence.
- fresh `npm run build` × 2: `dist/jz.wasm` SHA-256 byte-identical across
  both builds.
- `test/pointers.js` (Slice 1 unit pins): 8/8, folded into the full battery
  count above.

**FLAGGED probe build (JZ_CARRIER_BOX=1):** not run as a full battery per
the mandate (Slice 3's readers aren't landed — a flagged build is expected
to allocate correctly at the write sites, not run whole programs correctly
end-to-end) — but DID run the real kernel-scale probe the mandate names:
`compile(g.code, {modules: g.modules, optimize: false})` against
`scripts/self.js`'s full 149-module graph with `JZ_CARRIER_BOX=1`.
Compiled clean (41.6s, 11.4 MB wasm) and `new WebAssembly.Module(wasm)`
validated it — no trap, no malformed-module error, no invariant assert
firing. Textual WAT dump (`{wat:true}`) confirmed the engagement the
diagnostic predicts: **40 `call $__mkptr (i32.const 5) …` box-construction
sites** (the def-side wiring firing at every live call site of the one
measured boxed param, `m61_layout$i64Hex`, plus the module-init constants'
own downstream call-arg flows — more than 11 because the baseline's "11" is
DISTINCT BINDINGS, each reached from multiple call sites; every occurrence
carries the exact `boxBigInt` shape: `call $__alloc (i32.const 8)` →
`i64.store` → `call $__mkptr (i32.const 5) (i32.const 0) …`). Zero box
calls appear anywhere in the DEFAULT (unflagged) compile of the same graph
— confirmed by the same search returning 0 matches before `JZ_CARRIER_BOX`
is set. Correctness beyond "does it allocate" was NOT the target (Slice 3
isn't landed) but IS what surfaced the two bugs above — this probe is what
they were caught against, on hand-built repros first, then confirmed absent
of NEW invariant/validation failures at kernel scale.

## §10. Slice 3 — R-recovery (read side), as landed (2026-08-07)

Lands ON the heap-kind registry (`.work/heap-kind-registry-design.md`,
`layout-kinds.js`/`test/layout-kinds.js`, committed separately as the
registry's own Slice 1): the registry's 4 BIGINT FINDINGS (`typeof`,
`eq-identity`, `interop-decode`, `region-forwarding`) become real arms,
each a direct transcription of the registry's own documented column.

**Registry-derived arms landed:**
1. `$__typeof` (module/core.js) — PTR.BIGINT tag arm → `"bigint"`, landed
   alongside (not replacing) `emit['typeof']`'s static VAL.BIGINT fold — a
   PROVEN-bigint operand still folds to the literal and never reaches this
   dynamic dispatch.
2. `$__eq`/`$__eq_strict` (module/core.js) — PTR.BIGINT content-compare arm
   (`i64.eq` on the two payload cells, `$__ptr_offset`-derived — safe
   unconditionally since PTR.BIGINT is never in FORWARDING_MASK).
   `$__eq_strict` needed no separate arm (delegates to `$__eq` for the
   bits-differ case already).
3. `$__same_value_zero`/`$__map_hash` (module/collection.js) — NEW arms
   (none existed): content-compare and payload-hash respectively, so
   Set/Map dedup by BigInt VALUE across independently-boxed instances.
4. `interop.js mem.read` — `t===5` decode arm: `m.getBigInt64(off, true)`,
   a genuine host `bigint`. Distinct from the pre-existing raw-i64
   `jz:i64exp` sentinel-lane decode (`decodeBigintSentinel`), untouched —
   both mechanisms coexist per the mandate ("keep the sentinel lanes
   working until Slice 5"). `mem.write` gained no arm: BIGINT content never
   changes post-allocation, matching STRING's own no-write-arm precedent.
5. `__sclone_rec` (module/collection.js) — BIGINT joins the ATOM/STRING
   immutable-share arm (live, structuredClone-reachable). `__region_copy_rec`
   (module/core.js) — a REAL (no longer trapping) but DORMANT arm mirroring
   STRING's durable-check/memo/fresh-copy shape, simplified for BIGINT's
   flat header-less 8-byte cell; still unreachable outside the region
   program's own re-enable path (`.work/region-arena-design.md`), per the
   registry finding's own scoping.
6. `$__is_truthy` (module/core.js) — NEW arm: BigInt truthiness is
   VALUE-dependent (`0n` falsy, else truthy), unlike every other pointer
   kind reaching this dispatch (always truthy). `$__to_num` (module/
   number.js) — NEW arm, the interop mem.read fix's in-wasm ToNumber twin:
   reads the payload, `f64.convert_i64_s`.
7. `TYPEOF.bigint` (src/compile/emit.js, `emitTypeofCmp` — the `typeof x
   === 'bigint'` compile-time-comparison fast path): PTR.BIGINT tag check
   landed ALONGSIDE the magnitude heuristic (OR'd), matching the mandate's
   "verify every R-recovery arm before deleting the fallback" discipline.

**Arithmetic-core unbox wrapper.** `src/ir.js` gained `isCurrentlyBoxedBigint`/
`readI64` — the read-side twin of `isProvenBoxedBigint`/`carrierF64`. Per
`isProvenBoxedBigint`'s own doc comment (only a PARAM crossing the call ABI
is durably boxed on entry — coerceArg boxes the ARGUMENT once, at the call
site, per Slice 2; a plain local's own slot always stays raw, since Slice 2
boxes a fresh COPY at each W-sink occurrence, never the local's storage),
`isCurrentlyBoxedBigint(name)` is TRUE exactly where `isProvenBoxedBigint`
is forced false for a "still boxed," not "unproven," reason: a bigintBoxed
param of the CURRENT function. `readI64(node, emitted)` unboxes first in
that one case, else degenerates to a bare `asI64(emitted)` — byte-identical
whenever `CARRIER_BOX` is off (a pure boolean short-circuit, no behavior
change possible in the default build). Wired at every VAL.BIGINT-gated
raw-payload-assuming site found by a full sweep: `bigIntOperand`,
`bigIntUnary` (covers `emitNeg`/`~` via delegation), the bare-name postfix
`++`/`--` and `+1`/`-1` member-postfix-recovery table entries, `+`/`-`'s
three postfix-recovery/unary-minus short-circuits, `cmpOp`'s BIGINT branch
(both the literal-mixed and pure-i64-compare arms), the `+=`/`-=`/`*=`/`/=`/
`%=` and `<<=`/`>>=`/`&=`/`|=`/`^=` compound-assignment BIGINT branches — 16
call sites total (the design's own "~10" estimate, undercounted the
compound-assignment family). `toStrI64`'s `coerceRest` tail (src/ir.js)
gained the same `readI64` swap for its final generic `$__to_str` call.
`toNumF64` (src/ir.js) was NOT touched: its own VAL.BIGINT arm is the
documented "self-host contract" pass-through (compiler-source BigInt used
as an opaque bit container, never treated as a numeric value needing
ToNumber) — a different, narrower concern than the carrier-box read side,
confirmed via grep that no arithmetic-core call site routes a proven-BIGINT
operand through it (all go through `bigIntOperand`/`bigIntUnary` instead).

**Two real regressions found and fixed during this slice's own development**
(the mandate's "verify, don't assume" discipline, same class of catch as
Slice 2's own param/ternary double-box bugs):
1. **Auto-dep-scan false positive.** A WAT *comment* (not code) referencing
   `$__same_value_zero` inside `$__map_hash`'s new arm was picked up by
   `test/selfhost-includes.js`'s text-based caller→callee reachability
   check (which cannot distinguish a comment from a real `call`) — fixed by
   dropping the `$` prefix in prose, matching the codebase's own established
   convention for referencing a helper by name in a comment without
   triggering the auto-scan.
2. **Heap-free minimal-output regression.** `$__is_truthy` (reachable from
   EVERY dynamic boolean coercion, including the boundary boolean-boxing
   wrapper every exported boolean return uses) and `emitTypeofCmp`'s
   `TYPEOF.bigint` fast path both gained an unconditional `$__ptr_type`/
   `$__ptr_offset`/`i64.load` reference — found live via
   `test/minimal-output.js`'s "heap-free boolean fn" pin (`(a) => a > 0`
   started declaring memory it never needed). Root cause: `pullStdlib`'s
   `needsMemory` computation trips on ANY reachable `__ptr_type` reference
   or `i32.load`/`i64.load`-containing reachable template, and both of
   these helpers are near-universally reachable. Fixed by gating each new
   arm behind `ctx.features.bigint` (converting `$__is_truthy` to a
   function-valued stdlib entry to allow this, matching `$__typeof`'s own
   existing `closureArm` precedent and `$__to_num`'s own pre-existing
   `ctx.features.bigint`-gated magnitude arms) — sound because no program
   lacking any bigint syntax can ever construct a PTR.BIGINT box (neither
   the test-only `__box_bigint` intrinsic nor carrier-box's write-side
   wiring can exist without it), so the gate never hides a reachable case.
   `$__eq`/`$__same_value_zero`/`$__map_hash`/`$__to_num`'s OWN new arms
   needed NO such gating — each already unconditionally references
   memory-touching machinery for an unrelated pre-existing reason
   (`$__str_eq`/`$__str_hash`/string-parsing), confirmed empirically
   (`a === b` and `+a`-style dynamic-coercion programs already declared
   memory before this slice touched anything).

**Gates, DEFAULT build (CARRIER_BOX unset):**
- Full battery (`node test/index.js`): 3397/3405 pass, 2 pre-existing
  failures (test/optimizer.js bounds-check-guard counts, same as Slice 0-2's
  own documented baseline — re-verified unrelated to this slice via a
  disposable `git worktree` at pre-Slice-3 HEAD), 6 skip.
- kernel-parity: 33/33 byte-identical (O0/O2/O3 × 11 examples) — required a
  `npm run build` re-snapshot of `dist/jz.wasm` first (the self-hosted
  kernel's own stdlib templates now include the same registry arms; a stale
  snapshot diverges from the freshly-compiled "native" side by construction,
  not a real bug — the same "kernel-parity WILL break until re-snapshotted"
  dynamic the mandate's Slice 4 gate section names ahead of time, just
  triggered one slice early by the unconditional (non-CARRIER_BOX-gated)
  registry arms).
- kernel-oracle: 11/11 suites, 451/451 assertions (unchanged from Slice 2's
  own baseline — expected, default build is representation-unchanged).
- selfhost.js: 21/21.
- perf-ratchet: 10/10 at +0 delta AFTER a justified re-baseline
  (`node test/perf-ratchet.js --update`): `buf`/`nest`/`slice`/`ring`
  moved +100/+220/+672/+400 loop-body ops (≤1% each) because `$__map_hash`'s
  new BIGINT arm grows the body `optimize:2`'s inliner ALREADY chooses to
  inline at these programs' dyn-prop-fallback call sites (array-element
  writes through an unproven-type receiver) — confirmed via a disposable
  `git worktree` at pre-Slice-3 HEAD reproducing the OLD baseline exactly,
  then a per-seed WAT diff isolating the exact inlined `$__map_hash` body
  growth. The other 6 categories (int/float/mixed/cond/condref/fgather)
  moved +0 — this slice adds a small, bounded, and now-measured cost only
  where a shared registry-derived helper happens to get inlined into a hot
  loop, not a systemic regression.
- size sweep: geomean 1.020× (jz/AssemblyScript) — unchanged from the
  design's own cited baseline.
- fuzz: 2000×4 (opt 0/1/2/3) + `--typed`/`--typed-int`/`--typed-map`
  variants, 2000×4 each — 0 divergence across all five runs.
- test262: 3000/3000 pass, 0 fail (54 tracked xfail, unrelated to BigInt).
- test262-builtins: 852/852 pass, 0 fail (87 tracked xfail, incl. 6
  documented "BigInt arithmetic/coercion — out of scope" rows, pre-existing,
  unrelated to carrier boxing — jz's BigInt IS a real host bigint at the
  boundary, per this slice's own interop-decode fix; the xfail rows probe
  test262's OWN deeper BigInt-object-identity assumptions, a separate,
  pre-existing scope boundary).
- fresh `npm run build` × 2: `dist/jz.wasm` SHA-256 byte-identical
  (`78f9d400c0f7e9c0d64b99fd066b73fdcebf56620afce728ad95ee5f0f41c776`)
  across both builds.
- `test/pointers.js`/`test/layout-kinds.js` (the registry's own probe +
  Slice 1's unit pins): 32/32 and 43/43 respectively — the registry's 4
  BIGINT findings flip from "live reproduction of a documented bug" to
  "regression pin for the arm that closed it" (renamed `finding[X]` →
  `closed[X]` in test/layout-kinds.js, oracle-flip inventory below).

**Oracle-flip inventory (registry findings, this slice):**

| # | Row | Before | After |
|---|---|---|---|
| 1 | `typeof(boxed BigInt)` | `"object"` (wrong) | `"bigint"` (JS-correct) |
| 2 | `===` on two equal-value boxed BigInts | `false` (wrong) | `true` (JS-correct) |
| 3 | Set dedup by BigInt value across separate boxes | size 2 (wrong) | size 1 (JS-correct) |
| 4 | Boxed BigInt returned across the host boundary | number, wrong value | real host `bigint`, correct value |
| 5 | `Boolean(boxed 0n)` | `true` (wrong) | `false` (JS-correct) |
| 6 | `__region_copy_rec` on a BIGINT | `unreachable` trap | real (dormant) arm |

Not yet flipped (explicitly out of Slice 3's read-side scope, Slice 4/5
territory): every `test/dyn-keys.js` KNOWN-FAIL and the two documented
carrier-collision gaps (§5 kill-list items 11-14) — those depend on
`CARRIER_BOX` actually defaulting on (Slice 4) and, per this slice's own
investigation, at least one (line 1131, "architecturally out of reach")
additionally needs export/interop WRITE-side boxing that Slice 2 explicitly
deferred and this slice's charter (read side only) does not add.

**Local commit:** 48139d9b.

## §11. Slice 4 — ATTEMPTED, WALL HIT, banked (2026-08-07)

Flipped `CARRIER_BOX` (src/ctx.js) default to ON. Two real bugs found; one
fixed and kept, one banked as the slice's honest boundary.

**Bug 1 — FOUND AND FIXED (kept, independent of the default flip).**
`export let f = () => { let x = 5n; return x + 1n }` under `JZ_CARRIER_BOX=1`
returned the box's own POINTER bits (`9221823924482868224n`, decoding to
type=5/aux=0/offset=1024 — a real PTR.BIGINT pointer) instead of `6n`.
Root cause: emit.js's `'return'` handler boxes ANY inline (non-bare-name)
BIGINT return expression unconditionally (`needsBigintBox`'s own "inline
expressions box at emission time, no rep needed" contract) — correct for an
INTERNAL caller (Slice 3's read-side arms handle a boxed F64 correctly) but
WRONG for `ctx.func.exported`: `synthesizeBoundaryWrappers` (compile/
index.js) gives a proven-BIGINT export's wrapper an ALREADY-UNAMBIGUOUS i64
ABI (`resultBigint`/`resultBigintSentinel`/`resultDynamic` all do a bare
`i64.reinterpret_f64(call $name)`, no `r` decode marker — "the BigInt IS the
value" is the documented contract) — boxing before that reinterpret hands
the wrapper a pointer to misreinterpret as a payload. **Fixed** by excluding
`ctx.func.exported` from `needsBox`'s condition (src/compile/emit.js) — the
i64-export channel was never ambiguous to begin with, so it never needed
boxing. This fix is orthogonal to the default-flip decision (harmless when
CARRIER_BOX is off, correct when explicitly on) and is KEPT in this commit.

**Bug 2 — FOUND, NOT FIXED, the actual wall.** `test/watr.js`'s own
self-hosted-through-jz battery (`jz(watrJs, {modules: ENTRY_MODULES, …})` —
compiling the `watr` npm package's OWN source, including its real i64
LEB128 encoder `encode.js`, then using THAT compiled-by-jz assembler to
compile hand-written WAT test cases and diff byte-for-byte against watr
running natively) — 4 of 35 assertions fail under `JZ_CARRIER_BOX=1`, ALL
involving extreme-magnitude 64-bit values: `i64.smax`/`i64.smin` literal
encoding, `memory64` limits, `v128.const i64x2` max/min, a large table
index. Isolated to a minimal repro (a `while(true)`-loop-carried BigInt
local doing `n = n >> 7n` / `n & 0x7Fn` / `n === -1n`, LEB128-shaped)
independently — that repro is ALSO wrong, but on FURTHER isolation turned
out to be wrong even OFF the carrier path (reproduces identically with
`JZ_CARRIER_BOX=0` and on the pre-Slice-3 worktree's own HEAD) — a
DIFFERENT, unrelated, genuinely pre-existing arithmetic bug the carrier
program does not own; a red herring, not this wall's cause.

**Root-caused to Slice 2, not Slice 3/4, by direct reproduction**: a
disposable `git worktree` at 35f5ce94 (heap-kind registry Slice 1, the
commit immediately BEFORE this session's Slice 3 work) with
`JZ_CARRIER_BOX=1` forced reproduces the SAME 4 `test/watr.js` failures,
byte-for-byte (`memory64 limits: byte 23`, `int literals: byte 95`, `call
indirect case: binary length`, `v128.const i64x2 max/min: byte 15`) — on
that clean HEAD `JZ_CARRIER_BOX=0` (its own default) passes 35/35. This
proves the bug lives entirely in Slice 2's landed def-side box wiring
(carrierF64/coerceArg/'return'/'?:', ir.js/emit.js — none of it touched by
Slice 3's read-side-only charter), surfacing for the FIRST TIME here
because Slice 2's own gates never ran a real end-to-end BigInt-heavy
program under the flag — its own landing notes say so explicitly
("Correctness beyond 'does it allocate' was NOT the target"). Not isolated
further: the actual watr `encode.js` code path differs from every hand-
built repro tried, and diagnosing it properly needs the SAME unhurried,
dedicated-session treatment Slice 2's own def-side wiring got — not a
same-session fix bolted onto a default-flip investigation, which is
exactly the discipline the round-1/round-2 history (§2 above) exists to
enforce.

**Decision: revert the default flip, keep everything independently green.**
`CARRIER_BOX` reverted to OFF by default (`JZ_CARRIER_BOX=1` stays as the
opt-in probe flag, unchanged shape from Slice 2/3). Verified clean after
the revert: full battery 3397/3405 (same 2 pre-existing failures, 6 skip),
kernel-parity 33/33, kernel-oracle 451/451, selfhost 21/21, fresh build ×2
byte-identical
(`1fc27b44d6de974be7901d9a4af01959319c065bac9e3bf2a739e4f5ff635c30`),
`test/watr.js` 35/35 with the flag back at its default. Bug 1's fix stays
landed (dead-but-correct off-flag, real fix on-flag).

**Oracle-flip inventory: NONE closed this slice** (the default never
flipped, so nothing in `test/dyn-keys.js` or the curated kernel-oracle rows
changes state — all stay exactly where Slice 3 left them). The one
concrete, durable gain: bug 1, a genuine Slice-2 export-boundary
correctness fix, found and closed via this attempt.

**What Slice 4 needs before a second attempt**: a dedicated root-cause
session on Slice 2's def-side wiring specifically, using `test/watr.js`'s
own self-hosted-through-jz battery (not a hand-built repro — confirmed NOT
equivalent) as the reproduction harness, with `JZ_CARRIER_BOX=1` forced and
the failure narrowed via bisection of `encode.js`'s actual functions
(`i64`/`uleb`/hex-literal parsing) rather than a mimicked shape. Slice 5
(retire the magnitude heuristics) is blocked on Slice 4 landing — not
attempted this session.

**Local commit:** 3daa4410.

## §12. Slice 4 — ATTEMPT 2: def-side bug root-caused and fixed, flag-forced
verification complete, flip re-attempted, hit a SECOND (self-host) wall,
banked (2026-08-07)

Dedicated session on exactly what §11 asked for: root-cause `test/watr.js`'s
4-row `JZ_CARRIER_BOX=1` wall via the real battery (not a mimicked repro),
narrowed by bisecting `encode.js`'s actual functions.

**Root cause.** `needsBigintBox` (ir.js) — the shared predicate `carrierF64`
and `'return'` use to decide "does this AST node reaching a W-sink need a
real PTR.BIGINT box" — has two branches: a bare name defers to its
solver-settled `bigintBoxed` rep (proven, narrow); any OTHER (inline)
BIGINT-kinded expression boxes UNCONDITIONALLY (§9's own words: "box
unconditionally... no rep needed"). That unconditional branch is sound
exactly where carrierF64's own doc comment says it is: a REAL dyn-prop/
array-elem/Set/Map store or closure-capture, whose value a LATER, separately
-compiled reader can only observe through registry-aware dynamic dispatch
($__dyn_get, $__typeof, …) — Slice 3's R-recovery arms. It is NOT sound
wherever no such reader exists — and it was firing at several such sinks
Slice 2 never distinguished:

1. **`'return'`, mixed/closure context.** `ctx.func.boxedResult` (set
   unconditionally for EVERY closure-convention body, regardless of whether
   THIS closure's own return is uniformly BIGINT) and `ctx.func.
   mixedAtomReturn` (a BOOL-only heuristic, "this func's own returns
   disagree in type" — its own doc comment: "every non-bool-mixed function…
   untouched either way" as the pre-carrier-box contract) both route through
   the pre-existing `carrierF64` call at the return site — Slice 2 wired
   `needsBigintBox` into that SAME call, so an inline BIGINT return boxed
   unconditionally the moment EITHER flag was true, for reasons entirely
   about BOOL, never about BIGINT. Watr's own `compile.js` `limits()` —
   `is64 ? v => { if (typeof v === 'bigint') return v; return BigInt(v) } :
   parseUint` — the closure's `return BigInt(v)` boxed (an inline
   expression, `boxedResult` true only because it's a closure); `uleb(parse
   (minVal), out)` then called the box through `call_indirect` with no
   statically-provable-BIGINT call site for narrow.js to seed `uleb`'s own
   param as `bigintBoxed` — `uleb`'s `n & 0x7Fn` read the pointer's own bits
   raw. (A plain, non-closure, non-mixed function's return was ALSO wrong
   this way — `i64.parse`'s `return _i64[0]`, a genuine BigInt64Array
   element read with no ambiguity at all, boxed unconditionally too — the
   very first repro that cracked this open.)
2. **SRoA flat-object/array field storage** (`let o = {n: 1n}` / `let a =
   [1n]`, no heap alloc — every read/write rewrites to a plain `o#i`/`a#i`
   local, per scanFlatObjects' own contract). Routed through the SAME
   `storedValue`/`carrierF64` chokepoint real heap-object schema stores use
   (deliberately, for BOOL identity — a flat field MIGHT still be shadow-
   readable dynamically) — but BIGINT has no such shadow-reader case a flat
   field's own value ever needs, so the unconditional inline-box fallback
   fired for nothing: `let o = {n: 4611686018427387903n}; o.n++` boxed the
   LITERAL FIELD INIT (no ambiguity whatsoever) on construction; `o.n++`'s
   own bigIntOperand arithmetic then read the pointer's bits raw.
3. **A proven-ARRAY receiver's own numeric element store**, independent of
   flat/SRoA-ness: no array-element consumer (this session confirmed via
   grep — zero `PTR.BIGINT` references anywhere in module/array.js) is
   registry-aware yet, matching Slice 5's own not-yet-landed status; a
   receiver's OWN element-type census (`repOf(arr).arrayElemValType ===
   VAL.BIGINT`) already proves every read takes the raw path regardless.
4. **Array-literal and object-literal construction** (module/array.js,
   module/object.js), independent of any later element/field WRITE: a
   homogeneous-bigint literal element, or a non-shadowed (`!needsDynShadow`)
   schema field, has the identical "no reader" argument at DEFINITION time.
5. **A compiler-synthesized decl-destructure array-literal temp**
   (`ctx.schema.arrayVars`, prepare/index.js prepDecl — "single-write,
   non-escaping… only this destructure's own generated reads ever touch
   it"): `let [a, b] = [1, BigInt(v)]` — mixed element types, so (4)'s
   per-literal uniform-BIGINT admission didn't cover it either, yet NO
   reader here is ever dynamic (every index resolves statically). Also
   applies to the `'?:'` handler's OWN dedicated box (a genuinely different,
   narrower mechanism than `needsBigintBox` — guards against a raw-bigint-
   bits/null-sentinel COLLISION for a reader that inspects the merge's own
   bits, not "registry-awareness" per se) when the merge feeds a destructure
   temp: no reader inspects those bits there either.

**Second, narrower gap (read side, not overreach): a ternary-nullish-BIGINT-
declared local's own storage IS a box.** `let r = cond ? BigInt(x) : null`
— unlike every `carrierF64`/`'return'` sink (whose doc comment is explicit:
boxes a FRESH COPY at the point of use, "never the local's own storage"),
the `'?:'` handler's box for THIS shape becomes the declared name's entire,
permanent storage from that point on — there never was a separate raw-bits
form of `r`. `isCurrentlyBoxedBigint` only ever recognized a boxed PARAM
(the one case Slice 2 durably materializes outside a fresh-copy), so
`readI64`-covered consumers like `.bigint:toString` (module/number.js) read
`r`'s pointer bits raw. New `isTernaryBoxedBigint` (ir.js) closes it — backed
by `ctx.func.ternaryBoxedNames`, an EMISSION-TIER TRANSIENT Set (compile/
index.js `enterFunc`, reset per function), not `updateRep`/the rep system:
`test/passes.js`'s own "emission tier never writes durable analysis state"
exit grep is a real, checked architectural invariant a first draft of this
fix violated and had to be redone around.

Wiring it in turn exposed a THIRD, genuinely pre-existing gap: `coerceArg`
crossing an already-boxed bare name (a boxed param OR now a ternary-boxed
local) into a callee whose OWN param settled "receives BIGINT consistently,
stays raw at the boundary" (`bigintBoxedVerdict`, narrow.js — a verdict
computed from every call site's argument STATIC KIND alone, blind to one of
those uniformly-BIGINT-typed values secretly being a durable box) crossed
the box UNCHANGED, callee body misreading it raw. `chain(5)` → `arith(r)`
(`r` ternary-boxed; coerceArg already correctly passes it through unboxed)
→ `hex(r)` (`hex`'s param0 settled "stays raw", `r` is `arith`'s own
ALREADY-boxed param) — `hex`'s `v.toString(16)` read the pointer raw.
`coerceArg` now runtime-checks BOTH directions (box-when-raw, unbox-when-
boxed-but-callee-expects-raw), nullish-guarded — a nullable-BIGINT argument
may genuinely be the sentinel at runtime, never a box, in either direction.

**A fourth bug, found only by attempting the fresh self-host build (below):
`coerceArg`'s own new box/unbox blocks fed an UNTAGGED `['local.get', $t]`
into `asI64`/`unboxBigInt`** — both dispatch on a node's `.type` to choose
the coercion shape, defaulting an untagged node to "assume i32, needs
`f64.convert_i32_s`" — even though `$t` is a genuine f64 temp. Fixed by
tagging (`typed(['local.get', $t], 'f64')`), matching every other f64-temp-
read call site's own convention. Found via `WebAssembly.Module()` validation
failure compiling the compiler's OWN `layout.js` `ptrNanHex` during `npm run
build`, bisected to the exact commit and function via a disposable worktree
per landed commit plus a function-index correlation against the unoptimized
WAT dump.

**Fix mechanism, uniformly:** a new narrow-admission twin, `carrierF64Narrow`
(ir.js) / `storedValueNarrow` (bridge.js) — identical BOOL-atom-boxing
contract, but for BIGINT admits ONLY the bare-name case independently proven
by `isProvenBoxedBigint` — never the unconditional inline-expression
fallback. Threaded through: `'return'`'s `boxes` branch (mixed/closure),
the SRoA flat-object/array field init (emit.js) and write-back
(emit-assign.js, both the named-object and `[]`-element forms — the latter
moved EARLIER in `emitElementAssign`, before the shared `keyExpr`/`valueExpr`
computation, so `val` still emits exactly once), a known-ARRAY receiver's
element store when its own census proves uniform BIGINT, array/object-
literal construction (module/array.js `emitElem`/`elemStoredValue`, module/
object.js's static-segment and runtime-alloc paths), and — via a NEW
transient per-function flag, `ctx.func._arrayLiteralNeverEscapes`, set
around the ONE `emit(init)` call at both its call sites (the plain `'='`
handler and `emitDecl`'s own documented WALL site, which stays completely
untouched otherwise) — a decl-destructure array-literal temp's own elements,
including through a nested `'?:'` arm.

**Gates, FLAG-FORCED (`JZ_CARRIER_BOX=1`), the end-to-end verification §11
named and this attempt actually ran:**
- `test/watr.js`: 35/35 (was 31/35).
- Full battery (`node test/index.js`): 3386/3405 pass, 13 fail — ALL
  pre-existing and out of THIS bug's scope, verified against a disposable
  worktree at 3daa4410 with `JZ_CARRIER_BOX=1` forced: 11 `test/dyn-keys.js`
  rows (Map/dict export-boundary write-side boxing — explicitly named in
  §10 as "Slice 4/5 territory," a separate, larger, not-yet-scoped feature)
  and 2 `test/optimizer.js` bounds-check-guard rows (present at
  `CARRIER_BOX=0` too, this project's own pre-existing baseline, wholly
  unrelated to BigInt). 6 skip.
- `test/kernel-oracle.js`: 11/11 suites, 451/451 assertions.
- `test/statements.js`: 202/202 (the 2^62±1 pins included).
- `node test/fuzz.js` (2000 seeds × opt {0,1,2,3}) and its `--typed`/
  `--typed-int`/`--typed-map` siblings (2000×4 each): 0 divergence, all four
  runs.
- Default build (`CARRIER_BOX` unset) re-verified unaffected after every
  commit in this session.

**The flip, re-attempted.** `CARRIER_BOX`'s default flipped to ON. Full
battery unflagged: 3386/3405, identical to the flag-forced run — confirms
the flip behaves exactly as forced. `npm run build` (the fresh self-host
rebuild `dist/jz.wasm`, gate #4 in the original brief): compiled and
WASM-validated cleanly (after the fourth bug above was found and fixed) —
but the resulting KERNEL then **crashes** ("memory access out of bounds") or
returns **wrong values** at optimize levels 2-3 on several of the exact
shapes this section just fixed (a proven-bigint array literal, a ternary-
nullish-BIGINT local), confirmed via direct `compileViaKernel` calls:

```
array literal bigint  O0/O1: 4611686018427387905n (correct)   O2/O3: CRASH
ternary bigint         all levels via NATIVE: 0n (correct)     O2/O3 via KERNEL: CRASH
obj field bigint       all levels via NATIVE: 4611686018427387906n (correct)
                       O2 via KERNEL: 7597125510078484066n (WRONG, no crash)
```

The SAME programs compile and run correctly at every optimize level through
the NATIVE (in-process, non-self-hosted) compiler — verified directly,
confirming a pure self-host FIDELITY gap (the kernel's own optimizer passes
mishandling some new code shape from this section's fix, not a logic error
in the fix itself), the same CLASS of wall (not the same instance) as
`emit.js`'s own extensively-documented decl-init WALL history.

**Decision: banked, not landed — same discipline as attempt 1.**
`CARRIER_BOX` reverted to OFF by default. Verified clean after the revert:
default battery 3397/3405 (2 pre-existing, unrelated — the documented
baseline, unchanged), fresh `npm run build` × 2 byte-identical
(`d5b05c2a11380ca5dcfb8b1fc721cb7040743cbbdabcc3405ab375dfd3721561`), flag-
forced battery unchanged (3386/3405, the same 13 pre-existing rows).
`JZ_CARRIER_BOX=1` stays the opt-in probe flag — every fix landed this
session is real, independently verified there, and unconditionally
beneficial regardless of the default.

**Oracle-flip inventory: none closed this slice** (the default never
stayed flipped). The durable gains are the def-side/read-side fixes
themselves — real correctness fixes behind the flag, verified end-to-end
for the first time since Slice 2 landed.

**What a third attempt needs**: a dedicated self-host-fidelity investigation
— bisect which of this session's new code shapes (the narrow-admission
carrier twins, `ctx.func.ternaryBoxedNames`, `coerceArg`'s runtime box/unbox
blocks, `ctx.func._arrayLiteralNeverEscapes`) the self-hosted kernel's OWN
compiled optimizer passes (O2/O3 specifically — O0/O1 are clean) mishandle,
most likely via the same disposable-worktree-plus-minimal-repro discipline
this session used for the def-side bug, but targeting `compileViaKernel`
specifically rather than `test/watr.js`. Slice 5 (retire the magnitude
heuristics) stays blocked on Slice 4 landing — not attempted.

**Local commits:** 4b775e98, ed37a4e6, 5cea45e1, cfe25e05, 30535365.

## §13. Slice 4 — ATTEMPT 3: wall re-localized, NOT a self-host gap — a native
compiler bug §12's own repros were too small to expose, banked (2026-08-07)

Protocol per §12's own handoff: flag-forced rebuild (`JZ_CARRIER_BOX=1 npm run
build`), reproduce the 3 named shapes directly via `compileViaKernel`, diff
kernel WAT against native WAT for the smallest failer.

**Reproduced exactly as §12 banked it.** Fresh flag-forced `dist/jz.wasm`:
`arrayLiteralBigint` (`let a=[BIGVAL]; return a[0]`) — O0/O1 correct, O2/O3
`memory access out of bounds`. `objFieldBigint` (`let o={n:BIGVAL}; return
o.n`) — O0/O1 correct, O2/O3 wrong value (`8388357179923384654` instead of
`4611686018427387906`). Both via direct `compileViaKernel({wat:true})` +
`instantiate`, not `test/watr.js` (matches §12's own "target `compileViaKernel`
specifically" instruction).

**WAT diff, `objFieldBigint` at O2 (kernel vs native), the smallest failer:**
kernel and native both fold the whole function to a single boundary-wrapper
constant (`o`'s SRoA flat field never escapes — §12 point 2's own fix — so
the entire body constant-folds and `$f` disappears, leaving only `$f$exp`).
The ONE line that differs:
```
native: (i64.reinterpret_f64 (f64.const 2.000000000000001))
kernel: (i64.reinterpret_f64 (f64.const 5.826595490514274e+252))
```
Both sides reach this via the SAME fold — `f64.reinterpret_i64(i64.const
"4611686018427387906")` → `f64.const <value>` — watr's own constant folder
(`node_modules/watr/src/optimize.js`, `f64FromI64`/`_i64Canon`/`_i64Hex16`,
imported into jz's pipeline as `watOptimize`). O0/O1 never run `watOptimize`
at all (`compileViaKernel`'s O0/O1 WAT is byte-identical to O0 — no inlining,
no folding — confirmed directly), which is why they're clean: this bug is
gated entirely behind whether the FOLD runs, not behind any target-program
optimize-level semantics.

**Re-tested §12's own "plain" claim and found it narrower than banked.**
`let x = 4611686018427387906n; return x` (a BARE-NAME return, no object, no
array, no ternary — none of this session's new carrier-box admission code
even fires: `ctx.func.exported` excludes it from `needsBox`/`isProvenBoxedBigint`
per Bug 1's own fix, confirmed by reading the `'return'` handler) — ALSO wrong
at O2/O3 through the flag-forced kernel (`8388357179923384654`, the identical
wrong constant), while the SAME shape through the DEFAULT (non-carrier)
kernel — rebuilt clean, verified — is correct at every level. This proves
the wall is not localized to the 3 named target-program SHAPES at all: it is
a property of the KERNEL BUILD (whether `CARRIER_BOX` was baked in when
`dist/jz.wasm` was compiled), independent of what the kernel is later asked
to compile.

**Root-caused past the self-host boundary entirely — this is a NATIVE
compiler bug, not a self-host fidelity gap.** §12's own "native clean at
every level" claim is true only for its own hand-sized repros. Compiling
`node_modules/watr/src/optimize.js` itself — an ~8500-line real-world
BigInt-heavy file jz already depends on and already self-hosts (it's part of
`scripts/self.js`'s own module graph, `resolveModuleGraph(..., {resolveNode:
true})`, exactly what `scripts/build-dist.mjs` runs) — through the plain
in-process NATIVE compiler (`compile()`, no kernel, no `compileViaKernel`, no
wasm-of-jz-self involved at all) with `JZ_CARRIER_BOX=1` at `optimize:{level:
3}` (build-dist.mjs's own config) reproduces the IDENTICAL wrong constant:
```js
import { fold } from '.../node_modules/watr/src/optimize.js'
export const run = () => fold(['f64.reinterpret_i64', ['i64.const', '4611686018427387906']])[1]
```
compiled+run via jz (`JZ_CARRIER_BOX=1`) → `5.826595490514274e+252`; the
SAME `fold()` called directly as plain JS (no jz involved) → `2.000000000000001`
(correct). This is decisive: `dist/jz.wasm`'s own wrongness is a downstream
SYMPTOM of the NATIVE compiler (running under host JS, `CARRIER_BOX=1`)
mis-compiling `watr/optimize.js`'s own BigInt-canonicalization helpers
(`_i64Canon`/`_i64Hex16`/`f64FromI64`) when it builds the kernel — every
subsequent kernel compile that needs THIS fold then inherits the corruption,
regardless of what target program triggers it. §11/§12's whole "self-host
fidelity gap" framing was the wrong altitude: no self-hosting is required to
see this bug, only a BigInt-heavy source file large enough to hit the shape
(watr/optimize.js; none of §7-§12's own repros were).

**Partial localization inside `_i64Canon`/`_i64Hex16` (not fully named — see
below).** WAT for the isolated `run()` probe (native, `CARRIER_BOX=1` vs `=0`,
`optimize:3`, function-name-preserved output) diverges starting inside
`_i64Canon`'s `neg ? -BigInt(mag) : BigInt(mag)` argument to `_i64Hex16(v)`
(`_i64Hex16 = (v) => v.toString(16).padStart(16,'0')`), inlined together at
O3. The `CARRIER_BOX=1` side inserts a `boxBigInt`/`unboxBigInt`-shaped
sequence (`$__ptr_offset`'s inlined body — tag-mask `898` = bits {1,7,8,9} =
{ARRAY,HASH,SET,MAP}, i.e. `FORWARDING_MASK`, then a conditional
`$__ptr_offset_fwd` chase, then `i64.load`) around the ternary's raw
arithmetic result that the `CARRIER_BOX=0` side never has. This IS the
documented, correct shape of `unboxBigInt`/`ptrOffsetIR` (ir.js:771-775 — the
generic `$__ptr_offset` runtime call is unconditional for every VAL kind,
including BIGINT; §10's "no-op for non-forwarding tags" claim is about
`$__ptr_offset`'s OWN runtime branch, not about skipping the call) — so its
PRESENCE alone is not proof of a bug, only that a box/unbox pair was inserted
where `CARRIER_BOX=0` has none. Two live candidates, not distinguished within
this session's time-box:
1. `_i64Hex16`'s shared param `v` settles `bigintBoxed=true` via
   `bigintBoxedVerdict`'s WHOLE-FILE fixpoint (some OTHER of `_i64Hex16`'s
   many call sites across this 8500-line file passes a genuinely
   already-boxed bare name), so `coerceArg` boxes THIS site's inline ternary
   argument to match — sound in principle (Bug 3, §12) but the box+unbox
   round trip here does not recover the original value, meaning either
   `boxBigInt`'s alloc/store or the inlined `unboxBigInt`'s
   `$__ptr_offset`-chase reads back the wrong bits for THIS specific
   caller/callee/inlining combination.
2. The unary-minus BigInt arm (`-BigInt(mag)`) itself, combined with the
   surrounding `'?:'`, hits `carrierF64Narrow`'s or `needsBigintBox`'s
   BOOL/BIGINT dispatch in a way none of §12's own single-arm-ternary repros
   exercised (their found-live shape was `cond ? BigInt(x) : null` — a
   nullish merge; `_i64Canon`'s is `neg ? -BigInt(mag) : BigInt(mag)` — both
   arms non-nullish BigInt, one negated).

Not narrowed further: isolating (1) vs (2) needs a same-shape minimal
repro reduced from `_i64Canon` itself (attempted — a hand-built two-call-site
shared-param mimic did not reproduce byte-for-byte, likely missing the exact
inlining/whole-file-fixpoint conditions the real file's OTHER ~30 call sites
to `_i64Hex16`-shaped helpers create), the same "hand-built repro is not
equivalent to the real file" lesson §11 already banked once for `test/watr.js`.

**Decision: banked, not landed.** `CARRIER_BOX` stays OFF by default
(unchanged this session — no default-flip was attempted, given the wall
reproduces before the flip step is even reached). Verified clean after
restoring a plain `npm run build` (no flag): default battery unaffected,
`dist/jz.wasm` rebuilt without `JZ_CARRIER_BOX`. `JZ_CARRIER_BOX=1` stays the
verified opt-in probe flag — nothing this session touched changes its
correctness for the NATIVE, non-kernel-building use of the flag (compiling
an ordinary target program with `JZ_CARRIER_BOX=1` set, not rebuilding
`dist/jz.wasm` itself, is unaffected — the bug only bites when the flag is
live WHILE COMPILING watr/optimize.js-shaped source, i.e. specifically
`npm run build` with the flag forced).

**What a fourth attempt needs**: reduce `_i64Canon`+`_i64Hex16` in place
(temporarily edit `node_modules/watr/src/optimize.js` — or a scratch copy —
down to just those two functions plus enough of `fold`'s dispatch to call
them, re-running the exact `compile()`-with-`CARRIER_BOX=1`-at-O3 probe after
each cut) until the wrong constant either disappears (narrows the guilty
code) or survives at minimal size (a clean, committable repro) — this
session's remaining scratch files were cleaned up (`.work/scratch-carrier-*`)
without reaching that minimal form. Slice 5 stays blocked on Slice 4 landing.

**Local commits:** none (investigation only — no source changes; `dist/jz.wasm`
restored to its plain-build state, gitignored, not committed either way).


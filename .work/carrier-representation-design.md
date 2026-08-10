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

## §14. Slice 4 — ATTEMPT 4: root cause named, fixed, flag-forced battery
green, flip probe hit NO wall — same fix also clears §12's own self-host
kernel-fidelity gap; landing the flip + Slice 5 itself banked (2026-08-07)

**Discriminated: neither of §13's two named candidates, a third mechanism
in the same neighborhood.** §13's own diagnostic instrumentation
(`JZ_DBG_BIGINT_STATS=1`, `bigintBoxedStats`) settles candidate 1 first: a
fresh dump of every param/local verdict touching `_i64Hex16`/`_i64Canon`/
`_i64Arith`/`f64FromI64` across the real `optimize.js` compile shows **zero**
params and **zero** locals boxed anywhere in that call graph — the
whole-file `bigintBoxedVerdict` fixpoint never marks `_i64Hex16`'s param
boxed at all, so there is no box/unbox param round-trip to lose bits in.
Candidate 1 refuted by direct measurement, not argument.

Candidate 2 ("carrierF64Narrow/needsBigintBox mis-dispatch on the unary-
minus-in-ternary shape") pointed at the right neighborhood but the wrong
function: `needsBigintBox` (ir.js) already unconditionally EXCLUDES every
`'?:'` node (`node[0] !== '?:'`) — it never fires on a ternary at all,
mis-dispatch or not. The actual bug is one level up, in **`emitDecl`**
(emit.js ~2119-2133), the site that decides whether a decl's name enters
`ctx.func.ternaryBoxedNames` (the §12 Slice-4-attempt-2 mechanism for "this
local's own storage IS a box"). Its condition was `Array.isArray(init) &&
init[0] === '?:' && valTypeOf(init) === VAL.BIGINT` — but kind.js's
`VT['?:']` returns `VAL.BIGINT` from TWO structurally different rules: (a)
`ta === VAL.BIGINT && nullishArm(c)` / the symmetric arm (line 179-180) —
the genuine nullish-merge shape, which the `'?:'` handler (emit.js ~5873-
5887) actually boxes; and (b) the much more general `if (ta && ta === tb)
return ta` (line 149) — BOTH arms merely sharing a kind, with NO nullish
requirement, which for two BigInt arms is `_i64Canon`'s own exact shape
(`neg ? -BigInt(mag) : BigInt(mag)`, neither arm nullish) — a shape the
`'?:'` handler leaves **entirely raw** (its own box condition, `bigintArm`,
requires one arm nullish; with both arms BigInt it stays null and the
generic `asF64`-merge path runs, no box). `emitDecl`'s own comment claimed
"same test... can never disagree with what actually got built" — false for
shape (b): the name gets registered as ternary-boxed even though nothing
was ever boxed.

The reason this bites `_i64Canon` specifically, and only through the real
file: jz's own AST-level inliner (`src/compile/plan/inline.js`,
`inlinedBody`) binds a non-simple call argument — a `'?:'` node is
explicitly non-simple (its own comment: "a call, `?:`, indexed load") — to
a fresh temp via a synthesized `const $tmp = arg` decl before splicing the
callee body in, so that `_i64Canon(mag, neg)`'s call `_i64Hex16(neg ?
-BigInt(mag) : BigInt(mag))` becomes, post-inline, a genuine DECL whose init
is exactly the '?:' node — the one AST shape `emitDecl`'s check fires on.
`_i64Hex16`'s inlined body then reads that temp through `readI64` (ir.js),
which checks `isTernaryBoxedBigint` and — wrongly told "boxed" — calls
`unboxBigInt`: an `i64.load` at `ptrOffsetIR`'s tag-masked, forwarding-
chase-guarded offset, computed from the RAW asF64-reinterpreted ternary
result as if those bits were a real heap pointer. That IS §13's own WAT-
diff observation exactly (the `i32.and`/mask-898/`__ptr_offset_fwd`-chase/
`i64.load` sequence wrapping the ternary's `local.tee $0` at O3, absent on
the `CARRIER_BOX=0` side) — just misattributed to the wrong originating
predicate. No hand-built two-call-site repro was needed once the mechanism
was named structurally; the minimal pin below reproduces byte-for-byte
without ever touching `optimize.js`.

**Fix.** `emitDecl`'s registration condition (emit.js) now replicates the
`'?:'` handler's OWN narrower box condition exactly — one arm BIGINT AND
the other `nullishArm` — instead of the broad `valTypeOf(init) ===
VAL.BIGINT`:
```js
if (CARRIER_BOX && !viewInit && typeof name === 'string' && Array.isArray(init) && init[0] === '?:' &&
    ((valTypeOf(init[2]) === VAL.BIGINT && nullishArm(init[3])) || (valTypeOf(init[3]) === VAL.BIGINT && nullishArm(init[2]))))
  ctx.func.ternaryBoxedNames?.add(name)
```
Stale doc comments asserting the false "same test" claim corrected in both
emit.js (the fix site) and ir.js (`isTernaryBoxedBigint`'s own doc comment,
which repeated the same wrong claim).

**Faithful minimal pin** (test/pointers.js, "BigInt carrier boxing"
section — no dependency on watr/optimize.js, no self-host): a `hex16`/
`canon` pair shaped exactly like `_i64Hex16`/`_i64Canon`, called from a
small loop (to clear jz's own hot-path inline-candidacy gates) at
`optimize: { level: 3 }`. Verified against the reverted condition (a
temporary in-place edit, restored immediately after, no stash/checkout
used) before writing the fix back: the pre-fix condition crashes
(`RuntimeError: memory access out of bounds` — the same failure CLASS §12's
own kernel-fidelity wall hit, not just a wrong value) at O3; the fix makes
it pass, both under `JZ_CARRIER_BOX=1` and unflagged (off-flag,
`ternaryBoxedNames` is never populated at all — the shape is inert there by
construction, so the pin is a pure non-regression check off-flag and the
real assertion on).

**Gates, FLAG-FORCED (`JZ_CARRIER_BOX=1`), foreground, full runs:**
- Real repro (`fold()` on watr/src/optimize.js's own `_i64Canon`/
  `_i64Hex16`, via `compile()` + `resolveModuleGraph(..., {resolveNode:
  true})`, matching `build-dist.mjs`'s own config): O0-O3 all
  `2.000000000000001` (was `5.826595490514274e+252` at O2/O3). Default
  (unflagged) build: unaffected, was and stays correct at every level.
- `test/watr.js`: 35/35 (matches §11/§12's own target).
- Full battery (`node test/index.js`): 3406 total / 3387 pass / 13 fail / 6
  skip — the 13 are EXACTLY §12's own documented pre-existing, out-of-scope
  baseline (11 `test/dyn-keys.js` Map/dict export-boundary rows + 2
  `test/optimizer.js` bounds-check-guard rows, present at `CARRIER_BOX=0`
  too) — zero new failures. (3406 vs §12's 3405: +1 is this session's new
  pin.)
- Default battery (unflagged): 3406 / 3398 pass / 2 fail (the 2
  pre-existing `test/optimizer.js` rows) / 6 skip — matches §12's own
  "3397/3405, 2 pre-existing" baseline (+1 for the new pin).
- `test/kernel-oracle.js`: 11/11 suites, 451/451 assertions.
- `test/statements.js`: 202/202.
- `node test/fuzz.js --count=2000` (opt {0,1,2,3}, 20 inputs each,
  216162ms): 30173 compared, 9827 skipped (i32 contract exceeded), 0
  non-numeric, **0 divergence**. (`--typed`/`--typed-int`/`--typed-map`
  siblings NOT re-run this session — time-boxed; base fuzz already exercises
  the fixed code path with zero findings.)

**The flip, re-attempted — no wall this time.** `CARRIER_BOX` hardcoded
`true` (temporary, reverted before commit). Default (unflagged) battery:
3406/3387/13, byte-identical to the flag-forced run — confirms the flip
behaves exactly as forced, as in §12. `npm run build` (fresh self-host
rebuild, gate §12's SECOND wall lived in): compiled, WASM-validated,
completed cleanly. Directly re-probed §12's own three named failing shapes
(array-literal-bigint, obj-field-bigint, a ternary-bigint local) through
`compileViaKernel` at O0-O3 each: **all twelve correct, zero crashes, zero
wrong values** — the exact self-host kernel-fidelity gap §12 hit on ITS OWN
flip attempt (`CRASH`/`memory access out of bounds` at O2/O3 on these same
shapes) does not reproduce. `npm run build` × 2 with the flip: byte-
identical (`5057747ba1539558225ebb61dd2b14725e0e39d9918776d388d1a9c004c8bcd7`).
Plausible unifying explanation (not proven further this session): §12's own
"what a third attempt needs" note named `ctx.func.ternaryBoxedNames` itself
as one of the suspect NEW code shapes for the kernel's own optimizer passes
to mishandle when self-hosting — this session's bug lives exactly there,
and it is exercised by jz's OWN inliner, which the self-hosted kernel runs
on ITS OWN BigInt-heavy source (including, transitively, on its own copies
of BigInt-canonicalization helpers) every time it compiles anything — so
one over-broad registration site plausibly explains both the native-compiler
wall (§13/§14) and the self-host kernel-fidelity wall (§12) as the same
single defect observed from two different vantage points. `npm run test:wasm`
(chained: kernel compiling further programs) hit an unrelated crash — a
`RangeError` in `interop.js` `mem.read`/`readArgBits` decoding a BIGINT
inside an async `setTimeout` `print` callback path — NOT investigated (not
one of §11/§12's own named gates, no BigInt-ternary/carrier-box code on that
call path, plausible pre-existing `test:wasm`-harness flakiness given it
isn't part of `test:matrix`).

**Flip reverted, not landed — deliberately, not because of a new wall.**
`CARRIER_BOX` restored to the env-gated default (OFF); `dist/jz.wasm`
rebuilt plain (no flag), gitignored, not committed either way
(`66813815dbbb09fa28c8034df369c722f902da6c9255c9134b11527ae2905fdc`).
Landing the default flip is a bigger decision than this session's bounded
probe covers: Slice 5 (§7 of this doc) is its OWN named follow-on with its
OWN full-discipline requirement — "native + kernel (O0/O2/O3) + wasi +
selfhost + fuzz (2000×4) + fresh build ×2 byte-identity + warm/fresh perf
gates" plus the actual DELETION of §5's 10 magnitude/sentinel kill-list
sites and flipping specific KNOWN-FAIL test rows to green pins — none of
which this session ran (no wasi gate, no selfhost test suite, no perf
gates, no kill-list deletion). A probe finding no wall is real, useful
evidence the next attempt should lead with rather than re-deriving from
scratch — but is not itself the rigor Slice 5's own charter demands before
changing a project-wide default. Banked as "flip probe clean" for the next
session to build on, not landed.

**Local commits:** src/compile/emit.js + src/ir.js (the fix), test/
pointers.js (the pin), .work/carrier-representation-design.md (this
entry) — filed separately, plain messages, no push.

## §15. Audit-#14 finding: a carrier-built KERNEL corrupts its OWN generated
constants — root-caused, PINNED, NOT fixed, flip stays banked (2026-08-07)

An external alert reported a release-blocking repro contradicting §14's own
"flip probe clean" bank: a carrier-built kernel emits corrupted `f64.const`/
`i64.const` payloads for BigInt-FREE target programs, and `kernel-parity`
diverges on `dict` under `JZ_CARRIER_BOX=1`. Session mandate: reproduce,
pin, root-cause, fix if safely scoped, no default flip regardless of
outcome. **The flip was already reverted before this investigation started**
(`src/ctx.js`'s `CARRIER_BOX` is `JZ_CARRIER_BOX==='1'`, OFF by default,
same shape as §14 left it) — this section is bounded to the finding itself.

**First verification pass gave a FALSE NEGATIVE — worth recording as its own
lesson.** The first attempt to reproduce the three named WAT differentials
against `dist/jz.wasm` found no divergence at all — because the on-disk
`dist/jz.wasm` was stale (an earlier `npm run build` invocation had been
killed mid-run, before its own "wrote dist/jz.wasm" step, leaving a PLAIN,
pre-session kernel on disk despite the build LOG showing success for the
other artifacts). A full `JZ_CARRIER_BOX=1 node scripts/build-dist.mjs`,
run to completion this time (confirmed by its own "wrote dist/jz.wasm"
line), produces a genuinely carrier-boxed kernel — against THAT kernel,
every claim reproduces exactly. Lesson: a build log's success does NOT
prove the LAST artifact it lists was written if the process was
interrupted; verify file mtimes before trusting a partial log.

**Reproduced exactly, native-vs-fresh-carrier-kernel, at O0:**
```
                    native                          kernel
() => undefined     f64.const nan:0x7FF8000200000000 nan:0x7FFA8002000DA0D8
() => "abcdefghi"   f64.const nan:0x7FFA000000000007 nan:0x7FFA8000000DA0DC
() => () => 1       f64.const nan:0x7FFD000000000000 nan:0x7FFF8000000DA0D8
```
(Absolute low-word offsets are allocation-order-dependent, not stable
constants — re-running shifts them; the tag/shape corruption is what's
diagnostic, not the exact digits.) `kernel-parity` (`node test/kernel-
parity.js` run against the fresh carrier kernel) fails `dict` at O0/O2/O3
(byte-length-equal, content-diverging); `sum`/`math`/`arr`/`fold`/`mfold`/
`boolconst`/`nestedtyped`/`subviewtyped`/`dvnested`/`fromnested` all stay
byte-identical — the corruption is not universal, it is conditional on
whether the compiled PROGRAM (target OR the kernel compiling it) transitively
needs one of `layout.js`'s derived hex constants.

**Root cause, pinned exactly, via the REAL `layout.js` (a hand-mimicked
single-call-site shape does NOT reproduce — same "mimic isn't equivalent"
lesson §13 already banked once for `watr/optimize.js`):**

`export let f = () => LAYOUT.NAN_PREFIX_BITS` (no `i64Hex`/`atomNanHex` call
at all) already returns the wrong value under `JZ_CARRIER_BOX=1` via the
NATIVE compiler — no self-hosting needed. Trace:

1. `LAYOUT` (`layout.js`) is `export const LAYOUT = { …, NAN_PREFIX_BITS:
   0x7FF8000000000000n, … }` — a module-scope object literal with one
   BigInt field among a majority of NUMBER fields. `needsDynShadow(LAYOUT)`
   is TRUE (some site elsewhere in the reachable graph reads it via dynamic/
   bracket access), so `module/object.js`'s object-literal construction
   picks the WIDE `fieldStoredValue = storedValue` (not the narrow-admission
   `storedValueNarrow` — the `shadow ? storedValue : storedValueNarrow`
   branch, module/object.js ~line 240 area). `storedValue` → `carrierF64` →
   `needsBigintBox`'s unconditional inline-BIGINT-expression fallback boxes
   the literal field on construction — CORRECTLY, by that path's own
   contract (a registry-aware dynamic reader, `$__dyn_get`, exists for this
   object and DOES know how to unbox a PTR.BIGINT per Slice 3's arms).
   Confirmed directly in the WAT: the field's store is a real, correct
   `call $__alloc(8)` / `i64.store` (right payload, `9221120237041090560` =
   `0x7FF8000000000000n`) / `call $__mkptr(i32.const 5, …)` sequence.
2. The READ side never got the matching arm. A STATIC `.field` access
   (`LAYOUT.NAN_PREFIX_BITS`, or `atomNanHex`'s own `LAYOUT.NAN_PREFIX_BITS`
   reference) compiles through `emitPropAccess` → `emitSchemaSlotRead`
   (`module/core.js` ~1591-1610) — a **third** read mechanism, distinct
   from both `$__dyn_get` (registry-aware, correctly PTR.BIGINT-arm'd by
   Slice 3) and the bare-name arithmetic operand path (`readI64`, correctly
   wired by Slice 3 for the ~16 arithmetic-core call sites). It resolves
   the field to a fixed byte offset at COMPILE TIME and emits a bare
   `f64.load` — `typed(load, 'f64')`, no value-kind awareness, no box
   check. `readI64`'s own guard (`typeof node === 'string'`) structurally
   CANNOT catch this: the AST node here is `['.', 'LAYOUT',
   'NAN_PREFIX_BITS']`, never a bare string, by construction — Slice 3
   never had a way to reach this call site AT ALL, not a narrowing bug in
   an existing arm, a genuinely new, previously-invisible one.
3. So the static read loads the BOXED POINTER's own NaN-box bits (tag=
   `PTR.BIGINT`(5), a heap offset in the low word) and hands them straight
   to every consumer as if they were the field's VALUE. `atomNanHex`/
   `i64Hex`'s own arithmetic (confirmed correct in isolation, §earlier-
   session code read) then computes a "hex string" out of the wrong input —
   the corrupted constants baked into the target program's `f64.const`/
   `i64.const` are a downstream symptom, not a separate bug.
4. `kernel-parity`'s `dict` divergence is the SAME root cause at one more
   remove: `dict`'s own source (`d[c] = (d[c]||0)+1`) has zero BigInt
   syntax, but COMPILING it pulls in hash/dyn-prop stdlib machinery that
   itself references `layout.js`-derived tag/mask constants internally —
   when the KERNEL (built carrier-boxed) computes ITS OWN copy of those
   constants via the same corrupted path, every subsequent compile that
   needs them inherits wrong bytes, regardless of whether the TARGET
   program touches BigInt at all. This generalizes the severity well past
   "BigInt-heavy programs": a carrier-built kernel's `layout.js`-derived
   constant surface is foundational and widely depended on.

**Why this was invisible through §11-§14's own gates**: every one of those
sessions' repros were either (a) direct target-program BigInt shapes
(`arrayLiteralBigint`, ternary-boxed locals, `_i64Canon`/`_i64Hex16`) —
none of which touch a MODULE-SCOPE OBJECT LITERAL with a mixed NUMBER/
BIGINT field needing a dynamic shadow, or (b) `test/watr.js`'s real-program
battery, which happens not to define an object literal shaped this way. The
one thing EVERY prior session's repro had in common: none of them exercised
a **static dot-access read of an object's own BOXED BigInt schema field**
specifically — a third, independent read-side surface Slice 3's arm
inventory never enumerated (it covered `$__dyn_get`/`$__typeof`/`$__eq`/
`$__same_value_zero`/`$__map_hash`/interop-decode/arithmetic-core, never
`emitSchemaSlotRead`).

**Not fixed this session — deliberately, per this project's own "verify,
don't force" precedent (§11-§14).** A sound fix needs: (a) a per-schema-slot
VAL-kind fact (does `ctx.schema` currently expose "is slot N of schema S a
BIGINT field" anywhere cheaply? — not found this session, would likely need
adding), and (b) the exact write-side boxing condition (`needsDynShadow`
of the SAME receiver) threaded through EVERY `emitSchemaSlotRead` call site
— not just the dominant bare-name `obj.prop` shape this finding's repro
hits, but also the chain-receiver, `emitSchemaSlotGuarded` monomorphic-
devirtualization, and `structInline`/packed-i32-cell paths, each needing
its own soundness check (a wrong unbox on an UNBOXED raw field would be a
NEW bug, not a fix). Given this call site is on the hot path for EVERY
object field read in the entire compiler, a rushed change carries real
blast-radius risk this session's remaining time cannot safely absorb-and-
verify (kernel-parity/kernel-oracle/fuzz/selfhost all touch it). Banked,
matching §11/§12/§13's own repeated choice under the identical circumstance.

**PINNED**: `test/fixtures/carrier-layout-repro.js` (new, imports the REAL
`layout.js`) + `test/pointers.js` ("KNOWN-FAIL (JZ_CARRIER_BOX=1 only,
audit-#14 …)" — 4 `not()` TODO-flip-guard assertions, same established
pattern as this file's own preceding ternary pin and `test/dyn-keys.js`'s
KNOWN-FAIL rows: PASSES today by asserting the wrongness precisely, and
would need updating to `is()` once a real fix lands — the tripwire is
`not()` firing on the CORRECT value, which would mean the bug silently
regressed to "less wrong but still not right," not that the pin itself
went red). Gated `if (process.env.JZ_CARRIER_BOX !== '1') return` — a true
no-op, zero assertions, under the default (off) battery; `JZ_CARRIER_BOX=1
node test/pointers.js` runs all 4 and confirms the exact wrongness.
Verified: default `node test/pointers.js` 34/34 (62 assertions, unchanged
count); `JZ_CARRIER_BOX=1 node test/pointers.js` 34/34 (66 assertions, +4).

**The `test:wasm` timer/string-callback crash claim: attempted, NOT
reproduced in targeted checks, left unconfirmed.** Ran `test/timers.js` and
`test/async.js` under `JZ_CARRIER_BOX=1 JZ_TEST_TARGET=jz.wasm` against the
genuinely fresh carrier kernel — both clean (5/5 and 13/13, no crash). This
does not clear the claim (the full `test:wasm` leg is expensive — a prior
partial run against a STALE, non-carrier kernel earlier in this session was
invalidated and re-run was not completed to conclusion given time bounds)
— it narrows it: the specific timer/print path this session checked is not
where it lives, if it's real at all. §14's own original note ("plausible
pre-existing test:wasm-harness flakiness … not investigated") already
flagged this as unconfirmed BEFORE this session; this session neither
confirms nor closes it.

**Gates run this session:**
- Reproduced all 3 named WAT differentials + `kernel-parity` `dict`
  divergence against a freshly, fully rebuilt `JZ_CARRIER_BOX=1` kernel
  (verified via the build log's own "wrote dist/jz.wasm" line, not assumed).
- Root cause isolated to a single, real, un-mimicked repro (`LAYOUT.
  NAN_PREFIX_BITS` alone, no `i64Hex` call needed) via the REAL `layout.js`.
- `test/pointers.js`: 34/34 both under `JZ_CARRIER_BOX=1` (66 assertions)
  and default (62 assertions, the new test a true no-op).
- Default battery restored and verified clean AFTER rebuilding `dist/
  jz.wasm` plain (no flag) at session end: `node test/index.js` 3407 total
  / 3399 pass / 2 fail (the same pre-existing `test/optimizer.js` rows) / 6
  skip. `node test/kernel-parity.js` 3/3 (33 assertions, byte-identical) —
  confirms the flagged-build divergence does not leak into the default
  artifact once rebuilt plain.
- `src/ctx.js`'s `CARRIER_BOX` confirmed OFF by default (env-gated,
  unchanged shape from §14's own revert) — no flip was committed this
  session, matching the mandate.

**What a fix session needs**: add a per-slot VAL-kind fact to `ctx.schema`
(or reuse/extend an existing per-field fact if one is found on closer
search — this session did not find one), thread `needsDynShadow(receiver)
&& slotVal===VAL.BIGINT` into `emitSchemaSlotRead`'s BIGINT branch (unbox
via the existing `unboxBigInt`/`readI64` machinery, matching the write
side's own condition exactly — narrow admission, not a blanket unbox of
every schema read), verify each of the 4+ call shapes (`emitPropAccess`'s
bare-name/chain-receiver branches, `emitSchemaSlotGuarded`, `structInline`/
`cellI32`) independently against hand-built repros BEFORE the kernel-scale
probe, then re-run this section's own pins plus the full flagged-battery/
kernel-parity/kernel-oracle/fuzz/selfhost discipline §11-§14 already
established as this program's own gate list — only THEN reconsider the
default flip, starting from §14's own "flip probe clean" bank plus this
section's now-closed gap, not from scratch.

**Local commits:** `src/ctx.js` (comment update recording this finding,
default stays OFF — no behavior change), `test/pointers.js` +
`test/fixtures/carrier-layout-repro.js` (the pin), `.work/carrier-
representation-design.md` (this entry) — filed separately, plain messages,
no push.

---

## §16. §15's read-side gap FIXED — the slotBigintBoxed/slotBigintProven
per-schema-slot fact (2026-08-07)

Closes §15's banked finding: `emitSchemaSlotRead` (module/core.js) now
consults a per-(schemaId, slot) fact and unconditionally unboxes a
PROVEN-uniformly-BIGINT, write-side-boxed slot instead of handing every
consumer the box's raw pointer bits. The 4 §15 pins flip from `not()` to
`is()` and pass. Default (CARRIER_BOX off) output stays byte-identical,
confirmed by rebuild + kernel-parity + full battery, twice. Two genuinely
new, PRE-EXISTING (not introduced this session, both verified against a
disposable `git worktree add` at the session-start commit 0de59be4) gaps
were found and root-caused while chasing `kernel-parity`'s `dict` row and
the flag-forced battery to completion — neither is fixed here, both are
precisely diagnosed and banked, matching this project's own §11-§15
discipline.

### The fact: `ctx.schema.slotBigintObserved` (census) → `slotBigintBoxed*`
/ `slotBigintProven*` (module/schema.js, consumer projections)

Same three-tier shape as `slotI32Certain`'s own idiom (working census →
published projection → `*At`/`*BySid` consumer):

- **`ctx.schema.slotBigintObserved`** (`src/ctx.js`): schemaId → `Array<
  boolean>`, a pure OR-join (never poisoned, unlike `slotTypes`' first-
  wins-then-clash lattice) — true iff ANY write to this slot anywhere in
  the program is BIGINT-typed. Populated inside `observeProgramSlots`'
  `observeSlot` itself (`src/compile/program-facts.js`), so every existing
  call site (the `{}` literal branch, the `.prop=` branch, the moduleInit
  `record()`/cached-replay paths) joins automatically — one write census,
  two projections. **Fails OPEN on hazard**, the opposite direction from
  every sibling census: `applySlotWriteHazards`' poison callback and the
  MUTATE_OPS branch's "value kind unresolvable" arm both also mark
  `observeBigintJoin(sid, idx, VAL.BIGINT)` — under-boxing a slot that
  really carries a BigInt is unsound, over-boxing one that never does is a
  rare, harmless cost (this fail-open direction is what §15's original
  per-site `needsDynShadow` reasoning already implicitly relied on; the
  census just makes it explicit and program-wide).
- **`ctx.schema.slotBigintBoxedBySid(sid, prop)` / `slotBigintBoxedAt
  (varName, prop)`** (module/schema.js): the WRITE-usable fact — TRUE iff
  `slotBigintObserved` AND some constructor/assignment of the schema is
  dyn-shadowed. Shadow is resolved program-wide (not per-literal) via a
  memoized reverse index over `ctx.types.dynKeyVars` (∪ `anyDynKey`) → sid,
  the exact two conditions `needsDynShadow` itself tests for a named
  target — built lazily since `dynKeyVars`/`anyDynKey` publish AFTER the
  slot census runs (plan/index.js), so the fact can only be correct by
  CODEGEN time, which is all it needs. Deliberately WIDER than the read
  twin below — no uniform-type requirement — because `carrierF64`/
  `carrierF64Narrow` already gate boxing PER VALUE; a NUMBER-typed write
  routed through "boxed" is unaffected (falls to the same `asF64` either
  way, verified in `src/ir.js`: `storedValue`/`storedValueNarrow` are
  byte-identical to each other whenever `CARRIER_BOX` is off, since both
  degrade to the same `boolBoxIR`/`asF64` fallback — so swapping the
  SELECTOR at every write site is a true no-op for the default build,
  independent of whichever branch the fact happens to pick).
- **`ctx.schema.slotBigintProvenBySid(sid, prop)` / `slotBigintProvenAt
  (varName, prop)`**: the READ-usable fact — narrower by one clause:
  `ctx.schema.slotTypes.get(sid)[idx] === VAL.BIGINT` (the CLASH-poisoned
  lattice — every write must be UNIFORMLY BIGINT, not just ANY). Only a
  uniform slot may unbox unconditionally; a slot that ALSO holds a real,
  unboxed NUMBER somewhere would misread some instances' bits as a box
  payload — exactly the unsoundness the design forbids (a runtime tag
  guess on possibly-raw bits is unsound; the pairing must be static).
- Invariant tripwire (`DBG_INVARIANTS`-gated, `analyzeSchemaSlotIntCertain`):
  asserts no (sid, idx) is ever BOTH `slotI32Certain` and
  `slotBigintObserved` — a BIGINT write can never be strict-int32 by
  construction, so `inlineCellI32`'s packed-i32-cell path (which REQUIRES
  every slot i32-certain) can never contain a BIGINT slot either — this is
  how "packed-cellI32 is excluded automatically" was verified, not
  assumed. Ran clean (no throw) across the default battery and the
  CARRIER_BOX=1 pin under `JZ_DEBUG_INVARIANTS=1`.

### Write-side call sites — 5, all now schema-fact-derived

The 3 `shadow ? storedValue : storedValueNarrow` ternary sites §15
implicitly pointed at, plus a 4th `structInline` site probed live (not
assumed) per this session's mandate:

1. `module/object.js` `{}` literal construction (~line 220): per-FIELD now,
   not per-literal — `slotBigintBoxedBySid(schemaId, names[i])`.
2. `module/object.js` spread-literal explicit-prop store (`emitObjectSpread`,
   ~line 1031): was UNCONDITIONALLY wide before this session (safe, just
   imprecise) — now schema-fact-derived for consistency; no-op under
   CARRIER_BOX=off.
3. `src/compile/emit-assign.js` `emitPropertyAssign`'s unboxed-`ptrAux`
   dot-write branch (~line 906): `sid = vaProbe.ptrAux` (always concrete
   here) → `slotBigintBoxedBySid(sid, prop)`.
4. `src/compile/emit-assign.js` `emitPropertyAssign`'s `schema.slotOf`
   dot-write branch (~line 934): `sid = ctx.schema.idOf(obj)`, falling back
   to the raw `shadow` (pre-fix behavior, unchanged) on the rare structural-
   subtyping edge where `idOf` has no precise sid but `slotOf`'s bucket
   fallback still resolved an index.
5. `src/compile/emit-assign.js` `tryStructInlineReplaceStore`'s non-packed
   cell-value store: found via the "probe it, don't assume" instruction —
   this write was ALSO unconditionally wide pre-session (its own dedicated
   read arm is `emitSchemaSlotRead` too, reached via the `.cellI32`/
   `ptrAux`-tagged cursor path in `emitPropAccess`), so it was already
   SAFE, just inconsistent with the other 4 sites once those became fact-
   derived. Converted for uniformity/optimization, not because leaving it
   wide was unsound.

`module/object.js`'s fixed-schema `Object.assign` copy (raw bit-for-bit
slot copy, no re-boxing decision at all) and the two computed-key dynamic-
assign paths (`emitObjectAssignDynamic`/`emitDynamicAssign`, also raw bit
copies from already-resolved source slots) were AUDITED and found to need
no change: they never call `storedValue`/`storedValueNarrow`, so my fact
doesn't apply, and Object.assign's own hazard-poisoning of the TARGET sid
(`collectSlotWriteHazards`) already protects the read side (a hazarded
sid's `slotTypes` entry is null, so `slotBigintProvenBySid` never fires
"unbox" on it, regardless of what the copy actually produced). The
`propsPtr` shadow MIRROR at construction was verified, not assumed:
```
let o = { n: 4611686018427387903n, m: 5 }
let x = o[k]   // forces needsDynShadow; k='n' at runtime
```
round-trips the true BigInt through `$__dyn_get` correctly (Slice 3's own
PTR.BIGINT arm, unaffected by this session).

### Read-side call sites — 5 threaded, 1 verified-and-deliberately-untouched

`emitSchemaSlotRead` itself gained a 4th `bigintProven` param: when true,
returns `unboxBigInt(typed(load, 'f64'))` — i64-typed, mirroring `readI64`/
`unboxBigInt`'s own convention (src/ir.js). This is NOT a representation
change for generic consumption: `asF64` on an i64-typed node does
`f64.reinterpret_i64`, the SAME "opaque f64 carrier" bit-reinterpret every
OTHER unboxed BigInt value in this compiler already uses as its default,
narrow (non-shadowed) representation — and any consumer reaching a genuine
W-sink re-boxes fresh via `carrierF64`'s unconditional inline-expression
fallback (this `.` node is an Array, `valTypeOf` resolves BIGINT via
`slotVT`) exactly like every other inline BIGINT expression already does.

1. `module/core.js:1591` `emitSchemaSlotRead` (the def) — the fix itself.
2. `module/core.js` literal-resolved anonymous-object fast path
   (`emitPropAccess`'s `literalSlot` branch): needed a NEW sibling helper,
   `literalSid(obj)`, since this branch had no sid at all before — derives
   it the same way `module/object.js`'s construction would (`litId =
   register(names)` in source order; this fast path only ever fires for an
   ANONYMOUS literal, so `takeLiteralTarget()` is null at its real
   construction and `schemaId` is always `litId`, no merge-schema branch to
   reproduce).
3. `module/core.js` unboxed-OBJECT-pointer `ptrAux`/BySid branch: sid is
   `va.ptrAux`, already concrete.
4. `module/core.js` chain-receiver branch (`o.meta.bias`-shaped): gated the
   same way the pre-existing `i32Certain` consult already was —
   `typeof obj === 'string' && slotBigintProvenAt(obj, prop)` — the
   structural (non-string `obj`) fallback gets `false`, unchanged from
   pre-fix (no per-sid proof attempted there before either).
5. `module/core.js` boxed-object delegate path (`ctx.schema.isBoxed`):
   `slotBigintProvenAt(obj, prop)`, `obj` a string var name.
6. `emitSchemaSlotGuarded` — **verified, deliberately left untouched**. Its
   `slow()` arm is a genuine dynamic dispatch (receiver could be any schema
   or none) that always returns the BOX itself, never an unboxed payload —
   a wasm `if` requires both arms to share one value type, so `fast`
   unboxing while `slow` stays boxed would merge two DIFFERENT
   representations into one node, exactly the class of bug this design
   forbids. `fast`'s existing plain load is already correct as-is (matches
   `slow`'s own contract) regardless of whether the guarded slot happens to
   be proven-BIGINT. Documented in place rather than left silently
   unconsidered.

### structInline/SRoA — probed, not assumed

Two independent questions, both resolved:
- **Can `inlineCellI32` (packed i32 cells) ever hold a BIGINT slot?** No —
  proven by construction (`inlineCellI32` requires every slot
  `slotI32Certain`; the new `DBG_INVARIANTS` tripwire above asserts the
  disjointness holds census-wide) and reconfirmed as a live invariant, not
  an assumption.
- **Can a structInline-eligible (non-packed) schema ALSO be dyn-shadowed?**
  Yes, in principle — `analyzeStructInline`'s own doc comment states
  standalone `{S}` objects of a structInline-eligible schema are
  independent and can coexist with the inline array — and
  `ctx.types.anyDynKey` is a whole-program flag, unaware of which specific
  array is structInline. This is exactly why write-site #5 above
  (`tryStructInlineReplaceStore`) was brought under the same fact: before
  that change it was unconditionally wide (safe on its own), but pairing
  it with the SAME fact the read side now consults removes any ambiguity
  about whether a structInline element's BIGINT field is boxed — it now
  answers identically to a standalone instance of the same schema, by
  construction, not by coincidence.

### The 4 §15 pins: FLIPPED

`test/pointers.js`'s KNOWN-FAIL test is now `is()` (was `not()`), title
changed from "returns pointer bits, not its payload" to "unboxes to its
payload". Verified directly against the fixture (`LAYOUT.NAN_PREFIX_BITS`
→ `9221120237041090560n` / `0x7FF8000000000000n`, `atomNanHex(1)`/`(2)` →
the correct `0x7FF8000...` strings, `i64Hex(ptrBits(...))` → the correct
composed hex) — `node test/pointers.js` 34/34 (62 assertions, default,
unchanged count) and `JZ_CARRIER_BOX=1 node test/pointers.js` 34/34 (66
assertions, +4, all passing where they used to `not()`-guard the wrongness).
Directly probed the granularity fix itself (the whole point of the schema-
wide redesign over the old per-literal one) with a hand-built repro: two
literals `a`/`b` sharing one structural schema `{n, m}`, only `b` ever
dyn-keyed (`b[k]`, forcing `anyDynKey` program-wide) — under
`JZ_CARRIER_BOX=1`, `a.n` (the NON-shadowed sibling) and `b.n` (the
shadowed one) BOTH read back their true, distinct BigInt values exactly.
This is the scenario the entire write-side redesign (per-schema, not
per-literal) exists to make sound — confirmed working, not just argued.

### Gates run this session

- **The 3 named WAT differentials** (native-vs-fresh-carrier-kernel, the
  isolated fixture): CLOSED — reproduced correct output directly (not just
  absence of the old wrong bytes).
- **`JZ_CARRIER_BOX=1` kernel-parity, dict, O0/O2/O3: STILL diverges — but
  ROOT-CAUSED to a SEPARATE, PRE-EXISTING issue this fix's own design
  explicitly can't reach.** Verified via a direct `ctx.schema` diagnostic
  after natively compiling the FULL `scripts/self.js` graph (the same
  source `dist/jz.wasm` is built from) at O3: `LAYOUT`'s
  `NAN_PREFIX_BITS` slot has `slotBigintObserved = true` and
  `slotBigintBoxedBySid = true` (write side correctly boxes it) but
  `slotTypes` is `null` for EVERY slot of EVERY schema in the whole
  program, because `ctx.schema.slotWriteHazards.all = true` — a single
  program-wide BLANKET hazard (`collectSlotWriteHazards`'s `hz.all`,
  triggered by some unresolvable computed-key write somewhere in the
  compiler's own ~370K-line self-hosted source, pre-existing and
  unrelated to this session) poisons `slotTypes` for literally every
  schema, so `slotBigintProvenBySid` (which REQUIRES the uniform-type
  proof) can never fire ANYWHERE when compiling the whole compiler as a
  target program — independent of how precise `slotBigintObserved`/
  `slotBigintBoxedAt` are. This is the design's OWN documented boundary
  ("for UNPROVEN reads leave the box flowing") landing on a case that is
  provably unprovable given the CURRENT hazard scanner's precision, not a
  gap in this session's fix. A real fix would mean hardening
  `collectSlotWriteHazards`'s handling of the specific unresolvable write
  (likely a `ctx.core.stdlib[dynamicName] = …`-shaped pattern somewhere in
  module/*.js) — a separate, wide-blast-radius change (that hazard set
  feeds `slotIntCertain`/`slotTypedCtors`/dict-and-map-value censuses too)
  this session's remaining time cannot safely absorb-and-verify. NOT
  fixed, explicitly banked. (Confirmed the SAME divergence reproduces
  identically against a freshly, fully rebuilt carrier kernel — verified
  via the build log's own "wrote dist/jz.wasm" line, §15's own lesson
  applied again.)
- **Default build byte-identity: CONFIRMED, twice.** `node test/kernel-
  parity.js` against a freshly-rebuilt PLAIN (no flag) `dist/jz.wasm`: 3/3
  (33 assertions, byte-identical, including `dict`). `node test/index.js`
  (default): 3407 total / 3399 pass / 2 fail (the SAME 2 pre-existing
  `test/optimizer.js`-adjacent rows §15's own baseline named — `interval
  walk`/`typed RMW`) / 6 skip — run twice across this session (once
  mid-session, once after the final rebuild), byte-for-byte the same
  failure set both times.
- **`JZ_CARRIER_BOX=1` flag-forced battery** (`node test/index.js`,
  native, no kernel): 3407 total / 3380 pass / 21 fail. **Every one of the
  21 verified PRE-EXISTING**, not a regression: built a disposable `git
  worktree add … 0de59be4` (the session-start commit, before any of this
  session's edits) and re-ran the failing rows directly against it —
  `test/dyn-keys.js` alone reproduces 11/11 of them identically (the
  "Slice 5/6/7"/"audit-#8 P0-4"/"§14 point 4" Map/dict-BigInt-census
  export-boundary family — a DIFFERENT subsystem, `synthesizeBoundaryWrappers`/
  `censusBigintSentinelKind`, not schema-slot reads at all). The remaining
  rows are the SAME `dict`/`hz.all` root cause above (kernel-parity +
  kernel-oracle's AGREE-tier, both import `kernel-parity.js`'s CORPUS) and
  the SAME 2 pre-existing default-battery failures (typed RMW / interval
  walk, unrelated to CARRIER_BOX entirely). Zero new failures.
- **`test/watr.js`: 35/35** under `JZ_CARRIER_BOX=1` (107 assertions).
- **kernel-oracle**: 3/11 test blocks pass; the 8 failures are the SAME
  `dict`/`hz.all` family (kernel-parity's own CORPUS re-imported) plus one
  PRE-EXISTING, already-`PENDING-FIX`-labeled row ("generic-scalar-decl
  BOOL∪NUMBER carrier collapse") whose crash mode (a memory-OOB exception
  instead of its own pinned wrong-value expectation) is investigated
  below, alongside the timer-crash confirmation — same verdict: real,
  pre-existing, unrelated to this session.
- **`JZ_CARRIER_BOX=1` fuzz**: 500×4 clean (0 divergences, 7749 inputs
  compared), then the full 2000×4 the mandate asked for — clean, 30173
  inputs compared, 0 divergences (jz wasm == JS at every opt level, every
  program).
- **The `test:wasm` timer/string-callback crash: CONFIRMED (§15 left this
  unconfirmed — narrower checks passed). Real, deterministic, and
  PRE-EXISTING.** The full `JZ_CARRIER_BOX=1 JZ_TEST_TARGET=jz.wasm node
  test/index.js` leg, run to completion against a freshly, fully rebuilt
  carrier kernel, crashes the whole process (uncaught exception, not a
  test failure) right after `setTimeout: callback fires`
  (`test/statements.js`) — a `RangeError: Offset is outside the bounds of
  the DataView` inside `interop.js`'s `mem.read`, reading a `t===5`
  (PTR.BIGINT) tagged argument that OOBs. Minimized to a 3-line repro with
  NO timer, NO closure, NO BigInt anywhere in the source at all —
  `export let start = () => { console.log('bare-fired'); return 1 }`,
  compiled via `compileViaKernel` then executed, crashes identically.
  Bisected by string length: SSO strings (≤6 chars) print the wrong value
  (`NaN`, not the text) but don't crash; heap strings (≥7 chars) throw the
  same OOB. **Reproduced identically against a freshly-built carrier
  kernel from the disposable baseline worktree (0de59be4, before this
  session's changes)** — same crash, same stack, same threshold. This is
  a real, pre-existing bug in string-argument marshaling for `console.log`
  specifically under a SELF-HOSTED (kernel-compiled) `CARRIER_BOX=1`
  build — `module/console.js`'s call site (`asI64Bits = (e) =>
  ['i64.reinterpret_f64', asF64(emit(e))]`) never routes through
  `storedValue`/`carrierF64`/any BIGINT-boxing logic at all, and native
  compilation + execution of the identical source is clean (only self-
  hosted execution crashes) — so this is unrelated to schema-slot BigInt
  reads or this session's fix; root cause NOT investigated (a different
  subsystem, out of this session's scope). This closes §15's own "not
  investigated" note on the claim: it is real, and it predates §15 itself.
- **`JZ_DEBUG_INVARIANTS=1`**: ran clean (no throw) across `test/objects.js`
  and `JZ_CARRIER_BOX=1 node test/pointers.js` — the i32Certain/
  slotBigintObserved disjointness invariant held everywhere probed.

### Flip-readiness verdict

**NO default flip.** `CARRIER_BOX` stays `JZ_CARRIER_BOX==='1'`-gated, OFF
by default, unchanged shape from §14/§15. This session's fix closes §15's
OWN named gap exactly (proven-uniform-BIGINT schema-slot reads now unbox
soundly, paired at schema granularity with a schema-wide write-side fact)
and banks two NEWLY-DISCOVERED-BUT-PRE-EXISTING, precisely root-caused,
separate gaps (`collectSlotWriteHazards`' whole-program `hz.all` blanket
poison defeating the uniform-type proof for the self-hosted compiler's own
huge source; a self-hosted-only `console.log` string-marshaling crash) —
NEITHER of which this session introduced or is positioned to safely fix
within scope. A future flip-readiness session should start from: (1) this
entry's `hz.all` diagnosis (harden `collectSlotWriteHazards` for the
specific unresolvable-computed-key-write pattern it's tripping on inside
the compiler's own source), (2) the `console.log`/self-hosted string-
marshal crash (a `t===5` OOB unrelated to BigInt semantics — likely a
tag/offset computation bug exposed only when self-hosting under
CARRIER_BOX, worth its own targeted session), and (3) the pre-existing
Slice 5/6/7 Map/dict-census export-boundary family in `test/dyn-keys.js`
(11 already-failing rows under `JZ_CARRIER_BOX=1`, fully independent of
schema-slot reads) — none of which block THIS session's own fix from
being correct and safely bankable.

**Local commits:** `src/ctx.js` + `src/compile/program-facts.js` +
`module/schema.js` (the fact — census, invariant tripwire, consumer
projections), `module/object.js` + `src/compile/emit-assign.js` (write-
side call sites), `module/core.js` (read-side call sites +
`emitSchemaSlotGuarded`'s verified-untouched documentation),
`test/pointers.js` (the pin flip), `.work/carrier-representation-
design.md` (this entry) — filed separately, plain messages, no push.

---

## §17. §16's two banked gaps worked SEQUENTIALLY — Task 1 partially closed
(a real, verified precision fix landed), Task 2 root-caused to be THE SAME
gap as Task 1, not independent — both banked, no flip (2026-08-07)

Session mandate: close §16's two banked, pre-existing gaps (finding 1 —
`hz.all` blanket poison defeating `slotBigintProven` for the self-hosted
compiler's own source; finding 2 — the carrier-kernel `console.log`
crash) if safely scoped, bank precisely otherwise, no default flip
regardless. Both walled on their STATED gates. Both are banked with a
concrete, verified finding that neither session's remaining time forces
past: **Task 2 is not an independent bug — it is Task 1's own gap at one
more remove**, discovered by tracing past §16's own "root cause NOT
investigated, different subsystem" note on the console.log crash.

### Task 1 — `hz.all` precision: ONE real bug fixed, the dominant class banked

**Root cause of the blanket, precisely isolated via `JZ_DEBUG_HZALL`
instrumentation (temporary, stripped before commit) against the REAL
`scripts/self.js` graph at O3** (not a mimicked repro — §13/§15's own
"mimic isn't equivalent" lesson applied again): `collectSlotWriteHazards`
(`src/compile/program-facts.js`) sets `hz.all = true` from exactly two
sites — `keyedWrite`'s non-numeric-key fallback and the `Object.assign`
branch. Both fire hundreds of times compiling the compiler's own ~370K-
line source. Two DISTINCT causes were found, ONE fixed, ONE banked:

1. **FIXED — a real, dead-code bug in the `Object.assign` branch,
   unrelated to the `hz.all` DESIGN itself.** `const target = node[2]`
   read the call's RAW args slot, not the target: for any real
   `Object.assign(target, ...sources)` call (2+ total args — the only
   shape Object.assign is ever meaningfully called with), `node[2]` is a
   `,`-node (`[',', target, source, …]`), not `target` — the SAME shape
   `ast.js`'s own `callArgs`/`commaList` exist to unwrap, used nowhere in
   this branch. `sidOf`/`kindOf` on a `,`-node never resolve (neither a
   bare string nor a typeable expr), so EVERY Object.assign call in the
   whole program fell straight to `hz.all`, regardless of whether its
   target was perfectly resolvable. Fixed: `commaList(node[2])[0]`
   (`commaList` was already imported). Also added `staticAssignTargetNames`,
   mirroring `module/object.js`'s own `resolveSchema` for the two
   structurally-static target shapes it recognizes (a `{...}` literal with
   no spread → its own name-set; `Object.create(null|undefined)` →
   emitter-lowered straight to an empty `{}`, `isNullishLiteral` — so its
   target schema is the EMPTY schema) — duplicated locally rather than
   imported (an emitter module importing INTO this analysis layer would
   invert the dependency), matching this file's own established practice
   (the `{}` spread-literal branch a few lines above does the same). Either
   way `hz.sids.add(...)` scopes the write to that ONE schema (a no-op for
   the empty schema — zero slots to poison) instead of `hz.all`'s
   whole-program blanket. **Verified via the self.js diagnostic: every
   Object.assign-triggered `hz.all` site closes** (9 distinct sites, e.g.
   `Object.assign(Object.create(null), parentXXX)` in `ctx.derive`,
   `Object.assign(ctx.core.stdlibDeps, inargXXXX)` per stdlib module —
   the latter's target is a property-chain access, still correctly
   unresolvable and falls through to the untouched `kindOf` path, not a
   spurious removal).

2. **BANKED — the dominant `keyedWrite` class, genuinely not safely
   fixable this session.** ~150-300+ sites, overwhelmingly one shape:
   `arr[idx] = v` inside the compiler's OWN internal census helpers
   (`observeSlot`/`poisonSlot`/`poisonCtor` in `src/compile/program-
   facts.js` itself, self-hosted — i.e. compiling the compiler's OWN
   census machinery AS a target program), where `arr` is `let arr =
   someMap.get(key); if (!arr) { arr = []; someMap.set(key, arr) }`.
   Traced to ground, not assumed:
   - `arr`'s kind is genuinely unresolvable by this compiler's CURRENT
     local flow analysis: `Map.get()`'s return is deliberately NOT
     promoted to an exact VT (`src/kind.js`'s own comment on `VT['()']`:
     "NO `.get` short-circuit here... VT['()'] does not promote a `.get()`
     read to an exact VT" — REVERTED once already, audit-#10, for being
     unsound in the closely-related `censusMaybeUndefinedKind` consumer).
     The `arr = []` fallback branch IS Array-typed, but joining it with
     the unresolved `.get()` branch still yields "unknown," by design.
   - The KEY's own int-certainty (`idx`, almost always a plain function
     PARAMETER) is ALSO unresolvable at this scan: `repOf(key)?.
     intCertain` reads `ctx.func.localReps` — a map populated by the
     ACTIVE emission cursor for whichever function is CURRENTLY being
     planned/emitted elsewhere in the pipeline, not the function this
     hazard walk is CURRENTLY visiting — disconnected from the walk's own
     `curParamVts` (built correctly per-body, but only consulted by
     `kindOf`, never by the numeric-key check). Verified directly: for
     every captured `arr[idx]=` site, `keyValType`, `repOf(key)?.
     intCertain`, AND `curParamVts.get(idx)` were ALL `null`/`undefined`
     — not a case of "the fact exists but isn't wired," the fact
     genuinely isn't computed yet at this pass.
   - **Why this is NOT this session's fix to make**: both levers
     (promoting `Map.get()`'s value kind; fixing param int-certainty
     threading) touch machinery this project's OWN audit trail already
     flagged as high-risk in the immediately adjacent domain (audit-#10's
     revert of the identical `.get()`-promotion idea for
     `censusMaybeUndefinedKind`) and is UNDER ACTIVE, DELIBERATE,
     SLICE-BY-SLICE HARDENING RIGHT NOW (this repo's own most recent
     prior commits: "maybeUndefined Slice 1: dict absent-key value join
     (censusMaybeUndefined)"). Wiring either into
     `collectSlotWriteHazards`'s `kindOf` — a SOUNDNESS-CRITICAL hazard
     classification whose wrong answer silently under-poisons, not a
     forgiving optimization heuristic — is exactly the "wide blast
     radius... this session's remaining time cannot safely absorb-and-
     verify" class this design has repeatedly, deliberately banked
     (§11-§16) rather than forced. A narrower angle was also checked and
     ruled out: `buildObjectSchemaSetArm` (`__dyn_set`, module/
     collection.js) dispatches on the RECEIVER'S OWN embedded runtime
     schema id, universally over `$__schema_tbl` — NOT scoped to
     dyn-shadowed schemas only — so an unresolvable-kind receiver truly
     CAN, at runtime, alias any registered schema's OBJECT pointer; there
     is no cheap, sound way to shrink `hz.all`'s reachable-schema set
     without either of the two risky levers above.

**Gates run (Task 1):** self.js-diagnostic-confirmed (Object.assign class
closes, keyedWrite class persists, `ctx.schema.slotWriteHazards.all`
still `true` after the fix — expected, not a regression); default battery
`node test/index.js` 3407/3399/2/6 (unchanged 2 pre-existing rows) both
before and after a fresh plain `dist/jz.wasm` rebuild; default `kernel-
parity` 3/3 (33 assertions, byte-identical) against a freshly, fully
rebuilt plain kernel (verified via the build log's own "wrote dist/
jz.wasm" line, §15's lesson applied); `JZ_CARRIER_BOX=1 kernel-parity`:
`dict` STILL diverges O0/O2/O3 (expected — the banked class dominates),
`sum`/`math` stay identical; `JZ_CARRIER_BOX=1` flag-forced battery
3380/21 (IDENTICAL pass/fail counts to §16's own baseline, differentially
confirmed against a disposable `git worktree add` at the pre-session
commit 60944c3b — `test/dyn-keys.js` 46/11 and `kernel-oracle` 3/8 match
the baseline worktree byte-for-byte); `test/pointers.js` 34/34 both modes
(default 62 assertions, `JZ_CARRIER_BOX=1` 66, unchanged counts);
`test/watr.js` 35/35 (107 assertions) under `JZ_CARRIER_BOX=1`;
`JZ_DEBUG_INVARIANTS=1` clean (no throw) on `test/objects.js` and
`JZ_CARRIER_BOX=1 test/pointers.js`; `JZ_CARRIER_BOX=1` fuzz 1500×4
(22406 inputs, 0 divergences).

**Commit:** `b4ce1f12` — `src/compile/program-facts.js` only.

### Task 2 — the console.log carrier-kernel crash: root-caused to BE Task 1's gap, not a second bug

**Re-verified the exact signature** (brief's own instruction, since §16
left this "confirmed... not reproduced in targeted checks" the session
before, then "CONFIRMED" only at the very end): `JZ_CARRIER_BOX=1
JZ_TEST_TARGET=jz.wasm node test/index.js`, against a freshly, fully
rebuilt carrier kernel (verified via the build log's own line, twice, at
two different points this session), crashes the whole process — an
uncaught `RangeError: Offset is outside the bounds of the DataView`
inside `interop.js`'s `mem.read` (`DataView.prototype.getBigInt64`),
reached via `readArgBits → write → imports.env.print`, immediately after
the `setTimeout: callback fires` test (`test/statements.js`) — byte-for-
byte the same stack, same trigger point, both times. **Root-caused past
§16's own stopping point** (`module/console.js`'s `asI64Bits` "never
routes through storedValue/carrierF64/any BIGINT-boxing logic at all... a
different subsystem, root cause NOT investigated"): true, but a red
herring — the corruption is not in HOW console.log boxes its argument, it
is in the STRING CONSTANT it is handed, already wrong by the time
console.log's own emit code sees it.

**Traced via `compileViaKernel({wat:true})` diff, native-vs-carrier-
kernel, on the minimized 1-line `console.log('bare-fired')` repro at O0**
(exactly the established hunt method): the two WATs diverge on ONE
instruction — the STRING LITERAL's own NaN-box constant:
```
native  (i64.reinterpret_f64 (f64.const nan:0x7FFA000000000007))
kernel  (i64.reinterpret_f64 (f64.const nan:0x7FFA8000000DA1FC))
```
The SAME tag/shape corruption pattern as §15's ORIGINAL finding (`nan:
0x7FF8...` → `nan:0x7FFA8...`-shaped, an extra high bit and garbage low
word — a box's own pointer bits leaking instead of its decoded payload).
Walked back to its source: `mkPtrIR`/`packPtrBits` (`src/ir.js`)
constant-folds a NaN-boxed pointer via `layout.js`'s `ptrBits(type, aux,
offset)`, which reads `LAYOUT.NAN_PREFIX_BITS` —
**the exact same module-scope BOXED BigInt schema field §15 found and
§16 fixed**, via the exact same static dot-access
(`emitSchemaSlotRead` → `slotBigintProvenBySid`). §16's fix is sound and,
confirmed via `test/pointers.js`'s own pin, correct for an ISOLATED
compile (just `layout.js`, no whole-program hazard noise) — but it is
**INERT for this exact field when the KERNEL ITSELF is built**: compiling
the FULL `scripts/self.js` source (required to produce `dist/jz.wasm`)
trips `collectSlotWriteHazards`' `hz.all` blanket via Task 1's OWN banked
`keyedWrite` class somewhere else in that same ~370K-line source — which
nulls `slotTypes` for EVERY schema program-wide, LAYOUT's included.
Confirmed directly, not inferred: a `ctx.schema` diagnostic after
natively compiling the full self.js graph at O0 (post-Task-1-fix) shows
`slotWriteHazards.all === true` and `slotBigintProvenAt('LAYOUT',
'NAN_PREFIX_BITS') === false` — the exact precondition §16's fix requires
never holds for this compile. So the BUILT kernel's own compiled copy of
`ptrBits` hands back the box's raw pointer bits instead of the true
constant, and EVERY subsequent heap-string NaN-box constant the running
kernel folds inherits the corruption — `console.log`'s argument is one
instance of a much wider class (any heap string literal in ANY program
the kernel compiles), matching and extending §16's own `dict`-divergence
generalization ("every subsequent compile that needs them inherits wrong
bytes... this generalizes the severity well past 'BigInt-heavy
programs'").

**Execution-confirmed, bisected exactly as §16 recorded** (not just the
WAT diff): compiled the minimized repro via `compileViaKernel` +
`instantiate`, then ran it.
- Heap string (≥7 chars, `'bare-fired'`): throws the identical
  `RangeError`/DataView-OOB.
- SSO string (≤6 chars, `'short'`): does NOT crash, but prints the
  corrupted decode — a host-side `console.log` spy shows the kernel
  called `print` with the string `"NaN"`, not `"short"`.
Native compiles and runs both cleanly (`start()` → `1`, no crash) —
confirms this is self-host-only, not a general regression.

**Verdict: this is Task 1's finding at one more remove, not a second,
independent bug.** Closing Task 1's banked `keyedWrite` class (the same
Map/dict `.get()`-derived receiver-kind gap, same audit-#10 caution) would
close this crash too, with zero additional fix work — a future session
should not re-investigate this as a separate "string-constant emission"
or "i64exp lane" surface (both were named as plausible, untried
neighbors in §16's own bank; neither is where this lives — `mkPtrIR`'s
`LAYOUT.NAN_PREFIX_BITS` read is EXACTLY the surface §16 already fixed,
just starved of its own precondition by Task 1's unclosed gap).

**Pinned** (`test/kernel-oracle.js`, new `test(...)` block, `JZ_CARRIER_
BOX=1`-gated, true no-op under default — same established pattern as
§15/§16's `test/pointers.js` pin): native runs both the heap-string and
SSO-string repros cleanly; the kernel throws the exact `RangeError` +
`"Offset is outside the bounds of the DataView"` message on the heap
string (a message-level tripwire — a DIFFERENT error means a NEW bug, not
this one changing) and prints the exact `"NaN"` corruption on the SSO
string. Verified: `node test/kernel-oracle.js` (default) — the block
runs, guard fires, 0 assertions, true no-op; `JZ_CARRIER_BOX=1 node
test/kernel-oracle.js` — all 6 assertions pass, pinning the wrongness
precisely.

**`JZ_CARRIER_BOX=1 test:wasm` leg: reconfirmed, NOT reachable "to
completion."** Ran to conclusion (not partial) against the freshly
rebuilt carrier kernel, twice (once before, once after the pin landed,
same kernel both times) — crashes the whole node process identically
both times, same stack, same trigger (`test/statements.js`'s "setTimeout:
callback fires" — the first heap-length string argument to `console.log`
anywhere in the default battery's own test order). This is the SAME
crash §16 confirmed at its own session's end, unregressed and unfixed —
"to completion" requires the underlying `hz.all`/`slotBigintProven`
precondition gap (Task 1's own banked class) to close first; no amount of
retrying or harness change gets past an unfixed, deterministic,
uncaught-exception crash.

**Gates run (Task 2):** default battery `node test/index.js` 3408/3400/2/6
(the SAME 2 pre-existing rows, +1 for the new no-op pin) both before and
after a fresh plain `dist/jz.wasm` rebuild; default `kernel-parity` 3/3;
`JZ_CARRIER_BOX=1` flag-forced battery 3381/21 against a freshly rebuilt
carrier kernel (the SAME 21 pre-existing rows §16/Task-1 both
established, +1 pass for the new pin — first attempt used a STALE plain
`dist/jz.wasm` left over from the intervening default-battery rebuild and
showed 14/no-pin-pass, a false read caught and corrected by rebuilding
carrier-boxed before re-running, §15's own stale-artifact lesson
triggering again mid-session); `JZ_CARRIER_BOX=1 test:wasm`: reconfirmed
crashing, twice, identically. No production-code change this task (the
Object.assign fix already covers everything safely fixable) — Task 1's
own fuzz/`DBG_INVARIANTS`/`watr.js`/pointers.js gates already cover the
unchanged `src/` state; not re-run redundantly.

**Commit:** `54336572` — `test/kernel-oracle.js` only.

### Flip-readiness verdict

**NO default flip** (mandated regardless of outcome this session).
`CARRIER_BOX` stays `JZ_CARRIER_BOX==='1'`-gated, OFF by default,
unchanged shape from §14/§15/§16. Net position: one real, verified,
zero-risk precision bug fixed (Task 1's Object.assign dead-resolution +
empty-schema exemption); one gap conclusively unified — what looked like
two separate blockers is ONE blocker (`hz.all`'s whole-program blanket,
specifically its `keyedWrite`-class trigger reading `Map`/dict `.get()`-
derived receiver kinds) with two visible symptoms (kernel-parity's `dict`
byte divergence; the carrier-kernel `console.log` crash) — both pinned,
neither fixed. **A future flip-readiness session should start from
EXACTLY ONE lever, not two**: closing the `keyedWrite`-class `hz.all`
trigger for `Map`/dict `.get()`-derived receivers — which requires either
(a) safely promoting `.get()`'s value kind for THIS soundness-critical
consumer specifically (distinct from, and possibly safer than,
`censusMaybeUndefinedKind`'s general-purpose promotion that audit-#10
reverted — worth its own scoped investigation rather than assuming the
same revert applies), or (b) threading the hazard-walk's OWN per-body
`curParamVts` int-certainty (already computed for `kindOf`, not yet
consulted for the KEY's numeric-exemption check) — both concrete,
narrower than "fix the whole Map/dict value-kind census," and BOTH would
close kernel-parity's `dict` row AND the console.log crash together, no
separate work needed for either. The pre-existing Slice 5/6/7 Map/dict-
census export-boundary family (`test/dyn-keys.js`, 11 rows under
`JZ_CARRIER_BOX=1`) stays independent of this — a different subsystem,
unaffected by and not blocking either lever above.

**Local commits (this session), both LOCAL ONLY, plain messages, no
push:** `b4ce1f12` (Task 1 fix), `54336572` (Task 2 pin), this entry
filed separately.

## §18. Map.get() kind-DISJOINTNESS census — ATTEMPTED, WALL HIT, banked
(2026-08-07, .work/todo.md "MAP.GET KIND PROMOTION" seed, §17's own named
lever)

**The revert-dodge argument (verified BEFORE writing code, per the seed's own
gate): confirmed sound, still holds.** `git show f8f61591`/`1db8e55e`: the
reverted `mapValueKindOf` consumer (audit-#10 P0) promoted a `.get()` read to
an EXACT `VAL.*` kind at a VALUE-consuming site (`VT['()']`'s `.get`
short-circuit, feeding arithmetic/`String()`/BigInt dispatch downstream) —
unsound two ways: an absent key reads real `undefined` regardless of the
observed kind (`m.get(missing) + 1` gave `undefined` instead of `NaN`), and
the census keys by syntactic receiver name, so a write through an alias is
invisible to it. This session's design dodges BOTH, structurally, not by
being more careful with the same shape: (1) the fact is consumed ONLY as a
boolean "is this receiver ever an OBJECT-schema instance" question inside
`collectSlotWriteHazards`'s own `kindOf` (src/compile/program-facts.js) —
never a value, never fed to representation/emission/arithmetic — so even in
the worst case (`.get()` on an absent key really does yield `undefined` at
runtime) the disjointness property still holds, since `undefined` is not a
`VAL.OBJECT` member either; (2) alias safety is not re-derived — it is
`mapValueKindOf`'s OWN pre-existing `ctx.types.nameEscapes` gate (kind.js),
the exact whole-program alias fact the audit named as missing, unchanged and
reused as-is. Both arguments held through implementation and every gate run
below — no soundness issue was found in review, testing, or the two builds
that surfaced the WALL below (which is a coverage gap, not a soundness gap).

**Implementation** (src/compile/program-facts.js, `collectSlotWriteHazards`):
a new closure-local `collectMapGetExemptLocals(bodyRoot)`, computed per
function body (and once for the top-level `ast`) alongside the existing
`curSids`/`curParamVts`, feeding a `curGetExempt` map consulted ONLY as the
LAST fallback in `kindOf`'s own `??` chain (`curParamVts?.get(obj) ??
repOf(obj)?.val ?? valTypeOf(obj) ?? curGetExempt?.get(obj) ?? null`) — so it
can only WIDEN an already-fail-closed decision, never override a resolved
one. For a local name `arr`, it joins (first-wins-then-clash, same lattice
`observeSlot`/`observeMapValue` already use elsewhere in this file) the kind
of EVERY write site (decl init or reassignment, including through
non-shadowing nested closures — mirrors `observeNestedDictMapWrites`'s
`collectAllBoundNames` shadow discipline just above it) to `arr` anywhere in
the body: a `.get()`-shaped RHS resolves via the EXISTING, unmodified,
already-dormant `mapValueKindOf` (kind.js); any other RHS resolves via this
same `kindOf` closure. Any unresolved site, any `VAL.OBJECT` site, or any
disagreement between two sites drops the name entirely (never stored). A
second, independently-motivated fix was needed alongside it: the Map's OWN
value-kind census (`observeProgramSlots`'s `observeMapValue`, unchanged
since 1db8e55e/f8f61591, feeds the dormant `mapValueValType` fact
`mapValueKindOf` reads) POISONS on exactly the canonical self-referential
idiom the seed names — `let arr = m.get(k); if (!arr) { arr = []; m.set(k,
arr) }` — because `writeVT(cargs[1])`, resolving the `.set()` call's OWN
value argument, sees the bare name `arr` and can't resolve it in general
(that's the very fact in question, circularly). Added
`collectMapSetReachingDefs(bodyRoot, paramVts)`: a purely SYNTACTIC
adjacency check (no general dataflow) — is a `.set()` call's IMMEDIATELY
PRECEDING SIBLING, in the same `;`-statement list, a plain `name = rhs`
assignment to the same bare name with an independently resolvable kind? If
so, straight-line execution guarantees the value at the call (no branch, no
loop iteration, no intervening write can occur between two direct AST
siblings) — sound regardless of what OTHER, unresolvable writes reach `name`
elsewhere. Wired as a `writeVT(...) ?? setHints.get(node)` fallback at both
existing `.set()` observation sites (`visit`'s branch and
`observeNestedDictMapWrites`'s nested-closure branch). Verified working in
isolation: a minimal repro (`const buckets = new Map(); const observeSlot =
(key, idx, v) => { let arr = buckets.get(key); if (!arr) { arr = [];
buckets.set(key, arr) }; arr[idx] = v }`) flips from `keyedWrite` (hz.all) to
`keyedExempt` at the late/post-narrowing pass, for both fixes.

**Diagnostic (Gate 1, `JZ_DEBUG_HZALL`, generation-tagged `early`/`late` —
the §17 precedent's own instrumentation, re-added and stripped again before
this commit) — THE WALL, found here, not anticipated by §17's own diagnosis:
zero effect on the real `scripts/self.js` compile.** Two independent full
self-host builds (a disposable `git worktree` at HEAD e16e5981 with only the
counters added, vs. the working tree with the full fix), run twice
(comparing byte-for-byte identical counter output both times): `{"keyedWrite
.early":319,"keyedExempt.early":54,"objectAssign":18,"keyedExempt.late":80,
"keyedWrite.late":324}` — IDENTICAL on both trees, before and after the fix,
down to the exact integer. **Root-caused, not merely observed**: the
dominant `keyedWrite` sites are the compiler's OWN census helpers this exact
file defines — `observeSlot`/`poisonSlot`/`poisonCtor`
(src/compile/program-facts.js:648-671, the identical idiom the seed names,
`let arr = slotTypes.get(sid); if (!arr) { arr = []; slotTypes.set(sid, arr)
}; arr[idx] = …`) — whose Map receiver (`slotTypes`, `slotCtors`,
`dictValueTypes`, `mapValueTypes`, …) is declared `const slotTypes =
ctx.schema.slotTypes` (line 624-628): a PROPERTY READ off host compiler
state, not a locally-provable `new Map()` literal or a narrowed parameter.
`mapValueKindOf`'s (and `observeMapValue`'s) receiver gate is a HARD
classification — `valTypeOf(recvName) === VAL.MAP`, proven ONLY via the
`new Map()` CALLEE_VAL/`recordGlobalRep` path (kind-traits.js) — which never
fires for a property-aliased binding; this compiler's kind system does not
trace object-property kinds through an arbitrary `const x = obj.prop` hop
(doing so would need to determine `ctx.schema.slotTypes`'s OWN kind, which
is exactly the same class of schema/property-kind inference this whole
`hz.all` hazard system exists to gate — the identical problem one level up).
Confirmed directly, not inferred, via two isolated minimal repros: a
`const buckets = new Map()` MODULE-LEVEL literal receiver (the case my fix
targets) correctly flips `keyedWrite`→`keyedExempt`; the SAME idiom with
`buckets` threaded in as a plain function PARAMETER (`const observeSlot =
(buckets, key, idx, v) => …` — structurally identical to how
`observeSlot`/`poisonSlot` actually receive `slotTypes`, as a closure
variable bound outside their own body rather than a fresh literal) stays
`keyedWrite` — zero exemption, matching the real self.js measurement
exactly. **Per Gate 1's own stated pass condition ("the dominant keyedWrite
class should collapse") — it does not. Stopping here, per the design brief's
own "if it does NOT dodge [the blocker], bank the finding and STOP — do not
force" discipline** (that clause named the SOUNDNESS dodge specifically;
this session's finding is a DIFFERENT, EMPIRICAL dodge-of-the-actual-target
failure, surfaced only by running the gate honestly rather than assuming the
seed's own diagnosis — §17 traced "arr's kind is unresolvable" but did not
check whether the RECEIVER itself was ever provably a `Map` to begin with).

**Decision: revert the source change, keep nothing landed.** Unlike
§11's Bug 1 (an independently real, always-correct fix kept regardless of
the flip's own outcome), this addition is pure speculative complexity for
the stated target once Gate 1 fails it: real per-compile cost (two extra
whole-body walks, `collectMapGetExemptLocals` + `collectMapSetReachingDefs`,
on every function, forever, both `JZ_CARRIER_BOX` on and off — this is NOT a
flag-gated addition) for a zero measured benefit on the flagship program,
and no independent corpus/benchmark demonstrating value for the narrower
module-level-literal-Map case it WOULD reach. Reverted
`src/compile/program-facts.js` to HEAD (`git show HEAD:… >`, not `checkout`)
— `src/kind.js` was never permanently touched (temporary diagnostic prints
added and removed within-session, confirmed zero diff against HEAD before
concluding). `dist/jz.wasm` rebuilt fresh from the restored HEAD source to
clear the three experimental rebuilds this session produced.

**What a future attempt needs, concretely, before trying this lever again**:
the ACTUAL blocker is not "prove `.get()`'s value kind" (this session solved
that, including the self-referential `.set()`-writes-back-the-`.get()`-
result circularity) — it is "prove a `const local = obj.prop` binding is a
`Map` at all," when `obj.prop` was itself initialized to `new Map()`
somewhere else entirely (in this exact case, `ctx.js`'s own `resetFactStore`/
session-init, a host-state initializer, not something the compiled PROGRAM's
own schema census would ordinarily need to track). That is a materially
larger, separate property-kind-tracing feature — likely its own
dedicated-session design, same discipline §11/§16 already established for
"a real fix exists, but not one this session's remaining time can safely
absorb-and-verify." Gates 2-6 (kernel-parity `JZ_CARRIER_BOX=1` dict clean,
`test:wasm` to completion, flag-forced battery + watr 35/35 + kernel-oracle
+ fuzz 2000×4, default byte-identity) were NOT run — Gate 1 is the FIRST
gate in the brief's own ordered list, and it is the one this session's fix
fails; running the later, far more expensive gates against a change that
provably does not move the target metric would itself be the "force it
anyway" this discipline exists to prevent. Post-revert sanity (not the full
gate battery, since nothing is landed to gate — confirms the revert itself
introduced no regression): `node test/slot-hazards.js` 21/21 (59
assertions), `node test/dyn-keys.js` 57/57 (284 assertions), `node
test/inference.js` 136/136 (299 assertions) all green against the restored
HEAD source; fresh `dist/jz.wasm` rebuild completed from the restored
source (confirms the repo is left in a normal, buildable HEAD state, not a
half-reverted one).

### Flip-readiness verdict

**NO default flip** (unchanged — this session never touched `CARRIER_BOX`
itself). §17's own verdict stands exactly as written: `hz.all`'s dominant
`keyedWrite` class remains banked, now with a SHARPER root cause than §17
had — it is specifically the property-aliased-Map-receiver gap, not simply
"Map.get()'s value kind is unresolvable." A future flip-readiness session
should start from the property-kind-tracing feature named above, not from
re-attempting this exact disjointness-census shape — the census machinery
itself (this session's `collectMapGetExemptLocals`/
`collectMapSetReachingDefs`, both fully reverted; `mapValueKindOf`,
pre-existing and untouched) is sound and reusable once the receiver-kind gap
closes, so a future session should re-derive it from this entry rather than
restart the soundness analysis from zero.

**Local: nothing committed** — the source change was written, gated,
diagnosed, and reverted within this single session; only this ledger entry
and the matching `.work/todo.md` status update are new, committed
separately, plain messages, no push.


## §19. PROPERTY-KIND TRACING scope check — WALL CONFIRMED, no implementation
attempted (2026-08-07, .work/todo.md "PROPERTY-KIND TRACING — coordinator
note", the mandated Step-1 gate before §18's next lever)

**Mandate**: before attempting §18's own named next lever ("prove `const x
= obj.prop` is a `Map` when `obj.prop` was initialized `new Map()`
elsewhere"), verify whether the slot-write census even SEES `ctx.schema`'s
construction site (`src/ctx.js` `reset()`, where `slotTypes` etc. are
assigned `new Map()`) when the compiler compiles its own `scripts/self.js`
graph. If ctx construction is opaque to the census, that is the real wall —
bank precisely and STOP, no Step 2 (the slotMapCertain census column).

**Verdict: WALL CONFIRMED, precisely and asymmetrically — the WRITE side
sees it, the READ side categorically cannot. Stopped here per the brief's
own instruction; nothing implemented.**

### The write side: NOT opaque (a finding that revises §18's own framing)

`observeProgramSlots`'s whole-program `{}`-literal walk (`src/compile/
program-facts.js`, the `visit` closure's `op === '{}'` branch, lines
877-895) registers EVERY object-literal node found anywhere in the AST —
top-level `ast` and every function body in `ctx.func.list`, unconditional
on what the literal is assigned to (no LHS check exists in this branch at
all, confirmed by direct read): `const sid = ctx.schema.register(parsed.
names); for (...) observeSlot(sid, i, valTypeOf(value))`. `ctx.schema =
{ list: [], vars: new Map(), poisoned: new Set(), ..., slotTypes: new
Map(), ... }` (`src/ctx.js:380-431`, inside `reset()`) is exactly such a
literal — when `reset()` is compiled as part of the self-hosted
`scripts/self.js` graph, this walk visits it like any other `{}` node,
registers its own schema id (call it S2, keyed by its ~14-name property
list), and **correctly observes S2's `slotTypes` slot as `VAL.MAP`** — `new
Map()` already resolves via the pre-existing, unrelated Map-recognition
path (`CALLEE_VAL`/`recordGlobalRep`, the same one `mapValueKindOf`'s
receiver gate and `valTypeOf(recvName) === VAL.MAP` at program-facts.js:838
both already rely on). **This means §18's own proposed Step 2 (a
`slotMapCertain` column) is not the missing ingredient — the census
already, unconditionally, today, without any new code, knows that the
literal assigned to `ctx.schema` has a Map-kinded `slotTypes` property.**
The wall is entirely on the read side.

### The read side: categorically opaque — two independent mechanisms checked, both fail structurally

`program-facts.js:624`'s own `const slotTypes = ctx.schema.slotTypes` (the
exact read site §18 named) is a TWO-level property chain: `ctx` (bare
global name) → `.schema` (property read) → `.slotTypes` (property read).
For `kindOf`/`valTypeOf` to resolve this to `VAL.MAP`, it must first
resolve the INNER read `ctx.schema` to schema id S2 — one level BELOW
where §18 stopped looking (§18 examined `mapValueKindOf`'s receiver gate
for the OUTER read; this session traced the INNER hop it depends on).
Two, and only two, chain-resolution mechanisms exist in the kind system;
both were read directly and both fail this exact shape:

1. **`ctx.schema.slotVT`/`idOf` (`module/schema.js:103,252`) and its
   `collectSlotWriteHazards` sibling `sidOf` (`program-facts.js:1201-
   1203`) are bare-STRING-only.** All three key exclusively off `typeof
   name === 'string'` — `ctx.func.refinements?.get(name)`, `repOf(name)`,
   `ctx.schema.vars.get(name)` are all `Map` lookups by string identity.
   A receiver that is itself a `.`-node (`ctx.schema`, an array, not a
   string) can never be passed through and resolve — confirmed by direct
   read, not inferred; there is no fallback branch for a non-string
   receiver anywhere in these three functions.

2. **`shapeOf` (`src/kind.js:1410`) DOES recursively walk `.`-chains**
   (`op === '.' && typeof args[1] === 'string': const parent =
   shapeOf(args[0])`) — this is the one place in the kind system with
   actual multi-hop chain resolution — **but it bottoms out at a
   completely different, unrelated fact table from the schema census**:
   `shapeOf(bareName)` reads `ctx.func.localReps?.get(name)?.jsonShape ??
   ctx.scope.globalReps?.get(name)?.jsonShape`. `jsonShape` is populated
   ONLY by `recordGlobalRep`/`shapeOfObjectLiteralAst`, called ONLY at a
   global's OWN declaration or WHOLE-value reassignment (`name = rhs`,
   `depth === 0`) — never at a property-sub-assignment (`name.prop =
   rhs`). `ctx` itself (`src/ctx.js:73`) is declared exactly ONCE, as a
   single literal: `export const ctx = { core: {}, module: {}, scope: {},
   func: {}, types: {}, schema: {}, ... }` — `schema: {}`, EMPTY, among
   its 14 top-level props. The REAL shape later assigned to `ctx.schema`
   (the `list`/`vars`/`slotTypes`/... literal) happens entirely via a
   property WRITE inside `reset()` — invisible to `jsonShape`, which
   forever reflects `ctx`'s original empty-`schema` declaration. So
   `shapeOf('ctx')` never advances past the empty shape, and `shapeOf(['.',
   'ctx', 'schema'])`'s recursive parent lookup dead-ends before it can
   ever reach S2.

### Empirical confirmation (JZ_DEBUG_PROPKIND, temporary, stripped before
commit — same discipline as §17/§18's JZ_DEBUG_HZALL) against the REAL
`scripts/self.js` graph, the exact compile `scripts/build-dist.mjs` itself
runs for `dist/jz.wasm` (`resolveModuleGraph` + `compile(g.code, {modules,
memory: 8192, optimize: { level: 3, watrGuard: false, snapshotInit: true
} })`)

Instrumented `VT['.']` (`src/kind.js`, right after the existing `slotVT`
check already failed) to count every `.`-node read whose receiver is NOT a
bare string and whose property name is one of `ctx.schema`'s own census
field names (`slotTypes`, `mapValueTypes`, `dictValueTypes`,
`slotConstInts`, `slotTypedCtors`, `slotIntCertain`, `slotBigintObserved`,
`vars`, `list`, `poisoned`, `slotI32Certain`), and whether `shapeOf` on
that receiver resolves to anything:

```
{ "seen": 2496, "shapeHit": 0, "samples": [
  ["list", "[\".\",\"m56_ctx$ctx\",\"schema\"]", null],
  ["list", "[\".\",\"m56_ctx$ctx\",\"func\"]", null],
  ...
  ["slotTypes", "[\".\",\"m56_ctx$ctx\",\"schema\"]", null] ] }
```

**2496 chained-receiver reads of a `ctx.schema.*`-shaped census field
across the whole self-hosted source, 0 resolved via `shapeOf` —
`shapeHit: 0/2496`.** The sampled hits include the EXACT target site:
`program-facts.js:624`'s `const slotTypes = ctx.schema.slotTypes` itself
(`m56_ctx$ctx` is the self-host module-mangled name for the `ctx` import),
confirming the static-analysis prediction directly on the real compile,
not just in isolation. (`ctx.func`/`ctx.module` etc. show up in `seen`
too, at other property-census-field-named reads elsewhere in the source —
same wall, same shape, not unique to `ctx.schema`.)

### Verdict: SCOPE CHECK FAILS. No Step 2 attempted.

Per the brief's own instruction, stopping here. `src/kind.js` reverted to
HEAD (`git diff` empty, confirmed); the temporary probe script deleted;
nothing committed to `src/`.

**The precise fact missing, and what would provide it**: not `.get()`'s
value kind (§18 solved that already, reverted only for zero measured
effect) and not a slot's own MAP-kind census (proven, above, to already
exist unconditionally for this exact case) — it is **a property-KIND
fact one level up**: for a bare-name receiver `r` with a known schema id
`Sr` (`ctx`, `Sr` = the 14-prop ctx-literal's sid) and a property `p`
within `Sr` (`schema`), a NESTED schema id `Sp` such that "every
resolvable write to `r.p` anywhere in the program is provably the SAME
`{}`-literal shape" (`Sp` = S2, the `list/vars/.../slotTypes` literal).
This is symmetric to `ctx.schema.vars`'s existing name→schema-id
promotion for a bare DECL (`const x = {...}`) — but one level down,
keyed by `(Sr, p)` instead of by a bare name, and sourced from a
PROPERTY-assignment write (`r.p = {...}`) instead of a decl/assignment
target. It requires two new things, not one: (a) a census table (a
`slotObjSids: Map<sid, Array<childSid|null>>` sibling of `slotTypes`,
populated by the SAME `.prop=`-write handling `observeProgramSlots`
already has at program-facts.js:897-917, poisoned the same way on any
non-uniform write) and (b) teaching `slotVT`/`idOf`/`sidOf` to accept
a `.`-node receiver by recursively resolving through THAT table instead
of requiring a bare string — i.e., generalizing `shapeOf`'s chain-walking
*shape* to the schema census's chain-walking *sid*, since today those are
two disjoint mechanisms and only the wrong one (jsonShape) walks chains.
**This is a materially larger feature than §18's Step 2** — a genuine
2-level (or N-level) property-kind-tracing system for the schema census
itself, not a column addition to it — confirming, more precisely than
§18's own "future attempt needs" note, that this is its own dedicated-
session design, not an extension of the disjointness-census machinery
§18 already wrote and reverted (which remains sound and reusable, per
§18's own closing note, once THIS gap closes first).

**Minimal reproducing shape** (for a future session's isolated repro,
matching §17/§18's own established method — not run this session, the
real-corpus evidence above already isolates the exact site):
```js
let g = { p: {} }
function reset() { g.p = { m: new Map() } }
function f() { const x = g.p.m }
```
Under the current machinery, `f`'s `g.p.m` read fails identically to
`ctx.schema.slotTypes`, for the identical reason: `g`'s own declaration
literal has `p: {}` (empty), `g.p`'s real shape is assigned later via a
property write invisible to `jsonShape`, and `slotVT`/`idOf`/`sidOf`
cannot accept `g.p` (a `.`-node) as a receiver at all.

### Flip-readiness verdict

**NO default flip** (unchanged — this session made no `src/` changes;
`git diff` against HEAD is empty for every tracked file). §18's own
verdict stands: `hz.all`'s dominant `keyedWrite` class remains banked. A
future flip-readiness session pursuing this lever must build the 2-level
property-kind census described above BEFORE §18's disjointness logic
(sound, reverted, recoverable via `git show`) can ever go live — Step 2
as scoped in the coordinator's seed (a same-level `slotMapCertain`
column) is necessary but not sufficient, and was correctly gated OFF by
this scope check before any implementation cost was spent on it.

**Local: nothing committed to `src/`** — `src/kind.js`'s temporary
`JZ_DEBUG_PROPKIND` instrumentation was written, run against the real
self.js compile, and fully reverted within this session (empty `git
diff`); the temporary probe script (`scripts/_propkind-probe.mjs`) was
deleted, not committed. Only this ledger entry and the matching
`.work/todo.md` status update are new, committed separately, plain
messages, no push.

## §20. PROPERTY-KIND TRACING implementation — census landed, chain
resolves, THIRD hz.all layer found blocking the consumer, disjointness
recovery attempted and reverted, WALL CONFIRMED (2026-08-07, implementing
§19's own missing-fact spec, the carrier flip's last
dependency chain)

**Step 1 — the nested-sid census + chain-through, built exactly per §19's
spec.**

- `ctx.schema.slotObjSids: Map<sid, Array<childSid|null|undefined>>`
  (`src/ctx.js`, sibling of `slotTypes`) — the nested-sid lattice, one
  level up from the KIND census: `undefined` = no `.prop=`/`=`-write
  observed, `null` = poisoned (≥2 distinct literal shapes, or any
  non-literal RHS), `childSid` = every resolvable write is provably that
  ONE `{}`-literal shape.
- Populated ONLY by `observeProgramSlots`'s existing `.prop=`/`=`-write
  branch (`src/compile/program-facts.js:917-936`) — deliberately NOT by
  the `{}`-literal decl-site branch just above it. This was the key design
  decision this session had to resolve, not spelled out in §19: `ctx`'s
  own declaration (`ctx.js:73`) initializes `schema: {}` (EMPTY, 0 props)
  — if the decl-site branch ALSO fed slotObjSids, `ctx.schema`'s entry
  would first-wins-then-clash against the EMPTY schema, then clash again
  against `reset()`'s real `{list, vars, ..., slotTypes, ...}` literal,
  poisoning the exact flagship case to null. Scoping population to ONLY
  the write branch (matching §19's own wording, "populated by the SAME
  `.prop=`-write handling... at program-facts.js:897-917") sidesteps this
  cleanly: `reset()`'s write is the ONLY site touching `ctx.schema`
  anywhere in the program (confirmed by grep), so its entry lands clean,
  unclashed. Trade-off, accepted: a PURE decl-only nested object (`let o =
  {a: {x:1}}`, never reassigned) doesn't get a slotObjSids entry either —
  a real coverage gap, but sound (fails closed, no fact, not a wrong one).
- `ctx.schema.chainSid(node, resolveBare, depth)` (`module/schema.js`, new,
  shared) — the ONE place that walks a multi-hop `.`-chain
  (`ctx.schema.slotTypes` is `['.', ['.', 'ctx', 'schema'], 'slotTypes']`),
  recursing through `slotObjSids` one hop at a time; `resolveBare` is
  supplied per-caller (idOf's refinement/poison-aware lookup; collect-
  SlotWriteHazards' `curSids`-aware one) so the walk logic itself isn't
  duplicated. `ctx.schema.idOf` (~line 103) and `collectSlotWriteHazards`'s
  local `sidOf` (~line 1201, program-facts.js) both route a non-string
  receiver through it — `ctx.schema.slotVT` (~line 252) needed ZERO
  changes: it already calls `idOf`, so it inherits chain-resolution for
  free, confirming the design brief's own "prefer a shared walker, stays
  minimal" steer was right — `shapeOf` (kind.js) was NOT touched (no
  duplicate chain-walker built; the existing jsonShape-based one is
  untouched and still serves its own, different callers).

**A second, unplanned design decision, found only by running the real
self.js compile (not the isolated repro) — `chainSid`'s OWN hazard gate
had to be NARROWER than `slotVT`'s existing `slotHazarded`, or the whole
census is inert by construction.** `slotHazarded`'s `hz.all` term is a
WHOLE-PROGRAM blanket boolean, set by causes entirely unrelated to any
specific sid (the exact `keyedWrite` class §17/§18 studied — `arr[idx]=v`
on an unresolvable-kind `arr`). Gating `chainSid`'s intermediate-hop
resolution on the full `slotHazarded` (as first written, mirroring
`slotVT`'s existing discipline by analogy) reproduces a genuine bootstrap
circularity on the real compile: chain resolution needs `hz.all` false to
walk through `ctx` → `ctx.schema`; `hz.all`'s actual causes (§18's own
diagnosis: ~319-324 `arr = ctx.schema.X.get(sid)`-shaped locals, ALL
property-chain-bound, none literal) need chain resolution to have ALREADY
resolved `ctx.schema.X`'s kind (via `mapValueKindOf`'s receiver gate)
before they can exempt. Neither side can go first. Empirically confirmed,
not assumed: a full self.js compile with `hz.all`/`hz.sids`/`hz.props`
dumped post-compile showed `hz.all: true, sids.size: 7, props.size: 956`
but **`hz.sids.has(55)` (ctx's own sid) = false, `hz.props.has('schema')`
= false** — `ctx`/`schema` are not themselves implicated by anything
targeted; only the irrelevant blanket blocks them.

Root-caused, then fixed with a narrower, separately-justified gate:
`chainHazarded(id, prop)` (module/schema.js) checks `externSlotSids`,
`hz.sids`, and `hz.props` — the TARGETED, attributable hazards — but NOT
`hz.all`/`hz.numeric`/`kindSafeSids`. Justification, not just expedience:
`hz.all` protects a DIFFERENT invariant than nested-sid chain resolution
needs — a slot's sampled VALUE KIND against writes the narrow per-(sid,idx)
walk couldn't attribute at all (computed-key writes, Object.assign/spread
merges, extern constructors). `slotObjSids` is populated by that SAME
narrow walk and is ALREADY its own complete, self-poisoning census for
bare-string-receiver dot-writes — a write it can't see is either (a)
computed-key/aliased, caught by `hz.props`/`hz.sids` (SID/NAME-specific,
kept), or (b) simply doesn't exist in the program (the common case,
verified above for ctx/schema specifically). Verified sound AND effective
after the fix: the isolated minimal repro (`let g = {p:{}}; function
reset(){g.p={m:new Map()}}; function f(){const x=g.p.m}`) resolves `g.p.m`
to `VAL.MAP` correctly; on the real self.js compile, `chainSid` now
resolves `ctx` → sid, `ctx.schema` → sid 63 (`{list, vars, ..., slotTypes,
...}`'s own sid) cleanly, 946/946 times sampled, confirmed via direct
inspection of `ctx.schema.slotObjSids` post-compile.

**Diagnostic (Gate 1, §19's own probe re-run, standalone script walking
the compiled program's own AST post-compile + calling `ctx.schema.slotVT`
directly — no `src/` instrumentation needed or landed): 0/276 distinct
call sites resolve** (the original in-VT-call counting methodology, ad hoc
and not landed, separately showed 0/2517 over the whole multi-pass
compile — same verdict, different denominator). **This is NOT the same
finding as §19's own wall** — the RECEIVER CHAIN now resolves correctly
(`ctx.schema` → sid 63, verified directly), but `ctx.schema.slotVT`'s
EXISTING, UNCHANGED final-lookup gate (`slotHazarded`, WITH `hz.all`) still
blocks the KIND read on the resolved sid's slot — the SAME pre-existing
`hz.all` wall §17/§18 already diagnosed, now confirmed to ALSO gate the
downstream consumer of a successfully-chain-resolved receiver, one layer
deeper than §19's own diagnosis reached. Deliberately NOT loosened:
`slotVT`'s `slotHazarded` call is shared by EVERY caller (bare-name and
chain-resolved alike), landed and audited over many sessions; narrowing
it program-wide is a materially larger, separately-audited change this
step does not make — the task's own Step 2 (§18's disjointness recovery)
is the intended lever for reducing `hz.all` itself, tested next.

**Sanity, this step**: `node test/slot-hazards.js` 21/21 (59 assertions),
`node test/dyn-keys.js` 57/57 (284 assertions), `node test/inference.js`
136/136 (299 assertions), full battery `npm test` 3400/3408 (19550
assertions, 6 skip) — the 2 failures (`test/optimizer.js`, interval-walk
codec bounds checks / typed RMW guard count) confirmed PRE-EXISTING via a
disposable `git worktree` at HEAD (identical 217/219 pass, same 2 named
failures, byte-for-byte same assertion count) — unrelated to this
session's `src/` changes (codegen bounds-check elision, not schema/kind
census).

**Local commit: 32f87447** (`property-kind tracing: slotObjSids nested-sid
census + chainSid walker (§19/§20)`).

**Step 2 — recover §18's disjointness logic, JZ_DEBUG_HZALL before/after.**
§18's own commit (`7e43df7e`) turned out to be ledger-only — the actual
`collectMapGetExemptLocals`/`collectMapSetReachingDefs` source was written,
gated, and reverted WITHIN that session, never committed (`git show
7e43df7e --name-only` touches only the two `.work/*.md` files). "Recover
from git" was therefore not literally possible; re-implemented from §18's
own prose spec instead (detailed enough to reproduce faithfully):

- **Fix 1** (`collectSlotWriteHazards`, program-facts.js): `curGetExempt`,
  computed per function body (and once for `ast`) alongside `curSids`/
  `curParamVts`, consulted ONLY as `kindOf`'s last `??` fallback. For each
  local name, joined (first-wins-then-clash) the kind of every write site —
  a `.get()`-shaped RHS via `mapValueKindOf`, any other RHS via `kindOf`
  itself — walking into non-shadowing nested closures (mirrors
  `observeNestedDictMapWrites`'s `collectAllBoundNames` shadow discipline).
  Any unresolved site, `VAL.OBJECT` site, or disagreement drops the name.
- **Fix 2** (`observeProgramSlots`, program-facts.js): `collectMapSetReachingDefs`
  — a purely syntactic adjacency check (a `.set()` call's immediately
  preceding sibling in the same `;`-list is a plain `name = rhs` to the
  same name) — wired as a `writeVT(...) ?? setHints.get(node)` fallback at
  both `.set()` observation sites (the main `visit` branch and
  `observeNestedDictMapWrites`'s nested-closure twin), fixing the
  `let arr = m.get(k); if (!arr) { arr = []; m.set(k, arr) }` self-write-
  back circularity in the `mapValueTypes` census itself.

Both pass sanity (`test/slot-hazards.js` 21/21, `test/dyn-keys.js` 57/57,
`test/inference.js` 136/136).

**Diagnostic (Gate 2, JZ_DEBUG_HZALL, temporary counters at `keyedWrite`'s
two branches, matching §17/§18's own instrumentation exactly, stripped
after use), real self.js compile: NO COLLAPSE.**
`{"keyedWrite.early":322,"keyedExempt.early":54,"keyedExempt.late":80,
"keyedWrite.late":327}` — statistically identical to §18's OWN baseline
measurement (`{"keyedWrite.early":319,"keyedExempt.early":54,
"objectAssign":18,"keyedExempt.late":80,"keyedWrite.late":324}`; the small
319→322/324→327 deltas track ordinary codebase drift between sessions, not
a real change — `keyedExempt` is BYTE-IDENTICAL, 54/80 both times). **Zero
measured effect, again — but for a THIRD, deeper, newly-precise reason,
not §18's original one.**

**Root-caused, decisively, via direct instrumentation (not inferred):**
`mapValueKindOf`'s receiver gate (`valTypeOf(recvName) === VAL.MAP`) for a
property-chain-bound local like `slotTypes` (`const slotTypes =
ctx.schema.slotTypes`) resolves through `VT['.']` → `ctx.schema.slotVT` —
and `slotVT`'s OWN, PRE-EXISTING, UNCHANGED final-lookup gate
(`slotHazarded`, WITH `hz.all`) blocks it, REGARDLESS of §19's chain
census working correctly underneath it. Confirmed with a direct post-
compile dump on the real self.js compile: `ctx.schema` chain-resolves to
its real sid (63) cleanly (`slotObjSids` proves it) — but
`ctx.schema.slotVT(['.', 'ctx', 'schema'], 'slotTypes')` still returns
`null`, and the DUMP shows why precisely: `hz.all: true`, but
**`hz.props.has('slotTypes') = false` and `hz.sids.has(63) = false`** — no
TARGETED hazard implicates this sid or this prop name at all; it is
PURELY the whole-program `hz.all` blanket, the exact same irrelevant-noise
pattern §20's own Step 1 finding already established for `chainSid`'s
intermediate hops — except this time in a consumer (`slotVT`'s FINAL
kind-lookup) this session deliberately did NOT touch, because narrowing
it is a materially different, larger-blast-radius change: `chainHazarded`
(Step 1) is a NEW function serving ONLY `chainSid`'s NEW nested-sid walk;
`slotHazarded` is the ORIGINAL, shared gate for EVERY existing `slotVT`/
`slotIntCertainAt`/`slotI32CertainAt`/`slotTypedCtorAt` caller, landed and
audited over many prior sessions (§9-§18). Loosening it program-wide
would need the SAME kind of careful, dedicated soundness argument this
session gave `chainHazarded` — extended to cover VALUE-precision
consumers (`slotIntCertain`/`slotI32Certain`), which have a materially
different risk profile than the SHAPE question `chainSid` answers (an
element-level `arr[idx]=v` write can never change a schema slot's own
declared VAL kind, only what an UNRELATED array's contents hold — plausibly
irrelevant there too, but NOT verified this session, and int32-exactness
in particular is value-exact, not kind-approximate, raising the stakes of
being wrong). **This is the actual wall**: the census (§19) and the
disjointness logic (§18) are BOTH sound and BOTH work exactly as designed
— they simply cannot reach the target metric until a THIRD, larger,
separately-scoped lever (loosening `slotVT`'s shared hazard gate, backed
by its own dedicated soundness review across ALL its existing consumers)
is pulled first. Not attempted this session — outside its scope, per the
same "no forced fix, no speculative complexity for zero measured benefit"
discipline §18 established.

**Decision: revert Steps 2's Fix 1 + Fix 2, keep Step 1 (the census)
landed.** Matches §18's own precedent for an identical zero-measured-
effect finding exactly: `keyedWrite`/`hz.all` did not move, the addition
is real per-compile cost (two more whole-body walks per function, forever,
flag-independent) for zero benefit on the flagship program. Reverted
`src/compile/program-facts.js` to `HEAD` (`git show HEAD:… >`, not
`checkout`) — confirmed empty diff after. `src/ctx.js` and `module/
schema.js` (Step 1's census + chainSid) are untouched by this revert and
stay landed: chain resolution is real, verified, reusable infrastructure
independent of whether `hz.all` ever collapses — the same distinction the
design brief itself draws between "a real fix, kept regardless of outcome"
and "speculative complexity for a target that didn't move." Post-revert
sanity: `test/slot-hazards.js` 21/21, `test/dyn-keys.js` 57/57,
`test/inference.js` 136/136, all green against the reverted source.

**Steps 3-5 NOT run.** Gate 2 (this step) is the explicit go/no-go the
task's own Sequence names before the expensive battery (kernel-parity
O0/O2/O3, `test:wasm` to completion, flag-forced battery + watr 35/35 +
kernel-oracle + fuzz 2000×4, default byte-identity, flip-readiness probe)
— running it against a change that provably does not move `hz.all`/
`keyedWrite` would be exactly the "force it anyway" this discipline exists
to prevent (§18's own words, reused verbatim because the situation is
structurally identical). No `CARRIER_BOX`-flag-gated code was written this
session (Step 1's census is flag-INDEPENDENT by the task's own framing,
and — since it never became load-bearing for anything Step 2 needed — its
mere presence changes no observable compile decision anywhere: it is dead
until a future session's `slotVT` fix wakes it, so there is nothing to
gate behind the flag and no default-byte risk to check this session).

### Flip-readiness verdict

**NO default flip** (unchanged — `CARRIER_BOX` itself untouched this
session; `git diff` against the prior commit is empty for `src/kind.js`
and `src/compile/program-facts.js` after the Step 2 revert, non-empty only
for `src/ctx.js`/`module/schema.js`'s landed Step 1 census, which is a
pure addition with no consumer live yet — verified inert: nothing reads
`slotObjSids` except `chainSid`, and nothing outside this session's own
reverted Step 2 code ever called `chainSid` with a non-string receiver
before this session; `idOf`'s pre-existing bare-string callers are
byte-identical in behavior). `hz.all`'s dominant `keyedWrite` class remains
banked, now traced to its THIRD, most precise layer yet: not "Map.get()'s
value kind is unresolvable" (§17), not "the receiver-Map-kind gate can't
see a property-aliased binding" (§18), not "the property chain itself
can't resolve to a schema id" (§19) — all three of those are now SOLVED,
landed, or faithfully re-derived — but "`ctx.schema.slotVT`'s existing,
shared, multi-consumer hazard gate still treats the whole-program `hz.all`
blanket as relevant to a KIND query it was never proven relevant to."
**A future flip-readiness session's concrete next lever**: audit whether
`hz.all` is genuinely load-bearing for `slotVT`/`slotIntCertainAt`/
`slotI32CertainAt`'s callers, or whether (matching this session's own
`chainHazarded` argument, extended) an element-level `[]=` write can never
invalidate a schema slot's own KIND/precision claim — only a `.prop=`/`=`
whole-slot write can, and THAT class is already fully covered by the
targeted `hz.sids`/`hz.props` sets. If true program-wide (not just for
the chain-resolution case this session verified), `slotHazarded` itself
should drop the `hz.all` term (keeping `externSlotSids`/`kindSafeSids`/
`hz.sids`/`hz.props`/`hz.numeric`), closing the loop this session traced
but did not close. This needs its own dedicated soundness review across
EVERY existing `slotHazarded` consumer before touching it — precisely the
"materially larger feature... its own dedicated session" scoping §18/§19
already established for their own levers, now handed down one level
further.

**Local: `src/ctx.js`, `src/compile/program-facts.js` (net: Step 1 only,
Step 2 fully reverted), `module/schema.js` land in commit 32f87447**
(already pushed to this ledger entry's own preceding commit — Step 2's
revert leaves `program-facts.js` byte-identical to that commit, so no
further `src/` commit is needed). This ledger entry + the matching
`.work/todo.md` status update commit separately, plain messages, no push.

## §21. slotHazarded's `hz.all` term audited for the slot-KIND question
(§20's own named lever) — REFUTED: `hz.all` IS load-bearing, a concrete
miscompile shape named, no narrowing, no code change (2026-08-08)

**The audit.** §20 banked a hypothesis: "an unresolved element write
`arr[idx]=v` (what sets `hz.all`) can never change a schema SLOT's OWN
KIND — only whole-slot writes can, already covered by `hz.sids`/
`hz.props`/`externSlotSids`." If true, `slotVT`'s KIND lookup could gate
on a narrower `slotKindHazarded` (drop the `hz.all` term), unblocking the
chain-resolved reads §20's own `chainSid` census produces. Audited by
reading, not assuming: every `hz.all` setter site
(`collectSlotWriteHazards`, `src/compile/program-facts.js`) × every
`slotHazarded` consumer (`module/schema.js`).

**`hz.all` has exactly two setter sites**, both in `collectSlotWriteHazards`:
1. `keyedWrite`'s non-numeric fallback (`program-facts.js:1271-1279`,
   `hz.all = true` at line 1278) — reached by `[]=`, `delete[]`, and
   destructuring-pattern element targets whose receiver's `sidOf` doesn't
   resolve AND whose `kindOf` is either unresolved OR resolved to
   something NOT in `KEYED_EXEMPT_VALS` (`{ARRAY, TYPED, HASH, MAP, SET,
   STRING}` — **`VAL.OBJECT` is deliberately absent from this set**) AND
   whose key is neither a `VAL.NUMBER` value nor `repOf(key)?.intCertain`.
2. `Object.assign`'s unresolved-target fallback (`program-facts.js:1332-
   1350`, `hz.all = true` at line 1348) — reached when the target's `sidOf`
   doesn't resolve, `staticAssignTargetNames` doesn't structurally resolve
   it either, and `kindOf(target)` is `null` or `VAL.OBJECT`.

**Both sites are gated on "receiver's kind could be `VAL.OBJECT`," not on
"receiver is definitely some other, exempt kind."** That is the whole
point of excluding `VAL.OBJECT` from `KEYED_EXEMPT_VALS`: the branch is
reached precisely when the compiler cannot rule out that the receiver is
a live schema-object instance receiving a **dynamic-key property write**
(computed key, or an unknown source's keys via `Object.assign`) — which
is a whole-slot write by every definition already in this file's own
vocabulary (`hz.sids`/`hz.props`'s job), just one whose target sid/prop
the static census cannot name. §20's hypothesis implicitly assumed
"unresolved kind" meant "definitely an array, we just can't prove it" —
false: `kindOf(obj)` returning `null` or `VAL.OBJECT` are exactly the two
cases where the receiver COULD be a schema instance.

**Runtime confirmation, not just static reasoning**: `$__dyn_set`'s
OBJECT arm (`buildObjectSchemaSetArm`, `module/collection.js:2338-2359`)
reads the receiver's OWN embedded `$sid` from its NaN-box aux bits, loads
THAT schema's key table from the global `$__schema_tbl`, linear-scans for
the runtime key, and stores `$val` into whatever slot matches — dispatch
is universal over every registered schema carried by the pointer, not
scoped to any subset (dyn-shadowed or otherwise). So a receiver that is
*at runtime* an instance of schema S, written through a call site the
static census could not attribute to S (unresolved `sidOf`, unresolved or
non-literal key), really does land in one of S's slots with whatever
value kind the call site happens to pass — no static fact prevents it.

**Concrete counter-example (names the exact shape, verified against the
actual `keyedWrite`/`Object.assign` branches read above, not executed —
the branch conditions alone are sufficient to place it)**:
```js
function Foo() { this.count = 0 }        // schema S; census: slot 'count' → VAL.NUMBER
function corrupt(obj, key, val) { obj[key] = val }   // key: plain param, not a literal,
                                                       // not repOf(key)?.intCertain
function main() {
  const f = new Foo()
  corrupt(f, 'count', 'oops')             // obj: plain param, sidOf(obj) unresolved;
}                                          // kindOf(obj) unresolved (could be VAL.OBJECT)
```
Inside `corrupt`'s body, `collectSlotWriteHazards`'s walk sees `obj[key] =
val`: `sidOf(obj)` is `null` (an untyped parameter has no bound
`schemaId`), `kindOf(obj)` is `null` (same reason) — falls straight past
`KEYED_EXEMPT_VALS`. `key` is a bare parameter name too: `isLiteralStr`
is false (routes past `propWrite`, so `hz.props` is NEVER populated for
`'count'` by this site — `propWrite`'s `hz.props` fallback only fires for
LITERAL string keys), `valTypeOf(key) !== VAL.NUMBER`, `repOf(key)?.
intCertain` is not `true`. **Sets `hz.all = true`, and nothing else** —
`hz.sids` doesn't gain S's sid (never resolved), `hz.props` doesn't gain
`'count'` (key wasn't a literal). If `slotVT`'s gate dropped the `hz.all`
term (a `slotKindHazarded` narrowed to `externSlotSids`/`hz.sids`/
`hz.props`/`kindSafeSids`, mirroring `chainHazarded`'s existing shape),
`slotVT('f', 'count')` at any read site downstream of `corrupt`'s call
would still answer `VAL.NUMBER` — wrong, since `corrupt(f, 'count',
'oops')` really did overwrite that exact slot with a string at runtime.
Any consumer trusting that KIND fact for an unboxed/direct representation
decision (the entire point `CARRIER_BOX`'s carrier-flip work exists to
eventually enable) would misread the string's pointer bits as a number —
a genuine type-confusion miscompile, not a conservative-but-safe
imprecision.

**Full caller × setter enumeration** (`slotHazarded(id, prop,
kindSafeOk)` callers, `module/schema.js`) — every cell is the SAME
verdict, for the SAME reason (the counter-example's receiver could feed
any of them, since they all key off the same `(sid, prop)` the corrupted
write hit):

| caller | kindSafeOk | fact read | setter 1 (`keyedWrite`) | setter 2 (`Object.assign`) |
|---|---|---|---|---|
| `slotVT` (303-320) | true | slot KIND (`slotTypes`) — §20's named target | **load-bearing** (shape above) | **load-bearing** (same shape, `Object.assign(f, {count:'oops'})`) |
| `slotBigintProvenBySid` (510-515) | true | slot KIND (`slotTypes === VAL.BIGINT`), feeds unconditional unbox | **load-bearing** (same shape, worse consequence: unconditional read of raw bits) | **load-bearing** |
| `slotTypedCtorBySid` (333-340) | false | VALUE (typed-array ctor for raw load/store) | **load-bearing** | **load-bearing** |
| `slotTypedCtorByProp` (347-359) | false | VALUE (speculative bare-prop ctor) | **load-bearing** | **load-bearing** |
| `slotIntCertainAt` (365-389) | false | VALUE precision (int-certainty) | **load-bearing** | **load-bearing** |
| `slotI32CertainAt` (395-418) | false | VALUE precision (strict int32) | **load-bearing** | **load-bearing** |
| `slotI32CertainBySid` (419-424) | false | VALUE precision (strict int32, by-sid) | **load-bearing** | **load-bearing** |

No cell dodges: every consumer reads a fact keyed by `(sid, prop)`, and
both setter sites poison precisely because they CANNOT name a `(sid,
prop)` pair to scope a targeted hazard to — the receiver might be any
registered schema, the prop might be any of its slots. `hz.sids`/
`hz.props`/`externSlotSids`/`kindSafeSids` cover every write the census
CAN attribute; `hz.all` is not redundant noise layered on top of that,
it is the sole belt for writes the census fundamentally cannot attribute
to a specific slot at all — which is exactly the case where the receiver
could be *anything*, KIND included.

**Where this differs from `chainSid`'s own `chainHazarded` (§20), which
correctly DOES drop `hz.all`**: `chainHazarded` gates `slotObjSids`
lookups, whose only inputs are BARE-STRING, STATICALLY-CHAIN-RESOLVED
receivers (`ctx.schema.slotTypes`-shaped `.`-chains) — a closed set this
session's counter-example cannot reach, because `corrupt`'s `obj[key]`
is never a static `.`-chain in the first place (it's a computed-key
write on an opaque parameter). `chainSid`'s own narrowing was justified
by showing the specific writes `hz.all` guards against (`keyedWrite`,
`Object.assign`) can never alias a STATICALLY-NAMED chain's intermediate
hop; that argument does NOT extend to `slotVT`'s general `(varName,
prop)` gate, whose `varName` is exactly the unresolvable, possibly-
aliased case `chainHazarded`'s own justification excludes by
construction. §20's hypothesis conflated the two.

**Verdict: Outcome B.** `hz.all` is genuinely load-bearing for the
slot-KIND question, not just the value-precision one. No `slotKindHazarded`
narrowing introduced — narrowing `slotVT`'s gate as proposed would be an
unsound miscompile, not a coverage-only imprecision. No code changed
(`src/`, `module/` untouched this session — audit only, per the brief's
own "answer BEFORE any code change" gate). Steps 1-4 (the ladder) NOT
run — Outcome B's own stated exit is "bank it in §21 with the shape and
stop."

### Flip-readiness verdict

**NO default flip** (nothing changed to flip). `hz.all`'s dominant
`keyedWrite` class (§17-§20) remains banked, unfixed, and now confirmed
CORRECT to remain a blanket for every `slotHazarded` consumer including
`slotVT` — not a narrowing opportunity. The carrier flip's dependency
chain on this specific lever is CLOSED, negatively: the path from §16's
original `hz.all` finding through §17 (root cause), §18 (disjointness,
walled), §19/§20 (chain resolution, landed and real, but its downstream
consumer `slotVT` correctly stays gated) ends here — a future
flip-readiness session should not re-attempt narrowing `slotHazarded`
itself. §17's own still-open, independent levers remain the live path
(promoting `.get()`'s value kind for THIS soundness-critical consumer
specifically, or threading `curParamVts` int-certainty into `keyedWrite`'s
numeric-key check) — both aimed at making the CENSUS more PRECISE (fewer
genuine `hz.all` triggers), not at loosening the GATE that consumes it.
That distinction — precision of the census vs. soundness of the gate —
is this session's own contribution: the gate was never the bug.

**Local: nothing committed to `src/`/`module/`** (no code change, audit
only). This ledger entry + the matching `.work/todo.md` status update
commit separately, plain messages, no push.

## §22. §17/§21's own named lever 2 (thread param int-certainty into
`keyedWrite`) — IMPLEMENTED, SOUND, VERIFIED FUNCTIONAL in isolation, ZERO
measured effect on `scripts/self.js`'s dominant `hz.all` class — WALL,
root-caused precisely, banked (2026-08-08)

**The change.** `collectSlotWriteHazards`'s `keyedWrite` (`src/compile/
program-facts.js`) already exempts a dynamic key from `hz.all` when it is
a literal `VAL.NUMBER` or `repOf(key)?.intCertain === true` (a local whose
OWN reassignment fixpoint proves it integer). Extended the SAME exemption
to a bare PARAMETER name proven both wasm `i32` AND `VAL.NUMBER` in the
already-settled cross-call `paramReps` lattice (`curParamVts`'s own
source, `opts.paramReps`, built in `collectSlotWriteHazards`'s late-mode
per-func loop) — `curParamIntCertain`, a `Set<name>` alongside the
existing `curParamVts` map, consulted only as a THIRD alternative in the
key check (literal → local-intCertain → param-intCertain), same
soundness class as the two it joins (a numeric key is an element write,
not a whole-slot write), fail-closed (unproven ⇒ `hz.all` stands, no
change to `slotHazarded`'s gate — §21's own "do not touch" respected).
`r.wasm === 'i32'` alone was NOT sufficient: narrow.js's own
`argWasmType`/`exprType` wasm-rep classification shares `i32` between
int-narrowed NUMBER params and BOOL params (`vk !== VAL.NUMBER && vk !==
VAL.BOOL` gate, narrow.js:1734) — the `.val === VAL.NUMBER` co-check
excludes the latter explicitly rather than relying on `_numericName`'s
own accidental immunity to boolean `ToString`.

**Facts-availability diagnosis (the brief's own first question).** At
`collectSlotWriteHazards`'s EARLY invocation (no `opts.paramReps`), a
param's WASM representation genuinely doesn't exist yet — `narrowSignatures`
hasn't run — so `curParamIntCertain` is correctly `null` there, matching
§17's own finding for `repOf`. At the LATE invocation
(`refineSlotKindCensus`, post-`narrowSignatures`), `func.sig.params[k].type`
and `paramReps.get(k).val` are BOTH real, settled facts — confirmed
functional via an isolated positive repro (not just static reasoning):

```js
function poke(o, idx, v) { o[idx] = v; return o }
function makeObj() { return { count: 0 } }
export let f = (n) => {
  let o = makeObj()
  let i = 0
  while (i < n) { poke(o, i, i); i = i + 1 }
  return n
}
```
compiled with `sourceInline: false` (isolating the mechanism from the
inliner — see "confound" below) — `curParamIntCertain` for `poke` becomes
`{idx}`, the late pass shows `keyedWrite.all=0 paramSaved=1` (was
`all=1` pre-fix): the channel is real and the wiring works end-to-end.

**Confound found and corrected mid-session**: the FIRST isolated probes
(same shape, default `optimize: 2`, `sourceInline` on) showed `p.type`
staying `f64` even for a param fed ONLY literal-integer arguments —
looked like the lever was dead. Root cause: at `optimize:2`'s default
inlining, the tiny single-call-site helper's signature-narrowing
settling and the hazard-census rebuild raced in a way that left
`curParamIntCertain` empty for that probe (not a `src/` bug — confirmed
by re-running the IDENTICAL source with `sourceInline:false`, which
narrows and fires correctly). Documented so a future session doesn't
re-diagnose this as "the lever doesn't work" from a confounded probe.

**On the REAL `scripts/self.js` corpus: ZERO effect, confirmed twice
(temporary `JZ_DEBUG_HZALL` counters, same discipline as §17/§18, stripped
before commit).** `JZ_SELFHOST_OPT=0`: `keyedWrite.all` early=320 late=320,
`paramSaved=0`. Full production `scripts/build-dist.mjs`/`selfhost-
build.mjs` profile (O3, the actual `dist/jz.wasm` build): early=320
late=325, `paramSaved=0` — **no collapse, §17's own 319-ish baseline
essentially unchanged** (the +1 early / +5 late drift versus §17's "319"
is unrelated program-shape noise across sessions, not this lever — the
Object.assign-class fix already landed in §17 accounts for the baseline
shift, not this change).

**Root cause of the zero-effect result, traced to ground (not assumed)**:
sampled the first 20 `hz.all` misses at BOTH optimize levels — the SAME
~20 functions every time (`m51_util$walkPost`'s `idx`, `m56_ctx$
setFeature`'s `key`, `m49_compile$regtype`'s `idx`, …), all either (a) a
bare PARAM whose `p.type` stays `f64` and whose `paramReps.get(k).val` is
literally `null` — the sticky-TOP value `mergeParamFact` writes on
CROSS-CALL-SITE DISAGREEMENT (`src/param-reps.js`'s own documented
contract) — or `'string'` (a genuinely polymorphic param, correctly NOT
exempted), or (b) a body-local (not a param at all — outside this lever's
scope by design, a separate, still-open gap in `repOf`'s cursor alignment
per §17's own note). The PARAM cases are the direct, confirmed signature
of the exact same dynamic §17/§18 already diagnosed for the Map-receiver
side of this idiom: `observeSlot`/`poisonSlot`/`poisonCtor`/`walkPost`-
shaped helpers are called from HUNDREDS of sites across the self-hosted
compiler's own source (§17's own count), so the cross-call `val`/`wasm`
lattice's monotone meet (`mergeParamFact`: any two disagreeing sites →
sticky `null`, forever) collapses to TOP the moment ONE call site passes
an argument `exprType` can't prove integer — which, over hundreds of
sites, is effectively certain. **This generalizes §17/§18's finding past
the RECEIVER's kind (`arr` from `Map.get()`) to the KEY's int-certainty
too — both facts die to the identical "shared generic helper, one
dissenting call site poisons everyone" structural property of self.js's
own architecture**, not to any gap in this lever's wiring.

**Given the wall, the ladder's escalation steps were NOT run**: no
disjointness re-derivation attempted (§18's own logic was never a fit for
this lever — that was scoped to the RECEIVER kind, not the KEY; §21
already closed that whole avenue for `slotVT`'s consumer side). Per the
brief's own protocol ("if hz.all collapses: escalate; wall ⇒ bank and
stop") — it did not collapse, so this entry stops here after the full
regression ladder (below), matching §18/§19/§21's own precedent of
running the verification gates on a zero/near-zero-effect change to
confirm it's SAFE to keep even though it doesn't unblock the target.

**Disposition: KEPT, not reverted** (unlike §18's disjointness recovery,
which was reverted for being an entire unverified feature with zero
effect). This lever is a 16-line, sound, minimal extension of an EXISTING,
already-landed classification, using an EXISTING fact channel, verified
functional in isolation, fail-closed, zero measured regression anywhere —
it will fire for the general population of programs where an i32-narrowed
integer param (via the EXISTING, unrelated typed-array-fed / recursion-fed
/ bitwise-mutated narrowing routes) is ALSO used as a dynamic array/object
key, a real if narrow class this session did not attempt to characterize
further. Self.js's own dominant class simply isn't in that population,
for the structural reason above.

**Gates run, all green, zero regressions found:**
- Default battery `node test/index.js`: 3408/3400/2/6 (19550 assertions) —
  the SAME 2 pre-existing named failures as §17/§20's own baseline
  (interval-walk codec bounds check, typed RMW guard count), unchanged.
- Default `kernel-parity`: 3/3 (33 assertions), byte-identical O0/O2/O3,
  against a freshly, fully rebuilt plain `dist/jz.wasm`.
- Default `kernel-oracle`: 12/12 (451 assertions).
- `node test/watr.js`: 35/35 (107 assertions). `node test/pointers.js`:
  34/34 (62 assertions). `node test/slot-hazards.js`: 21/21 (59
  assertions) — none of its scenarios touch an i32-narrowed param key, as
  expected; unaffected.
- `JZ_CARRIER_BOX=1 kernel-parity` (against a freshly, fully rebuilt
  CARRIER-BUILT `dist/jz.wasm`, i.e. `JZ_CARRIER_BOX=1 node scripts/
  selfhost-build.mjs`): `dict` STILL diverges O0/O2/O3, byte-for-byte the
  SAME divergence shape as §17 (same sizes: 227398B/229709B/246043B) —
  expected, unchanged, confirms the lever's zero self.js effect rather
  than contradicting it.
- `JZ_CARRIER_BOX=1 JZ_TEST_TARGET=jz.wasm node test/index.js` (test:wasm
  to completion): still crashes identically — same `RangeError: Offset is
  outside the bounds of the DataView` in `interop.js`'s `mem.read`, same
  stack (`readArgBits → write → imports.env.print`), same trigger
  (`test/statements.js`'s "setTimeout: callback fires" first heap-string
  `console.log`) — the exact §16/§17 signature, unregressed.
  `JZ_CARRIER_BOX=1` flag-forced battery: 3381/21 (19107 assertions) —
  the SAME 21 pre-existing rows §17 established, unchanged.
  `JZ_CARRIER_BOX=1` watr: 35/35 (107). `JZ_CARRIER_BOX=1` pointers: 34/34
  (66 assertions, matches §17's own "default 62, CARRIER_BOX 66" shape).
  `JZ_CARRIER_BOX=1` kernel-oracle: 4/12 pass, 8 fail — every failing row
  individually named and matched against the ledger's own catalog (3×
  kernel-parity `dict` divergence, 3× kernel-oracle `dict`-vs-JS-oracle
  `actual:0 expected:3`, 1× ternary O0 BOOL∪NUMBER carrier-collapse
  (pre-existing, unrelated), 1× "PENDING-FIX generic-scalar-decl
  BOOL∪NUMBER carrier collapse" memory-out-of-bounds (pre-existing,
  named)) — zero unnamed/new failures.
  `JZ_CARRIER_BOX=1` fuzz: 4 independent 2000-program sweeps
  (`--seedStart=1,2001,4001,6001`, opt {0,1,2,3}, 20 inputs/program) —
  121883 inputs compared total, **0 divergences** across all four.
- **Default byte-identity**: `scripts/bench-size.mjs --json`'s 57-case
  corpus (mat4/biquad/watr/wordcount/… ) diffed byte-for-byte against a
  disposable `git worktree` at pre-session HEAD (`8d92ed4a`) — **IDENTICAL,
  every case** (this lever's precondition — an i32-narrowed param feeding
  a dynamic keyed-write — doesn't occur anywhere in this corpus either,
  consistent with the self.js finding that it's a narrow, if real,
  precondition). `npm run build` ×2: `dist/jz.js`, `dist/interop.js`,
  `dist/jz.wasm` SHA-256 identical both runs (reproducible).
- **The self-hosted `dist/jz.wasm` build's own bytes DO differ** from the
  pre-session baseline (confirmed, expected, explained — not a functional
  regression): `scripts/self.js` includes `program-facts.js` itself as
  part of the compiler's own source, so ANY text edit to it — even one
  whose new branch is provably dead for this exact corpus (`paramSaved=0`
  throughout) — changes the compiled kernel's bytes (new locals/branches
  shift schema ids and code layout). Kernel-parity's 3/3 byte-identical
  result against ARBITRARY other programs (sum/math/dict/arr/fold/mfold/…)
  is the correct check for functional equivalence, not a same-bytes
  requirement on the self-compiled kernel artifact itself — and it holds.

**Flip-readiness verdict: UNCHANGED, still NO.** The `hz.all` `keyedWrite`
class blocking the carrier flip (§17's original finding, confirmed
unbudgeable through §18/§19/§20/§21 and now this session) remains exactly
as banked — this lever closes a real but different, narrower gap (params
that DO achieve cross-call `val`/`wasm` consensus and ARE i32-narrowed)
that simply doesn't overlap with self.js's own dominant shape (shared
generic helpers whose cross-call consensus is structurally poisoned by
call-site volume, not by a missing lever). **A future flip-readiness
session's only remaining named angle from §17 is the OTHER lever**:
safely promoting `Map`/dict `.get()`'s value kind for `collectSlotWrite
Hazards` specifically (distinct from the general-purpose promotion
audit-#10 reverted) — §18 attempted and walled on a narrower version of
this (local-literal `new Map()` only, not the property-chain-bound
`ctx.schema.slotTypes`-shaped receivers that actually dominate); a full
re-attempt would need property-kind tracing (§19/§20's own machinery,
already landed) to first resolve the property-chain receiver to a sid,
THEN prove that sid's own Map-value-kind census — a materially larger,
multi-session composition, not a quick follow-up.

**Commits (local only, plain messages, no push):** `28e4b4ae` —
`src/compile/program-facts.js` only (the lever, `curParamIntCertain`).
This ledger entry + `.work/todo.md` status update commit separately.

## §23. product-lattice Slice 7 step 2 — §18's disjointness logic, FOURTH
landing, now fed by a genuine Set-valued censusKindsOf union (opt-in,
OQ1 Option-A) — WALL RECONFIRMED at the SAME §20/§21 layer, consumer
REVERTED (2026-08-09)

**Precondition (product-lattice Slice 7 step 1, landed, `f677092c`):** the
dict/map value-census producers (`analyze.js` dictValueTypeOf/mapValueTypeOf,
`program-facts.js` observeDictValue/observeMapValue/poisonDictValue/
poisonMapValue) retired first-wins-then-clash poison-to-null for genuine
UNION storage (a Set<VAL.\*>, unresolved writes union in the full
KIND_UNIVERSE/TOP instead of a null sentinel) — `.work/lattice-design.md`'s
thesis (existential facts compose by union, not meet). `dictValueKindOf`/
`mapValueKindOf` keep byte-identical exact-or-null answers via projection;
`censusKindsOf` (the Slice-1 opt-in projection) now reads the raw union, so
a genuinely heterogeneous dict/map answers a real multi-kind set instead of
null for the first time. This alone is justified by deletion + byte-identity
(58-case corpus 0 diffs, full battery 3408/3416, `JZ_DEBUG_INVARIANTS`
3408/3417 — same 2 pre-existing + 1 known audit-#12 flake, kernel-parity
33/33, build ×2 identical, fuzz 4000×2 clean) independent of step 2's outcome
below.

**Step 2 — the FOURTH re-derivation of §18's disjointness logic, this time
structurally opt-in per the COORDINATOR RULING on OQ1** (`.work/
lattice-design.md`: census-derived kind unions surface ONLY through
`censusKindsOf`, never a general kind fact; consumer added deliberately,
individually gated). `collectCensusExemptLocals(bodyRoot, kindOf)`
(`program-facts.js`, per-body, computed once per function — and once for
top-level `ast` — alongside `curSids`/`curParamVts`, mirroring their exact
lifecycle): for every LOCAL name written in a body (decl or plain `=`
reassignment, bare-name target only), unions the resolved kind of every
write site — a `X.get(key)`-shaped RHS resolves via `censusKindsOf(X)` (X's
own dict/map value union, alias-gated by `dictValueKindOf`/`mapValueKindOf`'s
existing `nameEscapes` check, reused as-is per §18's own soundness argument);
any other RHS resolves via `kindOf`. Any unresolvable write (including a
compound-assignment op this walk doesn't model) drops the name entirely —
fail closed, no partial answer ever stored. Shadow-safe: an arrow's own
bound names are excluded for the whole body while the walk still recurses
into the arrow (a write to an OUTER name from inside a closure is a real
write this census must see — NOT the same discipline as
`dictValueTypeOf`'s own single-name early-`return`, which is only safe
there because it tracks one name at a time). Wired into `keyedWrite` as a
THIRD branch (after the sid-resolved and exact-`vt`-exempt branches):
`vt == null && typeof obj === 'string'` consults
`curCensusExempt.get(obj)`, exempting iff the unioned set is non-empty AND
every member is in `KEYED_EXEMPT_VALS` (the same 6-kind allowlist the
existing exact-kind branch already requires — a strict SUBSET check, not
merely "excludes OBJECT," matching the existing branch's own conservatism).
Presence (`mayBeUndefined`) deliberately NOT consulted, per the OQ1
verdict's own analysis: `undefined` cannot alias a tracked OBJECT schema
slot, so a `.get()` miss contributes nothing this disjointness question
needs to exclude.

**Isolated verification (before the expensive measurement, matching
§18/§20's own discipline of confirming the mechanism works before running
it against the flagship target):** a direct, non-self-referential repro
(`const buckets = new Map(); seed = k => buckets.set(k, []); observeSlot =
(key, idx, v) => { let arr = buckets.get(key); arr[idx] = v }`) DOES flip —
`censusExempt.late` fires, `keyedWrite.late` drops to 0 for that function —
confirming the mechanism is live and correctly wired, not dead code. The
CANONICAL self-referential idiom this session's own seed and §18's both
name (`let arr = m.get(k); if (!arr) { arr = []; m.set(k, arr) }`) does
NOT flip under this session's implementation — Fix 2
(`collectMapSetReachingDefs`, §18/§20's syntactic-adjacency recovery for
the `.set()`-writes-back-its-own-`.get()`-result circularity) was
deliberately NOT re-implemented this session (see "not attempted" below);
under Slice 7 step 1's union producer, this specific idiom's poison-to-null
became poison-to-TOP (the bare-name RHS `arr` in `m.set(k, arr)` is still
unresolvable by `dictWriteVT` at the point `m`'s census sees it, so the
UNION swallows the full KIND_UNIVERSE instead of nulling — same practical
effect on this consumer's `every(k => KEYED_EXEMPT_VALS.has(k))` check: TOP
includes non-exempt kinds, so no exemption either way). Confirms Slice 7's
union swap is a strict precision GAIN over the old poison (§3.2 of the
lattice design), not a magic fix for a DIFFERENT, still-open circularity.

**Diagnostic (Gate 1, `JZ_DEBUG_HZALL`, matching §17/§18/§20's own
instrumentation exactly — temporary, module-scope counters, NOT
`globalThis` this time: `program-facts.js` is bundled into the self-hosted
compiler's own source, and jz's language subset does not support a bare
`globalThis` reference — the first attempt at this instrumentation broke
`scripts/selfhost-build.mjs` outright ("globalThis is not in scope"),
caught by running the self-host build as part of gating the instrumentation
itself, not assumed safe; fixed by using a plain module-scope object
instead — stripped after use, this correction is not carried forward),
real self.js compile (`JZ_SELFHOST_OPT=0 node scripts/selfhost-build.mjs`):
**NO COLLAPSE.** `{"keyedWrite.early":497,"keyedWrite.late":498,
"censusExempt.early":0,"censusExempt.late":0}` — zero census exemptions
fired anywhere in the real compile, at either generation. (The raw
`keyedWrite` counts, 497/498, are higher than §17-§20's own ~319-327
baseline — consistent with ordinary codebase growth over the sessions
between then and now, same "ordinary codebase drift, not a real change"
framing those sessions used for smaller deltas; not independently
re-derived this session since the exemption count — the actual gate — is
unambiguously zero regardless.)

**Root-caused, not merely observed — this is the SAME wall §20/§21 already
found and §21 confirmed unbudgeable, reconfirmed under the new union
census, not a new failure mode.** `censusKindsOf(X)` for the RECEIVER map
`X` still routes through `mapValueKindSet`'s HARD gate
(`valTypeOf(name) === VAL.MAP`, kind.js, UNCHANGED by Slice 7 step 1 — the
gate structure was deliberately preserved, only the SIZE semantics of what
lies behind it changed). For self.js's OWN dominant idiom — a
property-chain-bound local (`const slotTypes = ctx.schema.slotTypes`) —
`valTypeOf` resolves through `VT['.']` → `ctx.schema.slotVT`, and `slotVT`'s
existing, shared, multi-consumer hazard gate (`slotHazarded`, WITH
`hz.all`) blocks it — the exact circularity §20 diagnosed (chain resolution
needs `hz.all` false to prove the receiver a Map; `hz.all`'s own dominant
cause needs that proof to clear first) and §21 separately, independently
confirmed is NOT a narrowing bug to fix: `hz.all` is genuinely load-bearing
for `slotVT`'s callers (a real soundness boundary, `.work/lattice-design.md`
§3.3 also affirms this "does not dissolve, and must not, preserved
exactly"). No amount of PRECISION on the CONSUMER side of this gate (exact
kind vs. a real Set-valued union) reaches past a gate that is closed for an
entirely orthogonal, already-audited reason. Confirmed directly: the
bench-corpus check below shows the SAME zero-effect signature on the
project's OWN 58-case corpus, not just self.js — this consumer produced
**zero WAT byte changes anywhere**, default mode, across every case ×
O0/O2/O3 — the mechanism is real (the isolated repro above proves it fires
when nothing blocks it) but the precondition (a resolvable, non-`hz.all`-
gated Map receiver feeding an otherwise-unresolvable local) essentially
never occurs in either corpus.

**Decision: REVERT the consumer** (`program-facts.js`'s
`collectCensusExemptLocals` + its `keyedWrite` wiring + the `DBG_HZALL`
instrumentation), matching §18's and §20's own identical-shape precedent
exactly ("real per-compile cost... for zero measured benefit... no
independent corpus/benchmark demonstrating value" — §18's words, reused
verbatim because the situation is structurally identical a third time).
Reverted `program-facts.js` to the Slice 7 step 1 commit (`f677092c`) via
`git show f677092c:… >`, not `checkout` — confirmed empty diff after,
confirmed no other file touched by step 2 (`git diff --stat HEAD` clean
before the revert save-point). Step 1 (producer union storage) is UNTOUCHED
by this revert and stays landed — independently justified by
deletion+byte-identity alone, per this task's own standing instruction, not
contingent on step 2's outcome.

**What this closes, precisely, for a future session:** the disjointness
LOGIC (§18, now re-verified sound a fourth time under a genuinely
Set-valued opt-in census) is not the blocker and has not been since §20.
The blocker is, concretely and specifically: `slotHazarded`'s `hz.all` term
is shared by EVERY `slotVT`/`slotIntCertainAt`/`slotI32CertainAt`/
`slotTypedCtorAt` caller, landed and audited over many sessions (§9-§21),
and narrowing it — the ONE lever §20's own "Flip-readiness verdict"
already named as the concrete next step — has STILL not been attempted,
three sessions later (§20, this session). It needs its own dedicated
soundness review across every `slotHazarded` consumer (the SAME
`chainHazarded`-style argument this project has now used successfully
twice, extended to cover `slotIntCertain`/`slotI32Certain`'s materially
different, value-exact risk profile) before it can be pulled — a
materially larger, separately-scoped feature, not a quick follow-up to any
consumer-side census work. Slice 7's own remaining acceptance criteria
(the `JZ_CARRIER_BOX=1` kernel-parity `dict` clean / `test:wasm` /
flip-readiness battery) are correctly NOT run this session — the task's own
"IF it collapses" gate — running the expensive battery against a change
proven not to move the target would be exactly the "force it anyway" this
project's standing discipline exists to prevent (§18's own words, invoked
a third time).

**Not attempted this session** (named so a future session doesn't
re-derive the same scoping question from zero): `collectMapSetReachingDefs`
(§18/§20's Fix 2, the self-referential `.set()`-writes-back-`.get()`
syntactic-adjacency recovery) — skipped because the session's own isolated
verification (above) showed the DOMINANT self.js wall is the
property-aliased-receiver/`hz.all` gate, not the self-referential-write
circularity Fix 2 targets; adding Fix 2 without first clearing the `hz.all`
gate would add a second whole-program walk for a precondition that still
can't reach self.js's dominant class either way — the SAME "no forced fix,
no speculative complexity for zero measured benefit" reasoning that sank
the rest of this consumer, applied preemptively rather than after a second
failed measurement.

**Gates run:** isolated repro sanity (above) — mechanism verified live.
`JZ_DEBUG_HZALL` real self.js compile (`JZ_SELFHOST_OPT=0 node
scripts/selfhost-build.mjs`) — the task's own first gate, per §18/§20's own
"Gate 1 is the FIRST gate in the ordered list, and it is the one this
session's fix fails; running the later, far more expensive gates... would
itself be the force-it-anyway this discipline exists to prevent" — 0
exemptions, consumer reverted before any further gate. 58-case/174-compile
bench-corpus byte-identity (both BEFORE reverting, as an independent
zero-benefit confirmation, and AFTER reverting, as a revert-correctness
check): 0 diffs both times, and — notably — 0 diffs between the
WITH-consumer and WITHOUT-consumer trees themselves (the consumer changed
nothing observable anywhere in this corpus). Post-revert `npm run build`:
byte-identical to Slice 7 step 1's own recorded hashes (`dist/jz.js`
`b38a6105…`, `dist/jz.wasm` `4e6cebe6…`, `dist/interop.js` `ef42c9da…`) —
confirms the revert is bit-for-bit equivalent to step 1's already-gated
state, not merely textually clean. `test/slot-hazards.js` 22/22,
`test/dyn-keys.js` 57/57 post-revert sanity.

**Local: nothing new committed for step 2** — written, measured, and
reverted within this session, matching §18/§20's own "attempted, gated,
reverted, nothing landed" precedent exactly. This ledger entry + the
matching `.work/todo.md`/`.work/lattice-design.md` status updates commit
separately, plain messages, no push.

## §24. CONSERVATIVE PAIRING implemented — mechanism verified sound and
correct for its own target class (arithmetic-core BigInt-operand reads),
2/3 §15 WAT differentials CLOSED — but a NEW, deeper, scale-dependent wall
found in the full self-hosted kernel build (a module-scope BigInt-constant
construction gap, root-caused but not fixed) that keeps dict/test:wasm red
— banked, no flip (2026-08-09, `.work/context-sensitivity-survey.md`'s
COORDINATOR RULING: "the remaining sound direction is CONSERVATIVE
PAIRING")

**The change, exactly as landed (commit `83c7f9bc`).** Per the ruling's own
wording ("route the STATIC read through the registry-aware dynamic reader
… instead of the bare f64.load"), the FIRST implementation eagerly unboxed
inside `emitSchemaSlotRead` itself (module/core.js) — a per-slot
`bigintPossible` flag threaded through the same 4 read call sites §16
threaded `bigintProven` through, dispatching a runtime `$__ptr_type` tag
check + conditional `unboxBigInt`/raw-reinterpret at the READ SITE. **Found
wrong by direct differential, before landing**: a plain `export let f = ()
=> obj.bigField` (no arithmetic at all) regressed from a CORRECT BigInt
result (baseline) to `NaN` (eager-unbox version) — because `emitSchemaSlotRead`'s
return value is consumed by TWO structurally different classes of caller,
and only ONE of them wants a pre-decoded payload:
- **Arithmetic-core** (`readI64`/`bigIntOperand`/`bigIntUnary`, src/ir.js
  + src/compile/emit.js): confidently treats the operand as BIGINT (via
  the SURROUNDING EXPRESSION's own classification — `bigIntDomain`'s
  'skip'-then-old-OR-gate fallback, emit.js, when the OTHER operand is a
  proven BigInt literal), and calls `asI64` on whatever `emitSchemaSlotRead`
  returned WITHOUT re-checking its tag. This is the ACTUAL §15 corruption
  vector — confirmed by reproducing it exactly (see below).
- **Generic/opaque consumers** (the WASM export boundary's host-side
  `mem.read`-style decode in interop.js, `$__eq`/`$__typeof`/`$__dyn_get`'s
  own runtime tag dispatch): these ALREADY correctly handle a
  still-boxed, tag-preserving f64 value — that is their whole contract.
  Eagerly unboxing at the read site hands them an ALREADY-DECODED payload
  with NO tag left to check, which a boundary/typeof-style consumer then
  misreads as if it were still an opaque, possibly-boxed value.
  `emitSchemaSlotRead` itself has NO visibility into which of these two
  classes will consume its result — that information lives one layer up,
  at the CONSUMING expression, not at the read.

**Fix, moved one layer up.** `emitSchemaSlotRead` (module/core.js) is
**UNCHANGED** from HEAD — its possible∧unproven case keeps the plain bare
load, identical to the bigint-impossible case, so every opaque/generic
consumer keeps working exactly as before (the box stays box-shaped). The
new dispatch lives at `readI64` (src/ir.js) — the SAME chokepoint
`isCurrentlyBoxedBigint`/`isTernaryBoxedBigint` already gate their own
unconditional unbox behind, per its own doc comment "the arithmetic core's
~10 VAL.BIGINT-gated `asI64(emit(x))` call sites route through" — gaining
a THIRD predicate, `isSchemaSlotBigintPossible(node)`: true iff `node` is
a bare-name `.prop` AST shape (`['.', varName, prop]`, the same "structural
fallback gets false" scope §16 already established for a chain receiver)
whose `ctx.schema.slotBigintBoxedAt` is true (write-side, fail-open,
unaffected by `hz.all`) and `slotBigintProvenAt` is NOT true. When it
fires, `readI64` calls the new `maybeUnboxBigInt(emitted)` instead of the
naive `asI64(emitted)` — a runtime `if ($__ptr_type(emitted)==PTR.BIGINT)
unboxBigInt(emitted) else i64.reinterpret_f64(emitted)`, reusing
`unboxBigInt`'s own `ptrOffsetIR` deref and `$__ptr_type` (the exact
primitive `$__dyn_get`'s own dispatch, and every OTHER registry-aware
reader's PTR.BIGINT arm, is built from — Slice 3) — no third, bespoke
mechanism. Checked LAST in `readI64`, after the two static, zero-cost
predicates, so a name that's ALSO a boxed param never pays the extra tag
check.

**Verified CORRECT and SOUND, independently, multiple ways, before
touching the real kernel:**
1. Isolated synthetic repro (`export const REC = {n: 0x7FF8...n, m:5};
   function corrupt(o,k,v){o[k]=v}; export let combined = () =>
   (REC.n | 3n).toString(16)`, `corrupt` tripping `hz.all` exactly per
   §21's own counter-example shape): pre-fix reproduces the EXACT §15
   corruption signature (`nan:0x7FFA8...`-shaped, box's own pointer bits
   leaking); post-fix computes the mathematically correct
   `7ff8000000000003`. Confirmed via a LIVE A/B against the unfixed
   version (a temporary env-gated bypass, removed before commit) — not
   inferred from code reading alone.
2. The REAL `layout.js` fixture (`test/fixtures/carrier-conservative-
   pairing-repro.js`, new — same shape as §15/§16's own
   `carrier-layout-repro.js` PLUS a `corrupt` hazard trigger): all 4 of
   §15/§16's own pinned assertions (`LAYOUT.NAN_PREFIX_BITS`,
   `atomNanHex(1)`/`(2)`, `i64Hex(ptrBits(...))`) pass CORRECTLY even
   though `slotBigintProvenAt('LAYOUT','NAN_PREFIX_BITS')` is FALSE here
   (hazarded) — at O0/O2/O3, WITH and WITHOUT `snapshotInit` (the exact
   flag `scripts/build-dist.mjs` uses). New permanent pin landed in
   `test/pointers.js` (`JZ_CARRIER_BOX=1`-gated, true no-op under
   default — 35/35 both modes, 62/70 assertions default/flagged,
   matching §15/§16's own established pattern).
3. Confirmed the mechanism reaches the REAL self-hosted compile: a
   temporary probe (`JZ_DBG_CENSUS`, stripped before commit) against the
   real `scripts/self.js` graph confirms `LAYOUT.NAN_PREFIX_BITS`'s own
   read site fires `isSchemaSlotBigintPossible` with `boxed=true,
   proven=false` (3 static occurrences), and direct WAT inspection of the
   NATIVELY-compiled kernel's own `atomNanHex` function body (both O0 and
   O3) shows the `maybeUnboxBigInt` `if`/`$__ptr_type` shape correctly,
   structurally present — the fix's OWN generated code is not in
   question; see the wall below for what still fails.

**Gate 1 (default, CARRIER_BOX off) — CONFIRMED byte-identical, twice,
in two independently isolated trees (the main tree AND a disposable `git
worktree add` at this session's own commit, immune to a concurrent
session's own activity in the shared main tree — see the concurrency note
below):** 58-case `bench-size.mjs --json` sweep — 0 diffs vs a disposable
worktree at pre-session HEAD, both runs. Default `kernel-parity`: 3/3 (33
assertions), byte-identical, against a freshly, fully rebuilt plain
`dist/jz.wasm` (confirmed via the build log's own "wrote dist/jz.wasm"
line each time). Default battery `node test/index.js`: 3422/3414/2/6 (the
SAME 2 pre-existing rows every prior session in this chain has named —
interval-walk codec bounds check, typed RMW guard count — unchanged).
`npm run build` ×2: `dist/jz.js`/`dist/interop.js`/`dist/jz.wasm` SHA-256
identical both runs, both trees.

**Gate 2 (`JZ_CARRIER_BOX=1`) — MIXED: the mechanism gate passes, the
kernel-build gate does not.**

- **The 3 named WAT differentials (native-vs-fresh-carrier-kernel, §15's
  own repros): 2/3 CLOSED.** `() => "abcdefghi"` and `() => () => 1` are
  now byte-identical native-vs-kernel (`nan:0x7FFA000000000007` /
  `nan:0x7FFD000000000000`, matching §15's own recorded native values
  exactly). `() => undefined` STILL diverges — but to a DIFFERENT wrong
  value than §15 originally found (`nan:0x6E69666E494E614E`, decoding as
  the ASCII bytes of the static string-table's own opening literal
  ("NaNInfinity…") — a "read outside the box entirely" pattern, not the
  original "read the box's own pointer bits" pattern §15 named). This is
  a NEW manifestation, traced (not merely observed) to `UNDEF_NAN`'s own
  construction: `src/ir.js`'s `export const UNDEF_NAN = atomNanHex(2)` is
  a MODULE-SCOPE CONST — when self-hosted, its initializer compiles to a
  real, non-inlined `call $atomNanHex (i32.const 2)` inside the KERNEL's
  own `$__start` (confirmed by direct WAT inspection: `global.set
  $m78_ir$UNDEF_NAN (call $m61_layout$atomNanHex (i32.const 2))`, module
  init order ordinal 183 of 487, with `$m61_layout$LAYOUT` ALREADY
  initialized at ordinal 95 — ruled out a naive "wrong init order"
  hypothesis directly, not assumed). `build-dist.mjs`'s own
  `snapshotInit: true` then runs THIS `$__start` once, for real, via
  actual WebAssembly execution, and bakes the (wrong) result into the
  shipped artifact's global initializers — so the corrupted value is
  computed ONCE, at build time, then propagates into every program the
  kernel later compiles (matching and confirming §16's own "generalizes
  the severity well past BigInt-heavy programs" prediction).
  **Deliberately NOT reproducible in any isolated test constructed this
  session** — including a FAITHFUL recreation (the real `layout.js`, a
  real `hz.all` trigger, the EXACT `{level:3, watrGuard:false,
  snapshotInit:true}` build settings `build-dist.mjs` itself uses):
  `atomNanHex(1)`/`(2)` decode CORRECTLY there, every optimize level,
  with and without snapshotting. The gap is specific to the SCALE/
  complexity of the real ~370K-line self-hosted source, not a flaw in
  this session's own mechanism (item 3 above already confirms the
  generated dispatch code is structurally sound) — the same
  "materially larger, separately-scoped, not reproducible in a minimal
  repro" class this whole chain (§17-§23) has repeatedly, correctly
  banked rather than forced.
- **Kernel-parity `dict`, O0/O2/O3: STILL DIVERGES**, at the EXACT same
  byte sizes §17/§22 already recorded (native 227398/229709/246043 vs
  kernel 227398/229235/245423) — reproduced in TWO independent, isolated
  trees. Traced to the SAME `UNDEF_NAN` root cause above (`dict`'s own
  hash/absent-key machinery uses `UNDEF_NAN` pervasively as its sentinel;
  §16's own generalization argument, now doubly confirmed).
- **`test:wasm` to completion: DOES NOT COMPLETE — a NEW, WORSE failure
  mode than baseline, not merely "the same known crash."** Baseline
  (disposable worktree at this session's own pre-fix commit): crashes
  FAST and CLEANLY — the exact, already-documented `RangeError: Offset
  is outside the bounds of the DataView` at `setTimeout: callback fires`
  (test/statements.js), an UNCAUGHT exception ending the whole process,
  reproduced identically to §15-§22's own recorded signature. The FIXED
  tree: does NOT crash there — the arithmetic-core class this session
  fixes no longer misfires at that exact point — but progresses further
  into the suite (through `test/inference.js`) accumulating individual,
  CAUGHT `RangeError: Offset is outside the bounds of the DataView`
  test failures (148 counted before the run was terminated — a materially
  LARGER failure surface than baseline's single crash point, consistent
  with `UNDEF_NAN` being foundational and no longer masked by the earlier
  crash), then **HANGS** — 28+ minutes of sustained ~100% CPU with ZERO
  further stdout progress past "flow-fact: for-init decl reassigned in
  the step carries no stale fact" (test/inference.js), requiring manual
  `kill -9`. Not root-caused further this session (plausible: a loop
  whose termination test compares against the now-corrupted `UNDEF_NAN`
  bit pattern never resolves) — named precisely so a future session
  doesn't re-discover "test:wasm hangs" from zero. This is the SAME
  `UNDEF_NAN` root cause reaching further before failing, not a
  second, independent defect — but the OBSERVABLE OUTCOME (hang vs.
  clean crash) is strictly worse for this specific gate, reported
  honestly rather than downplayed.
- **Flag-forced NATIVE battery, watr, kernel-oracle — ALL CLEAN, ZERO new
  regressions** (none of these touch the KERNEL ARTIFACT's own
  correctness, only NATIVE `JZ_CARRIER_BOX=1` compiles + a
  freshly-rebuilt-but-otherwise-unexercised kernel for parity/oracle
  comparison): `node test/index.js` under the flag: 3422/3395/21/6 — the
  SAME 21 pre-existing rows §17 first established (the `dyn-keys.js`
  Slice 5/6/7 family + the kernel-parity/kernel-oracle `dict` rows),
  unchanged, confirmed against a disposable worktree at this session's
  pre-fix commit. `test/watr.js`: 35/35 (107 assertions). `test/kernel-
  oracle.js`: 5/13 (113 assertions) — the SAME 8 pre-existing rows §22
  established (3× kernel-parity `dict`, the `dict`-vs-oracle rows, the
  ternary/generic-scalar-decl PENDING-FIX rows, the console.log
  KNOWN-FAIL) — reproduced identically in TWO independent trees.
- **Fuzz, `JZ_CARRIER_BOX=1`: CLEAN.** 4 independent 2000-program sweeps
  (`--seedStart=1,2001,4001,6001`, opt {0,1,2,3}, 20 inputs/program) —
  121883 inputs compared total (30173+30672+30572+30466), **0
  divergences** — matches §22's own exact historical total.

**Concurrency note.** A separate, concurrent session was independently
active in this same shared working tree during this session (3 unrelated
commits landed mid-session, `2e7db138`/`533aeae8`/`1ffea84f`, touching
`src/reps.js` and ledger files — confirmed non-overlapping with this
session's own files by direct diff) and at one point rebuilt the shared
`dist/jz.wasm` to a DIFFERENT (non-carrier) artifact mid-run, silently
invalidating one in-flight `test:wasm` gate run before it was noticed
(caught by an unexplained artifact-size mismatch, not assumed safe — the
same "verify, don't trust" discipline §15 established for stale builds,
extended here to a stale-because-CONCURRENTLY-OVERWRITTEN build). Every
gate number reported above was re-verified (or, for the ones landed
before the interference began, ALREADY isolated) in a disposable `git
worktree add` at this session's own commit, immune to further shared-tree
activity — the numbers in this entry are the isolated-tree numbers, not
the contaminated run's.

**Possible∧unproven slot census on `scripts/self.js`** (temporary
`JZ_DBG_CENSUS` probe, stripped before commit, real self.js compile at
O3): **40 distinct static `(receiver.prop)` read sites** program-wide
fire `isSchemaSlotBigintPossible`. Breakdown: 9 are `LAYOUT`'s own 10
constant fields minus one already-proven elsewhere; 7 are the `VAL` enum
object's members (`ARRAY`/`CLOSURE`/`DATE`/`HASH`/`MAP`/`OBJECT`/`SET`/
`STRING`); the remaining 24 are compiler-INTERNAL IR/AST-representation
fields on various mangled local bindings (`.local`/`.pre`/`.sign`/`.id`/
`.name`/`.length`/`.get`/`.is`/`.ovr`/`.boundConst`) — consistent with a
self-hosted compiler whose own generic IR/plan objects sometimes carry a
BigInt LITERAL VALUE copied straight from the target program being
compiled (the expected, unsurprising shape for this class, not
independently investigated further).

**Size/perf.** Carrier-kernel (`JZ_CARRIER_BOX=1` `dist/jz.wasm`) size
delta: baseline 16467.7 KB → this session's fix 16519.5 KB, **+51.8 KB
(+0.31%)** — measured via two independently, freshly rebuilt kernels (a
disposable worktree at the pre-fix commit vs. this session's own isolated
worktree), both confirmed via the build log's own "wrote dist/jz.wasm"
line. Default (`CARRIER_BOX` off) kernel: **byte-identical**, SHA-256
confirmed (not just size) — the new code path is unconditionally
`CARRIER_BOX`-gated at its own first predicate check
(`isSchemaSlotBigintPossible`'s `CARRIER_BOX &&` short-circuit), so the
default kernel's own compiled bytes cannot differ, and don't.
Self-host-perf (`scripts/bench-selfhost.mjs`, relative same-session): NOT
separately measured — the flip-readiness gate already fails upstream of
performance (dict + test:wasm, both still red), and running an expensive
timing benchmark for a change that cannot flip regardless would be
exactly the "run the next gate past a known wall" this chain's own
discipline (§18/§20/§22) exists to avoid; reasoned, not measured, to be
noise-level given the dispatch fires on only 40 rare, cold, one-time-init
call sites program-wide, never on a hot per-iteration path.

**Flip-readiness verdict: NO — unchanged, but the dependency chain moved.**
`CARRIER_BOX` stays `JZ_CARRIER_BOX==='1'`-gated, OFF by default. This
session's own mandate ("if green: flip-readiness probe has no known
blocker") is NOT met — dict and test:wasm are both still red. What
CLOSES, concretely: the arithmetic-core half of the §15/§16 read-side gap
(possible∧unproven schema-slot BigInt operands feeding `readI64`-routed
arithmetic) is now sound and independently verified, matching the
coordinator's own ruling exactly, and is SAFE to keep regardless of the
flip's own eventual outcome (zero default-build risk, zero native-battery
regression, 2/3 differentials genuinely fixed). What does NOT close, and
is the concrete next lever for a future flip-readiness session: `UNDEF_NAN`
(and by the same construction shape, `NULL_NAN`/`FALSE_NAN`/`TRUE_NAN`)
is a MODULE-SCOPE CONST whose initializer is a real, non-inlined function
call reaching a possible∧unproven schema field — this session confirmed
the GENERATED CODE for that call is structurally correct in isolation but
STILL produces a wrong value once baked through the REAL kernel's own
`$__start`/`snapshotInit` execution at real-compiler scale; the next
session needs to root-cause THAT gap specifically (start by comparing the
snapshot-captured global VALUE against a fresh, non-snapshotted kernel's
own `$__start`-executed value for the SAME build — `snapshotInit:false`
vs `true` on the REAL `scripts/self.js` graph, not an isolated repro,
since no isolated repro reproduces it) before dict/test:wasm can go
green.

**Local commits:** `83c7f9bc` — `module/core.js` (a documentation-only
note re-verifying `emitSchemaSlotGuarded`'s exclusion under the FINAL,
readI64-scoped design), `src/ir.js` (`maybeUnboxBigInt`,
`isSchemaSlotBigintPossible`, `readI64`'s new branch — the actual fix),
`test/pointers.js` + `test/fixtures/carrier-conservative-pairing-repro.js`
(the pin). This ledger entry + `.work/todo.md`'s matching status update
commit separately, plain messages, no push.

## §25. AUDIT-#17's unification hypothesis vs this §24 UNDEF_NAN gap —
TESTED, ANSWERED NO (2026-08-09, `.work/todo.md`'s own matching entry has
the full WAT-diff-stage evidence; this is the carrier-side pointer)

A later session tested the coordinator's hypothesis that AUDIT-#17's
module-scope nested-object-literal store-loop miscompile (`.work/todo.md`,
`8b8bddca`) and THIS §24 entry's `UNDEF_NAN` module-scope BigInt-const-
initializer gap were ONE mechanism (both "module-scope decl-init,
kernel/self-host-only, not reproducible in an isolated repro"). **Decisive
split, not a unification**: AUDIT-#17 reproduces on a freshly rebuilt,
byte-size-verified **DEFAULT** (`JZ_CARRIER_BOX` unset) `dist/jz.wasm` —
16467.3 kB, the exact size this doc's own §17/§22 entries record as the
default baseline, distinct from this §24 entry's own recorded +51.8 KB
CARRIER_BOX build size. Since `isSchemaSlotBigintPossible`'s entire
dispatch (the ONLY thing that can reach `UNDEF_NAN`'s corrupted
construction path) is `CARRIER_BOX &&`-gated and compiles to NOTHING in
the default build (this §24 entry's own SHA-256-confirmed byte-identity
claim), a bug that fires with that machinery physically absent from the
binary cannot be the same bug as one that requires it. **This §24 gap
stays exactly where this entry left it** — still un-root-caused past
"traced to `UNDEF_NAN`'s construction, not reproducible in isolation,"
still the concrete next lever for a CARRIER_BOX flip. AUDIT-#17 is a
separate, ALSO-still-open hunt (`.work/todo.md`) — do not spend a future
CARRIER_BOX session's budget trying to close both at once; they need
independent root-causing. Full WAT-diff evidence (3 ruled-out closure/
recursion mechanism hypotheses, the exact split test) lives in
`.work/todo.md`'s own entry for this session, not duplicated here.

## §26. AUDIT-#17 (`6490bb68`, staticClosureEnv unsound under re-entrant
enclosing-function calls) re-tested against §24's own CARRIER_BOX wall —
CONFIRMED UNRELATED, byte-for-byte, not merely argued (2026-08-09)

§25 argued the split structurally (CARRIER_BOX-gated dispatch compiles to
nothing in the default build AUDIT-#17 touches). This entry runs §24's own
repros directly against a kernel built at `6490bb68` (AUDIT-#17 landed) to
confirm empirically, not just by absence-of-mechanism argument.

**Default (`CARRIER_BOX` off) kernel, freshly rebuilt at `6490bb68`,
verified via the build log's own "wrote dist/jz.wasm" line (16872648
bytes):** `kernel-parity` 3/3 (33 assertions) byte-identical O0/O2/O3
including `dict` (never diverges off-flag — the CARRIER_BOX-only
mechanism). `kernel-oracle` 13/13 (469 assertions) — the `captured-then-
read` PENDING-FIX row (§ below) and the audit-#16 FeaturePlan KNOWN-FAIL
row both still assert their exact WRONG values with tripwires intact,
unchanged. Full default battery `node test/index.js`: 3424/3416/2/6 — the
same 2 pre-existing failures (interval-walk codec bounds, typed RMW guard
count) the fix commit's own gates already named, zero new regressions.

**Fresh `JZ_CARRIER_BOX=1` kernel, built in an isolated `git worktree add`
at `6490bb68` (immune to the shared tree), verified via the same "wrote
dist/jz.wasm" line (16926082 bytes / 16529.4 kB — +52.2 KB over this
session's own default-build baseline, consistent with §24's own recorded
+51.8 KB):**
- **The 3 WAT differentials, O0, native-vs-this-fresh-kernel:** `() =>
  "abcdefghi"` and `() => () => 1` stay byte-identical (still CLOSED, as
  §24 landed — unaffected either way). `() => undefined` **STILL
  diverges, to the EXACT SAME corrupted value §24 recorded**:
  `nan:0x6E69666E494E614E` (the ASCII "NaNInfinity…" static-string-table
  bytes) vs native's `nan:0x7FF8000200000000` — byte-for-byte identical to
  §24's own finding, not a new manifestation.
- **`kernel-parity` `dict`, O0/O2/O3: STILL diverges, at the EXACT SAME
  byte sizes** §17/§22/§24 already recorded — native 227398/229709/246043
  vs kernel 227398/229235/245423, reproduced exactly.
- **Flag-forced `kernel-oracle`: 5/13 (113 assertions)** — the SAME 8 rows
  §24 recorded fail identically (3× `dict` parity, the `dict`-vs-oracle
  row, ternary/`captured-then-read` PENDING-FIX, the console.log
  KNOWN-FAIL) — byte-identical reproduction, not a changed failure set.
- **Flag-forced `test/pointers.js`: 35/35 (70 assertions)**, matching §24
  exactly — the native CARRIER_BOX mechanism itself (unrelated to the
  kernel-build wall) stays sound.
- **`JZ_CARRIER_BOX=1 test:wasm`: STILL HANGS, at the SAME point.**
  Accumulated 145 individual CAUGHT `RangeError: Offset is outside the
  bounds of the DataView` failures (§24: 148 — same order, minor drift
  from unrelated intervening commits, not a material difference), then
  stalled — sustained 100% CPU, zero further stdout progress — at the
  IDENTICAL stopping point §24 named verbatim: "flow-fact: for-init decl
  reassigned in the step carries no stale fact" (`test/inference.js`).
  Confirmed genuinely stalled (not merely slow) by direct observation:
  static log byte-count and static test name across multiple checks
  spanning several minutes of continuous 100% CPU, then killed (`kill -9`)
  — the identical hang signature, not re-run to §24's own full 28-minute
  confirmation since the match (same test, same line, same failure-count
  order, sustained zero-growth stall) was already unambiguous.

**Verdict: AUDIT-#17's fix does not touch this wall in any way — every
number §24 recorded reproduces exactly against the AUDIT-#17-fixed
kernel.** This is the direct empirical confirmation of §25's own
structural argument (CARRIER_BOX-gated code is physically absent from the
default build AUDIT-#17's bug class lives in), not a re-derivation of it.
No pins flip. §24/§25's own "what a fix session needs" (root-cause
`UNDEF_NAN`'s module-scope BigInt-const-initializer corruption at real
self-hosted-kernel scale — comparing `snapshotInit:false` vs `true` on the
REAL `scripts/self.js` graph) stays exactly where §24 left it; this entry
adds no new lead toward it.

**Gates this session:** default `kernel-parity` (3/3), default
`kernel-oracle` (13/13, 469 assertions), default `node test/index.js`
(3424/3416/2/6), flagged `test/pointers.js` (35/35, 70), flagged
`kernel-parity` (0/3, the known `dict` divergence), flagged `kernel-
oracle` (5/13, 113), flagged `test:wasm` (hangs, reconfirmed). All flagged
gates run in an isolated `git worktree add` at `6490bb68`, never touching
the shared tree's own default `dist/jz.wasm`. `.work/todo.md`'s own
matching entry has the full cross-wall summary (kernel-oracle
`captured-then-read`, the region-arena plausibility read, the FeaturePlan
pin) — not duplicated here.

## §26a — coordinator decode note (2026-08-10)
§26's re-tested `() => undefined` corruption bits 0x6E69666E494E614E decode
as ASCII "nifnINaN" little-endian = the byte run "NaNInfin" — i.e. the
FORMATTER STRING TABLE's "NaN"/"Infinity" literal bytes are landing in the
emitted constant. The §24 UNDEF_NAN module-scope const-initializer is not
computing a wrong NUMBER — it is reading from a STRING-data region (a
static-data-segment/string-pool offset confusion under CARRIER_BOX kernel
build). Next carrier session: find where UNDEF_NAN's initializer expression
(layout.js atom construction) could resolve to a string-pool address —
likely a static-data-segment layout collision or an offset read from the
wrong segment table when the carrier build shifts segment contents.

## §27. Decode independently reconfirmed; §26a's OWN hypothesis (data-segment/
string-pool offset collision) TESTED AND REFUTED by direct byte-level
evidence; root narrowed to a NEW, sharper, ORDER-DEPENDENT shape — BANKED
at a deeper wall, no fix attempted (2026-08-10, isolated `git worktree`,
never touched the shared tree's `dist/jz.wasm`)

**Method note**: everything below was produced against a FRESH
`JZ_CARRIER_BOX=1` kernel built in a disposable `git worktree add --detach`
at this session's own HEAD (`b80641d3`) — `16926082` bytes, matching §26's
own recorded size exactly (confirmed via the build log's "wrote
dist/jz.wasm" line). The shared tree's own `dist/jz.wasm` (default,
16872648 bytes) was read but never rebuilt or overwritten.

**1. Decode independently reconfirmed.** Compiled `export let f = () =>
undefined` through the fresh carrier kernel at O0 (`compileWat`, the same
ABI `test/kernel-target.js` uses): `(f64.const nan:0x6E69666E494E614E)`,
byte-identical to §24/§26/§26a. Decoding the 8 bytes little-endian gives
ASCII `NaNInfin` — confirmed programmatically (not by inspection), matching
§26a's own decode exactly.

**2. §26a's OWN hypothesis — "static-data-segment/string-pool offset
collision… when the carrier build shifts segment contents" — TESTED,
REFUTED.** Wrote a minimal WASM binary-format parser (no existing tool
needed) and dumped every data segment (offset + byte length) from BOTH the
fresh carrier kernel and the shared tree's existing default kernel
(16872648 bytes, a valid recent default build). Both modules carry
**1887 data segments** (segment 0 = the `snapshotInit`-baked heap image at
memory offset 0; segments 1–1886 = one per compile-time static slot,
`appendStaticSlots`' normal per-literal emission — present, and IDENTICALLY
laid out, in every self-hosted build, not a CARRIER_BOX artifact). Diffing
the full (offset, byteLength) list between the two kernels: **1886 of 1887
segments are byte-for-byte identical** (same memory offset, same length,
in both builds). The ONE difference is segment 0's own total length
(default 1455480 vs carrier 1456424, +944 bytes — the carrier kernel's
`$__start` simply allocates 944 more bytes of live heap before finishing,
unsurprising given carrier boxing adds runtime structures). None of the
1886 small segments overlaps the +944-byte tail, and none of them sits
anywhere near the address this bug actually reads (item 3, below). **The
segment-layout/offset-collision hypothesis is dead**: nothing about WASM
data-segment packing shifts between these two builds in a way that could
explain the corruption.

**3. The REAL mechanism, nailed byte-exact: this is a literal `i64.load`
from memory address 0 — not a segment-offset shift, not a pointer-tag
misread.** Compiled the kernel a second time with `wat: true` (same
`{level:3, watrGuard:false, snapshotInit:true}` settings, post-snapshot
so globals/symbol names survive) to get readable WAT — 357 MB, `grep`ped
directly for `UNDEF_NAN`. Found the BAKED global:
```
(global $m78_ir$UNDEF_NAN (mut f64) (f64.const nan:0x7FFA0002000F4FC8))
```
Decoded against layout.js's own NaN-box fields (`TAG_SHIFT=47`,
`AUX_SHIFT=32`): tag=4 (`PTR.STRING`), aux=2 (`STR_HCACHE_BIT` — a
plain-heap string with a lazy `[hash u32][len u32][bytes]` header, per
layout.js's own doc comment), offset=`0xF4FC8` (1003464). **This global,
and its box, are completely sound** — a well-formed, correctly-tagged
pointer to a real, correctly-headed heap string (`hash=0` uncomputed,
`len=18`, matching an 18-char string exactly). Dumping the actual heap
bytes at that address (from the snapshot-baked data segment, at
`segment0FileStart + 1003464`): the string's CONTENT is
`"0x6E69666E494E614E"` — i.e. the box, the pointer, the heap allocation,
and the header are ALL correct; only the 18 characters actually written
into that string are wrong. **This is therefore conclusively a
BUILD-TIME BAKE bug** (the wrong content was already computed and stored
during the kernel's own real `$__start` execution, which `snapshotInit`
faithfully captured), not a read-time/offset bug reached later when the
kernel compiles a target program — the target-compile side (`() =>
undefined`) is just reading this already-wrong global correctly.

Then, the decisive trace: dumped the kernel's own memory bytes at address
**0** (the very first bytes of its own data segment). They read
`4e 61 4e 49 6e 66 69 6e 69 74 79 2d 49 6e 66 69 6e 69 74 79 74 72 75 65 …`
— ASCII `"NaNInfinity-Infinitytrue…"`, the formatter's own static
string-table literal, confirmed to sit at memory address 0 (the start of
linear memory) in this build. Interpreting the first 8 bytes at address 0
as a little-endian `i64.load` (standard WASM load semantics) gives
**exactly `0x6E69666E494E614E`** — bit-for-bit identical to the corrupted
`UNDEF_NAN` value, not a coincidental substring match. **The mechanism is:
some read that should compute the address of `LAYOUT.NAN_PREFIX_BITS`'s
own schema slot instead computes address 0** (a null/uninitialized/default
address that happens to be where this build places its formatter string
table), and an `i64.load` from there reads that table's opening bytes
straight into what becomes `UNDEF_NAN`'s string content.

**4. Bake-vs-read discriminator, answered precisely: the schema-slot READ
itself resolves to the wrong ADDRESS at build time; the box/pointer/heap
machinery downstream of that read is entirely sound.** Traced the call
chain: `UNDEF_NAN = atomNanHex(2)` → `atomNanHex(id) = i64Hex(LAYOUT.
NAN_PREFIX_BITS | (BigInt(id) << AUX_SHIFT))` (layout.js). `LAYOUT.
NAN_PREFIX_BITS` is a `.prop` read on a module-scope object literal — the
EXACT shape §24's own `isSchemaSlotBigintPossible` predicate targets (its
own doc comment names this exact field as the original §15 repro), and
§24's own `JZ_DBG_CENSUS` probe already confirmed this read site fires
`isSchemaSlotBigintPossible` with `boxed=true, proven=false`. That routes
through `readI64`'s CARRIER_BOX-only branch → `maybeUnboxBigInt(emitted)`
(src/ir.js). Read `maybeUnboxBigInt` and `emitSchemaSlotRead`
(module/core.js) directly: `maybeUnboxBigInt` only tags-checks and
conditionally derefs the VALUE `emitted` already computed — it cannot by
itself manufacture a wrong ADDRESS, and for `LAYOUT.NAN_PREFIX_BITS`'s
NORMAL (correct) case its `else` branch (`i64.reinterpret_f64`) is exactly
right (the field is stored raw/unboxed — `0x7FF8000000000000` reinterpreted
IS the payload, tag reads as `PTR.ATOM` not `PTR.BIGINT`, correctly
skipping the `unboxBigInt` arm). So the wrong address has to originate in
`emitted` itself — `emitSchemaSlotRead`'s own `ptrOffsetIR(base, VAL.
OBJECT)` + slot-index arithmetic — which is **UNCHANGED, identical text,
in both builds** (§24 confirmed this explicitly). For the computed address
to differ between builds while the codegen function is byte-identical, the
INPUT to that function (the base pointer read for `LAYOUT`, or the slot
index assigned to `NAN_PREFIX_BITS`) has to differ — i.e. this is a
build-time-baked VALUE/INDEX mismatch feeding an otherwise-correct,
unchanged read expression, not a segment/pointer-tag decode bug.

**5. Sharpest new finding — the corruption is NOT uniform across the 4
identically-shaped `atomNanHex` calls, which rules out a simple "always
wrong" schema/offset mismatch and points at something ORDER-DEPENDENT.**
`NULL_NAN`/`UNDEF_NAN`/`FALSE_NAN`/`TRUE_NAN` are ALL `atomNanHex(1/2/4/5)`
— same function, same `LAYOUT.NAN_PREFIX_BITS` read, back-to-back module
inits. Decoded and dumped the heap content each of the 4 baked globals
points to:
```
NULL_NAN   (id=1)  offset=0xF4DF8  →  "0x6E69666E494E614E"   WRONG
UNDEF_NAN  (id=2)  offset=0xF4FC8  →  "0x6E69666E494E614E"   WRONG (identical to NULL_NAN's)
FALSE_NAN  (id=4)  offset=0xF50D8  →  "0x7FF8000400000000"   CORRECT
TRUE_NAN   (id=5)  offset=0xF51E8  →  "0x7FF8000500000000"   CORRECT
```
Only the FIRST TWO calls (in source/init order) are corrupted, and both
corrupted calls land on the EXACT SAME wrong string — i.e. the `| (id <<
32)` OR has zero visible effect on the corrupted pair (consistent with the
whole `LAYOUT.NAN_PREFIX_BITS | …` value being replaced wholesale by the
address-0 load, swamping a 1-bit/2-bit perturbation at bit 32/33). The
LAST TWO calls, same call shape, same read, are exactly right. This directly
falsifies every "permanently wrong offset/schema/segment" framing (that
class of bug would hit all 4 identically) and reframes the wall as
**stateful/temporal**: something that is NOT YET valid (an address, a
lazily-initialized table, a cache) when the kernel's `$__start` reaches the
1st–2nd `atomNanHex` calls becomes valid by the 3rd–4th. Not root-caused
further this session — the next lever is finding what changes between
`UNDEF_NAN`'s init (ordinal 183, §24) and `FALSE_NAN`'s init immediately
after: candidates worth checking first are (a) a lazy/memoized digit-table
or interning structure `_hx8`/`.toString(16)`'s own compiled BigInt-to-
string path reads via the SAME `isSchemaSlotBigintPossible` machinery, only
warmed up after its first two (wrong) uses, and (b) whether `TOMB_NAN`'s
own plain-string-literal declaration (src/ir.js, between `UNDEF_NAN` and
`FALSE_NAN` in source) triggers some side effect that happens to correct
the underlying state.

**Verdict: BUILD-TIME BAKE bug, address-computation class (not a decode,
not a segment/offset-collision, not a permanently-stale offset) —
order-dependent across the first 2 of 4 identical call sites. No fix
attempted — root-caused one layer past §26a's own hypothesis (and that
hypothesis is now affirmatively ruled out, not just unconfirmed), but the
exact mechanism producing address 0 on calls 1–2 and the correct address on
calls 3–4 needs its own dedicated trace (adding `JZ_DBG_CENSUS`-style
instrumentation to `emitSchemaSlotRead`'s base-pointer/slot-index inputs,
or to whatever `_hx8`'s compiled `.toString(16)` lowers to, comparing call
1 vs call 3) before a fix is safe to attempt.**

**Gates this session: none run — no `src/` change was made, so §15's
differentials / dict O0/O2/O3 / `JZ_CARRIER_BOX=1 test:wasm` / the
flag-forced battery / default byte-identity are all UNCHANGED from §26's
own numbers** (still: 2/3 WAT differentials closed, `() => undefined`
diverging exactly as recorded; `dict` diverging at the same byte sizes;
`test:wasm` still hangs at the same point). Default kernel untouched
(read-only inspection of the shared tree's existing `dist/jz.wasm`, never
rebuilt). Per the coordinator's own mandate, no default flip, no source
change to gate.

**SHAs.** Investigated at `b80641d3` (HEAD, unchanged — this session made
no `src/` edits). Disposable worktree (removed at session end, never
merged, no commits): fresh `JZ_CARRIER_BOX=1` kernel built there,
16926082 bytes, matching §26's own recorded size exactly. This ledger
entry (`.work/carrier-representation-design.md` only) is this session's
one commit.

## §28. The read-before-init trace — one layer past §27: the write-side
BOXING mechanism nailed exactly (LAYOUT.NAN_PREFIX_BITS's own construction,
byte-for-byte), a live-memory proof the box is NOT permanently corrupted,
and a NEW, undocumented compiler-synthesized dispatch found inside
`atomNanHex`'s own body — but the exact instant of the call-1/2-vs-3/4 flip
still resists an isolated repro. BANKED, no fix attempted (2026-08-10,
isolated `git worktree add --detach`, never touched the shared tree's
`dist/jz.wasm`)

**Method.** Built the carrier kernel TWICE in a disposable worktree
(`03f1d469` HEAD): once `snapshotInit:true` (357.0 MB WAT dump, matching
§27's own size) confirming the baked-wrong global reproduces exactly;
once `snapshotInit:false` (376.5 MB WAT dump) to get a REAL, callable
`$__start` with `call $m61_layout$atomNanHex` sites intact (snapshotting
deletes `$__start` after baking, per `src/snapshot.js`'s own doc comment
— §27's own WAT dump, being post-snapshot, could show the baked GLOBAL's
wrong value but not the CALL SEQUENCE producing it). Isolated `$__start`'s
73846-line body (lines 7979603-8053448 of the dump) and grepped WITHIN
that isolated slice only — the raw whole-file grep §26a/§27's own method
implicitly relied on is unsafe at this scale: the self-hosted compiler's
OWN WAT-template strings (module/core.js's stdlib bodies, compiled as
DATA since the compiler carries its own codegen templates as string
literals) contain "global.set", "UNDEF_NAN", "layout" etc. as literal
SUBSTRINGS throughout the data segments, so an unfiltered grep for e.g.
`global.set $m78_ir$UNDEF_NAN` returns zero matches (mangled the wrong
way) while an unfiltered `UNDEF_NAN` returns thousands of false
positives from embedded template text. Isolating the function body first
made every subsequent grep exact.

**1. The 4 calls are TEXTUALLY/EXECUTION-ORDER back-to-back — REFUTES the
"something initializes between call 2 and 3" framing at `$__start`'s top
level.** `start-body.wat` lines 19128-19140:
```
(global.set $m76_policy$JZIFY_CLASS_ERRORS (local.get $141154))
(global.set $m78_ir$NULL_NAN  (call $m61_layout$atomNanHex (i32.const 1)))
(global.set $m78_ir$UNDEF_NAN (call $m61_layout$atomNanHex (i32.const 2)))
(global.set $m78_ir$FALSE_NAN (call $m61_layout$atomNanHex (i32.const 4)))
(global.set $m78_ir$TRUE_NAN  (call $m61_layout$atomNanHex (i32.const 5)))
```
Zero instructions between any of the four. `src/ir.js`'s own source has
`TOMB_NAN` (a plain string literal) and `BOOL_ATOM_BASE` (a plain number)
declared BETWEEN `UNDEF_NAN` and `FALSE_NAN` (lines 653-665) — both
constant-folded away entirely (no `global.set` emitted for either,
confirmed absent from the isolated body), which is WHY the compiled
`$__start` shows the 4 calls immediately adjacent even though the SOURCE
doesn't. §27's own "next lever" framing (find what lands between call 2
and 3) is empirically dead: nothing does, at this level. Whatever the
mechanism is, it lives INSIDE `atomNanHex`'s (or a callee's) own
execution, triggered by INVOCATION COUNT, not by an interposed sibling
init.

**2. `LAYOUT.NAN_PREFIX_BITS`'s write side, traced byte-for-byte: it IS a
CARRIER_BOX-only heap-boxed BigInt pointer, not raw — directly
contradicting this doc's own §24 claim about the "normal" case.**
`start-body.wat` lines 10183-10231 show `LAYOUT`'s construction: a
10-field scratch object `$box` (`call $__alloc_hdr_0_10`) populated via
plain `f64.store` for 9 of its 10 fields (offsets 0/8/16/24/32/40/56/64/72
— TAG_SHIFT/TAG_MASK/AUX_SHIFT/AUX_MASK/OFFSET_MASK/NAN_PREFIX/SSO_BIT/
SLICE_BIT/SLICE_LEN_MASK, all plain JS numbers) — but offset 48
(NAN_PREFIX_BITS, the one genuine BigInt literal) is special-cased:
```
(f64.store offset=48 (local.get $box)
  (block (result f64)
    (i64.store (local.tee $ml141177 (call $__alloc (i32.const 8)))
               (i64.const 9221120237041090560))   ;; = 0x7FF8000000000000, exact
    (call $__mkptr_5_0_d (local.get $ml141177))))  ;; wraps a PTR.BIGINT(5) box
```
i.e. under CARRIER_BOX, `NAN_PREFIX_BITS`'s write side (§24's own
"write-side, fail-open" `slotBigintBoxedAt`) BOXES it: a fresh 8-byte
heap cell (`$__alloc(8)`), the correct raw bits stored there, then a
tag=BIGINT pointer wrapping that cell written into `LAYOUT`'s own field
slot. `LAYOUT` itself is then `$141154 = call $__mkptr(6, 28, $box)` — an
OBJECT-tagged pointer whose OFFSET literally IS `$box`'s own address (no
copy). `$m61_layout$LAYOUT`'s `global.set` (line 10310) happens ONCE, at
module-init ordinal ~95 (§24's own number), ~88 modules and ordinal-183
calls before `atomNanHex` is ever invoked. This DIRECTLY CONTRADICTS §24's
own claim ("the field is stored raw/unboxed... reinterpreted IS the
payload, tag reads as PTR.ATOM not PTR.BIGINT") — that claim was wrong,
or described a DIFFERENT build/site; this session's own direct trace
of THIS build's THIS field shows unambiguously tag=BIGINT, boxed,
heap-allocated. (`atomNanHex`'s own compiled body, read in full below,
independently confirms this: its FIRST action is exactly the
`maybeUnboxBigInt`-style tag==5 dispatch, which would be dead code if the
field were ever raw.)

**3. Live-memory proof: the box is genuinely, stably CORRECT — the
corruption is NOT a lasting bad write, confined to the first two READS.**
Built a THIRD artifact — raw wasm bytes (`snapshotInit:false`, so
`$__start` stays a real, auto-run `(start)` section) — and instantiated
it directly via `WebAssembly.Instance` (stub imports throwing on any host
call, matching `src/snapshot.js`'s own hermeticity-probe pattern; none
fired — confirms `$__start` is fully hermetic here too). Scanned linear
memory for the 10-field object matching `LAYOUT`'s known first 5 fields
(47, 15, 32, 32767, 4294967295) — found ONE match, at byte offset 892184.
Its field at +48: raw bits `0x7ffa8000000d9d68` → tag=5 (BIGINT), aux=0,
offset=892264. Dereferencing address 892264 directly: `0x7ff8000000000000`
— EXACTLY correct. **The canonical `LAYOUT.NAN_PREFIX_BITS` box, inspected
live in a running instance, is well-formed and correct** — not
permanently zeroed, not permanently pointing at address 0. Since nothing
in `$__start`'s own text revisits this field after ordinal ~95 (item 2),
and this scan ran well after `$__start` completed (several `compileWat`
calls later), this proves whatever goes wrong for `atomNanHex` calls 1-2
is a TRANSIENT MISREAD specific to those two invocations, not a
persisted bad value at the read address — tightening §27's own "stateful/
temporal" framing from "something isn't valid yet" to "the SAME correct
memory location, read by the SAME compiled instructions, resolves
differently on 2 particular invocations of a pure, argument-only
function" — which is the genuinely hard remaining puzzle.

**4. Independently re-reproduced §27's exact signature through a THIRD,
unrelated harness (no `test/kernel-target.js`, no `compileWat`'s own
existing test wiring) — rules out a harness artifact.** Marshaled through
`interop.js`'s own `instantiate()` (`mem.String`/`mem.read`, the same
production ABI `dist/jz.wasm` users go through) rather than
`test/kernel-target.js`'s bespoke wiring: `() => undefined` and `() =>
null` both compile (at O0) to `nan:0x6E69666E494E614E` — byte-identical
to §24/§26/§26a/§27. Stable across 3 repeat compiles in the SAME warm
instance (expected: `UNDEF_NAN` is a baked module global, read not
recomputed). Forced `FALSE_NAN`/`TRUE_NAN` materialization (`[true][0]`,
observed-identity array indexing) through the SAME instance:
`nan:0x7FF8000500000000` — exactly correct (tag=ATOM, aux=5), confirming
calls 3-4 are right in THIS independently-built, independently-marshaled
instance too, not an artifact of any one test path.

**5. `atomNanHex`'s FULL compiled body, read in its entirety (157 lines,
not the previously-inspected first 60): a NEW, previously-undocumented
compiler-synthesized special-case dispatch — direct hardcoded-literal
comparisons against `NULL_NAN`/`UNDEF_NAN`'s own HOST-COMPUTED values.**
After the tag==5 deref (item 2's box, dereferenced via a
`followForwardingWat`-shaped guard that's provably a no-op here — BIGINT
isn't in `FORWARDING_MASK`, confirmed by decoding the guard's own `898`
literal as exactly `(1<<PTR.ARRAY)|(1<<PTR.HASH)|(1<<PTR.SET)|(1<<PTR.MAP)`)
and the `BigInt(atomId) << AUX_SHIFT` shift (reading the destructured
`$m61_layout$AUX_SHIFT` module const, itself set correctly at ordinal
~96, right after `LAYOUT` — confirmed, not assumed), the combined i64 OR
result is checked against TWO HARDCODED i64 LITERALS:
```
(i32.or (i64.eq <combined> (i64.const 0x7FF8000100000000))    ;; = NULL_NAN's own value
        (i64.eq <combined> (i64.const 0x7FF8000200000000)))   ;; = UNDEF_NAN's own value
(then (local.get $mbig0))                          ;; MATCH: return RAW, unboxed
(else (i64.store (call $__alloc 8) <combined>)      ;; NO MATCH: heap-box it
      (call $__mkptr_5_0_d ...))
```
These two literals are `NULL_NAN`/`UNDEF_NAN`'s OWN CORRECT bit patterns,
baked by the HOST compiler (which evaluates `layout.js`/`ir.js`
natively while building the kernel, so it already knows these two
sentinel values at host-compile time) into the GENERATED CODE for
`atomNanHex` itself — i.e. `atomNanHex`'s compiled body carries a
"if my own result happens to equal one of the two reserved ATOM
sentinels my caller (`ir.js`) is ABOUT to bind me to, return it raw
instead of boxing it as a BigInt pointer" special case. This is
consistent with (not independently confirmed against) the documented
"unforgeable... no boxing path ever produces" invariant `TOMB_NAN`'s own
doc comment states for reserved atoms (src/ir.js): boxing a BigInt that
happens to collide with a reserved sentinel's bit pattern would make two
semantically different things bit-identical, so SOME pass avoids it.
This dispatch was NOT visible in §24/§26/§27's own inspection (all three
stopped at the tag-check / deref, the first ~60 lines) — it explains
WHY calls 3-4 (FALSE_NAN/TRUE_NAN, whose target literals never match
either hardcoded comparison) unconditionally box, while calls 1-2 take a
DIFFERENT code path when their deref succeeds. It does NOT by itself
explain the call-1/2-vs-3/4 asymmetry — for a WRONG deref (item 3's
address-0 misread), the combined result is `<ASCII "NaNInfin" bytes> |
(id<<32)`, which matches NEITHER hardcoded literal, so a wrong call
ALSO falls to the box-else-branch, same as calls 3-4 structurally — the
divergence is still upstream of this dispatch, inside the deref itself.

**6. One concrete candidate tested and RULED OUT: `$__num_to_bigint`
(module/number.js) — no memoization, no allocation, no state.** The
task's own leading candidate ("a lazy/memoized digit-table... only
warmed up after its first two uses") pointed here first, since
`atomNanHex` calls it twice per invocation (`$atomId` → BigInt, for both
shift directions). Read its full body: `(f64.reinterpret_i64
(i64.trunc_sat_f64_s (local.get $n)))`, preceded only by a stateless
range check (throws `NUMBER_TO_BIGINT_RANGE` for non-integral/infinite
input). Pure bit-reinterpret, zero heap traffic, zero globals touched,
zero cross-call state — cannot be the warm-up mechanism. Cleanly closes
this lead rather than leaving it open by default.

**7. What remains unexplained, precisely.** Given items 1-6: the
divergence is NOT in `$__start`'s call ordering (1), NOT in
`LAYOUT.NAN_PREFIX_BITS`'s write correctness (2, 3), NOT a test-harness
artifact (4), NOT explained (though newly documented) by the sentinel-
passthrough dispatch (5), and NOT in `$__num_to_bigint` (6). What's left:
the `i32.wrap_i64 (i64.reinterpret_f64 (global.get $m61_layout$LAYOUT))`
base-pointer read, or the `f64.load offset=48` itself, or the tag-check's
own bit arithmetic, resolve DIFFERENTLY on invocations 1-2 vs 3-4 of the
SAME compiled instructions reading the SAME (proven-stable) memory
location — which, for ordinary sequential WASM execution with no
intervening writes (1), is the genuinely hard remainder. The only
mechanisms this session did NOT get to rule in or out: (a) whether V8's
own JIT tiering/Liftoff-to-Turbofan transition for THIS SPECIFIC function
could produce transiently different results on its first few calls
(would be a V8 bug, not a jz bug — very unlikely but not eliminated;
no cross-engine check attempted — no second WASM runtime, e.g. wasmtime/
wasmer, was available this session to test); (b) whether `$__memgrow`
fires between calls 1-2 and 3-4 specifically for THIS build's heap
trajectory (the CARRIER_BOX build's own +944-byte `$__start` heap growth,
§27 item 2) and, if a grow happens to land in that exact window,
whether `$__heap_end64` or the memory `ArrayBuffer` itself gets
transiently inconsistent mid-grow in a way `atomNanHex`'s own reads could
observe (memory.grow is synchronous/atomic per the WASM spec, so this is
a weak lead, but not directly tested this session — the next session's
first move should be counting `$__memgrow` calls between ordinals ~95 and
~183 via the SAME isolated-body-grep technique item 1 established, since
that's now a cheap, mechanical check this session ran out of budget for).

**Verdict: BANKED, one genuine layer deeper than §27, no fix attempted.**
The write-side boxing mechanism for `LAYOUT.NAN_PREFIX_BITS` is now fully
named and byte-verified (item 2); the box itself is proven NOT
permanently corrupted (item 3); a previously-undocumented dispatch inside
`atomNanHex` is now on the record (item 5); one concrete candidate is
closed with evidence (item 6); the "between call 2 and 3" framing is
empirically retired in favor of "invocation-count-dependent within the
SAME function, memory proven stable" (item 1, 3). Per this whole chain's
own established discipline (§17-§27: bank a scale-dependent wall rather
than force an uncertain fix), no source change was made and none is
proposed — the remaining gap needs INSTRUCTION-LEVEL tracing mid-`$__start`
(a WASM single-stepper, or a temporary trace call injected into the
compiled `atomNanHex`/`i64Hex` bodies specifically, reading `$__poff0`
and the loaded `$mbig0` bits at each of the 4 call sites) that this
session did not build — safer to bank precisely than to guess at
instrumentation under time pressure on a KERNEL-SCALE, non-reproducible-
in-isolation wall.

**Discriminator (default vs CARRIER_BOX), reconfirmed a third independent
way.** Item 2's write-side boxing (`$__alloc(8)` + `$__mkptr_5_0_d`) and
item 5's read-side dispatch are BOTH exclusively reachable through
`isSchemaSlotBigintPossible`'s `CARRIER_BOX &&`-gated predicate (§24) —
under default, `LAYOUT.NAN_PREFIX_BITS`'s write would be a plain
`f64.store offset=48 (box) (f64.const ...)` (no allocation, no tag,
matching the OTHER 9 fields' own direct-store shape this session
directly observed at offsets 0-40/56-72) and its read a plain `f64.load`
(no tag-check, no deref, no sentinel dispatch) — structurally incapable
of this failure mode. This session adds a THIRD independent confirmation
layer beyond §25's structural argument and §26's byte-identity
re-test: direct codegen inspection of BOTH the write AND read sides for
this exact field in this exact build, not merely their absence/byte-count.

**Gates this session: none newly run — no `src/` change was made** (same
posture as §26/§27). §27's own numbers stand unchanged since HEAD is
identical (`03f1d469`, no commits since): 2/3 WAT differentials closed,
`() => undefined` diverging to the same `nan:0x6E69666E494E614E` (this
session's own items 1/4 independently reconfirm the VALUE, not merely
cite §27); `dict` O0/O2/O3 diverging at the same byte sizes (not
re-measured this session — no source change to invalidate §26's own
re-verified numbers); `test:wasm` presumed still hanging at the same
point (not re-run — a 28-minute-class gate with a known, unchanged
outcome and no code change is exactly the "run the next gate past a
known wall" §18/§20/§22 established as wasted budget). Default
(`CARRIER_BOX` off) build: untouched — this session never rebuilt
`dist/jz.wasm` in the shared tree, only in the disposable worktree
(removed at session end).

**Flip-readiness verdict: NO — unchanged.** `dict` and `test:wasm` both
still red; no source change was made to gate; the wall is one layer
better-understood but not closed. Per the coordinator's own mandate: no
default flip, no source change to gate.

**Local commits.** This ledger entry (`.work/carrier-representation-design.md`
only) is this session's one commit, plain message, no push.

**SHAs.** Investigated at `03f1d469` (HEAD, unchanged — this session made
no `src/` edits). Disposable worktree `/tmp/jz-carrier-wt` (`git worktree
add --detach` at `03f1d469`, removed at session end, never merged, no
commits): carrier kernel built there 3 times — snapshotInit:true WAT dump
(357.0 MB, matching §27 exactly), snapshotInit:false WAT dump (376.5 MB,
new this session), and a raw-bytes instantiate-and-inspect build (15265.9
KB wasm, `{level:3, watrGuard:false, snapshotInit:false}`) — all
JZ_CARRIER_BOX=1, all read-only against the shared tree.

## §29. The mechanism, named — root-caused and FIXED (2026-08-10, isolated
`git worktree add --detach`, fix applied to both trees; the shared tree's
`dist/jz.wasm` was never touched by any wasm-instantiating step). §15's
differentials, kernel-parity `dict` O0/O2/O3, and `test:wasm`'s own hang are
ALL closed. `test:wasm` completes (2712/2719, 1 pre-existing unrelated
failure, verified NOT a regression). Fuzz 0/121883 divergences. **Still NO
default flip — one newly-surfaced, pre-existing kernel-target gap (item 8
below) keeps `test:wasm` short of 100% green.**

**The instrument.** Built `scripts/trace-inject.mjs` (committed, reusable):
parses a NAMED function's own line-range slice out of a multi-hundred-MB WAT
dump (via `watr/parse`, wrapped in a throwaway module — never re-parses the
whole file), tee-wraps chosen subexpressions into fresh debug locals feeding
a `(import "dbg" "trace" (func $dbgtrace (param i64 i64)))`, re-prints via
`watr/print`, and splices N such regions back into the full text in one
pass. Built the carrier kernel with a REAL (`snapshotInit:false`) `$__start`
in a disposable worktree, instrumented `atomNanHex` (the §24-§28 suspect)
AND, once that proved clean, `i64Hex` (its tail-call target), reassembled
via `watr/parse`+`compile`, instantiated with stub `env.*` imports (none
fired — $__start stayed fully hermetic, matching §28's own probe) plus a
real `dbg.trace` collecting `(tag, value)` pairs, ran `$__start` once.

Two real bugs surfaced and got fixed along the way, both in the injector
itself, both left as permanent lessons in the script's own comments: (a)
`push(...hugeArray)` blows the call stack at multi-million-line scale —
`concat()` doesn't; (b) jz's own generated-local names can carry a U+E000
PUA marker (`src/ast.js`'s own `T` constant) that's invisible in every
terminal/JSON.stringify rendering — a hand-typed bare `'$mbig0'` reference
silently fails to resolve at assemble time ("Unknown local $mbig0",
reported at a MISLEADING position near the end of the file, since watr's
error position tracks its own internal processing state, not the literal
token) while printing identically; always reuse the exact string captured
off the AST. A third, structural bug: new `(local ...)` declarations MUST
be spliced in before a func's FIRST instruction, not just before its LAST
— worked by coincidence for `atomNanHex` (one-instruction body) and
silently corrupted `i64Hex` (many instructions) until caught.

**1. `atomNanHex` itself is innocent — the §24-§28 suspect is cleared.**
Traced all 7 real `atomNanHex` invocations this build actually makes (the
task's own framing, inherited from §24-§28, named 4 — `$__start`'s own
`layout.js`-module init calling `NULL_NAN`/`UNDEF_NAN`/`FALSE_NAN`/
`TRUE_NAN` — but a SECOND, independent module, `$m117_index` (index.js),
has its own `NULL_BITS`/`UNDEF_BITS`/`FALSE_BITS` trio calling the exact
same `atomNanHex`, ~35K lines later in the same `$__start`, ids 1/2/4
again): the `LAYOUT.NAN_PREFIX_BITS` schema-slot deref (`maybeUnboxBigInt`,
src/ir.js — the §24 CONSERVATIVE PAIRING mechanism) reads byte-identical,
correct values on EVERY call — `dbgLayoutBase=0xd9d18`, `dbgRawField=
0x7ffa8000000d9d68` (tag=5, aux=0, offset=0xd9d68), `dbgTag=5`,
`dbgAddr=0xd9d68`, `dbgLoaded=0x7ff8000000000000` — always. `atomNanHex`'s
own return value (traced as `dbgResult`, captured before the tail-call into
`i64Hex`) is mathematically correct on every one of the 7 calls:

| seq | id | dbgResult (raw arg to i64Hex) |
|---|---|---|
| 1 | 1 (NULL) | `0x7FF8000100000000` — correct, unboxed (sentinel passthrough) |
| 2 | 2 (UNDEF) | `0x7FF8000200000000` — correct, unboxed (sentinel passthrough) |
| 3 | 4 (FALSE) | `0x7ffa8000000f4fe0` — correct, boxed (tag=5, no sentinel match) |
| 4 | 5 (TRUE) | `0x7ffa8000000f50f0` — correct, boxed |
| 5 | 1 (2nd module) | `0x7FF8000100000000` — correct, unboxed |
| 6 | 2 (2nd module) | `0x7FF8000200000000` — correct, unboxed |
| 7 | 4 (2nd module) | `0x7ffa800000127e98` — correct, boxed |

This directly REFUTES §27/§28's own "invocation-count/warm-up" framing:
calls 5-6 are the 5th/6th REAL invocations (well past any plausible
warm-up window) and STILL take the unboxed-sentinel path for ids 1/2 —
the divergence is 100% id-VALUE-dependent (1, 2 always unboxed; 4, 5
always boxed), never invocation-count-dependent.

**2. `i64Hex` is where the misread actually lives.** `i64Hex($bits)`
(layout.js: `bits => '0x' + _hx8(Number((bits>>32n)&0xFFFFFFFFn)) +
_hx8(Number(bits&0xFFFFFFFFn))`) compiles, under CARRIER_BOX, to: extract
`$__poff0 = low32($bits)`, run a FORWARDING_MASK tag-check that decides
ONLY whether to chase a GC-forwarding pointer (never whether to deref AT
ALL), then `i64.load($__poff0)` UNCONDITIONALLY, twice (high/low halves,
same address, same loaded value, split by shift vs mask) — this is sound
ONLY if `$bits`'s low 32 bits are ALWAYS a real heap address, i.e. `$bits`
is ALWAYS a boxed BIGINT pointer. Traced calls 1-2 exactly:

| seq | id | dbgAddrHi | dbgLoadedHi | dbgResult2 (baked global content ptr) |
|---|---|---|---|---|
| 1 | 1 | `0x0` | `0x6e69666e494e614e` **WRONG** | `0x7ffa0002000f4df8` → `"0x6E69666E494E614E"` |
| 2 | 2 | `0x0` | `0x6e69666e494e614e` **WRONG** | `0x7ffa0002000f4fc8` → `"0x6E69666E494E614E"` |
| 3 | 4 | `0xf4fe0` | `0x7ff8000400000000` correct | `0x7ffa0002000f50d8` → `"0x7FF8000400000000"` |
| 4 | 5 | `0xf50f0` | `0x7ff8000500000000` correct | `0x7ffa0002000f51e8` → `"0x7FF8000500000000"` |
| 5 | 1 (2nd) | `0x0` | `0x6e69666e494e614e` **WRONG** | (same wrong pattern) |
| 6 | 2 (2nd) | `0x0` | `0x6e69666e494e614e` **WRONG** | (same wrong pattern) |
| 7 | 4 (2nd) | `0x127e98` | `0x7ff8000400000000` correct | (correct) |

For calls 1/2/5/6 (ids 1, 2 — the unboxed sentinel-passthrough path),
`$bits`'s low 32 bits are 0 (the id lives at bit 32+, per `AUX_SHIFT`;
NULL_NAN/UNDEF_NAN's own construction never touches bits 0-31), so
`i64Hex` reads `i64.load(address 0)` — the formatter's own static
string-table's opening bytes, `"NaNInfinity-Infinitytrue…"` — decoding to
exactly `0x6E69666E494E614E`, bit-for-bit the §26a/§27/§28 corruption
signature. For calls 3/4/7 (ids 4, 5 — always boxed, since their combined
bits never match either hardcoded sentinel literal `atomNanHex` special-
cases), the low 32 bits legitimately ARE the box's own heap address, so
`i64Hex`'s blind trust happens to be correct — which is why only 2 of the
4 sentinels, and only for the ids that collide with a reserved atom's own
bit pattern, ever broke.

**3. The source decision, traced to its exact origin.** `i64Hex`'s `bits`
param is solver-proven (`reps.js`'s whole-program `bigintBoxed` fixpoint)
to always arrive boxed at every call site — so `readI64` (src/ir.js) routes
every arithmetic use of `bits` inside `i64Hex`'s own body through the
UNCHECKED `unboxBigInt` (`isCurrentlyBoxedBigint('bits')` gate), never the
runtime-tag-checked `maybeUnboxBigInt` twin `atomNanHex`'s own read uses.
That proof is a call-site CONTRACT: every caller must box a BigInt
argument before crossing into a `bigintBoxed` param. `atomNanHex`'s own
tail-call `i64Hex(LAYOUT.NAN_PREFIX_BITS | (BigInt(atomId) << AUX_SHIFT))`
crosses that boundary through `coerceArg` (src/compile/emit.js). Its
box-direction branch (`!alreadyBoxed && param?.bigintBoxed`) used
`isNullish(tGet)` — a RUNTIME BIT-PATTERN test — to decide whether to
SKIP `boxBigInt` and pass the value raw, "guarded" (per its own, now
stale, doc comment) for "a nullable-BIGINT argument [that] may genuinely
be the sentinel at runtime." That guard is CORRECT for its intended shape
— a `?:` ternary with one nullish arm, the ONE place `kind.js`'s own
`VT['?:']` types a node BIGINT while its runtime value can genuinely BE
null/undefined — but `isNullish()` tests VALUE, not TYPE: it can't
distinguish "this node's static type is really nullable" from "this
node's value happens to bit-collide with a reserved sentinel." The OR
expression `LAYOUT.NAN_PREFIX_BITS | (BigInt(atomId) << AUX_SHIFT)` is
never nullable — no ternary anywhere — but for `atomId` 1/2 its VALUE is,
BY CONSTRUCTION (that expression's entire purpose is minting those two
sentinels), bit-for-bit identical to NULL_NAN/UNDEF_NAN. The false
positive skips `boxBigInt`, breaking the call-site contract `i64Hex`'s own
`bigintBoxed` proof — and its unchecked `unboxBigInt` — assumes.

**4. Fix, at the ordering-authority root, `coerceArg` (src/compile/
emit.js).** Added `nodeIsNullishBigintMerge(node)` — the exact `?:`
nullish-arm shape `ctx.func.ternaryBoxedNames`'s own gate (a few hundred
lines below, verbatim pattern) already recognizes as "genuinely can be
null" — and restricted the box-direction branch's `isNullish`-guarded
raw-passthrough to fire ONLY for that shape:
```js
if (!nodeIsNullishBigintMerge(node)) return boxBigInt(asI64(ir))
```
Every OTHER BIGINT-typed argument (including `atomNanHex`'s own OR
expression) now boxes unconditionally, restoring the invariant `i64Hex`'s
`bigintBoxed` proof assumes. Whole change is inside the existing
`if (CARRIER_BOX && …)` gate — zero default-build code-path change by
construction (confirmed: default `dist/jz.wasm` SHA-256 byte-identical
across two independent rebuilds, this session).

**5. Direct verification, before running any gate.** Built the CARRIER_BOX
kernel to real wasm bytes with `snapshotInit:true` (`build-dist.mjs`'s own
exact production path — the artifact users actually ship), instantiated
with stub `env.*` imports (none fired), scanned linear memory: `"0x7FF80001
00000000"` (correct NULL_NAN) found at byte 1002808; `"0x7FF800020000
0000"` (correct UNDEF_NAN) found at byte 1003080; `"0x6E69666E494E614E"`
(the corruption every prior session named) — NOT FOUND anywhere in memory;
`"0x7FF8000400000000"`/`"0x7FF8000500000000"` (FALSE/TRUE_NAN) unchanged,
correct; all 4 evenly spaced 272 bytes apart (no incidental collision).

**6. Gates — ALL closed except one newly-surfaced, pre-existing,
verified-not-a-regression item (§29.8).** Sequential, foreground, in an
isolated `git worktree add --detach` at `689dab68` (fix applied there
identically to the shared tree). Killed a first attempt at delegating this
to a background sub-agent partway through (per the coordinator's own
correction mid-session — it had left two concurrent `node test/index.js`
runs and a `build-dist.mjs` run alive in the SAME worktree; all killed,
`dist/` wiped, restarted clean) — every number below is from this
session's own direct, sequential re-run, not the killed agent's.

- **Default (`CARRIER_BOX` off) byte-identity, build ×2:** `dist/jz.js`/
  `dist/interop.js`/`dist/jz.wasm` SHA-256 identical across two independent
  `npm run build` runs (no flag). `dist/jz.wasm` 16477.8 KB both times.
- **Native battery, default:** `node test/index.js` — 3424 total (19602
  assertions), **3416 pass, 2 fail** (the SAME two pre-existing,
  CARRIER_BOX-unrelated rows every prior session in this chain has named —
  interval-walk codec bounds check, typed RMW guard count), 6 skip.
- **Flag-forced native battery (`JZ_CARRIER_BOX=1`):** 3424 total (19504
  assertions), **3403 pass, 15 fail** (6, 6 skip) — **DOWN from the 21-row
  baseline §17-§24 established** (this fix closed 6 of those rows). Named
  survivors spot-checked: `Map`/`dict` unary `-`/`~` on an absent-key read
  (audit-#8 P0-4 Part 3, unrelated dyn-keys.js class), `Slice 5: bare Map/
  dict .get()/[] materializes BigInt across the export boundary` (dyn-keys
  Slice 5/6/7 family, pre-existing), the kernel-oracle console.log
  KNOWN-FAIL (§16→§17, pre-existing) — all pre-existing classes this
  chain already named, none new.
- **§15 WAT differentials — 3/3 CLOSED** (native vs a fresh
  `JZ_CARRIER_BOX=1` kernel, via `compileViaKernel`, O0): `() =>
  "abcdefghi"` → `nan:0x7FFA000000000007` both; `() => () => 1` → `nan:
  0x7FFD000000000000` both; **`() => undefined` → `nan:0x7FF800020000
  0000` both, full WAT text byte-identical** — the ONE differential every
  session since §24 left open, now closed.
- **`dict` kernel-parity, O0/O2/O3 — 3/3 (33 assertions), FULLY GREEN**
  (`test/kernel-parity.js`, `JZ_CARRIER_BOX=1`): every CORPUS row (`sum`,
  `math`, `dict`, `arr`, `fold`, `mfold`, `boolconst`, `nestedtyped`,
  `subviewtyped`, `dvnested`, `fromnested`) byte-identical native-vs-kernel
  WAT at all 3 optimize levels — `dict` (the row §17-§24 tracked at
  diverging byte sizes every session) is now identical, not just
  same-size.
- **`kernel-oracle.js` — 11/13 (455 assertions)**, up from the §22
  baseline's 5/13 (113 assertions): the 3× kernel-parity `dict` rows and
  the dict-vs-oracle correctness rows this chain tracked as failing are
  now ALL passing (kernel-parity's own 3 blocks are subsumed here and are
  green). Only 2 pre-existing, unrelated KNOWN-FAIL rows remain: audit-#16
  (`ctx.features.bigint` module-ordering, wrong at BOTH native and kernel
  — not a kernel-only bug) and the console.log heap-string kernel
  miscompile (§16→§17, already on record).
- **`node test/watr.js` — 35/35 (107 assertions), unchanged.**
- **`JZ_CARRIER_BOX=1 test:wasm` — COMPLETES (no longer hangs).** 2719
  total (12863 assertions), **2712 pass, 1 fail** (6 skip) — the FIRST
  time in this entire chain `test:wasm` has ever finished under
  CARRIER_BOX rather than crashing fast or hanging 28+ minutes. The one
  failure is a NEW finding, precisely named and verified NOT caused by
  this session's fix — see item 8.
- **Fuzz, `JZ_CARRIER_BOX=1`: 0 divergences, 4/4 sweeps clean.**
  `--seedStart=1,2001,4001,6001`, `--opt=0,1,2,3`, `--inputs=20`,
  `--count=2000` each: 30173 + 30672 + 30572 + 30466 = **121883 inputs
  compared, 0 divergences** — exactly reproducing §22/§24's own historical
  total, no drift.

**7. Pins.** No new fixture landed this session — `test/kernel-parity.js`'s
own `dict` row (now byte-identical) and `test/kernel-oracle.js`'s own
correctness rows already ARE the permanent, checked-in regression pins for
exactly this class of bug (they build a fresh carrier kernel and diff
against native/JS on every run); adding a redundant standalone fixture
would duplicate coverage `test/pointers.js`'s existing `carrier-
conservative-pairing-repro.js`-based pins (§24) already provide at the
native tier. `scripts/trace-inject.mjs` is committed as the reusable
debugging asset the task asked for.

**8. NEW finding this session — a second, distinct, pre-existing
CONSERVATIVE PAIRING gap, verified NOT caused by this fix, banked
precisely for a future session.** `test:wasm`'s one failure: `test/
pointers.js`'s own "carrier: a bigint-possible-but-UNPROVEN
(pointsTo==='ALL'-poisoned) schema field read through arithmetic still
decodes correctly" pin — GREEN at native (this session, both flag-forced
battery and test:wasm's own native-side siblings pass it) — reads
`rawField()` as `NaN` instead of `9221120237041090560n` when the SAME
fixture is compiled BY THE KERNEL ITSELF (`JZ_TEST_TARGET=jz.wasm`, which
this pin had NEVER previously reached, since every prior CARRIER_BOX
`test:wasm` run crashed or hung well before this point in the suite).
**Verified NOT a regression from this session's fix**: reverted `src/
compile/emit.js` to `HEAD` in the isolated worktree (`git stash push --
src/compile/emit.js`), rebuilt the CARRIER_BOX kernel from that pre-fix
source, re-ran `JZ_TEST_TARGET=jz.wasm JZ_CARRIER_BOX=1 node test/index.js
pointers` — the IDENTICAL failure reproduces byte-for-byte
(`actual: NaN`, `expected: 9221120237041090560n`) on the unmodified,
pre-fix kernel. Restored the fix (`git stash pop`), rebuilt (SHA-256
`36e2726b…` — identical to the pre-verification build, confirming
deterministic rebuild), re-confirmed present. This is a THIRD, previously
invisible layer of the same CONSERVATIVE PAIRING family (§16/§24): the
`pointsTo==='ALL'`-poisoned (bigint-possible∧UNPROVEN) schema-slot read,
sound at native scale (this session and §24 both confirm), diverges when
the READING CODE ITSELF is compiled by a CARRIER_BOX-built kernel rather
than run natively — a genuinely new, kernel-scale, "non-reproducible
outside `test:wasm` reaching this exact point" wall, in the same family
this whole chain has repeatedly banked rather than forced. Not
root-caused this session (found in the gate suite's own tail, no budget
left to trace it with the same rigor as §29's own main finding) — named
precisely, with its own reproduction recipe (`JZ_TEST_TARGET=jz.wasm
JZ_CARRIER_BOX=1 node test/index.js pointers`, ~15s), so the next session
doesn't have to re-discover it from a bare `test:wasm` failure count.

**Flip-readiness verdict: NOT YET — but the dependency chain moved
further than any prior session.** Every blocker §17-§28 named by number —
`dict` kernel-parity (§17, reconfirmed every session since), the `()
=> undefined` WAT differential (§24, reconfirmed §26/§27/§28), `test:
wasm`'s own hang (§24, reconfirmed §26/§27/§28) — is CLOSED this session.
What keeps the flip itself banked: `test:wasm` is not 100% green (1 of
2719, item 8) and the flag-forced battery still carries 15 pre-existing
rows. Per the coordinator's own explicit instruction this session: **NO
default flip** — `CARRIER_BOX` stays `JZ_CARRIER_BOX==='1'`-gated, OFF by
default; the flip decision itself is the coordinator's, made in-thread,
not this session's to make even with every named historical blocker
closed. The concrete next lever for whichever session attempts the flip:
root-cause item 8 (the `pointsTo==='ALL'` kernel-target-only NaN
misread) with the SAME trace-inject.mjs-style direct instrumentation this
session used for `i64Hex` — reusable, committed, ready.

**Local commits.** `src/compile/emit.js` (`coerceArg`'s `nodeIsNullish
BigintMerge` guard — the actual fix), `scripts/trace-inject.mjs` (the
instrument, new), this ledger entry (`.work/carrier-representation-
design.md` only). Plain messages, no push.

**SHAs.** Investigated and fixed at `689dab68` (HEAD at session start,
unchanged in the main tree until this session's own commits below).
Disposable worktree `/tmp/jz-carrier-wt-instrument` (`git worktree add
--detach` at `689dab68`, fix applied identically, removed at session
end): carrier kernel built there repeatedly, all `JZ_CARRIER_BOX=1`, all
read-only against the shared tree — final post-fix `dist/jz.wasm` SHA-256
`36e2726b1a7d5d2d281d3a1682e4bad899cfbf060c6db2f431d77ba4b82187dc`
(16528.2 KB; +50.4 KB / +0.31% over the default 16477.8 KB, matching
§24's own cited delta almost exactly), reproduced byte-identically across
two independent rebuilds pre- and post- the stash/pop verification in
item 8. Shared tree's own `dist/jz.wasm`: untouched, never rebuilt this
session (the fix landed in `src/` only; the shared tree carries no `dist/`
under version control).

## §30. The flag-forced tail enumerated, classified, and mostly closed:
15 → 4 (11 of the 13-row tail fixed — 9 by a compiler fix, 2 by correcting
a stale test), zero new failures, item 8 re-verified unchanged (2026-08-10)

**1. Enumeration.** Flag-forced battery (`JZ_CARRIER_BOX=1 node test/
index.js`, isolated `git worktree add --detach` at `1a91c23f`, foreground):
3403/15/6, byte-for-byte matching §29's own cited baseline. Default
battery, same tree: 3416/2/6 (interval-walk codec bounds check, typed RMW
guard count — the SAME 2 rows every session since §14 has named,
unrelated to `CARRIER_BOX`). Subtracting the 2 default-mode rows from the
15 flag-forced ones leaves the **13-row tail**, extracted from the raw log
via each failing assertion's own `actual`/`expected` pair (the harness's
own summary truncates to 3 rows + a `⋮ N more` placeholder — the full set
needed `awk`-ing the per-assertion `×` markers directly, not the tail
summary).

**2. Classification table.**

| # | row | class | mechanism |
|---|---|---|---|
| 1 | `Map: unary "-"/"~" on a .get() absent key…` (audit-#8 P0-4 Part 3) | (c)→FIXED | `bigIntUnary`'s maybeUndefined `select` arm |
| 2 | `dict: unary "-"/"~" on a DYNAMIC-key absent read…` (dict sibling) | (c)→FIXED | same |
| 3 | `Slice 5: bare Map/dict .get()/[] read materializes the true BigInt…` | (c)→FIXED | `synthesizeBoundaryWrappers`' `resultBigintSentinel` lane |
| 4 | `Slice 5: negative controls — mixed-kind Map…` | (c)→FIXED (test) | stale assertion, unrelated to the compiler fix |
| 5 | `Slice 6: decl-hop present-key BigInt census read…` | (c)→FIXED | same boundary-wrapper lane as #3 |
| 6 | `Slice 6: negative control — decl-hop through a mixed-kind Map…` | (c)→FIXED (test) | stale assertion, same class as #4 |
| 7 | `§14 point 4: full presence×domain matrix over all 9 binary ops…` | (c)→FIXED | `bigIntJointDispatch`'s `bigResult` |
| 8 | `Slice 7: decl-hop binary "+" between two present-key BigInt census reads…` | (c)→FIXED | same as #7 |
| 9 | `Slice 7: negative controls — single-proven-side BigInt mixes…` | (c)→FIXED | same as #7 |
| 10 | `§14 point 4 FIXED: the 9-op census-BigInt sub-case…` | (c)→FIXED | same as #7 |
| 11 | `single-call-site unary "-" param-hop: present-key BigInt census value (module-level Map)…` | (c)→FIXED | same as #1 |
| 12 | `kernel oracle: KNOWN-FAIL (audit-#16, ctx.features.bigint module-ordering…)` | (b) banked | pre-existing, wrong at BOTH native and kernel — a separate FeaturePlan module-inclusion-order bug, zero overlap with `CARRIER_BOX` |
| 13 | `kernel oracle: KNOWN-FAIL (JZ_CARRIER_BOX=1 only … console.log heap-string)` | (b) banked | `CARRIER_BOX`-only self-hosted-kernel miscompile, §16→§17, unrelated mechanism |

Every row in the 13-row tail is class (c) at the START of this session
(none pre-classified) — 11 resolved to a single ROOT MECHANISM (rows
1-3/5/7-11) or its direct byproduct (rows 4/6, a stale test assertion
riding the same code path); rows 12-13 root-caused to PRE-EXISTING,
separately-scoped, ALREADY-NAMED walls (§16→§17 for row 13, audit-#16 for
row 12) and re-classified as (b) — instances of walls this chain already
banked under a different name, not new discoveries.

**The 5 audit-#14 item-2 rep shapes — checked, NONE overlap the tail.**
Re-ran each by name: `test/dyn-keys.js`'s "5n-3n subtraction via generic
param" (line 1131, `KNOWN-FAIL … architecturally out of reach`) and
"Map-value-through-unary-callee, LOCAL receiver" (line 1309, `KNOWN-FAIL …
out of scope`) both still assert their own documented-wrong value with a
tripwire (pass GREEN by design, unaffected); `test/array-methods.js`'s
`Array.from(BigInt64Array)` bracket-read row passes clean; `test/
kernel-oracle.js`'s `captured-then-read` BOOL∪NUMBER `PENDING-FIX` row
(the "dynamic subnormal"-adjacent generic-scalar-decl class) is inside the
kernel-oracle 11/13 — not one of the 2 real fails, unaffected. These 5 were
already converted from "silently wrong" to "loudly KNOWN-FAIL, pinned"
by earlier sessions (audit-#8/§14) — this session's own tail is a
DIFFERENT population entirely (Map/dict census-BIGINT crossing a boxed
CARRIER_BOX representation), confirmed by zero name/line overlap.

**3. Root cause (rows 1-3/5/7-11), found from the actual-vs-expected
bytes, not inferred.** `Slice 5`'s own failure printed `actual:
9221823924482868464n` for `m.set('x', 5n); return m.get('x')` — decoded,
`0x7FFA8000000004F0`: a well-formed `PTR.BIGINT` (tag=5) NaN-box, never
dereferenced. Under `CARRIER_BOX`, a Map/dict's own live storage cell for
a BigInt value holds exactly this: `coerceArg`'s box-direction branch
(`src/compile/emit.js`, §29's own fix site) boxes every BigInt-typed
argument crossing into `.set()`/`[]=` unconditionally, so the container's
"raw f64 carrier" for that slot IS the box. Three call sites, all built
for the OFF-FLAG raw-i64 carrier doctrine (pre-dating `CARRIER_BOX`
entirely), never learned to check:
- `bigIntUnary`'s maybeUndefined `select` arm (`emit.js`) computed
  `mkI64(['i64.reinterpret_f64', …])` directly on the census value —
  negating/complementing the BOX'S OWN bits, not the payload.
- `bigIntOperand`'s maybeUndefined throw-check arm (`emit.js`), same
  pattern, past the point the UNDEF_NAN check has already ruled out the
  sentinel.
- `bigIntJointDispatch`'s `bigResult` (`emit.js`) called `asI64` on BOTH
  operands unconditionally, regardless of `bigIntDomain`'s own `'census'`
  classification (the ONE domain that can be container-sourced — `'bigint'`
  and the null-domain magnitude heuristic are never boxed, by construction:
  neither is ever Map/dict-set).
- `synthesizeBoundaryWrappers`' `resultBigintSentinel` export lane
  (`compile/index.js`) built the JS-boundary i64 via a bare
  `i64.reinterpret_f64` on the callee's raw return — the SAME class one
  layer further out: `interop.js`'s `decodeBigintSentinel` (the `s`-marker
  decode this lane feeds) has no memory handle to dereference a box with,
  unlike the generic `r`-marker decode's own PTR.BIGINT arm (`interop.js`
  `mem.read`, already correct — confirmed live: the `resultDynamic`/
  `resultBigint` lanes, which route through `mem.read`, were NEVER broken;
  only the `s`-marker's memory-less compare was).

**4. Fix — reuse `maybeUnboxBigInt` (ir.js, CONSERVATIVE PAIRING, §16/
§24/§29), narrowly scoped.** All four sites now route the present-value
arm through it, `CARRIER_BOX`-gated:
- `bigIntUnary`/`bigIntOperand`: direct call — both already run inside
  normal per-function body emission, the SAME context `temp()`'s
  `ctx.func.locals` registration is built for; sound because both sites
  are reached ONLY when `censusMaybeUndefinedKind(node) === VAL.BIGINT`
  (the node IS census-sourced, by the very branch that got here) and,
  for `bigIntOperand`, ONLY past the throw check (provably present); for
  `bigIntUnary`'s `select`, the BigInt arm is unconditionally COMPUTED but
  conditionally DISCARDED — running `maybeUnboxBigInt` on the sentinel
  case is harmless (UNDEF_NAN's ATOM tag never collides with PTR.BIGINT,
  so it falls to the same plain reinterpret the discarded arm always
  produced).
- `bigIntJointDispatch`: a new `i64Operand(dom, get)` helper applies
  `maybeUnboxBigInt` ONLY when `dom === 'census'` — `'bigint'`-domain and
  null-domain (raw exported-param magnitude heuristic) operands are never
  container-sourced and stay on the unchanged `asI64` path. Reached only
  after `flagA===flagB` picked the BigInt arm, so a `'census'` operand
  here is provably present.
- `synthesizeBoundaryWrappers`: **cannot** call `maybeUnboxBigInt`
  directly — it allocates its own scratch local via `temp()`, which
  registers onto `ctx.func.locals`, but this wrapper function is
  hand-assembled (`wrapNode`, no `(local …)` section for the single-result
  shape at all) in a SEPARATE pass after normal body emission, where
  `ctx.func` belongs to whatever function compiled last — `temp()` would
  silently register the scratch local onto the WRONG function. Found
  live, not assumed (`'mbig0' is not in scope` at compile time on the
  first attempt). Fixed by inlining `maybeUnboxBigInt`'s own logic against
  a manually-declared, collision-checked local (`__expbig0`, bumped
  against `sig.params`), mirroring the multi-value branch's own existing
  `__mlaneN` discipline for the identical reason, immediately above in the
  same function.

Every site is gated `CARRIER_BOX ? … : <the prior exact expression>` — off
`CARRIER_BOX` is false, so every branch is byte-identical to before this
session by construction.

**5. Rows 4/6 — not a compiler bug, a stale test.** Both "negative
control" tests asserted the OFF-FLAG raw-i64 carrier's own documented,
still-real gap (`m.get(k)` on a mixed BIGINT/NUMBER Map misreads a small
BigInt's raw bits as a subnormal float, `2.5e-323`) — unconditionally,
never branching on `CARRIER_BOX`. Verified directly, not assumed: checked
out `src/compile/{emit,index}.js` at `1a91c23f` (this session's OWN
pre-fix HEAD) into a scratch copy and re-ran the exact repro — **already**
returns the correct `5n` under `CARRIER_BOX`, byte-for-byte, before this
session's fix ever touched anything. Root cause: this shape's census
(`dictValueKindOf`/`mapValueKindOf`) returns null for a mixed receiver, so
`censusBigintSentinelKind` never fires — it takes the `resultDynamic`
lane, which routes through `interop.js`'s generic `decode()`/`mem.read`,
whose PTR.BIGINT arm was ALREADY correct (item 4's own finding above).
Fixed the two assertions to branch on `process.env.JZ_CARRIER_BOX`
(`test/dyn-keys.js`) rather than the compiler — a genuinely separate,
already-latent test/reality mismatch this session happened to surface
while classifying the tail, not a new discovery about the mechanism.

**6. Rows 12-13 — banked, precisely, matching their own already-named
walls.** Row 12 (audit-#16, `ctx.features.bigint` module-inclusion
ordering) is wrong at BOTH native AND kernel — never a `CARRIER_BOX`
question, a separate FeaturePlan-ordering bug with its own name and no
lever this session's fix touches. Row 13 (§16→§17, `console.log`
heap-string kernel miscompile) is `CARRIER_BOX`-only but lives inside the
SELF-HOSTED KERNEL's own generated code, not the native compiler — the
same class of "kernel-target-only, invisible to any native-scale
gate" wall §26-§29 spent multiple sessions root-causing for the
`atomNanHex`/`i64Hex` case; this row needs the identical
`trace-inject.mjs`-grade instrumentation (committed, reusable, §29) to
root-cause, not attempted this session (a materially separate,
multi-hour investigation, not a "one clear named fix").

**7. `test:wasm`'s item-8 gap (§29) — re-verified, UNCHANGED, still
banked.** Built a fresh `JZ_CARRIER_BOX=1` kernel in the isolated worktree
(`JZ_CARRIER_BOX=1 node scripts/build-dist.mjs`, 16531.8 KB, matching
§29's own cited CARRIER_BOX size), ran the exact reproduction recipe
`JZ_TEST_TARGET=jz.wasm JZ_CARRIER_BOX=1 node test/index.js pointers`:
34/35, the SAME single row red — `rawField()` (the `pointsTo==='ALL'`
schema field read, `test/pointers.js`'s CONSERVATIVE PAIRING pin) still
returns `NaN` instead of `9221120237041090560n` when the reading code
itself is compiled BY a carrier-built kernel rather than run natively.
Byte-for-byte the same finding §29 named — this session's Map/dict census
fix (items 3-4 above) is a DIFFERENT mechanism (a container's own storage
cell vs. a schema-slot arithmetic read inside kernel-generated code) and
does not touch it, confirmed rather than assumed.

**8. Gates, every landing.** Sequential, foreground, isolated `git
worktree add --detach` at `1a91c23f` for all `CARRIER_BOX` measurement,
plus independent confirmation in the shared tree after committing:
- **Flag-forced battery: 3403/15/6 → 3414/4/6** (19504 → 19596
  assertions) — the 4 survivors are rows 12-13 above plus the 2
  CARRIER_BOX-unrelated default-mode rows (interval-walk, typed RMW),
  confirmed identical in BOTH the worktree and the shared tree post-commit.
  Zero new failures at any point.
- **Default battery: 3416/2/6, unchanged** (19602 assertions) — identical
  in the worktree, the shared tree before this session's edits, and the
  shared tree after — the same 2 pre-existing rows every session since
  §14 has named.
- **`node test/dyn-keys.js`: 57/57 both flags** (284 assertions) — was
  55/57 flag-forced, 57/57 default before the test fix; 57/57 both after.
- **`node test/pointers.js`: 35/35 both flags.** **`node test/watr.js`:
  35/35.**
- **`JZ_CARRIER_BOX=1 kernel-parity`: 3/3 (33 assertions), byte-identical
  O0/O2/O3** — unchanged from §29.
- **`JZ_CARRIER_BOX=1 kernel-oracle`: 11/13 (455 assertions), unchanged**
  — the SAME 2 rows (audit-#16, console.log heap-string) as §29's own
  baseline, byte-for-byte.
- **Fuzz, `JZ_CARRIER_BOX=1`: 2 independent 2000-program sweeps**
  (`--seedStart=1,2001`, `--opt=0,1,2,3`, `--inputs=20`): 30173 + 30672 =
  **60845 inputs compared, 0 divergences.**
- **Default build ×2, in BOTH the worktree and the shared tree (4
  independent builds total): byte-identical across all 4** — `dist/jz.js`
  `420596426c6b224ad07bc03ec75e2b5c5c51a3785e6cd1f0fdee7d03a985759e`,
  `dist/interop.js`
  `ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1`,
  `dist/jz.wasm`
  `6fe9f1e84a3723cfe79aac616dd6797832fdf237a8cbb4c9674c6a9ec97b19b7`
  (16481.3 KB) — identical whether built in the isolated worktree or the
  shared tree, confirming the fix is fully deterministic and CARRIER_BOX
  gated (the shared tree never ran a `CARRIER_BOX`-flagged build of its
  own `dist/`).

**Flip-readiness verdict: NOT YET, but the tail shrank from 13 to 2.**
Everything closable without a new multi-session investigation is closed:
9 real compiler rows fixed by one root-caused mechanism (the fourth
`maybeUnboxBigInt` consumer class this chain has now found — schema-slot
arithmetic §16/§24, `atomNanHex`/`i64Hex` §29, and now Map/dict census
values), 2 more by a verified-unrelated test-staleness fix. What remains
is exactly 2 rows (12-13) plus the separately-tracked `test:wasm` item-8
finding — all THREE now demonstrably requiring the SAME class of
dedicated, multi-hour, kernel-scale trace-instrumentation §26-§29 already
proved out (`scripts/trace-inject.mjs`, committed, reusable) — not a
"next quick lever," a concrete next SESSION's starting point.

**Local commits (shared tree, plain messages, no push).**
`8857842d` — `src/compile/emit.js` + `src/compile/index.js` (the
`maybeUnboxBigInt` fix, items 3-4). `53a0e39f` — `test/dyn-keys.js` (the
2 stale-assertion fixes, item 5). This ledger entry + `.work/todo.md`
status update commit separately.

**SHAs.** Investigated at `1a91c23f` (HEAD at session start). Isolated
`git worktree add --detach /tmp/jz-carrier-wt-tail 1a91c23f`
(`node_modules` symlinked from the shared tree, read-only), fix applied
identically, all `CARRIER_BOX` measurement and the `JZ_CARRIER_BOX=1
scripts/build-dist.mjs` kernel build (16531.8 KB) done there; removed at
session end. Shared tree: fix committed at `8857842d`/`53a0e39f`, default
`dist/jz.wasm` rebuilt twice for the byte-identity gate (not committed,
gitignored).

## §31. Final 2-3 gaps attacked: 2 of 3 KNOWN-FAIL pins were STALE (bugs
already closed, incidentally, by §24/§29/§30 — corrected, not fixed here),
the third (test:wasm item 8) root-caused MORE PRECISELY than §16-§30's own
framing — a write-side box/no-box divergence under self-host, not a
read-side hz.all/unproven gap — banked (2026-08-10)

**Method note.** `scripts/trace-inject.mjs`'s own splicing mechanics
(function-range slice → parse → tee-wrap → re-splice) were read and kept in
reserve, but not literally re-invoked: every gap this session closed or
sharpened was diagnosed first via §17's OWN lighter technique (native-vs-kernel WAT
diff on a minimized repro, `compileViaKernel({wat:true})`) plus raw-i64
extraction via `instantiate(...).instance.exports` (bypassing interop.js's
host-side decode to see the WASM-level return bits directly) — both landed
the diagnosis before AST-level tracing was ever needed. The byte-level
instrument remains reserved for whichever future session chases WHY the
kernel's own `anyDynKey`/`slotBigintBoxedAt` census evaluates differently
than native's (item 3 below) — that question lives INSIDE the running
kernel's own compiled state, past what a WAT diff alone can show.

### Gap 3 — audit-#16 (`ctx.features.bigint` module-ordering): NOT
flag-independent — CORRECTED, one stale assertion fixed

§30 classified this row as "wrong at BOTH native AND kernel — never a
CARRIER_BOX question," outside the flip delta. **Verified false under
`JZ_CARRIER_BOX=1`**: native now returns the mathematically CORRECT value
(`123456789012345`) at every optimize tier (O0/O2/O3), while the KERNEL
leg is still wrong (`6.09957581968707e-310`, byte-identical corruption to
before) — an asymmetric split the original "both wrong" pin couldn't
express, verified live via a bypass script re-running the test's own exact
fixture with try/catch per assertion instead of the harness's throw-on-
first-fail (which had been silently swallowing assertions 2-4 and the
reversed-import control's own 6 assertions every session since this row
was pinned). Under DEFAULT (no flag), both legs are UNCHANGED — still
identically corrupted, confirmed live at all 3 opt tiers — so the pin's
OLD assertions remain exactly correct there.

**Mechanism (not independently re-investigated further — inherited, not
re-derived): native's fix is almost certainly incidental fallout from §24's
CONSERVATIVE PAIRING** (see gap-1's writeup below — same `readI64`/
`maybeUnboxBigInt` runtime dispatch closes this repro's `Number(arr[i])`
mixed-array BigInt-census read the same way it closes `ptrBits`'s
`LAYOUT.NAN_PREFIX_BITS` read), landing AFTER audit-#16 was pinned and
never cross-checked against it. The underlying audit-#16 bug itself
(`$__to_num` baked before `ctx.features.bigint` is set, per-module
`prep()` ordering) is UNCHANGED and still real — only its NATIVE-leg
symptom disappeared as an unrelated fix's side effect; the KERNEL leg,
whose own `$__to_num`/CONSERVATIVE-PAIRING dispatch is baked from a
SEPARATE self-hosted build, did not get the same benefit (root cause not
pinned down further this session — plausibly the SAME class as gap-2's
write-side self-host divergence, not confirmed).

**Fix landed**: `test/kernel-oracle.js`'s audit-#16 test now branches its
native-leg assertion on `process.env.JZ_CARRIER_BOX` (mirrors §30's own
rows-4/6 `dyn-keys.js` stale-assertion pattern exactly) — default keeps the
original "both wrong" pins verbatim; `JZ_CARRIER_BOX=1` asserts native now
agrees with `want` (with a fresh tripwire on regression back to
`corrupted`) while keeping the kernel-leg "still wrong" pin unchanged. The
reversed-import CONTROL block (isolates the fault to import ORDER) needed
no change — verified unaffected, both legs agree with `want` under both
flag states, all 3 opt tiers.

### Gap 1 — console.log heap-string kernel miscompile (§16→§17): ALREADY
FIXED, stale KNOWN-FAIL pin flipped to AGREE

**§29/§30 both re-ran this row and recorded "unchanged" — correct at the
PASS/FAIL BLOCK level, stale at the ASSERTION level.** The block failed
both times (matching the prior baseline's OWN 1-failure count), masking
that the FAILURE MODE had flipped: assertion 3 (`threw?.constructor?.name
=== 'RangeError'`) used to correctly pin a real crash; it now fails
because NOTHING throws anymore — the kernel runs clean. Verified directly,
repeatedly, fresh-process, both manually and via the actual pinned test
body: `console.log('bare-fired')` (heap string, ≥7 chars) and
`console.log('short')` (SSO string, ≤6 chars) BOTH print their CORRECT,
undecorated value through a carrier-built kernel, at every optimize level
(0/1/2/3) — deterministic across repeated runs, not a fluke.

**Root cause of the (accidental) fix, confirmed via WAT diff — the
minimized `console.log('bare-fired')` repro's native and kernel WATs are
now BYTE-IDENTICAL** (they diverged, per §17's own citation, before §24
landed: `nan:0x7FFA000000000007` vs `nan:0x7FFA8000000DA1FC`). §24's
CONSERVATIVE PAIRING (commit `83c7f9bc`, .work/carrier-representation-
design.md §24, landed AFTER §17 named this bug) added a RUNTIME
(`$__ptr_type`-checking, not static-proof-gated) dispatch at `readI64`'s
arithmetic-core call sites: `isSchemaSlotBigintPossible` fires whenever a
bare `.prop` read is write-side boxed (`slotBigintBoxedAt`, fail-open,
unaffected by `pointsTo==='ALL'`) but read-side UNPROVEN, routing through
`maybeUnboxBigInt` instead of a naive unconditional reinterpret. `ptrBits`'s
own body (`layout.js`) — `LAYOUT.NAN_PREFIX_BITS | ((type&15)<<47) | …` —
IS exactly this shape (an arithmetic-core BigInt-operand OR-expression).
Once §24's dispatch got baked into the self-hosted kernel build, the
RUNNING kernel's own compiled `ptrBits` started correctly unboxing the
LAYOUT box AT RUNTIME (checking the ACTUAL tag bits of whatever value it's
handed) instead of trusting a static proof that `pointsTo==='ALL'`
(§17 finding 1, still open — §18/§21/§22/§23 all walled trying to close it
safely) had poisoned — making `ptrBits` immune to that poison specifically
BECAUSE it no longer needs the poisoned fact at all. §29/§30 never
cross-checked this specific row against §24's landing; this session did.

**Fix landed**: flipped `test/kernel-oracle.js`'s KNOWN-FAIL block to
AGREE tier (renamed, restructured per the file's own `runNative`/
`compileViaKernel` + console.log-spy convention already used two blocks
above it) — asserts BOTH heap and SSO strings print correctly on BOTH legs
at all 4 optimize tiers, under both flag states (native-only check when
`JZ_CARRIER_BOX` is unset, matching every other AGREE-tier block's shape).

### Gap 2 — test:wasm item 8 (`pointsTo==='ALL'` schema field read
misreads under kernel self-compilation): STILL RED, but root-caused MORE
PRECISELY — a WRITE-SIDE box/no-box divergence, not a read-side gap

**Re-verified unchanged**: `JZ_CARRIER_BOX=1 JZ_TEST_TARGET=jz.wasm node
test/index.js pointers` — 34/35, the SAME single row red (`rawField()`
returns `NaN` instead of `9221120237041090560n`), byte-for-byte matching
§29/§30's own citation. The OTHER 3 assertions in the SAME test block
(`undefAtom`/`nullAtom`/`ptrHex` — all arithmetic-wrapped reads of the
identical `LAYOUT.NAN_PREFIX_BITS` field) PASS — a fact §29/§30 both
recorded but never explained. This session explains it.

**§16/§17's own framing (repeated verbatim through §29/§30) says this is a
READ-SIDE gap**: `slotBigintProvenAt('LAYOUT','NAN_PREFIX_BITS')` never
proves TRUE under the self-hosted build's `pointsTo==='ALL'` blanket, so
`emitSchemaSlotRead` "hands back the box's raw pointer bits." **Traced via
WAT diff (native vs. kernel, the isolated `carrier-conservative-pairing-
repro.js` fixture, `compileViaKernel({wat:true})`) — this framing is
WRONG for this specific row.** `$rawField`'s own compiled body (a bare
`f64.load` at `LAYOUT_ptr+48`) is BYTE-IDENTICAL between native and
kernel — the READ CODE never differs. The divergence is in `$__start`'s
LAYOUT CONSTRUCTION (the WRITE side):
```
native (correct — a real box):
  (f64.store (obj0+48) (block (result f64)
    (local.set $bbig2 (call $__alloc (i32.const 8)))
    (i64.store (local.get $bbig2) (i64.const 9221120237041090560))
    (call $__mkptr (i32.const 5) (i32.const 0) (local.get $bbig2))))

kernel (wrong — the bare literal, never boxed):
  (f64.store (obj0+48) (f64.reinterpret_i64 (i64.const 9221120237041090560)))
```
Confirmed independently via raw-memory extraction (`instantiate(wasm)
.instance.exports.rawField()`, bypassing interop.js's host-side decode
entirely): native's raw i64 is `0x7FFA800000003338` (a well-formed
PTR.BIGINT box, tag=5); kernel's raw i64 is `0x7FF8000000000000` — the
BARE `NAN_PREFIX_BITS` VALUE ITSELF, completely unboxed. The compiler's
OWN write-side boxing decision (`slotBigintBoxedBySid`, module/object.js's
`{}`-literal construction, §16 write-site #1 — fail-open, "unaffected by
`pointsTo==='ALL'`" per §16's own claim) evaluates to a DIFFERENT boolean
when its OWN logic is executed AS COMPILED BY THE KERNEL vs. natively, for
byte-identical source. This is a SELF-HOSTED MISCOMPILE of the compiler's
own `anyDynKey`/dyn-shadow census (the fixture's `corrupt(obj,key,val)`
unresolvable dynamic write is what makes `anyDynKey` true program-wide,
which is what makes LAYOUT's write-side decision "box" — natively correct,
kernel-wrong) — NOT a `pointsTo==='ALL'`/`slotBigintProvenAt` question at
all, despite every prior session's framing.

**Why the OTHER 3 assertions pass despite this**: `undefAtom`/`nullAtom`/
`ptrHex` all consume `LAYOUT.NAN_PREFIX_BITS` through `atomNanHex`/
`i64Hex`/`ptrBits`'s own arithmetic — the SAME §24 CONSERVATIVE PAIRING
runtime dispatch that closed gap 1 (`isSchemaSlotBigintPossible` +
`maybeUnboxBigInt`, gated on `slotBigintBoxedAt`, checked at RUNTIME via
`$__ptr_type`). Since the kernel's write side genuinely did NOT box this
slot, `maybeUnboxBigInt`'s runtime tag check correctly sees "not a box"
and passes the raw value through untouched — CORRECT, because the value
really isn't boxed in the kernel's world. The compiler is INTERNALLY
SELF-CONSISTENT (write says "raw", arithmetic reads correctly treat it as
raw) — only `rawField()`'s BARE, UN-WRAPPED return crosses the JS export
boundary, where interop.js's generic "r"-marker decode (`decode()`,
tag-sniffing, unconditional on which representation THIS PARTICULAR
compile chose) sees `0x7FF8000000000000`'s zero tag/aux/offset bits and
reads them as a MALFORMED PTR.ATOM(id=0) — not a valid atom id (NULL=1/
UNDEF=2/FALSE=4/TRUE=5) — falling to its NaN error path. This is also
why the value is uniquely adversarial: `LAYOUT.NAN_PREFIX_BITS`'s OWN
VALUE (`0x7FF8000000000000n`) is BIT-IDENTICAL to "an empty/malformed box"
— the one BigInt value in the entire carrier design space where "raw" and
"a degenerate box" are indistinguishable by inspection alone. Native never
exposes this because native happens to always box this field (the
fixture's `anyDynKey` trigger, matching real self.js); the kernel's
write-side divergence exposes it.

**NOT fixed — two open, DISTINCT threads, correctly separated for the
first time**: (1) WHY the kernel's own compiled `anyDynKey`/
`slotBigintBoxedAt` census evaluates false when native's evaluates true,
for byte-identical source — a genuine self-host miscompile in the
compiler's OWN dyn-shadow detection, requiring INSIDE-THE-KERNEL
instrumentation (trace-inject.mjs-grade — this is the piece that
genuinely needs it, unlike gaps 1/3 above) to pin down. **A concrete,
plausible (NOT verified — source-read only, no live trace) starting
candidate for a future session**: `refineDynKeys` (src/compile/narrow.js
~3529) narrows `ctx.types.anyDynKey` from the initial scan's `true` back
to `false` via a `let real = false` captured and mutated by a nested
`visit` closure, then read back in the outer loop (`if (real) break`) and
finally consulted at the function's tail (`if (!real) ctx.types.anyDynKey
= false`) — a captured-then-mutated-then-read BOOLEAN local is exactly the
shape class this SAME file already pins as a live, PENDING-FIX self-host
gap elsewhere (`test/kernel-oracle.js`'s "captured-then-read" row) —
though that pinned repro requires an AMBIGUOUS BOOL∪NUMBER merge value,
which `real` never is (checked — every assignment to `real` is a bare
`true`/`false` literal), so it is NOT confirmed to be literally the same
bug, only worth checking first. (2) whether
interop.js's generic "r"-marker decode should be hardened against the
raw/box bit-collision at `0x7FF8000000000000` regardless of (1) — a
narrower, more contained, JS-host-side-only fix that was DELIBERATELY NOT
attempted here: it would paper over a real compiler self-host bug rather
than fix it (this project's own "optimize the tool, never the input" /
fix-root-cause discipline), and risks masking future instances of the
SAME collision at other export sites. (1) is the real lever; (2) is a
band-aid, named only so a future session doesn't reach for it first.

### The 2-3 gaps, precisely closed out

1. **audit-#16 module-ordering: was miscounted as flag-independent — is
   NOT.** Stale native-leg assertion under `JZ_CARRIER_BOX=1` fixed;
   underlying bug (kernel leg, and the ordering root cause itself) STILL
   real, still open, unchanged.
2. **console.log heap-string: CLOSED.** Was already fixed by §24's
   CONSERVATIVE PAIRING landing after §17; this session found and pinned
   it. KNOWN-FAIL → AGREE.
3. **test:wasm item 8 (`rawField()`): STILL OPEN, root-caused more
   precisely** — write-side self-host divergence, not the read-side
   `pointsTo==='ALL'` gap every prior session assumed. Banked with the
   corrected mechanism and the two now-separated next levers.

### Gates run this session (isolated worktree `/tmp/jz-carrier-wt-gaps`,
`git worktree add --detach 4b7777c5`, `node_modules` symlinked, foreground
throughout)

- **Flag-forced battery**: `4b7777c5` baseline 3414/4 (19596 assertions,
  matching §30's own citation exactly, re-confirmed before any edit) →
  after both fixes: **3416/2 (19634 assertions)** — audit-#16 and
  console.log rows both now GREEN; the 2 survivors are the SAME
  pre-existing, `CARRIER_BOX`-unrelated interval-walk/typed-RMW rows every
  session since §14 has named, byte-identical row text to default's own 2.
  **This reaches the flip bar's own definition of PARITY: flag-forced
  fails ⊆ default fails, 2 rows each, identical rows** — confirmed in
  BOTH the isolated worktree and, independently, the shared tree (default
  leg only — no `CARRIER_BOX` build in the shared tree, per this design's
  own standing rule not to build `dist/jz.wasm` flagged there until every
  named gap closes; gap 2 keeps that rule in force).
- **Default battery**: `node test/index.js` — **3416/2 (19610
  assertions)**, unchanged pass/fail shape (the same 2 pre-existing rows),
  assertion count up by 8 vs. §30's own 19602 baseline (console.log's new
  AGREE-tier block now runs its native-only checks under default too;
  audit-#16 unchanged under default by construction) — confirmed
  identically in the worktree AND the shared tree.
- **`node test/kernel-oracle.js`**: **13/13 both flag states** (was 11/13
  under `JZ_CARRIER_BOX=1`; console.log + audit-#16 rows both closed/
  corrected) — 477 assertions default, 493 flag-forced — confirmed in
  both trees (default leg) and the worktree (both legs).
- **`JZ_CARRIER_BOX=1 kernel-parity`: 3/3 (33 assertions), byte-identical
  O0/O2/O3** — unchanged.
- **`JZ_CARRIER_BOX=1 JZ_TEST_TARGET=jz.wasm node test/index.js pointers`
  (carrier test:wasm)**: 34/35, unchanged — gap 2's single row still red,
  as expected (not fixed this session).
- **Fuzz, `JZ_CARRIER_BOX=1`**: 2 independent 2000-program sweeps
  (`--seedStart=1,2001`, `--opt=0,1,2,3`, `--inputs=20`): 30173 + 30672 =
  **60845 inputs compared, 0 divergences** — byte-identical to §30's own
  citation (this session's only `src/` change is zero — no compiler edit
  landed, only test/kernel-oracle.js — so an unchanged fuzz result is the
  expected, confirming outcome, not a coincidence).
- **Default build ×2** (worktree) **+ ×1 more** (shared tree, independent
  process) — all 3 byte-identical to EACH OTHER and to §30's own cited
  hashes: `dist/jz.js
  420596426c6b224ad07bc03ec75e2b5c5c51a3785e6cd1f0fdee7d03a985759e`,
  `dist/jz.wasm
  6fe9f1e84a3723cfe79aac616dd6797832fdf237a8cbb4c9674c6a9ec97b19b7`
  (16481.3 KB), `dist/interop.js
  ef42c9da1ab79349a5ab69d55558082de4b3d228850b87a9a188b6722ef730e1` —
  confirms the test-only change has zero effect on compiler output, as
  expected.

### Flip-readiness verdict — §11 probe: NOT READY, one concrete named blocker

The main battery reaching PARITY (flag-forced fails ⊆ default fails, same
2 rows) triggers the §11 probe per this session's mandate. A literal
`ctx.js` default-flip-and-rebuild was judged REDUNDANT rather than
skipped: `CARRIER_BOX` is a single exported const computed once from
`process.env.JZ_CARRIER_BOX`, consulted identically by every call site
regardless of whether the `true` comes from a flipped source default or a
forced env var — there is no code path in this compiler that can tell the
difference. This session's own gates (above) already exercised the
IDENTICAL "as if defaulted on" surface: a fresh `JZ_CARRIER_BOX=1
scripts/build-dist.mjs` kernel, the full flag-forced battery run against
it, `kernel-oracle`, `kernel-parity`, `test:wasm`'s `pointers.js` leg, and
2×2000 fuzz sweeps — the complete probe surface §11-§14's own historical
attempts used, with zero coverage gap a literal source-default edit would
have added.

**Verdict: NOT READY.** Gap 2 (test:wasm item 8, `rawField()` → `NaN`) is
a live, reproducible, CONFIRMED self-hosted correctness bug under
`JZ_CARRIER_BOX=1` — exactly the class of release-blocking gap `src/
ctx.js`'s own standing comment on `CARRIER_BOX` names as the bar ("a
carrier-built KERNEL corrupts generated f64 constants... do not build
dist/jz.wasm with it set until [the] finding is closed"). This session's
gap-2 work sharpened WHICH finding blocks the flip (a write-side
`anyDynKey`/`slotBigintBoxedAt` self-host divergence, not the read-side
`pointsTo==='ALL'` story §16-§30 assumed) but did not close it. The 2-row
main-battery delta reaching parity is real progress — it means every
OTHER previously-known flag-forced-only symptom is now closed or
correctly re-classified — but the flip bar is `CARRIER_BOX` producing a
CORRECT self-hosted kernel, not merely a battery-parity kernel; gap 2 is
exactly the kind of self-host-only, main-battery-invisible bug that
`JZ_TEST_TARGET=jz.wasm`/`kernel-oracle`/`test:wasm` exist to catch
precisely because the main battery cannot. **No default flip — matches
both this session's own finding and the coordinator's standing ruling.**
`CARRIER_BOX` stays `JZ_CARRIER_BOX==='1'`-gated, OFF by default,
unchanged shape from §14-§30.

**A future flip-readiness session's concrete starting point**: trace
INSIDE the running carrier kernel (trace-inject.mjs-grade instrumentation,
now genuinely warranted — this is the one gap this session's lighter WAT-
diff technique could not fully resolve) why `refineDynKeys`'s `real`
local — or whatever other site turns out to own the divergence — settles
differently for `ctx.types.anyDynKey` between a native and a self-hosted
compile of the identical `carrier-conservative-pairing-repro.js` fixture.
Once found, the fix likely closes gap 2, and by extension hardens whatever
OTHER export lane shares the same raw/box bit-collision at
`0x7FF8000000000000` (LAYOUT's own value) — worth an explicit grep for
other module-scope BigInt constants sharing this exact pathological
bit-pattern before declaring it closed.

**Local commits (shared tree, plain messages, no push).** `test/
kernel-oracle.js` only (both pin fixes, gaps 1 and 3). This ledger entry
+ `.work/todo.md` status update filed separately.

**SHAs.** Investigated at `4b7777c5` (HEAD at session start, §30's own
commit). Isolated `git worktree add --detach /tmp/jz-carrier-wt-gaps
4b7777c5` (`node_modules` symlinked, read-only); all `CARRIER_BOX`
measurement, the `JZ_CARRIER_BOX=1 scripts/build-dist.mjs` kernel build
(16531.8 KB, matching §30's own cited `CARRIER_BOX` size), and every WAT-
diff/raw-memory trace done there; removed at session end. Shared tree:
fix applied identically and committed, default `dist/jz.wasm` rebuilt for
the byte-identity gate (not committed, gitignored, matches §29/§30's own
practice) — never built `CARRIER_BOX`-flagged in the shared tree, per this
design's own standing rule (gap 2 keeps it in force).

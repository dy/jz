# BigInt retirement — design (boxed + runtime-discriminated carrier paths)

> **SUPERSEDED IN DIRECTION (2026-08-20, `.work/research.md` §"Body-write-only
> BigInt params" / §"RETIREMENT FLIP — HALTED", branch `retirement-flip`):**
> the strict-only endpoint this doc prescribes (delete boxing, refuse every
> unprovable flow) was falsified by the fixed inference surfacing 40+ lawful
> guarded-normalization sites, self-graph included — the earlier "strict
> self-graph clean" was an artifact of an unsound census adopt. Ratified
> direction (9c170a8b): the BOXED carrier stays the unconditional default,
> `JZ_BIGINT_STRICT` stays a diagnostic-only opt-in, and the retirement
> re-aims at deleting the LEGACY parallel heuristics as RepresentationPlan
> coverage is verified — the plan as sole representation authority. §4's six
> flow classes, the sink-walk inventory, and Tables A/B remain the accurate
> MAP of the machinery; only the flip-to-refuse consequence is withdrawn.

Design-only deliverable, HEAD 53b17654 (2026-08-13). No `src/` changes.
Answers the user decision made on `.work/feature-reach-census.md`'s evidence
(BigInt — all three paths, raw/boxed/runtime-discriminated — reached by
0/130 real corpus programs, census census-line 315-317): retire the boxed
carrier (`PTR.BIGINT`) and every runtime-discrimination mechanism that
exists to make an unproven BigInt flow safe at runtime; keep only the raw
i64-as-f64 carrier for statically-proven BigInt bindings, and turn every
currently-boxed/discriminated flow into a compile-time diagnostic instead.

**Thesis.** `.work/carrier-representation-design.md` built the boxed carrier
to make an *existential* runtime claim sound — "is this f64 really BigInt
bits, at a point where the static kind can't prove it" — for flows a
real program *might* take. The census answers the empirical question that
design could only estimate: across 130 real programs (bench + examples +
three named real-input graphs), that existential case has zero incidence.
The boxing/tag-dispatch cost is paid on every build — self-compile warm-perf
headroom is "already thin, ~1-3%" today (carrier-doc §7, `test/
self-compile-perf.js` `WARM_CAP` 1.03×) — for a hazard the corpus never
exercises. This is not "undo the carrier program": audit #12's own mandate
(carrier-doc line 6-8) reads "Raw i64 may remain unboxed **only while
statically proven**" — this design deletes the ELSE branch of that sentence
(the machinery built to cover the *unproven* case) and turns "unproven"
into a compile-time error instead of a runtime hazard-cover. The one place
the unproven case is real (not hypothetical) is the compiler's own
self-compiled source — §5 below measures it precisely and sequences around
it; it is not covered by the census's 130/130 claim, which explicitly
excludes the self-compile kernel subject (feature-reach-census.md line 8).

---

## 1. Scope — what retires, what doesn't (the CARRIER_BOX / carrier-box delineation)

`src/ctx.js:1070`'s `CARRIER_BOX` flag name is generic but its **entire**
call-site footprint (33 hits across the tree) is BigInt-specific: every
consumer is `isCurrentlyBoxedBigint`/`isTernaryBoxedBigint`/
`needsBigintBox`/`isProvenBoxedBigint` (`src/ir.js:635,716,770`) or a
comment referring to the same. `grep -rn CARRIER_BOX src/` has zero hits
outside BigInt boxing. **This flag, and everything it gates, is entirely
in scope for retirement.**

The BOOL∪NUMBER carrier-box mechanism — `boolBoxIR`/`unboxBoolIR`/
`TRUE_NAN`/`FALSE_NAN` (`src/ir.js:664-694`, sentinels at `:666-667`) — is
a **structurally separate, unconditional** mechanism: it is never gated by
`CARRIER_BOX`, it boxes a *different* ambiguity (a proven-BOOL value
reaching a merge/ternary/template-literal site where the joined type is
BOOL∪NUMBER — audit-#10's carrier-dispatch work, per the repo's own recent
commit `756ae10f`), and the census (row "Carrier-box (BOOL∪NUMBER
ambiguous merges) / boxed-Boolean") measures it reached by **87/130**
programs — the opposite reach profile from BigInt's 0/130. **Not touched by
this design.** Any file-by-file inventory below that also contains
`boolBoxIR`/`TRUE_NAN`/`FALSE_NAN` call sites (there are several, e.g.
`emit.js` ternary/template-literal join arms) keeps those call sites
untouched; only the BigInt-specific arms at the same sites delete.

---

## 2. Current state: TWO independently-built BigInt-discrimination mechanisms are live today, not one

Carrier-doc §5's kill-list (10 items) was written as a *proposal* against
the tree as it stood 2026-08-06, before the boxed carrier's own consumer
slices landed. Re-grepped against the current tree, **every one of those
10 legacy items is still present, verbatim**, alongside the NEW boxed-tag
machinery it was designed to replace but which was landed *alongside*, not
*instead of* (module/number.js:1594's own comment: "Landed alongside, not
replacing, that heuristic — Slice 5 retires it once every arm is
verified" — that retirement never landed). This retirement's deletion
surface is the union of both, strictly larger than carrier-doc §5 alone:

**(A) Legacy magnitude-heuristic + sentinel-export-lane** (pre-dates the
carrier program; still gated by `ctx.features.bigint`, `src/ctx.js:878`,
`src/prepare/index.js:1159-1170`):
- `emit.js` `bigIntDomain`/`isBigIntCarrierBits`/`bigIntDomainsCanMix`/
  `bigIntJointDispatch` (`:4628-4757`, ~130 lines) — guesses BigInt-ness
  from bit magnitude (finite, nonzero, subnormal `abs`) when neither
  operand's static kind is known.
- `emit.js` `TYPEOF.bigint` magnitude arm (`:536-545`).
- `module/number.js` `$__to_num`'s `ctx.features.bigint`-gated ternary
  (`:1547-1576`) — two whole function bodies, selected by a whole-program
  flag, to decide whether a subnormal f64 might be BigInt carrier bits.
- `module/core.js` `$__is_truthy`'s `ctx.features.bigint`-gated branch
  (`:163-198`).
- `kind.js` `censusBigintSentinelKind`/`censusBigintBinaryVT`/
  `censusBigintUnaryVT`/`BIGINT_JOINT_BINARY_OPS` (`:591-635,1049-1090`) —
  the export-boundary sentinel-kind census.
- `layout.js` `BIGINT_SENTINEL_KIND`/`BIGINT_SENTINEL_BITS`/
  `BIGINT_SENTINEL_VALUE` (`:223-257`).
- `interop.js` `decodeBigintSentinel` + its 3 call sites (`:175,987,1012,
  1031`), `isBox` (`:134`) + its BigInt-specific consumer branches.
- `src/compile/index.js` `_resultBigintSentinel` producer
  (`:822,1653,1667,1782`) + `synthesizeBoundaryWrappers`'s `s`-marker lane.
- `ctx.features.bigint` itself (`src/ctx.js:878`, producer
  `src/prepare/index.js:1159-1170`, ONLY two consumers `src/ir.js:1216`,
  `module/number.js:1547`) — the whole-program prescan flag whose ordering
  fragility was itself an independently-found bug (carrier-doc §1,
  "ordering-scan investigation").

**(B) New `PTR.BIGINT` boxed-tag carrier** (`CARRIER_BOX`, default ON since
carrier-doc §34 — confirmed live: `scripts/build-profile.mjs:22`'s doc
states the self-compile builder's own default is
`process.env.JZ_CARRIER_BOX !== '0'`, matching `src/ctx.js:1070`):
- `layout.js` `PTR.BIGINT = 5` (`:33`), `ptrBoxPrefixBigInt` (`:199`).
- `src/ir.js` `boxBigInt`/`unboxBigInt`/`maybeUnboxBigInt`/
  `isProvenBoxedBigint`/`isCurrentlyBoxedBigint`/`isTernaryBoxedBigint`/
  `needsBigintBox`/`isSchemaSlotBigintPossible`/`readI64` BIGINT branch
  (`:420-770`, ~350 lines including doc comments).
- `src/reps.js` `bigintBoxed` REP_FIELDS entry (`:84-92,296`).
- `src/compile/analyze.js` `markBigintSink`/`markBigintCapture`/
  `BIGINT_COLLECTION_METHODS` W-sink walk (`:671-857`, ~190 lines including
  the surrounding VAL-kind dispatch it's interleaved with).
- `src/compile/narrow.js` `bigintBoxedVerdict` fixpoint + fixpoint-
  completeness assert (`:2551-2624`), `narrowValResults`' `isBigint` arm
  (`:2849-2858`), coerceArg's `r.bigintBoxed` propagation (`:2764-2766`).
- `src/compile/bigint-boxed-stats.js` (27 lines, whole file — diagnostic
  counter, `JZ_DBG_BIGINT_STATS`-gated, "not part of the production compile
  path" per its own header).
- `src/compile/erasure-diag.js` (205 lines, whole file — `scanErasureSinks`
  W-sink diagnostic, `JZ_DBG_BIGINT_ERASURE`-gated).
- `module/schema.js` `slotBigintBoxedBySid`/`slotBigintBoxedAt`/
  `slotBigintProvenBySid`/`slotBigintProvenAt` (`:441-534`).
- `src/ctx.js` `slotBigintObserved` SlotFact field (`:561-609`, doc + the
  `observeProgramSlots` producer it documents).
- `module/core.js` `$__eq`'s PTR.BIGINT content-compare arm (`:104,135`),
  `emitSchemaSlotRead`'s `bigintProven` param + arm (`:1696-1740` and its
  4 call sites at `:1973,1982,2022,2152`), `$__is_truthy`'s PTR.BIGINT arm
  (`:180-198`, entangled with legacy (A) in the same `ctx.features.bigint`
  ternary — see Table B below).
- `module/number.js` `$__to_num`'s CARRIER PROGRAM Slice-3 PTR.BIGINT arm
  (`:1588-1597`, entangled with (A)'s ternary at the SAME call — Table B).
- `module/collection.js` `__sclone_rec` BIGINT region-forwarding arm
  (`:1937-1944`), `$__map_hash`'s BIGINT content-identity arm
  (`mapHashBigintArm`, `layout-kinds.js:175-181`), `LENGTH_SSO_I64`-style
  identity-chain BIGINT ordering (`sameValueZeroIdentityChain`,
  `layout-kinds.js:100-153`).
- `layout-kinds.js` `KIND_REGISTRY.BIGINT` entry (`:58`) — one row of a
  shared multi-kind registry driving STRING/BIGINT content-identity
  generators; **partial edit**, not a file deletion (STRING's row and the
  generator functions themselves stay for STRING).
- `test/pointers.js` §347-380 whole "BigInt carrier boxing" test block
  (~160 lines: box/unbox roundtrip pins, PTR.BIGINT disjointness,
  ternaryBoxedNames repro, §15/§16 schema-slot pins, CONSERVATIVE PAIRING
  pin — see §7).

---

## 3. Deletion surface

### Table A — clean deletions (BigInt-exclusive; whole function, whole file, or whole gated block)

| # | File | What | Size |
|---|---|---|---|
| 1 | `src/compile/bigint-boxed-stats.js` | whole file | 27 lines |
| 2 | `src/compile/erasure-diag.js` | whole file | 205 lines |
| 3 | `src/ir.js` | `boxBigInt`, `unboxBigInt`, `maybeUnboxBigInt`, `isProvenBoxedBigint`, `isCurrentlyBoxedBigint`, `isTernaryBoxedBigint`, `needsBigintBox`, `isSchemaSlotBigintPossible` + their doc comments | ~350 lines (`:420-770`) |
| 4 | `src/reps.js` | `bigintBoxed` field + its `@property` doc | ~10 lines (`:84-92`) + `REP_FIELDS` entry |
| 5 | `src/compile/analyze.js` | `markBigintSink`/`markBigintCapture`/`BIGINT_COLLECTION_METHODS` + call sites | ~90 lines (`:671-857`, net of interleaving) |
| 6 | `src/compile/narrow.js` | `bigintBoxedVerdict` + assert, `bigintBoxed` propagation in `coerceArg`/param-seed paths | ~90 lines (`:2551-2624,2764-2766`) |
| 7 | `module/schema.js` | `slotBigintBoxedBySid`/`slotBigintBoxedAt`/`slotBigintProvenBySid`/`slotBigintProvenAt` | ~55 lines (`:441-534`) |
| 8 | `src/ctx.js` | `slotBigintObserved` SlotFact field + doc | ~10 lines (`:561-609` net) |
| 9 | `emit.js` | `bigIntDomain`/`isBigIntCarrierBits`/`bigIntDomainsCanMix`/`bigIntJointDispatch` | ~130 lines (`:4628-4757`) |
| 10 | `emit.js` | `TYPEOF.bigint` magnitude arm | ~10 lines (`:536-545`) |
| 11 | `kind.js` | `censusBigintSentinelKind`/`censusBigintBinaryVT`/`censusBigintUnaryVT`/`BIGINT_JOINT_BINARY_OPS` | ~60 lines (`:591-635,1049-1090`) |
| 12 | `layout.js` | `BIGINT_SENTINEL_KIND`/`BIGINT_SENTINEL_BITS`/`BIGINT_SENTINEL_VALUE`, `PTR.BIGINT` tag itself, `ptrBoxPrefixBigInt` | ~40 lines (`:33,199,223-257`) |
| 13 | `interop.js` | `decodeBigintSentinel` + 3 call sites, `isBox`'s BigInt-only consumer branches | ~30 lines (`:134,175,213,407,515,801,806,987,1012,1031`) |
| 14 | `src/compile/index.js` | `_resultBigintSentinel` producer + `synthesizeBoundaryWrappers` `s`-marker lane | ~40 lines (`:822,1653,1667,1767,1782,2709,2711`) |
| 15 | `src/ctx.js` + `src/prepare/index.js` | `ctx.features.bigint` flag: field, producer scan, both consumers | ~15 lines (`ctx.js:878`, `prepare/index.js:1159-1170`) |
| 16 | `test/pointers.js` | whole "BigInt carrier boxing" test section | ~160 lines |
| 17 | `test/data.js` | audit-#11 P0-1 divergence-class test | ~20 lines (see §7 — deleted, not converted) |
| 18 | `test/dyn-keys.js` | Slice-5 BigInt-materialization + mixed-Map negative-control tests | ~40 lines (converted to expect-error, see §7) |

**Table A total: ~1,380 lines of source + tests**, before the self-compile
kernel-source rewrite (§5) or Table B's partial edits.

### Table B — partial edits (BigInt arm deletes; the file's other-kind machinery stays)

| # | File | Site | What survives |
|---|---|---|---|
| 1 | `module/number.js` | `$__to_num`'s `ctx.features.bigint`-gated ternary (`:1547-1576`) | collapses to the single unconditional "every non-NaN f64 is a genuine Number" arm (today's `false`-branch) — 30 lines → ~4. `__num_to_bigint`/`__to_bigint`/`.bigint:toString`/`asIntN`/`asUintN` (`:1692-1880`) **stay unchanged** — these are raw-i64 conversion primitives, never boxed, orthogonal to this retirement |
| 2 | `module/core.js` | `$__is_truthy`'s BIGINT arm (`:163-198`) | collapses to the non-BigInt truthiness chain (NULL_NAN/UNDEF_NAN/FALSE_NAN check only) |
| 3 | `module/core.js` | `$__eq`'s PTR.BIGINT content-compare arm (`:104,135`) | the exact-bits fast path and every other kind's compare arm stay |
| 4 | `module/core.js` | `emitSchemaSlotRead`'s `bigintProven` param (`:1696-1740`) | function stays for `i32Certain`/other schema-slot reads; the BIGINT-specific branch deletes, the `bigintProven` argument at all 4 call sites (`:1973,1982,2022,2152`) deletes |
| 5 | `module/collection.js` | `__sclone_rec`'s BIGINT region-forwarding arm (`:1937-1944`) | ARRAY/HASH/SET/MAP/STRING arms stay |
| 6 | `layout-kinds.js` | `KIND_REGISTRY.BIGINT` row (`:58`) + BIGINT branches in `sameValueZeroIdentityChain`/`eqIdentityChain`/`mapHashBigintArm` (`:100-181`) | STRING's row/branches stay; `CONTENT_IDENTITY_ORDER` assert (`:105`) narrows from a 2-element to a 1-element (`['STRING']`) invariant |
| 7 | `src/type.js` | BigInt bitwise-narrowing veto (`:2179-2309`, "BIGINT gate") | **stays, unmodified** — not BigInt-boxing machinery at all; it prevents narrow.js from i32-narrowing a proven-BIGINT local's `~`/`&`/shift result to a real wasm i32, which stays load-bearing for raw i64 BigInt arithmetic under this retirement exactly as it is today. Flagged here only to state explicitly it is NOT part of the deletion surface, since it's the one BigInt-adjacent mechanism in a file the task lists as "context to absorb" |
| 8 | `src/param-reps.js` | — | **zero BigInt-specific code exists here** (`grep -ci bigint` = 0). `mergeParamFact` treats `VAL.BIGINT` like every other `VAL.*` kind — no special case to delete. Confirms the field was scoped correctly at design time: BigInt-boxing lives entirely in `reps.js`/`analyze.js`/`narrow.js`, never in the param-fact meet itself |

---

## 4. The kept-raw-i64 contract

**Stays compilable, unconditionally, exactly as today's raw-carrier path
already works:**
- BigInt literal syntax (`5n`), parsed as `['bigint', decimalStr]`
  (`parse.js`, unchanged — not carrier machinery, a syntax node).
- `BigInt(x)` / implicit ToBigInt coercions from a provably-Number or
  provably-String source, and `Number(bigintVal)`/unary `+` ToNumber
  coercion of a provably-BIGINT source — both already raw-i64-in/raw-i64-
  or-f64-out primitives (`__num_to_bigint`, `__to_bigint`, `module/
  number.js:1696-1880`), never boxed.
- BigInt arithmetic and bitwise ops (`+ - * / % & | ^ << >> ~` unary `-`)
  between two statically-BIGINT operands — the `i64.*` op family
  `bigIntOperand`/`bigIntUnary` already lower to, unconditionally.
- Comparison (`== === < > <= >=`) between two statically-BIGINT operands.
- `.toString(radix)`, `BigInt.asIntN`/`asUintN`.
- `BigInt64Array`/`BigUint64Array` typed-array element read/write — each
  element's kind is fixed by the array's ctor at every read (no dynamic
  ambiguity the way a dict/Map value has), so this needs no boxing today
  and needs none after retirement either.
- Any of the above where **every** use of the resulting BIGINT value is
  itself one of the above, transitively, for the value's entire lifetime.

**Becomes a compile-time error — reusing the EXACT same detection the
boxed carrier's fixpoint already computes, with its consequence flipped
from "insert a box" to "throw a diagnostic":** any BIGINT-kinded value
reaching a kind-erasing sink where the static kind cannot be proven
uniformly BIGINT at that point. Concretely, the same six flow classes
`analyze.js`'s `markBigintSink`/`narrow.js`'s `bigintBoxedVerdict` already
enumerate (§2 items 5-6 above), each becomes its own named diagnostic:

| Flow class | Example that now errors | Diagnostic names |
|---|---|---|
| call-arg | a function whose param sometimes receives a BigInt, sometimes a Number, from different call sites | the callee name, the param index, both observed kinds |
| return | a function whose return tail is BigInt on one path, something else on another | the function name, the disagreeing return sites |
| closure-capture | an arrow function capturing an outer BigInt binding across a closure boundary the fixpoint can't resolve | the captured binding name, the closure's declaration site |
| collection (dyn-prop / array-elem / Set / Map) | `d[k] = 5n` with an unresolvable key, `map.set(k, 5n)`, `arr.push(bigintVal)` into a heterogeneous array | the receiver expression, the store site |
| ternary-nullish | `cond ? BigInt(x) : null` | the ternary's own site |
| dataview | `dv.setBigInt64(...)`/`dv.getBigInt64(...)` on an unresolvable receiver | the DataView call site |

The error message names the flow class, the binding/function/site
involved, and the offending kinds observed — matching the fail-fast
requirement exactly: the value never produces a silently-wrong runtime
answer (no magnitude guess, no tag-dispatch fallback) — the compile
refuses, with a specific, actionable diagnostic. This is a smaller change
to the fixpoint machinery than it sounds: `markBigintSink`/
`bigintBoxedVerdict` already walk to precisely these sites today to decide
*whether* to box; only the action at the walk's leaf changes.

**Explicitly still out of scope, unaffected by this retirement** (per
carrier-doc §5's own "not touched" note, still true): `__to_bigint`'s
separate pass-through gap (round-3 risk 4) and `__same_value_zero`/
`__map_hash`'s BigInt arm completeness — pre-existing, narrower issues,
not created or worsened by deleting the boxed carrier.

---

## 5. Self-compiling interaction — the load-bearing risk, confirmed live

**The self-compiled compiler source itself uses real BigInt syntax.** 21
genuine files (of 25 raw `grep -lE '[0-9]n\b|BigInt\('` matches; 4 false
positives per the historical 84-site scrub — `bignum.js`, `compile/
index.js`, `prepare/index.js`, `snapshot.js` — confirmed still false
positives by direct inspection this session), ~150 occurrences, spanning
`src/prepare/math-kernel.js`'s exact-bit IEEE754 mantissa/exponent folding
("genuinely hard to do without BigInt," carrier-doc line 197), `layout.js`'s
own `i64Hex`/`ptrBits` helper family, `src/wat/assemble.js`, `src/kind.js`,
`src/parse.js`, `src/ctx.js`, `src/snapshot.js`. All of `src/prepare/*`
(including `math-kernel.js`) is itself part of `scripts/self.js`'s module
graph, so this is not incidental — it is `jz` compiling BigInt-using code
about itself.

**Today's standard self-compile build already relies on the boxed carrier to
succeed.** A live probe (carrier-doc §1, re-verified this session against
the same mechanism) against the current 149-module self-compile graph found
57 real BIGINT-value erasure flows; the fixpoint resolves 46 of them fully
raw, but **11 sites settle `bigintBoxed=true`**: 10 one-time module-init
`const` bindings (`m113_assemble`'s `NAN_PREFIX`/`TAG_SHIFT_BIG`/
`TAG_MASK_BIG`/`AUX_SHIFT_BIG`/`SSO_BIT_BIG`/`OFFSET_MASK_BIG`, `m50_encode`'s
`F64_SIGN`/`F64_NAN`/`F64_QUIET`, plus one `bif176_4`) and 1 param
(`m61_layout$i64Hex`'s `bits` — called from ~9 sites, no single call site
provably uniform). **This is not hypothetical:** `scripts/build-
profile.mjs`'s `resolveSelfCompileBuild` (the shared config resolver used by
both `build-dist.mjs` and `self-compile-build.mjs`) defaults `carrierBox` to
`process.env.JZ_CARRIER_BOX !== '0'` — i.e. **ON** for the standard
`dist/jz.wasm` build — so these 11 sites go through the real boxed carrier
in the artifact that actually ships today.

**Consequence for sequencing.** Deleting the boxed carrier before these 11
sites are addressed does not merely regress a benchmark — it makes
`scripts/self.js` **fail to compile** under §4's contract (each of the 11
becomes exactly the "call-arg"/"collection" flow-class error §4 defines).
This falls entirely outside the census's 130/130 byte-identity guarantee:
`feature-reach-census.md`'s own scope line explicitly excludes "the
self-compile kernel build `bench/jz/jz.js` = `scripts/self.js` subject" (line
8) — self-compiling is the one place in this repository that legitimately,
currently, exercises BigInt, and it is not covered by "0/130 reach."

**Required precondition, its own migration slice, before any deletion
slice lands:** rewrite the 11 sites in the self-compiled source so the
fixpoint resolves them raw without the boxed carrier's help. Two concrete
paths, both already named as plausible by carrier-doc's own measurement
(line 74, "plausible `src/snapshot.js` init-snapshot candidates — the
build already snapshots module-init state ahead of `_start`"):
- The 10 module-init constants: fold them at snapshot/init time via
  `src/snapshot.js`'s existing pre-eval mechanism (already used for other
  module-init state), so they never reach a live W-sink as *runtime*
  values at all — they become baked snapshot data, not a fixpoint question.
- `m61_layout$i64Hex`'s param: either split it into a genuinely
  single-call-site-provable specialization per hot call site (the
  `i64Hex`-family sibling helpers — `objectSchemaGuardHex`/
  `atomNanHex`/`ssoBitI64Hex`/etc. — already stay 100% raw precisely
  because *their* reach-sets are pure local arithmetic; `i64Hex` itself is
  the one shared multi-call-site entry point), or accept a narrow,
  explicitly-documented duplication (one raw-provable variant per call
  site) — a source-level decision for whoever executes this slice, out of
  this design's authority to pre-select.

**Gate for that slice, before it's considered done:** self-compile build
succeeds (`scripts/self-compile-build.mjs`/`scripts/build-dist.mjs`), `dist/
jz.wasm` SHA-256 converges across repeat builds, and kernel-parity/
kernel-oracle batteries stay green — measured with the OLD boxed carrier
still present (so the rewrite's own correctness is isolated from the
retirement), THEN re-measured with the boxed carrier's deletion slice
applied on top. If the rewrite cannot get all 11 sites to a raw-provable
state, this retirement cannot proceed to the deletion slices without
either accepting a hand-maintained self-compile-only exception (rejected,
§10) or leaving self-compiling broken (rejected, blocks the project's own
build).

---

## 6. jzify and RepresentationPlan — interaction risks

**jzify: confirmed no interaction, not merely assumed.** `grep -rn -i
bigint jzify/*.js` returns exactly one hit: `jzify/transform.js:1`, a
`BigInt64Array`/`BigUint64Array` ctor-name string inside a typed-array
allowlist (unrelated to lowering — never constructs, types, or reasons
about a BigInt *value*). jzify's own desugaring (class/async/generator →
plain objects + arrow-captured methods + state machines) never synthesizes
a BigInt anywhere. This retirement has zero jzify-lowering surface.

**RepresentationPlan: does not exist in source yet — assumptions stated
explicitly, per instruction not to pin line numbers in `narrow.js`/
`static.js`.** `grep -rn RepresentationPlan src/` is empty; `.work/todo.md`
line 10154 lists "RepresentationPlan provenance · whole-graph discovery ·
fact/session/variant/loop ownership" as items 5-7 of a **standing queue**,
unlanded, following the same "session-owned plan map, frozen before
consumption" discipline `ClosureEnvPlan`/`ClosureId` already landed
(audit-#19 P0, `.work/todo.md`). `narrow.js`/`static.js` are confirmed
in-flight from another agent right now ("agent's narrow.js/static.js work
is still uncommitted there," `.work/research.md:5437`) — consistent with
the task's own instruction to name `bigintBoxedVerdict`/the BigInt gate by
function, not by line, in both files.

Stated assumption: RepresentationPlan is expected to reformalize
per-binding `REP_FIELDS`-style facts (of which `bigintBoxed` is one
instance, alongside `nullable`/`carrier`/`typedCtor`) into a frozen,
session-owned plan, mirroring `ClosureEnvPlan`'s own precedent. **Deleting
`bigintBoxed` and its two schema-fact twins (`slotBigintBoxedAt`/
`slotBigintProvenAt`) now, before RepresentationPlan lands, removes one
entire field-class from RepresentationPlan's eventual migration scope** —
a net simplification for that future work, not a conflict with it. No
existing RepresentationPlan design commits to preserving `bigintBoxed`'s
existence (none exists to commit to anything yet); if a future
RepresentationPlan design disagrees with this assumption, that is for its
own doc to state when it lands — outside this design's authority to bind.

---

## 7. Test / conformance impact

**test262: zero tally change, in both directions.** Both runners already
pre-classify every BigInt-touching test as unsupported/out-of-scope by
**content detection**, before any compile is attempted:
- `test/test262.js:433-435`: `if (/\bBigInt\b/.test(content) ||
  /\b\d+n\b/.test(codeContent)) return 'BigInt unsupported'` — plus
  `/\bBigInt\b/i` sits in all three exclusion pattern lists
  (`EXCLUDED_PATTERNS:202`, `CLASS_EXCLUDED_PATTERNS:215`,
  `GENERATOR_EXCLUDED_PATTERNS:226`).
- `test/test262-builtins.js:169,742`: `'BigInt'` listed among excluded
  builtins, `['built-ins/BigInt/', 'BigInt arithmetic/coercion — out of
  scope (no BigInt type)']`.

`test/test262-baseline.json`'s `language:3000`/`builtins:852` floors were
measured with BigInt **already** fully excluded (`grep -ic bigint
test262-baseline.json` = 0). **No test262 row currently passes via any
BigInt path — boxed, discriminated, or raw — so there is nothing to
re-pin as xfail, and the baseline floors do not move.** The exclusion
patterns themselves are test-harness classification logic, not BigInt-
carrier machinery, and stay untouched by this retirement.

**test/pointers.js**: the whole "BigInt carrier boxing" test section
(box/unbox roundtrip pins including the max/min i64 boundary and the
box-shaped-bits-re-boxed hazard pin, `PTR.BIGINT` disjointness, the
`ternaryBoxedNames` false-positive repro, the §15/§16 schema-slot
unboxing pins, the CONSERVATIVE PAIRING pin) **deletes outright** — every
test in it exercises `boxBigInt`/`unboxBigInt`/`isProvenBoxedBigint`/
`PTR.BIGINT`/`isSchemaSlotBigintPossible`, all retired, and none of them
pin a shape that survives in any form (the `__box_bigint`/`__unbox_bigint`
test-only intrinsics themselves are jz-source hooks onto the deleted
functions — nothing to re-target them at).

**test/dyn-keys.js**: the Slice-5 tests ("bare Map/dict .get()/[] read
materializes the true BigInt across the export boundary," "mixed-kind Map
falls back to documented (unfixed) behavior") **convert to expect-error**,
not delete — the *shapes* they pin (`m.set('x', 5n); return m.get('x')`;
a Map mixing BIGINT and NUMBER values) are exactly the "collection" flow
class §4 defines, and remain valuable negative-space coverage: after
retirement, both must produce the named compile-time diagnostic (§4's
table), not a runtime value. Convert `is(mapMod.exports.f(), 5n)`-style
assertions to `throws(() => jz(src), /collection.*BigInt/)`-style
assertions naming the new diagnostic.

**test/data.js**: `'audit-#11 P0-1: bigint-using-program carrier
divergence — DOCUMENTED, still open by design (not a regression)'`
**deletes outright, not converted** — the divergence class it pins (a
genuine subnormal Number, `5e-324`, silently misread as a BigInt carrier
inside a dict-shaped/mixed-array-element coercion, because the legacy
magnitude heuristic can't distinguish the two 64-bit patterns) becomes
**structurally impossible** once an unprovable BigInt flow is a compile
error instead of a runtime guess — there is no longer a magnitude
heuristic left to fool. This is a genuine correctness improvement the
retirement buys (§8), not merely a size reduction: a documented, "open by
design," permanently-accepted wrongness class is eliminated at the root,
not narrowed. The file's OTHER BigInt pins (return-boundary roundtrip,
`i64Hex` 2^64-1 boundary literal, "internal calls keep the i64 carrier")
**stay unchanged** — pure raw-i64 arithmetic/export, unaffected by this
retirement.

**test/self-compile-perf.js**: no direct BigInt hits; the `WARM_CAP` (1.03×)
gate must be **re-measured**, not assumed, at the deletion slice — removing
box/unbox/tag-dispatch codegen should only ever reduce warm cost, but
§5's kernel-source rewrite (landing first) touches the same 11 sites and
could itself shift cost slightly; re-gate at each slice, don't assume net
zero.

---

## 8. Size / complexity payoff estimate

| Category | Lines removed (estimate) | Basis |
|---|---|---|
| Table A clean deletions (source) | ~1,160 | §3 Table A items 1-15, summed |
| Table A clean deletions (tests) | ~220 | §3 Table A items 16-18 |
| Table B partial edits (net delta) | ~60-80 | §3 Table B, arm-sized deltas, not whole functions |
| Self-compile kernel-source rewrite (§5) | net ~0, possibly slightly negative (new snapshot-fold code) | not a deletion — a precondition; sized separately, not part of this payoff |
| **Total source + test** | **~1,440-1,460 lines** | sum of the above, excluding §5 |

**Schema-fact slots freed**: 3 (`ValueRep.bigintBoxed`; `SlotFact.
bigintObserved`; the two `ctx.schema.slotBigintBoxedAt`/
`slotBigintProvenAt` accessor pairs collapse to zero — 4 named
fields/accessors total across `reps.js`, `ctx.js`, `module/schema.js`).

**Emit arms removed**: ~9 distinct dispatch arms across `emit.js`/
`module/core.js`/`module/number.js`/`module/collection.js` (TYPEOF.bigint,
`$__to_num`'s two-arm ternary → one arm, `$__is_truthy`'s BIGINT branch,
`$__eq`'s PTR.BIGINT arm, `emitSchemaSlotRead`'s bigintProven arm,
`__sclone_rec`'s BIGINT arm, `$__map_hash`'s BIGINT arm, the
`bigIntDomain`/`bigIntJointDispatch` runtime-domain-guess apparatus wired
at 9 binary ops per carrier-doc's own count).

**Kernel size delta guess**: every one of Table A's runtime-emitted arms
(items 9-14 — `bigIntDomain`/`bigIntJointDispatch`, `TYPEOF.bigint`,
sentinel encode/decode, `$__eq`/`$__is_truthy`/`emitSchemaSlotRead`/
`__sclone_rec`/`$__map_hash` BIGINT branches) only ever emits into a
compiled module when the source program constructs a BigInt somewhere
(`ctx.features.bigint`-style gating already scopes most of it; the
boxed-carrier arms are similarly dead-code-eliminated for a BigInt-free
program via the same "no program lacking `ctx.features.bigint` can ever
construct a `PTR.BIGINT` box" argument `module/core.js:163-172` already
documents). **For the 130-program census corpus specifically, none of
these arms currently emit any bytes at all** (0/130 BigInt reach) — so the
`.wasm` size delta for every real corpus program is **exactly zero
bytes**, before and after. The delta is real only for a BigInt-constructing
program (which no corpus program is) and for the self-compiled kernel itself
(§5) — where the delta is a handful of arms at the ~11 rewritten call
sites, not a broad shrink.

---

## 9. Migration slices — numbered, independently gated, byte-identical for every non-BigInt program at every slice

Per this repo's own convention (`.work/lattice-design.md §5`,
`.work/carrier-representation-design.md §7`): each slice lands
independently, each states its own warm/byte-identity gate. **The 130-
program census corpus (bench + examples + jessie/watr/jzify-entry) must
stay byte-identical at every slice — it never constructs a BigInt, so no
slice below should ever change one byte of its output.** The self-compiled
kernel (`scripts/self.js`) is the sole exception requiring its own gate,
called out per-slice.

**Slice 0 — self-compile kernel-source rewrite (§5), lands FIRST, before
anything below.** Rewrite the 11 `bigintBoxed=true` sites
(`m113_assemble`/`m50_encode`'s module-init consts via snapshot-fold;
`m61_layout$i64Hex`'s param via specialization or documented duplication)
so the fixpoint resolves all 57 real erasure flows fully raw. **Gate**:
self-compile build succeeds, `dist/jz.wasm` SHA-256 converges across repeat
builds, kernel-parity/kernel-oracle green — all measured with the OLD
boxed carrier still present (isolates the rewrite's own correctness).
Byte-identity: the 130-corpus is untouched by a self-compile-only source
change — confirm anyway, zero-risk check.

**Slice 1 — flip consequence, not mechanism: `bigintBoxed=true` verdicts
become compile errors instead of box insertions.** Repurpose
`markBigintSink`/`bigintBoxedVerdict` (their WALK stays identical) to
throw the named diagnostics from §4's table instead of setting
`bigintBoxed=true`/inserting `boxBigInt`. **Gate**: self-compile kernel
(post-Slice-0) compiles clean with zero diagnostics fired (proves Slice 0
was complete); 130-corpus byte-identical (proves the walk itself changes
nothing for a program that was always raw); every native test in
`test/dyn-keys.js`'s converted set (§7) now throws the expected
diagnostic.

**Slice 2 — delete the boxed-carrier consumer machinery** (§3 Table A
items 3, 7-14 — `boxBigInt`/`unboxBigInt`/`isProvenBoxedBigint`/etc.,
`slotBigintBoxedAt`/`slotBigintProvenAt`, the sentinel-lane/legacy-
magnitude apparatus, `ctx.features.bigint`). Nothing calls any of it after
Slice 1 (verified by grep: zero remaining call sites, not just zero
*exercised* call sites). **Gate**: self-compile build succeeds unchanged
(Slice 0 already made it not need this machinery); 130-corpus byte-
identical; full native + test262 batteries green with the counts in §7
unchanged.

**Slice 3 — delete the fact/diagnostic infrastructure itself** (§3 Table
A items 1-2, 4-6 — `bigint-boxed-stats.js`, `erasure-diag.js`,
`bigintBoxed` REP_FIELDS entry, `markBigintSink`/`markBigintCapture`,
`bigintBoxedVerdict`'s fixpoint scaffolding, `slotBigintObserved`) —
replaced by the (smaller) direct-error walk Slice 1 already installed.
**Gate**: same as Slice 2, plus confirm `JZ_DBG_BIGINT_STATS`/
`JZ_DBG_BIGINT_ERASURE` env vars are dead (no remaining reader).

**Slice 4 — Table B partial edits** (module/number.js `$__to_num`,
module/core.js `$__is_truthy`/`$__eq`/`emitSchemaSlotRead`, module/
collection.js `__sclone_rec`, `layout-kinds.js` `KIND_REGISTRY.BIGINT`
row). Each is a small, independent arm-removal inside a file whose other-
kind machinery is untouched — can land as one slice or several per
reviewer preference. **Gate**: per-file, same battery; `layout-kinds.js`'s
`CONTENT_IDENTITY_ORDER` assert narrows from 2 elements to 1
(`['STRING']`) — a deliberate, visible signal the BIGINT identity-arm is
gone, not silently dropped.

**Slice 5 — test cleanup** (§7): delete `test/pointers.js`'s BigInt-carrier
section and `test/data.js`'s audit-#11 P0-1 test; convert `test/
dyn-keys.js`'s Slice-5 tests to expect-error (this may need to land
*before* Slice 1-3 structurally, since the converted assertions are what
Slice 1's gate checks — sequencing note, not a hard requirement: the
conversion can be written and land as a no-op-passing test against
TODAY's tree first, since the current boxed carrier already produces the
"materializes correctly" behavior these tests pin, so writing the
expect-error variant ahead of time and having it initially skip/xfail is
safe).

---

## 10. Rejected alternatives

- **Keep the runtime-discriminated path as defense-in-depth, delete only
  the boxed-tag storage.** Rejected: the discrimination (magnitude guess
  or tag check) is exactly the mechanism whose cost the census shows is
  unpaid-for — keeping the runtime check without the box it protects
  either does nothing (nothing to discriminate once nothing is ever
  boxed) or reintroduces the pre-carrier-program magnitude heuristic's own
  documented wrongness (test/data.js's now-deleted audit-#11 P0-1 class).
  A partial retirement keeps the correctness hazard AND most of the cost.

- **Keep `bigintBoxed`/`PTR.BIGINT` alive, scoped ONLY to the self-compiled
  kernel's own compile, via a hidden always-on internal flag.** Rejected:
  this is a hand-maintained exception that only the compiler's maintainers
  would remember exists, contradicts "one raw-i64 contract, one diagnostic
  for everything else," and Slice 0's rewrite makes it unnecessary — the
  actual footprint (11 sites) is small enough to fix at the source, not
  paper over with a permanent carve-out.

- **Retire boxing but keep the export-boundary sentinel lane
  (`_resultBigintSentinel`/`decodeBigintSentinel`) as a cheaper partial
  fix.** Rejected: the sentinel lane exists ONLY to disambiguate an
  export value whose STATIC kind can't be proven BIGINT vs. something
  else — exactly the case this design turns into a compile error instead.
  With the ambiguous case erased at compile time, the sentinel lane has
  no remaining input to ever fire on; keeping it would be dead code from
  the moment Slice 1 lands, not a smaller fix.

- **Convert `test/pointers.js`'s BigInt section to expect-error instead of
  deleting.** Rejected for that specific file (unlike `dyn-keys.js`):
  every test in it exercises the box/unbox PRIMITIVES directly
  (`__box_bigint`/`__unbox_bigint`, `PTR.BIGINT` tag values) — there is no
  "the shape should now error" version of "does box/unbox roundtrip
  correctly," because the primitives themselves are gone, not their
  callers. `dyn-keys.js`'s tests, by contrast, pin a *source shape*
  (`m.set('x', 5n)`) that still parses and still means something (now: an
  error) — the distinction is "tests a deleted primitive directly" (delete)
  vs. "tests a source shape whose outcome changes" (convert).

- **Sequence the self-compile rewrite (Slice 0) AFTER the deletion slices,
  accepting a temporarily-broken self-compile build.** Rejected: this
  repository's own convention (every carrier-program slice in `.work/
  carrier-representation-design.md §7` gates on self-compile build success at
  every step) treats a broken self-compile build as a stop-ship condition,
  not a temporary state to tolerate mid-migration — Slice 0 must land
  first, verified independently, exactly as sequenced in §9.

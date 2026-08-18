# Walk-count reduction — measurement + design (2026-08-17)

Adopted from the v1 audit's pipeline finding: plan-middle traversal volume is
the shared root of (a) the memory endgame (churn → region-exit → recopy tax →
the 4 GiB jz×jz wall, `2a40d7b2`'s own "51 of ~53 exits survived, goal gate
NOT MET") and (b) the pipeline-optimality bar generally. Grounded at main tip
`a981e6e0`. Measurement-only — no `src/` changes ship; every number below is
either freshly measured this session (labeled **measured**) or cited from a
prior session's own ledger entry (labeled **cited, `<sha>`**). Nothing is
guessed.

## 0. Method

Per the brief's own pointer (`259cd4fc`'s ledger entry, §Method): the
`compile()` `profiler` parameter is the load-bearing seam — already
dual-purpose-safe (native AND self-compile), already wired through `plan()`'s
own `t(name, fn)` helper (`src/compile/plan/index.js:87`) into every named
pass. Three disposable instruments, built in a worktree
(`git worktree add … a981e6e0`, node_modules symlinked from main), all
reverted before this file was written — `git -C <worktree> diff` confirmed
clean except this file itself was never present there:

1. **Site 1** (`src/compile/analyze.js`, `analyzeBody`'s 929-971 region):
   wrapped each of the 8 named sub-passes in `process.hrtime.bigint()`,
   accumulating `{calls, ns}` into `globalThis.__WC1` — a no-op (identical
   code path) whenever that global is unset, so normal `npm test` runs are
   provably unaffected by the instrumentation's mere presence.
2. **Site 2** (`src/compile/analyze.js`, `analyzeBody`'s cache-miss
   fall-through, right after the existing `hit` check): recorded one tally
   into a `Map<body, count>` (`globalThis.__WC2`) per full recompute,
   regardless of which of the several call sites (`index.js` ×2, `narrow.js`
   ×2, …) triggered it — the cache-miss point is the single choke point
   every caller funnels through, so this subsumes per-call-site
   instrumentation without touching each site individually.
3. **Site 3**: zero source edits needed for time — `index.js`'s existing
   `opts.profile` sink already surfaces every `plan:*` named phase. For
   **byte churn**, `compileProfiler` (`index.js:119`) was extended (behind a
   `globalThis.__WC3_MEM` flag, default off) to force `gc()` and read
   `process.memoryUsage().heapUsed` before/after each named phase —
   the exact "`--expose-gc`-forced before/after each named phase" technique
   `d08d5968`'s own session used, applied fresh here via the profiler seam
   instead of a WAT-breadcrumb splice (no wasm kernel build needed for a
   **native**-only reading).

Driven via `resolveModuleGraph` + the public `compile()` (mirroring
`bench/bench.mjs`'s own `compileJzAt`, `optimize:'speed'`, `jzify:true`) on
two graphs: **jessie** (47→48 modules incl. patched benchlib) and **jz×jz**
(156→160 modules, jz compiling its own compiler — `bench/jz/jz.js` →
`scripts/self.js`, same self-graph every `.work/research.md` §Region arena
session uses). This is a **native single compile** of the self-graph (no
wasm kernel build, no self-compiled execution) — cheap enough to run
foreground: jessie 1.9 s, jz×jz 272.0 s (`--max-old-space-size=8192`).

All native `heapUsed`/`hrtime` numbers below are **V8 host-process**
measurements — a different unit from the self-compiled **wasm linear-memory**
churn tables `fa9fcc1a`/`d08d5968` measured (those read `$__heap`/
`memory.buffer.byteLength` inside the wasm instance jz's OWN compiler runs
as). The two are never added together below; where both exist for the same
pass they are compared as *shares*, the convention `097a51d7`'s own session
already established for exactly this native/self-compile split.

## 1. Site 1 — `analyzeBody`'s 8 traversals (`src/compile/analyze.js:929-971`)

### 1.1 The count, verified at current tip

Exactly 8 distinct full-body traversal calls, back-to-back, inside one
`analyzeBody` invocation:

| # | call | line | gated? |
|---|---|---|---|
| 1 | `walk(body)` | 929 | no |
| 2 | `stampCoInductionRanges(body)` | 935 | no |
| 3 | `widenLocalTypes(body, locals)` | 936 | no |
| 4 | `narrowUint32(body, locals)` | 941 | no |
| 5 | `scanNumericFill(body, numericFillRhs)` | 953 | no |
| 6 | `scanFlatObjects(body)` | 960 | `doSchemas` |
| 7 | `scanSliceViews(body)` | 968 | `doSchemas` |
| 8 | `scanNeverGrown(body)` | 971 | `doSchemas` |

No shared generic walker exists (`src/ast.js` has none) — each of the 8 is
its own hand-written recursive descent over the same node shape. This is
itself evidence for "historical accretion": a shared visitor was never
built, so each new fact family got its own full pass instead of a dispatch
arm in an existing one.

### 1.2 Measured — calls and wall time, per sub-pass (**measured**)

`doSchemas` is true on both graphs (schema registration active), so all 8
fire on every body.

| sub-pass | jessie calls | jessie ms | jz×jz calls | jz×jz ms |
|---|---:|---:|---:|---:|
| walk | 709 | 12.09 | 27,285 | 763.10 |
| stampCoInductionRanges | 709 | 2.27 | 27,285 | 98.98 |
| widenLocalTypes | 709 | 29.07 | 27,285 | 1579.64 |
| narrowUint32 | 709 | 2.90 | 27,285 | 194.60 |
| scanNumericFill | 709 | 2.56 | 27,285 | 128.86 |
| scanFlatObjects | 709 | 0.43 | 27,285 | 12.15 |
| scanSliceViews | 709 | 0.26 | 27,285 | 6.92 |
| scanNeverGrown | 709 | 0.48 | 27,285 | 95.36 |
| **sum** | | **50.1** | | **2879.6** |

Site-1 sum is **2.62% of jessie's total wall time, 1.06% of jz×jz's**
(1908 ms / 272,039 ms respectively) — a modest slice of native CPU time.
`widenLocalTypes` dominates both (58%/55% of the site's own sum) —
consistent with it being the one pass that does real per-node type-lattice
work (locals `i32`→`f64` demotion), not a cheap scan.

**Honest caveat**: wall time is the wrong unit for the memory campaign this
design serves. 8 sub-passes × 27,285 bodies = 218,280 sub-pass invocations
on jz×jz, each allocating its own return collection (`Map`/`Set`) even for a
trivial body — a fixed per-call allocation floor independent of body size.
Byte churn for site 1 specifically was **not measured this session**
(instrumentation timed only; a follow-up heap-delta pass analogous to site
3's would isolate this). The wall-time numbers above bound one input to that
estimate; they are not a substitute for it.

### 1.3 Genuine phase dependency, or historical accretion? Both — split by pass

Read against each pass's own doc comment (not guessed):

- **`walk` → `widenLocalTypes`**: genuine data dependency. `widenLocalTypes`
  takes `locals` as an argument — the map `walk`'s `processDecl` populates.
  Cannot reorder.
- **`widenLocalTypes` → `narrowUint32`**: genuine, documented ordering
  ("Runs post-widen so a local already demoted to f64 above … is
  reconsidered with final types"). Cannot reorder without re-deriving the
  same fixpoint by hand.
- **`stampCoInductionRanges`**: documented as needing to precede
  `widenLocalTypes` ("BEFORE widenLocalTypes' Pass D runs"), but its own
  signature (`body` only, no `locals`/`valTypes` argument) shows it does not
  *consume* `walk`'s output — it re-derives induction facts from the AST
  independently. Its position right after `walk` looks like accretion (any
  slot before `widenLocalTypes` would satisfy the one ordering constraint
  its comment states), not a proven need to run exactly there.
- **`scanNumericFill`**: its own comment says it must run "inside the
  val-type overlay" (i.e. before the overlay closes) and needs `valTypes` —
  available immediately after `walk`. Nothing in its doc says it needs
  `widenLocalTypes`'s or `narrowUint32`'s output. Its current position
  (last inside the overlay block, after both) is not justified by the
  comment that exists — **candidate accretion**, not verified dependency.
- **`scanFlatObjects` / `scanSliceViews` / `scanNeverGrown`**: three
  separate post-overlay full-body scans. No comment or code shows any of
  the three reading another's output — each is independently documented in
  terms of what it reads from `locals`/`escapes`/the AST. **No cross-
  dependency found** — the clearest, lowest-risk fusion target.

Realistic target from this reading: **8 walks → 3 walks**, not 1 — the
`walk`→`widenLocalTypes`→`narrowUint32` chain is a genuine 2-stage
type-refinement sequence (widen, then re-narrow against the widened result)
that would need a small internal fixpoint to fuse into a single dispatch
pass, a materially bigger and riskier change than the accretion cases below.
Claiming full fusion to one pass would overclaim past what the dependency
reading supports.

## 2. Site 2 — `analyzeFuncForEmit` re-derives locals (`src/compile/index.js:620-688`)

### 2.1 The self-diagnosed comments, quoted verbatim

At `index.js:620-624` (mandatory re-derivation, every block-bodied function):

> "Drop any earlier-cached analyzeBody.locals slice for this body —
> narrowSignatures called it before our pre-seed, when params still had no
> inferred VAL.TYPED, so the cached widths reflect the pre-narrow state.
> Re-walk now with reps in place."

At `index.js:680-687` (conditional second re-derivation, strict-int32
programs only):

> "analyzeBody's locals slice (line above bodyFacts) ran BEFORE inferLocals
> bound elem-alias schema ids … With strict-int32 slots in the program,
> re-derive the widths so exprType's slotI32CertainAt consult resolves
> through p … Gated: programs without strict slots skip the extra walk."

Both comments name the same root: **a cache entry computed against an
earlier, not-yet-final signature/fact state is untrustworthy, and the fix at
each site is a fresh, defensive, full re-walk** — not a freshness check.

### 2.2 The plan-time source of the "too early" cache entry

`narrow.js:453-487`, `refreshCallerLocals` (called during `narrowSignatures`,
building `callerLocals` per function for specialization decisions), seeds a
**transient, hypothesis-only** `ctx.func.localReps`/`ctx.func.typedElem`
overlay from each function's *candidate* narrowed param types, then calls
`reanalyzeBody(func.body).locals` (line 477) — a real, cache-populating full
re-walk under that hypothesis. Its own comment: "analyzeFuncForEmit
re-seeds + re-invalidates at emit time, so this transient localReps doesn't
leak past narrowing" — plan-time deliberately punts cleanup to emit time.
This is exactly the "cached too early" mechanism: the shared `bodyFacts`
cache has no notion of "this entry reflects a speculative hypothesis" vs
"this entry is the settled truth," so a real recompute at emit time is the
only way to not trust it.

Contrast `narrow.js:167-187`, `callerArgSelfConsistentI32` — same
speculate-via-`reanalyzeBody` shape (line 179), but it **does** call
`invalidateBodies(touched)` immediately after use ("The hypothesis tainted
analyzeBody's cache … invalidate again so the next … read re-derives
clean"). This site already self-cleans and is not part of the problem;
`refreshCallerLocals` is the one call site of four that leaves its
speculative entry sitting in the shared cache for someone else to
distrust-and-redo.

### 2.3 Measured — full-recompute histogram (**measured**)

Every fall-through past `analyzeBody`'s cache-hit check, regardless of
caller, tallied by body identity:

| | jessie | jz×jz |
|---|---:|---:|
| total full recomputes | 709 | 27,285 |
| distinct bodies recomputed | 365 | 16,859 |
| recomputes that are pure repeats | 344 | 10,426 |
| repeat share | **48.5%** | **38.2%** |
| max recomputes on one body | 10 | 16 |

Histogram shape (jz×jz): 12,679 bodies recomputed exactly once (fine — cold
cache, first touch), but 4,180 bodies recomputed 2+ times, with a fat tail —
1,443 bodies at exactly 4×, 192 bodies at 10×, one body at 16×. Roughly
2 in 5 full 8-sub-pass analyses in a jz×jz compile are **repeats of a body
this same compile already fully analyzed** — the concrete number behind the
brief's "2-3×" estimate, and in the tail, considerably worse than 3×.

**Amplification note**: these are native (V8) counts. `d08d5968`'s own
session measured a **40-420× native-vs-self-compiled overhead** for the single
hottest named pass on this identical class of workload (native `narrowSignatures`
+3.7 MB heapUsed / +38.5 MB RSS vs self-compiled breadcrumb +1564.9 MB). A
repeat-share that costs ~0.4% of native wall time is not evidence the same
repeat-share is cheap inside the self-compiled kernel the memory campaign
actually cares about — cited as directional context, not asserted as a
self-compiled number (unmeasured this session).

### 2.4 Root-cause fix contract — freshness, not a third cache

`analyzeBody` already computes a staleness fingerprint —
`sigFingerprint(ctx.func.current)` (`analyze.js:989-994`) stored as
`result.__sig`, consulted by `assertBodyFactsFresh` (`analyze.js:996-999`)
— but **only under `DBG_INVARIANTS`**, as an assert-and-crash safety net,
not a live cache-coherence mechanism. Every caller that might see a stale
entry is instead expected to know it and call `reanalyzeBody` defensively —
which is precisely the pattern the two quoted comments above show breaking
down (2-3× over-invalidation because the defensive calls are conservative,
not precise).

**The fix**: promote the existing fingerprint check from a debug-only assert
to a live, always-on gate on the cache-hit path itself — on a fingerprint
mismatch, `analyzeBody` transparently invalidates and recomputes once,
inline, instead of returning a stale `hit`. This is not a new cache; it
makes the *existing* one self-correcting instead of blindly-trusted-until-a-
caller-remembers-to-distrust-it. Once live:

- `index.js:624`'s explicit `reanalyzeBody(...)` can likely become a plain
  `analyzeBody(body)` call — the fingerprint gate does the invalidation only
  when actually needed, not unconditionally on every emit.
- `narrow.js:477`'s `refreshCallerLocals` speculative write no longer
  "leaks" an untrustworthy entry — the next real reader's fingerprint check
  catches the mismatch itself, so the deliberate-punt-to-emit-time comment
  at `narrow.js:463` becomes unnecessary as a *correctness* argument (it may
  still be true as a *performance* one, addressed by Slice B2 below).
- `index.js:688`'s second, strict-int32-gated recompute needs its own check:
  `sigFingerprint`'s own doc scopes it to "the WASM-type fields a retyping
  pass can flip" — `slotI32Certain` narrowing may not be one of them, in
  which case this call stays a genuinely separate, real dependency, not
  cache staleness. **Unverified this session — flagged as Slice B2's own
  first task, not assumed.**

## 3. Site 3 — five module-scope passes re-run after `narrowSignatures` (`src/compile/plan/index.js:158-319`)

### 3.1 The five, exactly identified

| pass (post-narrow) | line | early counterpart | early line | relationship |
|---|---|---|---|---|
| `inferModuleGlobalValTypes2` | 279 | `inferModuleGlobalValTypes` | 162 | **literal same function**, re-called |
| `refineModuleLetTypes` | 311 | `inferModuleLetTypes` | 158 | **literal same function**, re-called |
| `refineSlotKindCensus` | 288 | `observeProgramSlots` (gated) | program-facts.js:445 | fresh full rebuild, own comment says why |
| `refineSlotIntCensus` | 319 | `analyzeSchemaSlotIntCertain` (gated) | program-facts.js:452 | fresh full rebuild, own comment says why |
| `refineFieldProvenance` | 310 | *(none — new pass)* | — | shallow, top-level-decls only, not a body walk |

The two literal duplicates are the closest thing to a discovered bug in this
campaign: `inferModuleGlobalValTypes`/`inferModuleLetTypes` are called
**twice each**, unconditionally, over the same `ast`, in the same compile —
once before `narrowSignatures` (pass-1 evidence only), once after (paramReps
available). `inferModuleGlobalValTypes`'s own call-site comment
(`plan/index.js:277-278`) even says the *second* call is "Idempotent: names
pass 1 already claimed are skipped" — confirming the **write** is
redundancy-safe, but the **traversal** is not: every AST node is visited a
second time to find the (shrinking) set of still-unresolved names, even
where every visit's write is a no-op.

### 3.2 Measured — per-pass time and native heap delta (**measured**)

| pass | jessie ms | jessie ΔheapMB | jz×jz ms | jz×jz ΔheapMB |
|---|---:|---:|---:|---:|
| `inferModuleGlobalValTypes` (early) | 15.45 | 1.469 | 537.82 | 30.204 |
| `inferModuleGlobalValTypes2` (late) | 4.09 | 0.230 | **316.92** | **17.184** |
| `inferModuleLetTypes` (early) | 0.98 | 0.148 | 41.38 | 0.083 |
| `refineModuleLetTypes` (late) | 0.50 | 0.001 | **49.12** | 0.001 |
| `refineSlotKindCensus` | 1.43 | 0.011 | **72.73** | 0.032 |
| `refineSlotIntCensus` | 2.30 | -0.051 | **47.18** | 0.023 |
| `refineFieldProvenance` | 0.08 | 0.002 | 0.15 | 0.012 |
| *(context)* `narrowSignatures` | 36.17 | 1.072 | 1730.11 | 3.784 |
| *(context)* `plan` total | 272.02 | 5.316 | 6999.08 | 159.829 |

On jessie the five cost 8.32 ms combined — 3.1% of `plan()`'s own total. On
jz×jz they cost **485.94 ms combined — 6.9% of `plan()`'s own 6999.08 ms**,
with `inferModuleGlobalValTypes2` alone at 316.92 ms (4.5% of `plan()`).
`refineFieldProvenance` is confirmed innocent at both scales (0.08-0.15 ms)
— it is a shallow top-level-declaration walk (`plan/scope.js:209-231`,
`visitDecl` recurses only into `;`/`export` wrappers, never into function
bodies), not a "wholesale" pass despite the naming pattern; excluded from
the fix below. `narrowSignatures` itself remains the single largest cost in
`plan()` by a wide margin (24.7% of `plan()`'s total on jz×jz) — confirmed
out of scope per the file's own header doc (`627cf92a`'s "narrow.js's
O(functions×params×callSites) census is a NAMED, separately-banked
pathology … not a churn-vs-retain shape a region round can help").

### 3.3 Dependency graph — which of the five are genuinely re-derivable, which are true rebuilds

Read against each pass's own comment:

- **`inferModuleGlobalValTypes2`, `refineModuleLetTypes`**: genuinely
  redundant *traversal* (idempotent write, confirmed above) — the correct
  fusion shape is a **worklist**, not a full second walk: pass 1 records
  which module-scope names it left unresolved; the post-narrow call visits
  only those declaration sites instead of the whole `ast`. Requires pass 1
  to publish an "unresolved" set it doesn't currently keep — a real but
  bounded change to each function's own return contract, not a rewrite.
- **`refineSlotKindCensus`, `refineSlotIntCensus`**: **not** the same
  situation — each one's call-site comment explicitly argues for a full
  fresh rebuild ("the early hazard scan can't type params … so recompute
  hazards with paramReps and rebuild … fresh"). This is a genuine data
  dependency (post-narrow receiver resolution changes classification
  globally, not just for previously-unknown names) — proposing a worklist
  conversion here without redoing that soundness argument would be
  guessing, not designing. Left alone this campaign.
- These two censuses also cannot fuse with **each other** into one shared
  traversal despite both being "rebuild fresh, post-narrow" passes:
  `refineSlotKindCensus` runs in round 2 (`plan/index.js`'s bundle at line
  274), `refineSlotIntCensus` in round 4 (line 315) — separated by round 3,
  whose passes (`specializeBimorphicTyped` et al.) consume
  `refineSlotKindCensus`'s output before `refineSlotIntCensus` may safely
  run. Genuine ordering dependency, not accretion.

## 4. Cross-reference against the frontier trace — exits-skippable arithmetic

`fa9fcc1a`'s own per-round wasm-arena churn table (**cited**, self-compiled
kernel, jz×jz, pre-`2a40d7b2` fix) gives the round-by-round churn the 16 MiB
skip threshold (`2a40d7b2`, landed) tests against:

| round | churn (MB) | vs. 16 MiB skip cap |
|---|---:|---|
| front | +476.79 | far over — never skippable |
| early-plan prefix | +1442.03 | far over |
| narrowSignatures whole-call | +1846.02 | far over |
| plan-tail 1 (narrowBoolResults) | +3.89 | under — **skips** |
| plan-tail 2 (6-pass bundle, incl. `inferModuleGlobalValTypes2`/`refineSlotKindCensus`) | +210.47 | far over |
| plan-tail 3 (5-pass bundle, incl. `refineModuleLetTypes`/`refineFieldProvenance`) | +93.18 | far over |
| **plan-tail 4 (`refineSlotIntCensus`, alone)** | **+22.30** | **6.3 MB over** |
| plan-tail 5 (tail bundle) | +0.001 | under — **skips** |
| scan-round | +62.29 | far over |
| AFE batches (×~45-47, post-`2a40d7b2` fix) | 1.68-7.00 | under — **skip** |

**Honest conclusion, not overclaimed**: walk-fusion at sites 1/3 does
**not** make the big rounds (front, early-plan, narrowSignatures, plan-tail
2/3, scan-round — all hundreds of MB, orders of magnitude over the 16 MiB
cap) skippable. No plausible trim from removing 2-4 redundant sub-pass
traversals closes a 100-1800 MB gap. Those rounds' recopy tax is dominated
by `ctx.funcs`/`ctx.plans` — the monotonically-growing, pointer-keyed Maps
`2a40d7b2`'s own session named as the *actual* mechanism (`regionArmSetMap`'s
missing durable short-circuit) — a different, already-identified lever this
campaign does not touch.

**The one concrete, bounded candidate**: plan-tail round 4 is `refineSlotIntCensus`
running **alone** (not bundled — `plan/index.js`'s own comment: "own
boundary — the second-largest post-narrowSignatures delta"), measured at
+22.30 MB, just **6.3 MB over the 16 MiB cap**. It is a fresh full rebuild
(§3.3 — not a worklist-fusable duplicate), so this campaign's site-3 fixes
(worklist conversion of `inferModuleGlobalValTypes2`/`refineModuleLetTypes`,
which live in *different* rounds — 2 and 3) do not directly shrink round 4's
own churn. **This session did not measure round 4's own internal
composition** (how much of its 22.30 MB is `analyzeSchemaSlotIntCertain`'s
own genuinely-new work vs. incidental re-touch of already-classified slots)
— stated as unmeasured, not assumed zero or assumed sufficient. If a future
WAT-breadcrumb session finds a trimmable few MB inside it, tipping round 4
under 16 MiB converts one "real compaction" into one skip: a one-time ~292
MB tax saved (`fa9fcc1a`'s own measured near-constant per-round tax), worth
roughly **one additional AFE batch of survival** out of the ~2-exit gap
`2a40d7b2` left open (51 of ~53). Real, bounded, and worth checking — but
not, by itself, the fix that closes the goal gate. `2a40d7b2`'s own stated
next steps (the `regionArmSetMap` durable short-circuit, or fewer total
exits via `AFE_ROUND_BATCH`) remain the load-bearing levers; walk-fusion is
a third, smaller, additive one.

## 5. Slices — numbered, independently gated, byte-identity-or-documented-diff

Each slice: `npm test` + `npm run test:self` + kernel-oracle/parity +
self-build ×2 convergence, same bar every `.work/research.md` §Region arena
session already holds itself to. "Byte-identical" means the compiled output
corpus is unchanged bit-for-bit; any slice that cannot guarantee that must
document exactly which programs' output changes and why (a fusion bug would
show up here first).

1. **A1 — fuse the three independent post-overlay scans**
   (`scanFlatObjects`/`scanSliceViews`/`scanNeverGrown`,
   `analyze.js:960-971` → `analyze-scans.js`). No cross-dependency found
   (§1.3) — combine into one visitor computing all three return values in
   one traversal. 3 walks → 1. **Byte-identical required.** Lowest risk in
   this document.
2. **A2 — fold `scanNumericFill` into `walk`'s own dispatch**
   (`analyze.js:929`/`953`). Needs the empirical check §1.3 flags before
   removing the old call: run both old-and-new for one cycle under a debug
   assert (`DBG_INVARIANTS`-gated, mirroring `assertBodyFactsFresh`'s own
   convention) confirming identical results, THEN delete the separate call.
   1 walk removed. **Byte-identical required**, assert-gated rollout.
3. **B1 — promote `sigFingerprint`/`assertBodyFactsFresh` from
   `DBG_INVARIANTS`-only assert to a live cache-coherence gate** on
   `analyzeBody`'s cache-hit path (`analyze.js:270-273`). Root-cause fix for
   site 2 (§2.4). Remove `index.js:624`'s explicit `reanalyzeBody` in favor
   of plain `analyzeBody` once the gate is live. **The single highest-value
   slice in this document** — directly addresses the measured 38-48%
   repeat-recompute share.
4. **B2 — audit `index.js:688`'s strict-int32-gated second recompute**
   against B1's fingerprint domain (§2.4's flagged open question:
   `slotI32Certain` narrowing may or may not be a WASM-type flip
   `sigFingerprint` already tracks). Either delete it (if B1 subsumes it) or
   document precisely why it is a genuine third fact class, not staleness.
   Depends on B1 landing first.
5. **C1 — worklist-convert `inferModuleGlobalValTypes2`** from a full
   `ast` re-walk to a re-visit of pass-1's own recorded unresolved-name set
   (§3.3). Requires `inferModuleGlobalValTypes` to publish that set (bounded
   contract change, `plan/scope.js`). Largest measured site-3 line item
   (316.92 ms / 17.18 MB native heap on jz×jz).
6. **C2 — same worklist conversion for `refineModuleLetTypes`** /
   `inferModuleLetTypes`. Smaller (49.12 ms on jz×jz) but same shape as C1 —
   sequence together.
7. *(not a slice — explicitly rejected this campaign)* Worklist-converting
   `refineSlotKindCensus`/`refineSlotIntCensus`, or fusing them with each
   other. §3.3's dependency reading shows both are genuine full-rebuild
   requirements with a real ordering constraint between them. Revisit only
   with a fresh soundness argument, not as part of this campaign.
8. *(deferred, not a slice)* Chain-fusing `walk`→`stampCoInductionRanges`→
   `widenLocalTypes`→`narrowUint32` into one pass. §1.3: genuine 2-stage
   refinement, would need an internal fixpoint. Bigger and riskier than A1/
   A2; left as future work with the dependency proof on record so a future
   session doesn't have to re-derive it.

## 6. Coordination — RepPlan v2 territory (narrow.js / reps / kind / analyze)

RepPlan v2 (`.work/representation-plan-v2-design.md`, status "design, not
code" as of this same date) explicitly owns `narrow.js`, `reps.js`,
`kind.js`, and `analyze.js` surfaces, and its own solver "[r]un[s] after
semantic call-site/kind facts settle and before FunctionPlan publication" —
i.e. it will insert new fact computation into the exact plan-tail region
site 3 covers, and its forward/backward passes read `valTypeOf`/`analyzeBody`
output directly (v1's own postmortem names `kind.js`'s `literalTruthiness`/
`literalValue`/`valTypeOf` as the exact functions that broke).

| slice | files touched | RepPlan v2 collision |
|---|---|---|
| A1 | `analyze-scans.js` only | **none** — RepPlan v2's surface list doesn't name this file, and A1 doesn't touch `analyzeBody`'s own dispatch body |
| A2 | `analyze.js` (`walk`'s dispatch body) | **medium-high** — RepPlan v2 Slice 1's "forward representation seed" plugs into the same per-node dispatch |
| B1 | `analyze.js` (`analyzeBody`/`reanalyzeBody`/`sigFingerprint`), `index.js` (`analyzeFuncForEmit`) | **high** — both files are RepPlan v2's own named territory; RepPlan v2's `BigIntRep`/`possibleKinds` facts will want to ride the same cache-freshness contract |
| B2 | `narrow.js` (`refreshCallerLocals` and/or its callers) | **high** — `narrow.js` is RepPlan v2's own named territory |
| C1/C2 | `plan/scope.js`, `plan/index.js` (round scheduling) | **medium** — not in RepPlan v2's named-file list, but shares the plan-tail round structure RepPlan v2's solver will extend |

**Sequencing proposal**:

- **B1 before RepPlan v2 begins any code (its own Slice 1).** B1 is small,
  surgical, self-contained (a staleness-check promotion, not a new pass),
  and RepPlan v2's own facts will need exactly this cache-coherence contract
  to be correct — landing it first means RepPlan v2 inherits a sound
  invalidation story instead of independently re-discovering the "cached
  too early" bug (or building its own facts on top of it uncorrected). This
  is the one hard "land X before Y" recommendation in this document.
- **A1 is safe to land anytime** — zero file overlap with RepPlan v2's
  named surfaces, and it doesn't touch the one function (`walk`'s dispatch)
  RepPlan v2 will instrument.
- **A2 should sequence after RepPlan v2's own Slice 1 lands** (RepPlan v2's
  Slice 1 is itself "shadow plan, no codegen … byte-identical output," i.e.
  it wants to land soon and cheaply) — A2 rebasing onto RepPlan v2's
  already-added per-node fact hooks is cheaper than the reverse.
- **B2 depends on B1**, and should be sequenced with whoever is actively
  touching `narrow.js` at the time (RepPlan v2 Slices 2-4 touch
  `narrow.js`'s consumer sites directly) — coordinate live rather than
  presequence.
- **C1/C2 have a wide, low-collision landing window** — they don't touch
  `narrow.js`/`analyze.js`/`kind.js` at all. The one RepPlan v2 slice most
  likely to also touch `plan/index.js`'s round structure is its own Slice 5
  ("FeaturePlan graph completion … full module graph discovery") — land
  C1/C2 before that slice begins, or coordinate the round-boundary edit
  directly if timing doesn't allow it.

## 7. Rejected alternatives

- **Full single-pass fusion of all 8 site-1 sub-passes.** Rejected by the
  dependency reading in §1.3: `widenLocalTypes` needs `walk`'s settled
  `locals`, `narrowUint32` needs `widenLocalTypes`'s post-widen result — a
  genuine 2-stage refinement, not eliminable without an internal fixpoint.
  Claiming "8 → 1" would overclaim past the evidence.
- **A third cache layer for site 2** (e.g. a plan-time-vs-emit-time split
  cache). Rejected: the existing `bodyFacts` cache plus its already-built
  but dormant `sigFingerprint` freshness check is sufficient once made live
  (B1) — adding a second cache multiplies the staleness-reasoning surface
  instead of shrinking it, the exact anti-pattern the brief's framing
  ("fix the root, not a third cache") warns against.
- **Worklist-converting `refineSlotKindCensus`/`refineSlotIntCensus`.**
  Considered and rejected this campaign (§3.3, §5 item 7) — their own call-
  site comments argue a genuine full-rebuild need; converting them without
  redoing that soundness argument would be guessing.
- **Widening the region-exit skip threshold to swallow plan-tail round 4's
  22.30 MB directly** (skip it unconditionally past its current churn).
  Not proposed here — `2a40d7b2`'s own session already tried widening the
  threshold generally and measured it REGRESS jz×jz (fewer real
  compactions, more retained garbage, trapped sooner). Shrinking round 4's
  own churn (this campaign's C-track, indirectly) is the sound direction;
  moving the threshold to fit the churn is the already-falsified one.
- **C1/C2 as specified (§5 items 5-6) — VOIDED on implementation attempt
  (2026-08-18).** The "pass 1 publishes its unresolved-name set, pass 2
  revisits only those declaration sites" contract assumes the recorded
  sites still mean what they meant when pass 1 saw them. The window between
  the calls (`plan/index.js:161` → `:277`, `:157` → `:309`) breaks that
  assumption two independent ways, both verified against the code, not
  hypothesized: (a) `flattenFuncNamespaces` (`:179`, AFTER pass 1) rewrites
  `f.prop` reads to bare `f$prop` globals IN PLACE inside RHS positions —
  a site pass 1 recorded as field-provenance/poison evidence (`cur =
  f.prop`) is, by pass-2 time, an alias edge to a global (`cur = f$prop`);
  a site list replays the stale shape, a full walk sees the current one.
  (b) The inline/specialize family (`inlineHotInternalCalls`,
  `inlineLocalLambdas`, `specializeBimorphicTyped`,
  `specializeValKindDichotomy`, `speculateTypedParams` — all in the same
  window) clones writer sites into new bodies whose param-alias resolution
  under `programFacts.paramReps` differs per specialized clone — evidence
  that exists ONLY in the clones, invisible to any pre-clone site list.
  Making the worklist sound would require every in-window AST mutator to
  publish a site-delta log — coupling ~10 passes to an evidence contract
  for a lever worth 366 ms of a 7 s `plan()` and 17.2 MB of churn §4
  already ruled out as a memory lever. Not worth it at that price; the
  full re-walk at `:277`/`:309` is the correct, sound shape until the
  mutation window itself shrinks. Any future attempt must start from the
  delta-log design, not the return-contract one.

## 8. Unmeasured — stated, not guessed

- Site-1 byte churn (only wall time measured this session — see §1.2's
  caveat).
- Round-4 (`refineSlotIntCensus`)'s own internal composition — how much of
  its 22.30 MB wasm-arena churn is genuinely new work vs. redundant re-touch
  (§4). Needs a WAT-breadcrumb session on a region-live kernel, out of this
  session's native-only scope.
- Whether B1's fingerprint gate, once live, actually eliminates
  `index.js:624`'s need for an explicit `reanalyzeBody` call in practice
  (a full test-suite/self-build convergence check, deferred to the slice's
  own gate — not asserted here).
- Self-compiled (wasm-arena) byte churn for any of the site-1/site-3 fusions
  themselves, post-fix — this design proposes the fusions; the next
  session's own gate battery measures them.

# Self-compile memory campaign — hosted-build attribution + snapshotInit removal (2026-08-29)

Base `8986c2e2` (v1-readiness-audit's own ref). Worktree, never the main
checkout. Companion to `.work/v1-architecture-campaign.md` (the two
candidate strategies), `.work/region-release-notes.md` (region-arena's own,
much more complete, freshly-dated measurements — cited directly below rather
than re-derived), and `.work/archive/retained-set-census.md` (the prior
self-hosted allocator-class census this session's native table corroborates
and refines).

## 1. Attribution — hosted (Node) self-compile build, measured fresh

Method: `index.js`'s existing `opts.profile` phase-timing seam
(`compileProfiler`, already wraps every named phase via `time()`/`timePhase()`)
extended with one opt-in field, `profile.memory` — forces a GC
(`--expose-gc`) and samples `process.memoryUsage()` immediately before/after
every TOP-LEVEL phase (colon-free names; the `plan:*`/`optMod:*` sub-phase
entries are still recorded but without the added GC, to keep one diagnostic
run's cost bounded — a full GC on a multi-GB heap is not free), plus cheap
structural counts from the shared `ctx` singleton (function/schema table
sizes). Fully inert for every real caller (build/test/CLI never sets
`profile.memory`) — see `index.js`'s `compileProfiler`. Driver script:
scratch, not committed, reuses `resolveSelfCompileBuild()` — the exact
config `npm run build` uses — then calls `compile(graph.code, {...profile,
profile: sink})` directly.

One real run, current HEAD, **268 modules** (not the stale "162" cited
throughout `.work/` — that figure is `.work/porffor-alpha3-audit.md`'s own
2026-08-27/`4c38662f` measurement, last independently re-run then, never
refreshed since; dozens of `*-split.md` file-splitting refactors have landed
since and legitimately grown the module count without necessarily growing
total source bytes much — not investigated further, noted for honesty).

```
compiled 17,898,864 bytes in 318,673 ms
process RSS: start 93.9 MB -> end 2777.1 MB (post-final-GC settled state)
/usr/bin/time -l: 3,948,003,328 B max RSS (3.678 GiB) — this run carries
  forced-GC overhead from the instrumentation itself, so its wall time is
  not the clean baseline (see §2 for that); its RSS ceiling is still a valid,
  if slightly GC-flattened, upper bound.
```

Phase table (`ms` = wall; `rss/heap Before/After` = MB at that phase's own
entry/exit, GC-forced for top-level names only; `Δ` = After−Before; `funcs`/
`schemas`/`slotFacts` = live `ctx` table sizes at phase exit):

| phase | ms | Δrss MB | Δheap MB | funcs | schemas |
|---|---:|---:|---:|---:|---:|
| prepare | 1,120 | +219.8 | +79.9 | 2359 | 819 |
| plan (all internal rounds) | 4,416 | +331.1 | +187.3 | 2391 | 822 |
| analyzeFuncs (the "1435-call" AFE loop) | 1,373 | **+7.0** | +20.0 | 2391 | 822 |
| emitFuncs | 1,031 | +162.0 | +284.6 | 2391 | 826 |
| emitClosures (3 waves) | 1,289 | +329.4 | +317.1 | 2391 | 827 |
| buildStart | 835 | +14.5 | +57.7 | 2391 | 827 |
| pullStdlib | 538 | +7.6 | +34.6 | 2391 | 827 |
| optimizeModule (all `optMod:*`) | 26,423 | +502.5 | +129.0 | 2391 | 827 |
| — of which optMod:optimizeFuncs | 20,046 | +678.4 | +652.6 | — | — |
| **compile (prepare…optimizeModule, top-level)** | 43,432 | **+1,369.4** | +913.1 | 2391 | 827 |
| **watOptimize (watr's own whole-module fixpoint)** | 107,406 | **+839.5** | +446.8 | — | — |
| **snapshotInit** | 90,550 | **+478.9** | +61.2 | — | — |
| **watrCompile (final encode)** | 70,973 | **−242.3** | −64.3 | — | — |

**What is live at the peak, answered directly:**

- **Not per-function IR retained after emit, natively.** `analyzeFuncs`'s own
  net RSS delta is a mere +7.0 MB across 2,391 functions — V8's real GC
  reclaims that loop's scratch churn as fast as it's produced. This is the
  load-bearing asymmetry with the self-hosted side: `retained-set-census.md`'s
  self-hosted WAT-level census (2026-08-14, 156-module graph) found the SAME
  loop's allocations were ~70% of ALL self-hosted churn, MAP/HASH-shaped —
  because the self-hosted runtime is a bump allocator with **no GC at all**,
  so churn a native V8 process silently reclaims accumulates forever there.
  Native RSS numbers systematically **understate** what matters for the
  wasm32 ceiling for exactly this class of allocation.
- **`compile()`'s own pipeline (prepare through optimizeModule): +1,369.4 MB**,
  dominated by `optMod:optimizeFuncs` (+678.4 MB) — jz's own per-function
  optimizer pass (`hoistPtrType` + fused peephole/inline/memarg + auto-
  vectorization, `index.js`'s own header comment names this jz's ONLY
  optimizer pass). This IS the computation that produces the output — not a
  safe target for an output-identical memory fix.
- **`watOptimize` (watr's external whole-module fixpoint optimizer): +839.5 MB**
  — the single largest identified top-level phase, external to jz, opaque to
  this instrumentation (watr is a separate dependency; hooking inside its own
  passes would mean patching watr, out of this campaign's scope).
- **`snapshotInit`: +478.9 MB, confirmed fully TRANSIENT** — the very next
  phase (`watrCompile`) shows a NEGATIVE delta (−242.3 MB), i.e. GC reclaims
  snapshotInit's own probe instance/buffer before the final encode needs
  fresh memory. Mechanism: `src/snapshot.js`'s `snapshotInit()` calls
  `watrCompile(module)` a SECOND time (a full, separate ~18 MB encode) purely
  to build a throwaway probe `WebAssembly.Instance`, run its `__start` once,
  and read back the post-init globals/heap image to bake as static data.
- **The final encode (tree + output buffer coexisting): NOT a native peak
  driver** — `watrCompile`'s own delta is negative. This matches the native
  scale (tree + ~18 MB buffer is small next to a multi-GB heap already
  dominated by `optimizeFuncs`/`watOptimize`) but is the OPPOSITE of the
  self-hosted mechanism `.work/v1-architecture-campaign.md`'s Slice 6 names
  ("final copying and watr's whole-module cleanup/code-byte arrays need a
  second module-sized working set") — self-hosted, the SAME coexistence is
  decisive because every byte costs far more (NaN-boxed 8 B slots + 16 B
  headers vs V8's compact representations) against a MUCH smaller (4 GiB,
  not "whatever RAM is free") ceiling. Native evidence cannot rule this in or
  out for the self-hosted case; it only shows the native side is not where
  this particular problem lives.
- **The TRUE process peak is higher than any phase-boundary reading.**
  `/usr/bin/time -l`'s own max-RSS (3,678 MiB net of GC overhead; 3,914 MiB
  measured cleanly in §2 below) exceeds the highest **boundary** sample this
  table caught (~3,022 MB, at `snapshotInit`'s own end) by 650–900 MB —
  because forced-GC sampling only runs at phase START/END, and this is a
  fully synchronous pipeline (no event-loop yields), so a phase that spikes
  and partially GCs back down DURING its own execution hides its interior
  peak from boundary-only sampling. The gap is consistent with the true peak
  occurring transiently mid-`watOptimize` or mid-`optimizeFuncs` — both
  un-probeable without either patching watr or instrumenting inside jz's own
  optimizer internals, neither safe for an output-identical change.

## 2. Strategy decision — measured, not preferred

**Strategy A (region-arena), most complete form that exists on `main` today**
(not re-derived — cited directly from `.work/region-release-notes.md`'s own
2026-08-28 entries, same day as this campaign's ref commit): front's round
fix + `namedUses` fix + `errorSidEntries` fix, PLUS a batched per-function
region round already wired around BOTH `analyzeFuncs` and `emitFuncs`
(`EMIT_FUNC_ROUNDS_ACTIVE = true`, `AFE_ROUND_BATCH = 32`,
`src/compile/index.js` — this IS `retained-set-census.md`'s own "Lever 1",
already implemented, contrary to that document's 2026-08-14 assumption that
it was unattempted). `CLOSURE_ROUNDS_ACTIVE` stays permanently `false` — its
own comment says the full closure round "still reaches wasm32's copying
ceiling before producing bytes" on its own. Six further hooks-on-only
correctness defects (labeled (a)–(f) in that file) are banked, unfixed, block
`REGION_HOOKS_ACTIVE=true` from being mergeable at all.

Its own most recent goal-probe, WITH every currently-safe region round
active:

```
region-fixed(hooks-on): TRAP "unreachable", peakBytes 3,998,613,504,
  elapsedMs 601,108, 163 modules
```

**3,998,613,504 / 4,294,967,296 = 93.1% of the ceiling — a 6.9% peak-bytes
reduction, at a 601s / 11s ≈ 55× wall-time cost, and it still traps** (via a
different, jz×jz-scale-only banked defect, not the raw memory wall). This is
the single most important number this campaign has for strategy A: even its
most complete, currently-assembled form — including the per-function
reclaim round `retained-set-census.md` predicted could move the needle by
"on the order of 1–2 GB" — measured 6.9%, not an order of magnitude.

**Strategy B (streaming encoder)**, per `.work/region-release-notes.md`'s
own prototype on watr `feat/streaming-code-section`: peak bytes and elapsed
time measured INDISTINGUISHABLE from the dormant baseline, because a dormant
build never reaches the encode phase B optimizes (front/plan/emit alone
already exhaust memory first). Discovered AFTER that measurement: the
streaming-encoder kernel has its own, separate, unresolved correctness bug
(9/14 `kernel-oracle` failures) — so even that inconclusive number is
suggestive, not clean. It is also not byte-identical to the default encode
(padded LEB128 length prefixes), so it would need further work before it
could pass this campaign's own oracle byte-identity gate at all.

Region's own recommendation section: closing the wall needs BOTH region
reclaim (for front/plan/emit) AND a streaming/packed encode, working
TOGETHER — never measured combined, and region alone is not close even before
combining.

**Decision: neither named strategy, nor anything found in this session's
fresh attribution, safely closes the wasm32 ceiling within a scope
verifiable this session.** The true peak (§1) sits inside `watOptimize`/
`optimizeFuncs` — the passes that COMPUTE the output — not in any retained
bookkeeping table a reclaim mechanism could safely collect without risking
the output-identical constraint. Per the task's explicit instruction, this
session did not flip `REGION_HOOKS_ACTIVE` or attempt to close its banked
defects.

**What this session DID land** — the "third, cheaper" lever the attribution
surfaced: `snapshotInit`'s own probe (§1) is a fully self-contained, easily
disabled, ALREADY-FLAGGED-OPT-OUT mechanism
(`JZ_SELF_COMPILE_SNAPSHOT`/`resolveSelfCompileBuild`'s own `snapshot`
parameter, both pre-existing) that:
- **never reaches the in-wasm recursive kernel at all** — `scripts/self.js`'s
  `compileSelf()` pipeline (`front → emitIR → optimizeTail → watrCompile`)
  has no `snapshotInit` call anywhere, structurally, confirmed by direct
  reading AND by the goal-probe result below (bit-for-bit identical trap
  signature with the mechanism off);
- is **excluded from every existing self-compile timing gate by
  construction** — both `test/self-compile-perf.js` and
  `scripts/bench-self-compile.mjs` explicitly measure `compile()` only, with
  `instantiate()` (and therefore any un-baked `__start`) outside the timed
  region, by their own header comments;
- costs a real, measured, fully wasted 90.6 s / a transient (not
  peak-defining, see below) 478.9 MB on every hosted build for a benefit
  (baked `__start`) nothing downstream needs for THIS artifact — `dist/jz.wasm`
  is a build tool's output, not a warm-reuse service; the campaign's own
  `STABILITY.md` explicitly lists "kernel (dist/jz.wasm) byte identity
  between releases" as NOT a stability promise.

Implemented as a default flip: `resolveSelfCompileBuild`'s `snapshot`
parameter (`scripts/build-profile.mjs`) `true → false`, mirrored in
`scripts/self-compile-build.mjs`'s own env-var fallback default. Fully
reversible per-build via `JZ_SELF_COMPILE_SNAPSHOT=1` / `{snapshot:true}`.
Touches only the two self-compile-build entry points — zero effect on any
ordinary (non-self-compile) `compile()` call, since `snapshotInit` stays
available and default-configured however `resolveOptimize`'s normal presets
already set it for regular programs.

### Before/after (hosted build, `/usr/bin/time -l npm run build`, clean — no
### profiling instrumentation on either side)

| | before (snapshot on, task's own cited baseline, `a15ec98c`) | after (snapshot off, this session, `8986c2e2`+patch) |
|---|---:|---:|
| wall | 314.29 s | **245.34 s (−22%, −69 s)** |
| max RSS | 4,212,146,176 B (3.923 GiB) | 4,202,135,552 B (3.914 GiB) — **unchanged, −0.24%, within noise** |
| dist/jz.wasm | 17,481.3 kB | 16,276.1 kB (−6.9%, smaller: baked data segments cost more bytes than the equivalent live init code, empirically) |

**Honest result, stated plainly because it contradicts the working
hypothesis from §1's boundary-sampled phase table**: disabling `snapshotInit`
is a real, verified, **22% wall-time win** and removes a genuinely wasteful
duplicate encode+instantiate+run — but it did **NOT** measurably reduce peak
RSS. This is consistent with §1's own finding that the true process peak
occurs BEFORE `snapshotInit` even starts (mid-`watOptimize`, which runs
first) — removing a smaller, later, transient bump doesn't lower a ceiling
already set by an earlier, larger one. Reported honestly rather than claimed
as a memory win the data doesn't support: the goal here was output-identity
and a real measured improvement, not a flattering peak-RSS number.

### Goal-probe (in-wasm recursive jz×jz), before vs. after

| | before (cited, `.work/porffor-alpha3-audit.md`, `4c38662f`, 2026-08-27) | after (this session, `8986c2e2`+patch, fresh) |
|---|---|---|
| modules | 162 | **268** (source has grown; see §1's staleness note) |
| outcome | trap / unreachable | trap / unreachable — **identical** |
| memoryBytes | 4,294,967,296 (exactly 2³²) | 4,294,967,296 (exactly 2³²) — **bit-identical** |
| heap offset | −32 | −32 — **bit-identical** |
| wallMs | 11,448 | 11,197 |

Confirms the structural prediction exactly: the hosted-build-only
`snapshotInit` change has **zero** effect on the in-wasm ceiling, at every
observable digit. This milestone does not move STABILITY.md's release gate;
it was never expected to.

## 3. Battery — all green

| gate | result |
|---|---|
| `refactor-oracle.mjs check --ref 8986c2e2` (default, 560-spec corpus) | **CLEAN — 560 entries identical** |
| `test/kernel-parity.js` | 3/3 (**33/33** byte-identical assertions) |
| `test/kernel-oracle.js` | 14/14 (605 assertions) |
| `test/pointers.js` | 73/73 (132 assertions) |
| `test/data.js` | 204/204 (1,062 assertions) |
| `test/eager-stdlib-parity.js` | 22/22 (55 assertions) |
| full native suite, 94/95 files (`bench-c.js` excluded per instruction) | 3857/3858 pass, 1 skip (28,503 assertions) — **bit-identical totals to the established clean baseline** |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` (wasm-hosted, routes every compile through `dist/jz.wasm`) | 3034/3035 pass, 1 skip (14,639 assertions) |

The self-graph ('jz') oracle case is excluded by `refactor-oracle.mjs`'s own
default (its header: a single compile of that graph measures minutes;
`--full` opts in) — not requested, matching the task's own literal citation
of "560/560".

## 4. What remains to close STABILITY.md's actual gate — honest estimate

Not closed this session; not attempted beyond the measured decision above,
per the task's own explicit instruction not to chase region's banked defects.

1. Close region-arena's 6 banked hooks-on-only defects (a)–(f),
   `.work/region-release-notes.md`. Each of this campaign's already-landed
   region fixes (`namedUses`, `errorSidEntries`, front's round) took a full
   dedicated session from localized to fixed+verified; no reason to expect
   these six are cheaper on average — treat as ~6 more sessions at that
   depth, not a checklist.
2. Even fully fixed, region alone measures 93.1% — closing the remaining
   6.9% needs EITHER enabling `CLOSURE_ROUNDS_ACTIVE` (its own separate,
   currently-unproven "still hits the ceiling alone" issue) OR pairing with
   a genuinely byte-identical streaming/compact encoder (strategy B exists
   only as a non-byte-identical, separately-buggy prototype today).
3. If (1)+(2) still don't clear it: the architectural alternative named by
   `.work/porffor-alpha3-audit.md`'s own #1-ranked item — a compact,
   fixed-shape HIR (six-slot nodes, Porffor's own shape) replacing WAT
   arrays-with-expandos as the first authoritative IR — is a strictly larger
   undertaking than any lever in this document, not attempted or sized here.

No honest single "when" — the evidence (dozens of dated sessions already
spent on strategy A alone, per `.work/region-release-notes.md`'s own length)
says this is a multi-session engineering program at the SAME depth already
invested, not a remaining afternoon.

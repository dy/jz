# Self-compile memory campaign — hosted-build attribution (2026-08-29)

## Feasibility result; efficiency still open, 2026-08-31

The redesign landed after the diagnostic history below. The production kernel now recursively compiles the full 321-module graph and returns a working 14,005,329-byte compiler in 27.7 seconds. Final heap is 4,103,691,504, leaving 191,275,792 bytes below the wasm32 ceiling. The build artifact is 14,107.7 kB.

This is not closure of the self-compile requirement. The nearest process-level run reached 4,259,053,568 bytes max RSS, about 2.25× Porffor's pinned 1.89 GB full native self-build. The wasm heap retains only 4.5% headroom. The current checkpoint proves that the pipeline can finish; it does not prove that the pipeline is lean.

The redesign removed the dormant moving-region system, transferred FunctionPlan generations instead of cloning them, reduced transient collection/IR allocation, and parks optimized final IR in a binary lane before clearing dead analysis state. The recursive gate is `npm run test:self:recursive`; it also instantiates the returned compiler and compiles a probe. Region hooks remain deleted rather than dormant.

Base `8986c2e2` (v1-readiness-audit's own ref). Worktree, never the main
checkout. Companion to `.work/archive/v1-architecture-campaign.md` (the two
candidate strategies), `.work/archive/region-release-notes.md` (region-arena's own,
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
throughout `.work/` — that figure is `.work/archive/porffor-alpha3-audit.md`'s own
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
  self-hosted mechanism `.work/archive/v1-architecture-campaign.md`'s Slice 6 names
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
(not re-derived — cited directly from `.work/archive/region-release-notes.md`'s own
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

**Strategy B (streaming encoder)**, per `.work/archive/region-release-notes.md`'s
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

**Correction (coordinator review, same day): the snapshot-off default flip
below was WRONG and has been reverted.** First pass reasoning: `snapshotInit`
costs the hosted build 90.6 s / a transient 478.9 MB and never reaches the
in-wasm kernel either way, so disabling it looked like a clean, one-sided
win. That reasoning only weighed the ONE-TIME build cost against the wasm32
ceiling (which it never touched either way) — it never weighed the cost on
the OTHER side of the trade: disabling the bake means `__start` (watr's
OPCODE/IMM tables, atom interning, GLOBALS registry) now runs at **every**
instantiation of `dist/jz.wasm` instead of zero times after the first build
— paid by the website REPL, every kernel test file, and
`scripts/bench-self-compile.mjs`, forever, not once. That every self-compile
TIMING GATE happens to exclude `instantiate()` from its timed region
(`test/self-compile-perf.js`, `scripts/bench-self-compile.mjs` — both time
`compile()` only, by their own header comments) is a gap in what those gates
measure, not evidence the recurring cost is free — optimizing to what a gate
excludes instead of the real cost was exactly the mistake. `snapshot`
reverted to its original default (`true`) in a follow-up commit; the
90.6s / 478.9MB build-time cost stands, unresolved, below.

### Instantiate→first-compile time, snapshot ON vs OFF (measured, not assumed)

Method: matches `test/kernel-target.js`'s own pattern (the SAME pattern
`test/kernel-parity.js`/`scripts/bench-self-compile.mjs` use) — compile the
`WebAssembly.Module` bytecode ONCE (an expensive parse/validate, identical
cost either way, excluded from the timed region), then hand a FRESH
`Instance` (`{memory: 8192}`, matching every real caller's own convention) to
each timed run, timing from `instantiate()` through the first successful
compile of a one-line program (`export let f = () => 1`). Two real kernels
built (`scripts/self-compile-build.mjs`, snapshot default ON vs
`JZ_SELF_COMPILE_SNAPSHOT=0`), 268 modules each.

```
snapshot-ON  (17,898,864 B), 5 runs (ms):  9.638  9.821 31.520 62.220 804.572   median 31.520
snapshot-OFF (16,666,691 B), 5 runs (ms): 10.627 10.869 19.516 34.445 651.270   median 19.516
snapshot-ON,  15 runs: median 9.956 ms  (best-8 cluster: 6.5-14.3 ms; one 699 ms outlier)
snapshot-OFF, 15 runs: median 11.603 ms (best-8 cluster: 6.1-12.7 ms; one 552 ms outlier)
```

**Honest reading**: at N=5 the median favors OFF (matching the trade-off
hypothesis's DIRECTION); at N=15 it flips — ON is marginally faster at the
median, and the bulk of both distributions (the lower 8-9 of 15 runs)
overlap heavily in the 6-15 ms band. Every run of both kernels has one
extreme outlier (550-800 ms), almost certainly a major GC or memory-commit
stall from the shared 512 MB `{memory:8192}` allocation under this session's
own machine contention (confirmed earlier: concurrent agent builds, ~11 GB
swap in use), not `__start` itself. **At this sample size, on this
contended machine, the wall-clock cost of `__start` re-running is not
cleanly distinguishable from instantiation noise** — the architectural
concern (a real recurring cost was introduced by turning the bake off) is
still correct on its own terms, but the measured MAGNITUDE of that recurring
cost, at least for a single one-line-program compile immediately after
instantiation, is small relative to the fixed cost of standing up a fresh
512 MB instance at all. Reported both ways rather than picking the number
that flatters either conclusion.

### Bake-cheaply attempt: encode once, patch the binary — investigated, not landed

Goal: keep the bake (snapshot ON, kept — see above) but stop paying for
`snapshotInit`'s own SECOND full `watrCompile()` (the 90.6 s / 478.9 MB
probe-only encode, §1) by encoding the probe ONCE, running `__start` on
those exact bytes, then patching the captured heap image + global values
directly into the already-encoded binary's own data/global sections instead
of re-running the whole optimizer+encoder pipeline a second time.

**Feasibility investigation, empirical, before committing to the risky part**:
confirmed by direct WAT inspection (`compile(src,{wat:true,optimize:{level,
snapshotInit:false}})` on several small/representative programs, including
one with a real runtime closure table) that `__start` is reliably the
HIGHEST-numbered function in the module — it and the snapshot probe's own
getter functions are synthesized and appended strictly after every real
function, so removing them from the tail of the function/code sections never
renumbers any other function, and neither is ever referenced from an
`elem`/table entry (confirmed: no closure ever captures the init function).
Built a prototype (`src/wasm-section-patch.js`, a plain LEB128/section-frame
reader-writer — no third-party wasm tooling exists for this; checked
`node_modules/watr` first, per the task's own suggestion, and it exposes no
section-level API, only the monolithic `compile()`/`assemble()` encoder) that
drops the `start` section, truncates the function/code sections' tails,
drops the probe getters' export entries, and splices the captured heap
image + global values into the data/global sections directly — wired into
`src/snapshot.js` behind a fast-path gate (only the plain js-host
`(start $fn)` form, falls back to the original AST-mutate-then-reencode path
for anything else or on any exception).

**Validated the FAST way, before spending an expensive full self-compile
cycle**: generated reference bytes for 5 small representative programs (a
plain-globals case, a real-closure-table case, all-numeric-global-types
including i32/i64/f32/f64, a string/array-heavy case, a dict-heavy case) at
optimize levels 2 and 3 using the UNMODIFIED `snapshotInit`, then compared
byte-for-byte against the new fast-path implementation. Caught and fixed one
real bug this way (a data-section insertion computed its splice position
against a stale, non-index-aligned array, reordering sections) — exactly the
value of a cheap, fast, small-scale differential harness before trusting a
binary patcher on an 18 MB artifact.

**Blocking finding**: 4 of 5 cases still mismatch after that fix, isolated to
the `type` section being LARGER in the patched output (e.g. 31 vs 23 bytes
for the smallest case) — every other section (func, code, export, global,
data) matched exactly. Root cause: the probe encode's `type` section
necessarily includes signatures used ONLY by `__start` and the probe getters
(their `() -> ()` / `() -> i64` / `() -> i32` shapes); the ORIGINAL
AST-mutate-then-reencode path never creates these entries at all, because it
deletes those functions from the AST BEFORE encoding, so watr's own
type-deduplication (`ctx.type[idx] ??= ...`) simply never registers a type
nothing remaining needs. Removing those orphaned type entries from an
ALREADY-ENCODED binary requires renumbering every reference to any type
after them — and type indices are referenced not only from simple vectors
(the `import`/`function` sections) but from `call_indirect` operands embedded
directly in function BYTECODE, which jz's own closure/dispatch-table
mechanism emits pervasively (confirmed present in the closure-table test
case). Finding every `call_indirect` safely requires walking every
function's instructions as a real disassembler — knowing every opcode jz can
emit and its exact operand width, including the SIMD (`0xFD`-prefixed,
multi-byte) instruction set jz's own vectorizer emits — misjudging any
single opcode's width would silently corrupt bytecode into a still-valid,
wrong module: exactly the silent-miscompile risk this whole codebase's
architecture is built to avoid, not a small addition to what's already
working.

**Disposition, per the task's own explicit instruction**: not a small gap,
a genuinely separate, substantial engineering task (a WASM instruction-level
disassembler for jz's emitted subset) that this session cannot responsibly
implement and fully verify. Not landed. `src/snapshot.js`, `index.js`, and
the new `src/wasm-section-patch.js` prototype were fully reverted — the
committed tree carries none of this attempt, only the finding, here. The
90.6 s / 478.9 MB build-time cost of `snapshotInit`'s duplicate encode
remains open; closing it needs either that disassembler (bounding the
type-section-pruning renumbering safely) or a different mechanism entirely,
not attempted.

### Goal-probe (in-wasm recursive jz×jz), snapshot ON — unaffected, confirmed

`snapshotInit` structurally never runs inside the self-hosted kernel
(`scripts/self.js`'s `compileSelf()` pipeline has no call to it at all), so
this whole investigation — landed or not — has zero bearing on the wasm32
ceiling. Confirmed empirically earlier this session (before the revert, with
snapshot OFF) and unaffected by the revert:

| | cited, `.work/archive/porffor-alpha3-audit.md`, `4c38662f`, 2026-08-27 | this session, fresh |
|---|---|---|
| modules | 162 | **268** (source has grown; see §1's staleness note) |
| outcome | trap / unreachable | trap / unreachable — **identical** |
| memoryBytes | 4,294,967,296 (exactly 2³²) | 4,294,967,296 (exactly 2³²) — **bit-identical** |
| heap offset | −32 | −32 — **bit-identical** |
| wallMs | 11,448 | 11,197 |

Does not move STABILITY.md's release gate; was never expected to.

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
   `.work/archive/region-release-notes.md`. Each of this campaign's already-landed
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
   `.work/archive/porffor-alpha3-audit.md`'s own #1-ranked item — a compact,
   fixed-shape HIR (six-slot nodes, Porffor's own shape) replacing WAT
   arrays-with-expandos as the first authoritative IR — is a strictly larger
   undertaking than any lever in this document, not attempted or sized here.

No honest single "when" — the evidence (dozens of dated sessions already
spent on strategy A alone, per `.work/archive/region-release-notes.md`'s own length)
says this is a multi-session engineering program at the SAME depth already
invested, not a remaining afternoon.

## 5. What remains for the hosted-build competitiveness bar (CONTRIBUTING.md)

Separate from §4 — this is about matching/beating Porffor's self-host
wall+RSS once the wasm32 gate closes, not the gate itself. `snapshotInit`'s
own duplicate encode (90.6 s / a transient 478.9 MB, §1) is real, open, and
now precisely diagnosed rather than guessed at:

1. A WASM instruction-level disassembler for jz's own emitted opcode subset
   (enough to safely find and adjust `call_indirect` type-index operands —
   the one remaining piece the §2 bake-cheaply attempt needed). Sized at "a
   genuinely separate engineering task," not further broken down here —
   attempting a partial/unverified version was explicitly rejected this
   session as a real corruption risk, not a shortcut worth taking.
2. Once that exists, the fast path prototyped in this session's (reverted)
   `src/wasm-section-patch.js` needs only one more piece (type-section
   pruning + renumbering, using the disassembler from (1) to patch
   `call_indirect` operands) to reach byte-identity — everything else
   (function/code truncation, export/global/data patching, the js-host-only
   eligibility gate, the small-corpus differential harness) is already
   built, reverted, and described in §2 in enough detail to resume from.
3. Independent of (1)/(2): re-measure instantiate→ready cost on an
   UNCONTENDED machine — this session's own numbers (§2) were noisy enough
   (550-800 ms outliers on every run) that the true magnitude of the
   recurring per-instantiation cost snapshotInit exists to avoid is not
   pinned down; worth doing before investing in (1)/(2), since it directly
   answers whether the 90.6 s build-time cost is actually worth engineering
   around at all.

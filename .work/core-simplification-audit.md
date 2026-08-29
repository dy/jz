# Core simplification audit

Panel: V8/TurboFan-style engineer, LLVM/Binaryen-style engineer, AssemblyScript
author, Porffor author. Scope: is jz's core overdone, does it self-host well,
does it beat other Wasm generically (not per-bench). Every claim below is
either a file:line citation or a measurement taken in this run; opinions are
labeled as such.

**Methodology.** Worktree `/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/xa`,
detached at `a45ce6ca`, Node v25.9.0, Apple M4 Max, watr 5.9.3, measured
2026-08-28. Instrumentation added to `src/ast.js`'s `walkAst` (call/visit
counters) and three throwaway driver scripts under `scripts/_audit-*.mjs` —
all uncommitted, none of this ships. The benchmark specimen is
`bench/watr/watr.js` resolved through `src/resolve.js`'s `resolveModuleGraph`
(the same resolution `bench/bench.mjs` uses for the `watr` case: jz compiling
watr's own WAT encoder, 10,234 AST nodes across the resolved module graph).
`test/bench-c.js` and the multi-toolchain speed bench were **not** run (other
agents on this machine). `scripts/self-compile-build.mjs` (the ~6 min / ~4 GB
kernel build) was **not** re-run: at measurement time `uptime` showed load
average 33.24 and `sysctl vm.swapusage` showed 10.9/12 GB swap already in use
from other work on this shared machine — not a safe moment for a 4 GB, 6-minute
job. Self-compile economics below cite the existing, dated
`.work/porffor-alpha3-audit.md` (2026-08-27, one day old, same architecture)
and are cross-checked against this session's own small-scale profile, which
independently reproduces the same qualitative pattern at a completely
different input size (§1.6/§1.8). Where a command was blocked or skipped, it
is noted inline, not silently omitted.

---

## 1. Shape of the machine, measured

### 1.1 Lines per stage

```
jzify/ (pre-compile desugar)                    3,667
src/prepare/                                    5,860
src/compile/ (analyze+plan+narrow+emit+…)      36,940
  src/compile/*.js flat files                  23,515
  src/compile/analyze/ + analyze.js/-scans.js    4,761
  src/compile/program-facts/ + barrel            2,576
  src/compile/plan/                              4,994
  src/compile/representation-plan/ + barrel      2,716
  narrow.js (single file)                        4,027
  emit.js + emit-assign.js                       9,163
  call-target-index.js + dict-kind-index.js        948
  infer.js + flow-types.js + flow-state.js       1,132
  index.js (session driver)                      3,503
src/optimize/ (jz's own per-function IR passes) 14,934
src/wat/ (assemble + codegen)                    2,107
src/ir.js (46, barrel) + src/ir/ (11 files)      2,655 (2,701 incl. barrel)
src/kind.js (27, barrel) + src/kind/ (4 files)   1,767 (1,794 incl. barrel)
src/type.js (71, barrel) + src/type/ (8 files)   2,647 (2,718 incl. barrel)
module/ (stdlib written in the dialect)         29,274
---------------------------------------------------------
src + jzify + module total                    108,446 lines, 213 files
```
(`find src jzify module -name '*.js' | xargs wc -l`, this worktree.) Matches
the brief's cited "108k lines" almost exactly — confirms this is current.
`test/` alone is 63,876 lines — more test than compiler by more than half.

### 1.2 Files over 3,000 lines — shrinking, verified in-flight

```
8,167  src/compile/emit.js
4,452  src/prepare/index.js
4,027  src/compile/narrow.js
3,535  module/core.js
3,503  src/compile/index.js
```
`.work/handoff-2026-08-22.md` (2 days earlier) counted **10** files over 3k
(`emit.js 8154, prepare/index.js 4465, narrow.js 3945, core.js 3532,
compile/index.js 3504` — the whole list). Today there are **5**. The other
five were split into barrels in the intervening two days, verified by reading
the barrels, not inferred from a commit count:

- `src/kind.js` — 27 lines, pure re-export, header cites `.work/kind-split.md`
- `src/type.js` — 71 lines (mostly a load-bearing doc comment, see §2c),
  cites `.work/type-split.md`
- `src/compile/program-facts.js` — 86 lines, cites `.work/program-facts-split.md`
- `src/compile/representation-plan.js` — 62 lines, cites `.work/representation-plan-split.md`
- `src/compile/analyze.js` — 55 lines, cites `.work/analyze-traversals.md`

Two more outlier **functions** the handoff named are also independently
verified fixed, not just moved:
- `emitInstanceof` (`src/compile/emit.js:5713`) — the handoff cited ~2.1k
  lines; it is now a 5-line dispatcher over three named helpers
  (`emitTagInstanceof` 14 lines, `emitTypedInstanceof` 36 lines,
  `emitErrorInstanceof` 61 lines — 116 lines total, verified by reading them).
- `genUpsertStrictPrehashed` (`module/collection/upsert.js:931`) — the
  handoff cited ~2.5k lines; it is now 66 lines (a single WAT-template
  string builder).

`inferTypedValueRanges` (`src/compile/narrow.js:1621-2984`, verified by
locating the next top-level declaration) is **not** fixed: still ~1,364
lines, matches the handoff's "~1.3k" exactly, and `.work/todo.md:8512` already
has it as a planned extraction target ("extract inferTypedValueRanges' range
algebra toward static.js") — this is the team's own backlog item, not a new
finding.

**Read:** the minimality campaign is real, not aspirational — verified by
reading the current files against the two-day-old baseline, not by trusting
either doc's prose.

### 1.3 Whole-program passes and fixpoint loops, execution order

Four independent driver layers, none aware of the others as a single engine:

**A. `src/compile/plan/index.js` (445 lines) — 38 distinct named passes, 6
region-reclaim rounds, one lazy dirty-bit cache.** Grep-counted
(`(t|sweep)\('name'`, deduplicated): 38 unique pass names invoked from one
function (`plan(ast, profiler, regionHooks)`), wrapped in a hand-rolled
mark/exit "round" mechanism (`round(() => {...})`, 6 call sites) whose entire
job is region-arena memory reclamation for the self-hosted kernel (comments
document per-round retained-memory deltas: "+900MB before narrowSignatures
even starts", "+198 MB", "+~395 MB combined", "+60 MB", "+22 MB" — this is
real accounting, not decoration). A `facts()` getter with a `_dirty` flag
re-derives `collectProgramFacts(ast)` lazily after any AST-mutating pass
reports a change (`sweep(name, pass)`), so the actual re-collection count is
input-dependent, not fixed. In order: `inferModuleLetTypes` →
`inferModuleGlobalValTypes` → `unboxConstTypedGlobals` →
`inferModuleIntGlobals` → `collectProgramFacts` (first collection) →
`classifyHashDictGlobals` → `flattenFuncNamespaces` → `devirtGlobalCalls` →
`bindNestedRowLengths`/`unrollRowLenPadLoops` (×2 each) →
`inlineHotInternalCalls` → `inlineLocalLambdas` → `specializeFixedRestCalls`
→ (if optimizing) `splitCharScanLoops`/`scalarizeFunctionArrayLiterals`/
`scalarizeFunctionObjectLiterals`/`promoteIntArrayLiterals`/
`scalarizeFunctionTypedArrays` → `buildCallTargetIndex` →
`synthesizeComputedDispatchCallSites` → `releaseLiftedValueUsed` →
`buildDictKindIndex` → `materializeAutoBoxSchemas` → `resolveClosureWidth` →
[fast exit for simple programs, `canSkipWholeProgramNarrowing`] →
`narrowSignatures` (own internal fixpoint, see B) → `narrowBoolResults` →
round 2: `inferModuleGlobalValTypes` again (name suffixed `2`) /
`analyzeParamDistinctness` / `observeProgramSlots` **rebuilt fresh** /
`analyzeParamNeverGrown` / `scanInplaceStores` / `specializeBimorphicTyped` →
round 3: `specializeValKindDichotomy` / `speculateTypedParams` /
`refineDynKeys` / `refineFieldProvenance` / `inferModuleLetTypes` **again** →
round 4: `analyzeSchemaSlotIntCertain` **rebuilt fresh** (second time this
program run) → round 5: `invalidateAllBodyFacts` / `strictBoundaryTypeCheck`
/ `adviseProgram` → `solveRepresentationBoundaries`.

**B. `narrowSignatures` (`src/compile/narrow.js:1798-2991`) — phases D
through J, its own 5-call internal worklist fixpoint.** `runFixpointConverged`
(`narrow.js:2371-2412`) is called 5 times (lines 2414, 2473, 2492, 2680,
2715), each time rebuilding a fresh `sitesByCaller` `Map` from the whole
`callSites` array and running a worklist with a bounded guard
(`callSites.length * 64`); exhaustion is a **hard compiler-bug `err()`**, not
a silent fallback (narrow.js:2397) — a real correct-or-reject instance, see
§2c. Phases (grep-verified comment labels): D (call-site propagation), E/E2/E3
(numeric/VAL-kind/pointer result narrowing), F (cross-call typed-array ctor
propagation), G (TYPED pointer-ABI narrowing), H (post-F/G re-fixpoint), I/I1/I2
(re-narrow after G), J (jsstring boundary, standalone at narrow.js:2991,
runs even when the rest is skipped).

**C. `src/optimize/driver.js` (`optimizeFunc`, 187 lines) — 24 named
per-function passes, fixed order, non-fixpoint, run once per function during
emit.** Not a whole-program pass — sequenced once per function body, no
convergence loop (`hoistInvariantLoop` is called at 4 distinct points in the
fixed sequence, not as a "run until stable" fixpoint). The file's own comment
is explicit about the boundary: "jz's optimizer runs exactly once, before
watr" (driver.js:44-45).

**D. `watr/optimize.js` (external dependency, `node_modules/watr/src/optimize.js`,
8,677 lines, one file) — the only whole-module fixpoint that runs to actual
convergence.** `index.js:23-25`: "watOptimize... the SOLE, FINAL optimizer:
CSE, DCE, const fold, inline, coalesce. Runs ONCE, as a fixpoint. No jz pass
touches WAT after it." jz does not own this code; it is a pinned `^5.9.3`
dependency (`package.json`).

Outside the driver proper: `src/compile/analyze/` (6 modules, 4,761 lines)
runs its passes **per function during `compile()`**, separately from both A
and C (`analyze.js`'s own header: "Ordering: all passes run per function
during compile(). plan.js owns the cross-function dynKey scan"), and
`analyzeSchemaSlotIntCertain`'s own internal integer-certainty sweep is a
*third*, independent bounded fixpoint (≤64 rounds, `program-facts-split.md`
§5) distinct from both narrow.js's worklist (B) and `type/int-certain.js`'s
separate local-body lattice (§1.4).

**Read:** four uncoordinated driver layers (A/B/C/D) plus a fifth
per-function analysis layer outside all of them. None is wrong in isolation —
each has a documented reason (region reclaim for A, monotone worklist
soundness for B, fixed lowering order for C, "don't compete with watr" for
D) — but there is no single scheduler; "how many times does this program get
walked" is not answerable by reading any one file. §1.5 measures the result.

### 1.4 Type/kind/representation inference systems — 12 distinct answerers

| # | System | File | Question it answers | Recomputed / overlaps |
|---|---|---|---|---|
| 1 | `valTypeOf`/`valTypeOfWithLocals` | `src/kind/val-type-of.js` | VAL kind (STRING/ARRAY/OBJECT/HASH/BIGINT/…) from AST shape | base layer #7/#8 override; #9/#12 are whole-program siblings for slot/dict shapes it declines |
| 2 | dict/Map value-kind census | `src/kind/dict-census.js` | Kind of values stored in a dict/Map, whole-program | overlaps #9 (`observeProgramSlots`) — different data source (kind.js's own 3-prior-revert INVARIANT comment on why they stay separate, cited by dict-kind-index.js:27-29) |
| 3 | JSON shape propagation | `src/kind/shape.js` | Object-literal shape flow (`shapeOf`) | feeds #1 |
| 4 | `exprType` | `src/type/expr-type.js` | WASM i32 vs f64 for a local/param | **duplicate decision point** — see below |
| 5 | integer-certainty lattice (local) | `src/type/int-certain.js` | Is this binding provably an integer, per function body | separate fixpoint from #10 (whole-program slot version) |
| 6 | interval abstract interpreter | `src/type/interval-proof.js` | Provable index/charCodeAt bounds | consumed by #4, #5 |
| 7 | flow refinement | `src/compile/flow-types.js` | `typeof`/`instanceof`/`Array.isArray` guard narrowing per branch | **priority override** on #1 — `lookupValType` checks `ctx.func.refinements` before valTypeOf (flow-types.js:14) |
| 8 | per-binding evidence ladder | `src/compile/infer.js` | Function PARAMETER shape from an 8-tier evidence ladder | 2 of 8 tiers are **retired**, in-file (see §2c) — a documented unsoundness walk-back, not a design |
| 9 | whole-program slot-kind census | `src/compile/program-facts/slot-kind-census.js` (`observeProgramSlots`) | Per-schema-slot kind, whole program | rebuilt from scratch **twice** per compile (plan/index.js: early gate + round 2 `{fresh:true}`) |
| 10 | whole-program slot-int census | `src/compile/program-facts/slot-int-census.js` (`analyzeSchemaSlotIntCertain`) | Per-slot integer certainty, whole program | separate fixpoint from #5; also rebuilt twice (early gate + round 4) |
| 11 | BigInt representation plan | `src/compile/representation-plan/` (6 files, sole authority per ADR-0001) | raw i64 vs boxed, every edge | the one system explicitly unified from a worse dual-system (§3 item 8) |
| 12 | dict-kind index | `src/compile/dict-kind-index.js` | Per-key kind for an array-literal used as a string-keyed dict | narrower sibling of #2/#9, added because widening either was reverted 3× for unsoundness (own header, dict-kind-index.js:27) |
| — | call-target index | `src/compile/call-target-index.js` | Which function a `.`-member call reaches | not a value-kind system, but a **prerequisite** #1's `VT['()']` reads (`ctx.types.callTargets.resolveMember`) |
| — | function-signature narrowing | `src/compile/narrow.js` phases D-J | Per-call-site-census specialized param/result reps | a later, more precise LAYER on top of #1/#9 — both stay live simultaneously (program-facts-split.md §7.2: "no reader was found reading either fact before its relevant producer settled" — sound only by pass-ordering discipline) |

**The one clean, citable duplicate-decision-point (not just an "overlap"):**
`src/type.js`'s own barrel header (lines 11-39) documents that **two
independent implementations** decide i32-vs-f64 and must be kept in hand
sync: "emit.js DECIDES... exprType here MIRRORS... They cannot share one
function... but they MUST share these rules — edit one side only with the
other open beside it." The soundness direction is one-way and stated
explicitly: "exprType's i32 verdict must be a SUBSET of emit's... If type
says i32 but emit yields f64 [i.e. exprType is too permissive], the value is
trunc_sat-narrowed back → silent miscompile." This is a real, working,
documented safety rule (fails toward f64, not toward corruption) — but it is
a manually-maintained invariant across two files, not a computed-once fact
read twice, which is exactly the class of duplication the task asked to find.

**Read:** 12 systems answering overlapping "what is this value" questions is
not one dataflow lattice with 12 views into it — several are independent
walks with independent caching, independently reverted for unsoundness in the
past (kind.js's dict census, per its own in-file INVARIANT comment), and one
pair (#4 above) is a hand-synchronized duplicate by the file's own admission.

### 1.5 `walkAst` instrumented — calls, visits, per source node

`walkAst` (`src/ast.js:121`, the ONE canonical generic array-tree walker —
`enter`/`boundary`/`exit` callbacks, no visited-set) instrumented with call
and visit counters (uncommitted). Driven by `scripts/_audit-walkast.mjs`:
resolves `bench/watr/watr.js`'s module graph exactly like `bench.mjs` does,
counts AST nodes in the resolved source once (10,234 nodes, via a throwaway
walk before the timed compile), resets counters, then calls `compile()`.

| optimize level | wall | walkAst() calls | array-node visits | visits / source node | calls / source node |
|---|---:|---:|---:|---:|---:|
| `false` (O0) | 0.64 s | 12,942 | 2,932,839 | 287 | 1.26 |
| `1` (min) | 0.72 s | 16,708 | 3,285,923 | 321 | 1.63 |
| `2` (default) | 4.09 s | 156,311 | 10,746,104 | 1,050 | 15.27 |
| `3` (speed) | 5.78 s | 270,828 | 15,270,342 | 1,492 | 26.46 |
| `'size'` | 3.93 s | 56,601 | 7,342,473 | 717 | 5.53 |

The O1→O2 step (where the optimizer gate `optimizing()` turns on) is where
the machine gets heavy: 5.7× the wall time, 9.4× the walkAst call count, 3.3×
the visits. **Every source AST node is touched, on average, ~1,492 times
somewhere in the pipeline by the time an O3 compile finishes** (this counts
`walkAst` only — every hand-rolled recursive walker that bypasses it, e.g.
`program-facts/walk-facts.js`'s `walkFacts`, documented as unable to use
`walkAst` because it special-cases bare-string leaves, adds more, uncounted
here). 281 call sites across 80 files invoke `walkAst` today; a rough proxy
grep for a locally-defined recursive `visit`/`walk`/`scan` helper (not a
precise count — some are the callback passed *to* `walkAst`, not a bypass of
it) hits 49 more files, order-of-magnitude consistent with the handoff's own
"181 hand walkers" figure (different methodology, not reconciled here).

**Top call sites by visit volume** (traced separately, `--trace` mode,
top of 30): the volume is dominated by jz's *own* `src/optimize/` — not
by semantic analysis:

```
1,147,325 visits    3,733 calls  processLoop            src/optimize/licm.js:787
  998,820 visits      830 calls  buildRefcount          src/ir/control.js:30
  831,042 visits      664 calls  hoistInvariantLoop      src/optimize/licm.js:681
  806,577 visits  146,180 calls  hasHardOp               src/optimize/licm.js:204
  640,014 visits      594 calls  nextLocalId             src/ir/control.js:52
  603,379 visits    4,382 calls  containsV128            src/optimize/ir-scan.js:14
  551,270 visits      957 calls  collectGlobalRefs       src/optimize/treeshake.js:110
  498,818 visits    6,362 calls  localRefTallies         src/optimize/locals.js:23
  444,879 visits      758 calls  collectReachableGlobalWrites  src/optimize/globals.js:76
  423,699 visits      404 calls  devirtConstFnArrayCalls src/optimize/devirt.js:536
  378,253 visits   23,841 calls  loopInvariance          src/optimize/licm.js:311
  235,511 visits    9,359 calls  hoistInvariantLoop      src/optimize/licm.js:627 (2nd call site)
```
LICM alone (`src/optimize/licm.js`'s five entries above) accounts for
**~3.40M of 15.27M O3 visits (≈22%)**. `hasHardOp` is called **146,180
times** for 806,577 visits — a small predicate re-walked on overlapping
subtrees far more than it is used for anything new; `loopInvariance` is
called 23,841 times. Neither result is cached across calls within one
`optimizeFunc` invocation (§3 item 6). Two near-identical pairs also show up
as literal double traversal of the same tree inside one pass:
`specializeMkptr` (`src/optimize/specialize-mkptr.js:104` and `:214`) —
210,992 and 210,960 visits, a scan-then-rewrite two-pass structure; the same
shape appears in `static-data.js`'s `scan` (lines 46 and 139, 270,114 visits
each) and `devirt.js`'s `devirtSchemaReads` (lines 50 and 227, 266,756 visits
each).

### 1.6 CPU profile, O3, watr specimen — where the *time* actually goes

`node --cpu-prof` around the same compile (6,390 ms profiled span, 8,172
samples), self-time attributed via `samples[]`+`timeDeltas[]` (the
`hitCount`-only method under-counted by ~40% on this Node build — cross-
checked, see script). A second, independent measurement via the
`node:inspector` `Session` API scoped tightly around just the `compile()`
call (22,929 ms profiled — 100 µs sampling adds real overhead, ~4× dilation,
so its *absolute* numbers aren't used, only its *proportions* as a
cross-check) reproduces the same split within 1-4 points on every bucket.

```
stage bucket (by file path)              --cpu-prof (6.39s)   inspector cross-check
watr-optimize.js (whole-module fixpoint)   38.8%                38.7%
watr-util.js (shared walk, opt+encode)     16.2%                16.9%
watr-compile.js (binary encode)            14.8%                10.5%
semantic-compile (jz analyze/plan/narrow)  12.3%                13.5%
jz-ir-optimize (src/optimize/)             11.2%                 9.5%
node-internal (GC, ESM loader, etc.)        4.7%                 9.9%
wat-assemble (src/wat/)                     0.9%                 0.5%

  jz OWN source total:   24.4%   (24.0% in the un-normalized first pass)
  watr package total:    70.1%
```

**jz's own source code is a minority of self-time — the external `watr`
dependency (its whole-module optimizer, shared walk utilities, and binary
encoder) is ~70% of wall-clock, even on a small 10,234-node specimen, not
just at self-compile scale.** Top single functions by self-time:

```
  523.2 ms  8.2%  instr        node_modules/watr/src/compile.js:1127  (binary encode)
  436.6 ms  6.8%  walkN        node_modules/watr/src/util.js:133      (shared walker)
  307.4 ms  4.8%  walkPostN    node_modules/watr/src/util.js:171
  289.4 ms  4.5%  visit        src/ast.js:137                         (jz's own walkAst)
  230.9 ms  3.6%  walk         node_modules/watr/src/util.js:112
  138.9 ms  2.2%  hashFunc     node_modules/watr/src/optimize.js:7311
  119.0 ms  1.9%  rec          node_modules/watr/src/optimize.js:3142
  116.2 ms  1.8%  substGets    node_modules/watr/src/optimize.js:3118
  112.5 ms  1.8%  localidx     node_modules/watr/src/compile.js:1061
   96.1 ms  1.5%  writesOf     node_modules/watr/src/optimize.js:2497
```

This independently corroborates — at a completely different input scale —
what `.work/porffor-alpha3-audit.md` measured for the full 344 s self-build
("About 87% is after JZ has already built its semantic module"): **the
architecture spends more of its own time outside jz's source than inside
it, at any size, not just at self-compile scale.** The two measurements
(§1.5's visit *volume*, dominated by jz's own `src/optimize/`, vs §1.6's
*wall time*, dominated by `watr`) are complementary, not contradictory: jz's
own passes generate enormous re-walk volume cheaply; `watr`'s whole-module
fixpoint does comparatively few passes but each is expensive (real CSE
fact tables, hashing, a real multi-round fixpoint over the *entire* module
including all pulled-in stdlib, not just the touched function).

### 1.7 Peak RSS

`/usr/bin/time -l`, same watr specimen:

| | wall | max RSS | peak footprint |
|---|---:|---:|---:|
| bare `import('./index.js')`, no compile | 0.13 s | 93 MB | 59 MB |
| O0 compile | 1.34 s | 362 MB | 349 MB |
| O3 compile | 12.17 s* | 464 MB | 459 MB |

(*`/usr/bin/time` wraps the whole node-counting-prepass + compile driver, so
this wall figure is not the compile-only 5.78 s from §1.5 — RSS is unaffected
by that.) ~93 MB is fixed cost of loading a 108K-line compiler into V8 before
compiling anything; O0 adds ~270 MB compiling a 10,234-node program; O3 adds
another ~100 MB for the optimizer stages. Per-node cost at O3: **464 MB /
10,234 nodes ≈ 43.3 KB/node.** Porffor's own self-hosted bundle (105,069 AST
nodes) peaks at 251 MB during C-emission (`.work/porffor-alpha3-audit.md`) —
**≈2.39 KB/node, ~18× less per node.** The two numbers are not a controlled
A/B (different compilers compiling different source graphs, in different
target languages), but both are Node/V8-hosted compiler processes, so the
per-node memory shape is at least directionally comparable, and it lands in
the same direction the existing self-compile-scale numbers already show
(§1.8) — i.e. this is not purely an artifact of self-compile's 162-module
scale; the ratio is visible on a specimen 10× smaller than Porffor's own
bundle.

### 1.8 Self-hosting economics — cited, not re-run this session

Not re-measured (see Methodology: machine was at load average 33 / swap
89% full at audit time). Citing `.work/porffor-alpha3-audit.md`
(2026-08-27, one day old, same architecture as this worktree):

| | input | output | wall | peak RSS |
|---|---:|---:|---:|---:|
| Porffor selfhost → C | 2,102,661 B / 105,069 nodes | 11,230,057 B C | 1.94-1.95 s | 251 MB |
| Porffor selfhost → native | same | 5.9 MB exe | 203.77 s | 1.89 GB |
| **jz hosted build → executable Wasm** | 6,594,483 B / 411,488 nodes / 162 modules | 17,786,782 B Wasm | 344.02 s | 3.91-4.34 GB |
| jz Wasm-hosted jz×jz (full recursive self-compile) | same 162 modules | **trap, 0 bytes** | 10.5-11.4 s to trap | reaches 4 GiB, OOM |

Input-normalized: jz has 3.14× the source bytes and 3.92× the parsed nodes,
**not** the ~176× hosted-wall ratio against Porffor's C-emission phase — most
of the gap is not input size. The instrumented rerun (348.42 s, byte-identical
output) attributes: `watOptimize` 119.25 s (34.2%), `snapshotInit` 100.40 s
(28.8%), final `watrCompile` (binary encode) 82.25 s (23.6%), semantic
`compile` 42.15 s (12.1%, of which `optimizeModule` 26.82 s + planning
4.52 s). **~87% of hosted self-build wall time is after jz has already built
its semantic module** — whole-WAT optimization, a snapshot-probe encode/run/
rewrite cycle, and final binary encoding. This exactly matches this session's
own §1.6 finding at 1/40th the input scale (watr's package dominating
jz-source time by a similar ratio) — the self-build's cost profile is not an
emergent property of scale, it is the steady-state shape of the pipeline,
multiplied by 162 modules and then run into the wasm32 4 GiB ceiling before
it can finish. The **full recursive jz×jz Wasm-hosted compile has never
produced output** — it traps at exactly 4 GiB. This is the v1 release blocker
per STABILITY.md's own text ("V1 requires this run to produce bytes below
that ceiling").

---

## 2. What experts would say

### (a) IR design — S-expression arrays as the only IR

jz has no typed SSA-ish intermediate representation. The IR *is* the WAT
S-expression tree: nested JS arrays of strings and numbers
(`['i32.add', ['local.get', '$x'], ['i32.const', 1]]`), the same array shape
from `emit.js`'s first emission through `src/optimize/`'s per-function passes
through the final handoff to `watr`. `src/ir.js` is a 46-line barrel over
`src/ir/` (11 files, 2,655 lines: `classify.js`, `coerce.js`, `control.js`,
`tag.js`, `sentinels.js`, `pointers.js`, `numeric.js`, `arrays.js`,
`bigint.js`, `locals.js`, `vars.js`) — helpers *around* the array shape
(classification, coercion, tagging), not an alternative to it. Facts about a
node (result type, purity, effects, pointer kind) are carried as **expando
properties bolted onto the array** — `.type`, `.ptrKind`, `.ptrAux`,
`.schemaSid` are named directly in `.work/porffor-alpha3-audit.md`'s own
prior audit of this same codebase, which already flagged "metadata-loss and
aliasing bugs caused by this shape" as visible in `src/ir.js`'s own comments.

A value passes through at least four representations before it's bytes:
source AST (subscript/jessie parse tree) → jzify-desugared AST (same array
shape, different ops) → WAT-shaped array with expandos (jz's own emit +
optimize) → the *same* WAT-shaped array, now optimized by an *external*
package that also treats it as an untyped array of strings
(`node_modules/watr/src/optimize.js`) → binary. Optimization is therefore
done twice, by two different programs, on two different pieces of code, both
operating on the same weakly-typed textual/array representation — never on a
representation designed for the query an optimization pass actually needs
("is this pure", "what's its result type", "does this alias that"). §1.5
measured the consequence directly: `hasHardOp` (a purity-ish predicate) is
invoked 146,180 times on one 10K-node compile, `loopInvariance` 23,841 times,
neither cached across calls in the same `optimizeFunc` invocation, because
there is no O(1) place to store or look up "is this subtree invariant" —
answering it means walking it again. §1.6 measured the vendor half of the
same cost: ~38.8% of total self-time is `watr/optimize.js`'s own from-scratch
CSE/purity/effect rediscovery on a tree jz already knew the answers for and
threw away at emission.

This is the single highest-leverage structural finding in this audit.
Porffor's own architecture (a fixed six-slot `[kind, type, effects, a, b, c]`
node, O(1) queries, no post-hoc optimizer because the constructors fold as
they build — `.work/porffor-alpha3-audit.md` §1-2) is the right comparison
class, already ranked P1 by the team's own prior audit ("make the compact HIR
real... Keep WAT as a lowering product, not the first authoritative semantic
IR"). This audit concurs and elevates it: see §4(iii).

### (b) Analysis architecture — accreted layers, not one lattice

§1.3/§1.4 already showed the shape: four uncoordinated driver layers (plan's
38-pass round-bounded driver, narrow's 5-call worklist fixpoint, the
per-function optimizer sequence, and the external whole-module fixpoint),
plus 12 overlapping type/kind/representation systems. The team's own
`.work/program-facts-split.md` §7 ("Freeze audit") is the clearest first-party
evidence of what this costs: `programFacts` — the object nearly every pass
above reads and writes — is, in the authors' own words, "a shared mutable bag
the next edit can silently misuse," whose `paramReps`/`callSites`/
`callTargets` fields are written by **producers in at least three different
pipeline stages** (plan, narrow.js, and a fourth, post-`plan()` EMIT-phase
writer, `specializeUnionCursorParams`, called from `src/compile/index.js:2556`
— outside `plan()` entirely). The freeze audit's own conclusion: soundness
today rests on **"pass-ordering discipline, not... construction"** — i.e. the
architecture is correct because every existing call site happens to run in
the right order, not because the type system or a container contract makes
the wrong order inexpressible.

The remediation the team already shipped is itself evidence of the underlying
problem's shape: since neither `Proxy` nor `Object.seal`/`preventExtensions`
exist in the self-hostable subset, and `Object.freeze` is an **identity
no-op** under self-host (`module/object.js:294-299`, "jz objects have no
per-property [protection]"), the only available enforcement is a **read-only
view wrapper** (`{ get: k => paramReps.get(k) }`, swapped in for three plan
rounds and swapped back to the real mutable `Map` before `plan()` returns)
plus a **debug-only** (`JZ_DEBUG_INVARIANTS=1`) `Object.keys` allowlist scan.
This is a real, working mitigation for a real, correctly-diagnosed problem —
but it is a runtime convention bolted onto a language that cannot express
"this object is closed," standing in for a static guarantee a typed IR (or
even a closed record shape enforced by construction, e.g. always rebuilding
a frozen plain object instead of mutating one in place) would give for free.
The `analyzeSchemaSlotIntCertain`/`observeProgramSlots` census pair being
rebuilt **from scratch twice** in one compile (§1.4, #9/#10 — once in the
early gate, once "fresh" post-narrowing) is the same pattern at smaller
scale: it's cheaper to re-derive a whole-program census than to reconcile
its incremental update with everything that ran since the first version was
published, because there is no incremental dataflow engine to ask.

### (c) Inference soundness — real correct-or-reject, not centralized

STABILITY.md is unambiguous and, per this audit's reading of the actual
mechanisms, largely honored: "Where the compiler cannot [preserve JS
semantics], it must reject rather than silently choose a representation or
value. Any unlisted silent wrong value is release-blocking." This shows up as
working code, not just policy: `runFixpointConverged`'s guard-exhaustion path
(`narrow.js:2397`) is a hard `err()`, not a degrade-to-approximate; the
call-target index and dict-kind index headers both describe "never guessed...
poisons... back to unresolved" designs (`call-target-index.js:30-36`,
`dict-kind-index.js:27-32`); `src/type.js`'s duplicate-decider (§1.4) fails
*toward* the safe side (f64) by an explicit, load-bearing one-way rule.

But there is **no single arbiter** — "reject" is implemented independently,
dozens of times, once per analysis module, each with its own bail/poison/
decline vocabulary. `src/compile/infer.js`'s own doc comment is the most
candid first-party evidence available: its 8-tier "evidence ladder" records,
in the source itself, that tiers 2 and 3 (operator-use and member-access
induction — "`s.charCodeAt(...)` used to induce STRING") are **`[retired]`**,
walked back on branches `fix/string-method-guess` and
`fix/param-mutation-propagation` after they were found unsound in production
("a plain OBJECT/HASH can own a same-named closure property, so usage alone
never proves it"). That is the honest answer to "where was guessing
retired": iteratively, one evidence source at a time, discovered by bug, not
by one architectural sweep that made guessing structurally impossible
elsewhere. `kind.js`'s in-file INVARIANT comment on `dictValueTypes`/
`dictValueKindOf` recording **three prior reverts for unsoundness** (cited
verbatim by `dict-kind-index.js:27-29`) is the same pattern a second time.
The soundness *doctrine* is uniform and real; the soundness *mechanism* is
one bespoke predicate per module, not one typed lattice with one join
operator and one bottom value.

### (d) Stdlib-in-dialect and dispatch tiers

The stdlib (`module/`, 29,274 lines) is written in jz's own dialect and
self-hosts through the same pipeline as user code — a real, working
"eat your own dog food" design, and CONTRIBUTING.md documents its
registration surface honestly: **~580 raw `ctx.core.emit[name] = fn` /
`ctx.core.stdlib[name] = body` sites** (the default, for dep-free,
arity-agreeing handlers) versus **~35 `reg()`/`wat()` calls** (required
whenever deps must auto-include or arity is non-obvious) — "this is real,
not legacy-to-migrate," per the doc, and the file backs that framing:
`src/ctx.js`'s `registerName` throws immediately, naming both modules, on any
second write to an already-registered FLAT name, closing a real historical
bug class ("it corrupted `.valueOf()` on every unresolved-type receiver for
as long as it shipped" — CONTRIBUTING.md's own account). A raw-write clobber
of a guarded `reg()` handler still can't be caught synchronously (no Proxy —
same limitation as §2b), so a post-hoc `verifyEmitIntegrity` sweep runs after
every module's `init()` returns to catch it retroactively. Two dialects by
design, with one now-enforced invariant and one after-the-fact backstop for
the one case that can't be enforced live — a reasonable trade given the
language's own constraints, not an oversight.

Method-call dispatch, measured directly (`src/compile/emit.js:4671`
`emitMethodCall`, `LEADING_STRATEGIES` 4029 + `TYPED_STRATEGIES` 4648): **14
named strategies, first-match-wins, in a fixed order** — 5
context-free (`tryFlatObjectMethod`, `tryConcatBufCharCodeAt`,
`tryCharCodeAtFast`, `trySpliceInsert`, `tryFnPropCall`) then 9 keyed off the
receiver's statically-resolved value kind (`tryBoxedDelegate`,
`trySidecarToPrimitive`, `tryStaticDispatch`, `tryRuntimePtrTypeFork`,
`tryRuntimeNumberMethod`, `trySchemaClosureCall`, `tryGenericEmitter`,
`tryDynamicPropCall`, `externalMethodFallback` — the last one total). Most of
these resolve entirely at **compile time**: the compiler picks the one
strategy that applies and emits code for only that path — this is not 14
runtime branches. The generic-dispatch *cost in emitted code* shows up only
when the receiver's kind genuinely can't be proven: compiling
`export const f = (x) => x.slice(1, 2)` (a deliberately unresolvable
receiver) emits a NaN-box tag runtime fork (`tryRuntimePtrTypeFork`,
emit.js:4200-4270) that must ship **both** `__str_slice` and
`__typed_slice_rt` kernels — every kind the value could dynamically be, not
one shared generic path — plus the allocator. Measured: 11 functions, and
(thanks to tree-shaking + `watOptimize`) a 1,990-byte final binary — the
per-call-site *dispatch-fork* cost is real but the *total* stays small
because it's tree-shaken and shared once compiled, not duplicated per call
site with a distinct receiver in the same function. The dispatch tier count
is a genuine complexity cost to a reader of `emit.js` (14 strategies to
hold in your head to know what a given `.method()` call becomes); the
runtime cost it produces in real programs is smaller than the tier count
suggests, because most receivers *are* proven.

### (e) Codegen quality vs. state of the art

What jz has that's genuinely general, verified by reading, not by the
README's own marketing: `src/optimize/arena-rewind.js` — module-level escape
analysis is a real whole-program fixed-point over a call graph
("propagating 'arena-safe callee' status via fixed-point iteration," not a
per-bench recognizer), classifying every function as arena-safe/rewindable
generically. That is a legitimate general technique, in the same family as
what Binaryen's `heap2local` does for GC structs, scoped to jz's own
bump-arena model.

What's recognizer-based, not general: the vectorizer
(`src/optimize/vectorize/`, **24 files, 8,613 lines** — almost as large as
watr's *entire* external optimizer, 8,677 lines) is a named-pattern
dispatcher (`aos.js`, `blur-channel.js`, `butterfly.js`, `dot-slp.js`,
`idioms.js`, `map.js`, `memcpy.js`, `outer-strip.js`, `per-pixel-color.js`,
`ramp.js`, `reduce.js`, `stencil.js`, `strength-reduce.js`, `tone-map.js`, …)
tried in order (`CONTRIBUTING.md`'s own "Adding an auto-vectorizer
recognizer" section confirms this is the intended extension model: a new
idiom is a new file and a new dispatch entry, not a generalization of an
existing one). README's own optimization list documents the boundary
explicitly: "Loop-carried dependencies remain scalar" — a real, self-admitted
gap versus a general dependence/reassociation-based auto-vectorizer.
`CONTRIBUTING.md`'s own coverage note lists concrete open items in the same
vein: i32x4 cellular automata (game-of-life/ising/rule30) as "feasible," and
gather/scatter loops (dla/sand/voronoi) as infeasible **on this ISA**
(WASM-SIMD has no gather/scatter — correctly attributed to the target, not
the compiler).

Inlining is three narrow, named heuristics (`inlineHotInternalCalls`,
`inlineLocalLambdas`, `specializeFixedRestCalls`, all in
`src/compile/plan/inline.js`) — no general cost-modeled whole-program
inliner. There is no SSA form anywhere in the pipeline, so no GVN/PRE beyond
what `watr`'s external CSE happens to find on the WAT-array shape.

Binaryen comparison, measured locally (`wasm-opt --version` → 128 installed
at `/opt/homebrew/bin/wasm-opt`, not recalled from memory): `wasm-opt --help`
lists **271** flags, the large majority genuine IR-level passes —
`heap2local` (GC scalar replacement / escape analysis, general), `gufa`
("Grand Unified Flow Analysis," whole-program flow-sensitive type
refinement), `dfo` (SSA-based DataFlow optimization), `directize`
(devirtualize indirect calls generally), `code-folding`, `inlining-optimizing`
(budget-driven whole-program inlining), `dae`/`dae-optimizing`
(dead-argument elimination). jz relies on `watr`'s external, closed,
8,677-line `optimize.js` for CSE/DCE/const-fold/inline/coalesce as its *only*
whole-module fixpoint (§1.3 driver D) — a single file with an unknown
(un-audited by this session; out of scope, it's not jz's code) internal pass
list, almost certainly smaller and less general than Binaryen's, and jz has
**no visibility or control** over what that file does or doesn't do, only
what it hands it. Nothing in the pipeline plays Binaryen's `wasm-opt -O`
role *for jz's own emitted IR before* the handoff to `watr` — jz's own
`optimizeFunc` (§1.3 driver C) is explicitly non-fixpoint, one fixed pass
per function, by design (driver.js:44-45).

### (f) Self-hosting economics

Covered with full measurements in §1.8. Verdict: the 100×-class gap against
Porffor is real, mostly not input-size, and ~87% of it sits *after* semantic
compilation finishes (whole-WAT optimize + a snapshot probe + final encode).
This session's own §1.6 profile shows the identical shape at 1/40th the
scale — the self-build's economics are the steady-state pipeline shape
multiplied by 162 modules, not a scale-emergent pathology. The
Wasm-hosted jz×jz recursive self-compile has never produced output (traps at
4 GiB) — the single largest unresolved item in this codebase by any measure
(release-blocking per STABILITY.md, not a style preference).

### (g) Codebase size relative to what it does

108,446 lines (§1.1) to compile a deliberately *finite* JS subset to Wasm —
compare AssemblyScript (a much larger surface: full TypeScript-flavored
syntax, its own standard library, a Binaryen-backed backend it doesn't have
to write) and Porffor (currently ~2.1 MB selfhost bundle, closer to jz's
order of magnitude, also self-hosting a JS-subset-to-native compiler). jz's
own README frames the tradeoff correctly for *language* surface — "A finite
speed dialect, not an open-ended escape hatch" — but the **inference and
representation-planning machinery** (§1.4's 12 systems, `narrow.js`'s 4,027
lines, `emit.js`'s 8,167) is what a *sound, no-annotation* type/representation
inferencer over untyped JS costs, and that premise (infer, don't annotate) is
the single largest cost driver in the LOC total, not the language surface
itself. The file-size trend (§1.2: 10→5 files over 3k lines in two days) is
real evidence the team is actively cutting this, not merely aware of it.

### (h) Testing/gating culture — strengths and blind spots

**Strengths, verified by reading the mechanism, not the claim:**
`scripts/refactor-oracle.mjs` proves byte-identical compiled output across
the whole corpus at every optimize level between two trees — a real,
structural "this refactor changed nothing observable" proof, not a test
suite that merely didn't fail. It is explicit about its own boundary
(`.work/refactor-oracle.md`): excludes the self-host compile *by default*
purely for cost (68 s at O0, 246 s at O3, opt-in via `--full`) — a
deliberate, documented, sized tradeoff, not a silent gap. STABILITY.md's
correct-or-reject contract is CI-gated (test262: exactly 3,908 applicable
negative-parse rejects / 137 accepts, "an exact path set, not a count
ceiling" — regressions AND *improvements* both require updating the pinned
ledger, closing the easy failure mode of a ratchet that only tightens on
paper). `test/bench.js`'s claims ratchet (`win`/`tie`/`near`/`todo`,
"a PR may not move any claim backward") is a real anti-backslide mechanism.

**Blind spots, self-documented by the team, not discovered here:**
`refactor-oracle.md` states its own limits plainly — "cannot prove... runtime
behavior of host-nondeterministic paths" and, more importantly, "cannot
prove correctness of either side... a refactor that reproduces an existing
bug exactly is reported clean." Byte-identity is a *non-regression* proof,
not a correctness oracle — `kernel-oracle`/`kernel-parity` exist precisely
because byte-identity alone is insufficient, but that means the safety net
has two different meshes stacked, not one uniformly fine one. The handoff's
own 2026-08-26 audit records a real instance of the mesh gap doing damage:
"P0 kernel-target regression — recursive OBJECT-schema fails self-hosted only
(test:wasm 2913/1)... batteries MUST include the FULL kernel-target suite
from now on (the gap that let this land)" — i.e. a real wrong-value bug
shipped past the existing gates *because* the self-hosted-only battery
wasn't part of the default gate at the time, and the fix was procedural
("must include," going forward) more than structural. As of the same
handoff, exactly one open `KNOWN-WRONG` pin remained (Shape #7, BigInt across
computed-key dispatch) — tracked, not hidden, but a live accepted-wrong
value in a compiler whose entire stability contract is "correct or reject."

---

## 3. The overdone list

Each item: what it costs today (measured or cited), what would replace it,
what breaks if it's simply deleted. Two items below are explicitly **not**
overdone on inspection — included because they look like obvious targets
and are not; pattern-matching "big subsystem = cut it" is wrong here twice.

**1. Two independent i32/f64 deciders (`emit.js` vs `src/type/expr-type.js`).**
*Cost:* not lines (both are needed regardless) — the cost is a standing
synchronization obligation, documented by the file itself as something a
human must maintain by discipline ("edit one side only with the other open
beside it," `src/type.js:16-39`) rather than something the compiler enforces.
This is exactly the shape of bug the "recomputed elsewhere" question in this
audit's brief was checking for, and jz's own authors already found and fixed
one instance of the class it produces: the "opaque dispatch recovery" entry
in `.work/handoff-2026-08-22.md` ("Numeric use called
`__length_num → __length → __to_num`, repeating dispatch on ARRAY hot
paths... the mere existence of an unrelated durable rep hid higher-priority
flow facts") is a lookup-priority bug in the same family — not this exact
duplicate, but proof the two-deciders-for-one-fact pattern in this codebase
has produced real, shipped, measured regressions (recovered ~3 percentage
points of warm perf) before. *What would replace it:* one decision function
`emit.js` calls to both decide-and-emit and to answer "what will you decide"
before emission — i.e. collapse "decide" and "predict" into one call with two
call sites, not two implementations. The blocker the file itself names is
real: `emit` reads IR values (`isLit`/`maskBound`) that don't exist before
emission, `exprType` reads AST (`staticValue`/`intExprRange`) needed *before*
local types can be sized. *What breaks if merged carelessly:* the ordering
constraint is real, not laziness — locals must be typed before their home
function is emitted, so a merge needs either a two-phase decider (predict
now, confirm during emit, assert agreement in debug builds — cheaper than
what exists today, which asserts nothing, it just documents the invariant in
prose) or restructuring emission to defer local typing. Scope for §4.

**2. `plan()`'s 38-pass, 6-round monolith with a hand-rolled dirty-bit cache
(`src/compile/plan/index.js`, 445 lines).** *Cost:* 445 lines of pure
orchestration (not counting the ~30 pass implementations it calls), a
bespoke `facts()`/`_dirty`/`sweep()` re-derivation cache that every new
whole-program fact must be manually wired into to know when to invalidate,
and (per §1.3) a whole-program re-collection whose actual frequency is
input-dependent and only knowable by tracing, not by reading the driver.
*What would replace it:* a real incremental/worklist dataflow engine
parameterized by named lattices + transfer functions, so "does fact X need
to be recomputed after pass Y ran" is answered by declared dependencies, not
by each pass author remembering to call `sweep()` correctly. *What breaks if
removed naively:* the `round()`/`exitRound()` region-arena reclaim
boundaries are **not** ceremony — the inline comments document real,
measured retained-memory deltas per round (+900 MB, +198 MB, +395 MB, +60 MB,
+22 MB) that matter *only* because the self-hosted kernel has no garbage
collector (`CONTRIBUTING.md`: "No runtime... compiled WASM has no jz-specific
runtime" — a load-bearing product principle the team has explicitly chosen,
not an oversight). Any replacement driver needs the *same* reclaim hooks;
this is "overdone" only relative to a hypothetical GC'd self-host runtime the
project has already, correctly, declined to build. Simplify the scheduling
logic, keep the reclaim discipline.

**3. `inferTypedValueRanges` (`src/compile/narrow.js:1621-2984`, ~1,364
lines, one function).** *Cost:* the single largest remaining outlier
function in the pipeline (verified current, §1.2), already on the team's own
backlog (`.work/todo.md:8512`, "extract inferTypedValueRanges' range algebra
toward static.js"). Not a new finding — re-affirmed here as still the
highest-value single-function split remaining, now that `emitInstanceof` and
`genUpsertStrictPrehashed` (the handoff's other two named outliers) are
independently verified fixed (§1.2). *What would replace it:* exactly what
the team's own todo already specifies — extract the interval/range algebra
to `static.js`, alongside the existing `hull`/`typedValueLiteral`/
`typedValueExprRange` triad the function's own comment says were *already*
relocated there for the same reason. *What breaks:* nothing structural — this
is a pure extraction the team has already scoped; it just hasn't happened.

**4. Uncached hot predicates inside one optimizer pass (`hasHardOp`,
`loopInvariance`, `src/optimize/licm.js`).** *Cost:* measured directly
(§1.5) — 146,180 calls / 806,577 visits and 23,841 calls / 378,253 visits
respectively, in one 10,234-node O3 compile, none of it cached across calls
within the same `optimizeFunc` invocation on the same function body. LICM's
five hot entries together are ~22% of all O3 `walkAst` visit volume.
*What would replace it:* a `WeakMap<node, bool>` (or an expando flag, matching
the existing `.type`/`.ptrKind` convention on IR nodes, §2a) scoped to one
`optimizeFunc` call, invalidated per function (bodies aren't mutated
concurrently within one call). *What breaks if removed:* nothing semantic —
this is pure redundant work, the safest class of finding in this audit
(§4(i), same-day).

**5. Duplicate scan-then-rewrite double traversals inside single passes**
(`specializeMkptr` at `src/optimize/specialize-mkptr.js:104`/`:214`,
`static-data.js`'s `scan` at lines 46/139, `devirt.js`'s `devirtSchemaReads`
at lines 50/227). *Cost:* measured (§1.5) — each pair visits the *same*
tree twice for ~210-270K visits per pair, per compile. *What would replace
it:* `walkAst` already supports this in one call — `enter` for the scan
(collect candidates), `exit` for the rewrite (post-order, sees rewritten
children first, exactly the ordering these passes already want). This may
be a same-file, same-pass mechanical change per site, not a redesign.
*What breaks:* needs per-site verification that the scan phase doesn't
depend on having *finished* scanning the whole tree before any rewrite
starts (a real possible reason for the two-pass split — not yet verified
per site, flagged for the implementing agent, not assumed safe here).

**6. Relying on `watr/optimize.js` (external, 8,677 lines, unaudited by
jz) as the *only* whole-module fixpoint.** *Cost:* §1.6 measured ~38.8% of
total self-time inside this one external file, plus ~16.2% in its shared
walk utilities — a majority of wall-clock time in code jz does not own,
cannot restructure, and (per `index.js`'s own architecture comment) has
deliberately chosen not to duplicate ("jz's optimizer runs exactly once,
before watr... watr is the sole optimizer that runs after"). This is not
obviously wrong — `.work/porffor-alpha3-audit.md`'s own "what not to copy"
list is explicit that direct Wasm quality (not "trust a downstream tool") is
jz's actual claim, and that discipline is *why* jz's own SIMD/LICM/escape
passes exist instead of hoping `watr` finds those opportunities. But the
practical effect today is **two optimizer budgets paid on every compile** —
jz's own 24-pass non-fixpoint sequence (§1.3 driver C), then watr's
from-scratch whole-module fixpoint that re-derives CSE/purity facts jz
already had and discarded at emission. *What would replace it:* not
"remove watr" (§4(iii) explains why that's the wrong first move) but
reducing how much rediscovery watr has to do — feed it a module where jz's
own passes have already reached local fixpoint and folded what's cheaply
foldable, so the external pass's work shrinks proportionally to what jz's
own passes actually close out. *What breaks if watr were simply dropped:*
everything — it is the only pass in the pipeline that runs to convergence;
without it the compiler ships whatever jz's single fixed-order per-function
pass happened to leave behind, and per index.js's own comment this is by
design not accidental, so dropping it is not a simplification, it is a
regression.

**7. The SIMD vectorizer's recognizer sprawl (`src/optimize/vectorize/`,
24 files, 8,613 lines).** *Cost:* nearly as large as watr's entire external
optimizer (8,677 lines) spent on named, order-tried pattern recognizers
(`aos.js`, `blur-channel.js`, `butterfly.js`, `dot-slp.js`, `outer-strip.js`,
`per-pixel-color.js`, `ramp.js`, `stencil.js`, `tone-map.js`, …) rather than
one general dependence-based auto-vectorizer. Every new loop shape not
already matched by an existing recognizer needs a *new file*
(`CONTRIBUTING.md`'s own extension guide confirms this is the intended
workflow, not an accident). README already documents the resulting gap
honestly ("Loop-carried dependencies remain scalar"). *What would replace
it:* this is the one item in this list where "replace with something more
general" is a multi-month research project (a real polyhedral/
dependence-and-reassociation-based loop vectorizer), not a refactor — see
§5 for the ranked bench-impact case, and §4(iii) for why this is
re-architecture-class, not a slice. *What breaks if merely deleted:* every
already-shipping bench win attributed to a specific named recognizer
(stencil, outer-strip, tone-map are all named directly in the CLI flags and
README options table as stable, user-visible knobs) — this is not dead
code, it is a real, working, product-facing capability; the "overdone" claim
here is about the *pattern* (one file per idiom, unbounded growth) not about
any individual file being wasteful.

**8. NOT overdone, on inspection — the BigInt representation-plan
subsystem** (`src/compile/representation-plan/`, 6 files, 2,716 lines
including barrel, sole authority per ADR-0001). This *looks* like a
dedicated subsystem for one narrow value kind and would be an easy target by
pattern-matching alone. It is not: the handoff's own "one representation
authority — complete" entry records that this subsystem is what **replaced**
a *worse*, dual-implementation predecessor (a hand-built sentinel ABI plus a
separate `bigintBoxed` field, deleted end-to-end across "the final census
result sentinel ABI (`jz:i64exp.s`, layout tables, interop decoder and
hand-built wrapper)... bare, unary and joint results all use the generic
tagged decode" — net **−755 lines** across that completion, `dist/jz.wasm`
shrank 17,115.3→17,082.8 kB). What exists today is the simplification of a
previously-worse system, already measured and landed. It is a good template
for what §4's slices should look like (single authority, `KEEP/BOX/UNBOX/
HOST_BOX/REJECT` per edge, one decision, no shadow state) — not a
simplification target itself.

**9. NOT overdone, on inspection — the outlier "giant functions" the
handoff flagged.** `emitInstanceof` and `genUpsertStrictPrehashed` were both
independently re-verified in this session (§1.2) as already reduced from
~2.1k/~2.5k lines to 116/66 lines respectively. Listing them here (as the
brief's source material would suggest) would have been citing a two-day-stale
number as current. Recorded so the next reader doesn't re-discover and
re-report a already-closed item.

---

## 4. The simplification plan

### (i) Start today, land within a day — mechanical, low-risk, refactor-oracle-gated

| Slice | Scope | Files | LOC Δ | Expected effect | Gate | Effort | Deps |
|---|---|---|---|---|---|---|---|
| **1. Memoize `hasHardOp`/`loopInvariance`** | Cache the predicate per node within one `optimizeFunc` call (§3.4) | `src/optimize/licm.js` | +15/-0 | Cuts a slice of the measured ~3.40M LICM-family visits (≈22% of O3's 15.27M); expect measurable O3 wall-time drop on `watr`-class specimens, no RSS regression (cache is function-scoped, freed per function) | `refactor-oracle.mjs check` byte-identical (pure perf, zero behavior change) + before/after wall time on `bench/watr` | 2-4 agent-hours | none |
| **2. Collapse `specializeMkptr`'s two-pass scan+rewrite** | One `walkAst(enter, exit)` call instead of two separate walks (§3.5) | `src/optimize/specialize-mkptr.js:104,214` | -10/-0 | -~211K visits/compile (~1.4% of O3 total) | refactor-oracle byte-identical | 2-3 agent-hours | verify scan doesn't need whole-tree-complete state before any rewrite starts (check before assuming safe) |
| **3. Same collapse for `static-data.js`'s duplicate `scan`** (lines 46/139) | `src/wat/assemble/static-data.js` | -10/-0 | -~270K visits/compile | refactor-oracle | 2-3 agent-hours | same caveat as #2 |
| **4. Same collapse for `devirt.js`'s `devirtSchemaReads`** (lines 50/227) | `src/optimize/devirt.js` | -10/-0 | -~267K visits/compile | refactor-oracle | 2-3 agent-hours | same caveat as #2 |
| **5. Land `inferTypedValueRanges` extraction to `static.js`** — already scoped by the team's own `.work/todo.md:8512`, not a new finding here, re-affirmed as highest-value remaining single-function split now that emitInstanceof/genUpsertStrictPrehashed are independently confirmed done (§1.2/§3.9) | `src/compile/narrow.js:1621-2984` → `src/static.js` | ~1,364 moved, net ~0 | Readability/maintainability only — no behavior or perf change expected | refactor-oracle byte-identical | 4-8 agent-hours (mechanical extraction + re-verify the file's own documented reason it wasn't merged with the existing `hull`/`typedValueLiteral`/`typedValueExprRange` trio) | none |

Slices 1-4 together remove on the order of 750K-1M redundant `walkAst`
visits per O3 compile of a watr-sized specimen (~5-7% of the measured
15.27M) for under two agent-days total, at effectively zero risk (pure
caching / traversal-shape changes, no decision logic touched, oracle-provable).

**Landed / declined, 2026-08-29** (worktree
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/wv`,
branch `refactor/walk-volume` off `17bca77f`; instrumentation reproduced
per §1.5's method — `_auditCounters` in `src/ast.js`, driver
`scripts/_audit-walkast.mjs`, both uncommitted):

- **Slice 1 — LANDED** (`bcd1b905`). `hasHardOp` converted from a flat
  `walkAst`-rescan-per-call predicate to a bottom-up, `Map`-memoized one;
  `loopInvariance` wrapped with a `Map`-memoized-by-node cache. Both caches
  are created fresh at the top of each `hoistInvariantLoop(fn)`/
  `splitLoopPrivateScratch(fn)` call — scoped to survive only ONE such call,
  never shared across the driver's separate `hoistInvariantLoop` invocations
  (`src/optimize/driver.js` calls it twice by default, with `fusedRewrite`/
  `hoistAddrBase` running in between; confirmed those mutate nodes in place —
  e.g. `src/optimize/peephole.js:104`'s `n[1] = ...; n.splice(2, 0, base)` —
  so a cache surviving that boundary could read a stale verdict). Safety
  argument: within one top-level call, `isHoistable`'s `collect` walk
  finishes querying a loop's content before that loop's own hoist mutations
  run (the snap-splice happens after `collect` returns), and an inner loop's
  hoist relocates matched subtrees OUT of the outer loop's span rather than
  rewriting content the outer loop's later walk still depends on. Measured
  on the watr specimen at O3 (this worktree, before/after this commit only):
  walkAst calls 269,642 → 121,892 (**-54.8%**), visits 15,170,740 →
  14,330,942 (**-839,798, -5.5%**); wasm output byte-identical
  (540,785 bytes both sides). Battery: refactor-oracle CLEAN 560/560,
  `test/kernel-parity.js` 33/33, `test/kernel-oracle.js` 605/605,
  `test/pointers.js` 132/132, `test/data.js` 1098/1098,
  `test/invariants.js` 106/106, full `test/index.js` 3863/3864 (1
  pre-existing, unrelated skip).

- **Slice 2 — DECLINED**, proof from the code, not assumed: Pass 1
  (`collectCall`, `specialize-mkptr.js:104`) accumulates a **whole-`funcs`-
  array** signature-frequency census (`counts`/`countEntries`) — so
  centrally whole-module that it's threaded through `regionHooks` region-
  arena checkpoints every 8 functions specifically because it must span the
  entire corpus before use (lines 101-111). The `specialized` set (which
  signatures earn a helper) is only complete once `MIN_USES` (4) has been
  checked against the FULL census (line ~115) — a signature could cross
  that threshold from occurrences in a function with a **higher** index than
  the one currently being considered. Pass 2's rewrite (`exit: rewrite`,
  line ~214) for `funcs[0]` needs to know whether ITS call sites'
  signatures are in `specialized`, which isn't knowable until `funcs[N-1]`
  has also been scanned. This is exactly "the scan is genuinely whole-
  tree(module)-before-rewrite" — no `walkAst(enter, exit)` restructuring
  changes that, since it operates on one tree at a time and the dependency
  spans the whole `funcs` array. Not attempted.

- **Slice 3 — DECLINED**, different reason: the file's actual shape doesn't
  match the assumed pattern. `stripDeadLazyTables`'s `scan` (line 46) and
  `stripDeadInternedSpans`'s `scan` (line 139) are each a *complete,
  self-contained* mark-sweep reachability walk inside its own exported
  function — **neither function has a second `walkAst`-based rewrite phase**
  to merge with (each one's actual mutation — data-segment truncation/
  repointing via `dataReset`/`setInit`, or `spans` truncation — is flat
  array/Map manipulation, not a tree traversal). There is no scan-then-
  rewrite-via-`walkAst` pair to collapse in either function. The real
  redundancy is shaped differently: the two functions are separate, sibling
  exports, called back-to-back (this file's own header) over an unchanged
  call graph, so their two independent mark-sweeps recompute much the same
  reachable-function set. De-duplicating that is possible in principle but
  would mean either violating this file's own explicit "none of the three
  calls another in this file" design statement, or reaching outside this
  slice's single-file scope into the orchestrator (`compile/index.js`) to
  compute reachability once and hand it to both — both outside a same-file
  mechanical slice. Declined as specified; the cross-function redundancy is
  flagged here for a future, differently-scoped slice, not attempted now.

- **Slice 4 — DECLINED**, two independent reasons: (a) `devirtSchemaReads`'s
  first scan (`assigned`, line 50) collects every local ever written
  ANYWHERE in `fn`; its second scan (`countScan`, line 227) calls
  `stableRecv`, which tests `!assigned.has(...)` — a receiver-stability
  classification that depends on `assigned` being COMPLETE. A local written
  later in source order than an earlier tagged read of it is a real,
  ordinary shape (a param reassigned in a branch appearing after an earlier
  use); merging these into one `walkAst(enter, exit)` pass would classify
  that earlier read against a partial `assigned` set and wrongly treat the
  local as stable — a soundness risk, not just a missed optimization,
  exactly the "rewrite needs facts from nodes the scan has not yet reached"
  case this slice's own instructions anticipated. (b) Independently, the
  actual mutation in this function is a **third**, separate, hand-rolled
  traversal (`walkDSR`, ~line 293 on, its own scoped memo/clobber tracking)
  that never calls `walkAst` at all — so even setting reason (a) aside,
  there is no `walkAst`-based rewrite phase to fold scan-227 into. Not
  attempted.

### (ii) Multi-day, incremental, behind fuller gates

| Slice | Scope | Files | LOC Δ | Expected effect | Gate | Effort | Deps |
|---|---|---|---|---|---|---|---|
| **6. Unify the i32/f64 dual-decider** (§3.1) — first land a debug-only assert that `exprType`'s verdict and `emit`'s actual choice agree (cheap, catches drift immediately), then work toward one shared decision path | `src/type/expr-type.js`, `src/compile/emit.js` (`mulFitsI32`/`addFitsI32` area), `src/ir.js` | net negative once merged, but the intermediate assert step is +~20 | Closes the standing sync-bug class the file's own comment documents as a real risk (§3.1 cites a prior shipped regression in the same family) | **Full battery + kernel-parity + kernel-oracle + refactor-oracle** (not byte-identical alone — this is semantics-adjacent, not pure perf) | 1-2 agent-days for the assert step; the full merge is a second, separately-gated slice after the assert has run clean for a while | none blocking, but treat as high-care given the file's own explicit warning |
| **7. Always-on `programFacts` shape/freeze check** (§2b) — promote the existing `JZ_DEBUG_INVARIANTS`-gated allowlist scan to a cheap always-on check (or prove it's cheap enough to always run); this is the team's own handoff gate-5 finding, re-affirmed here, not new | `src/compile/program-facts/freeze.js`, `src/compile/plan/index.js` | +~10 | Closes (rather than just documents) the "shared mutable bag" soundness risk `program-facts-split.md` §7 names as a real, if not-yet-triggered, hazard | Full battery; must show negligible perf delta (it's a hot path) or gate it behind `optimizing()` off-path only | 0.5-1 agent-day | none |
| **8. Precompiled, compressed, lazily-decoded stdlib IR** (Porffor pattern #4 below, existing team ranking: P0) — targets the `pullStdlib` churn the prior audit measured at ~927 MB during self-compile | `module/*`, `src/wat/assemble/stdlib-pull.js`, new build-time generator (precedent: `scripts/gen-prop-modules.mjs` + `src/prop-modules.generated.js` + its freshness test `test/self-compile-includes.js` — the exact "generated table + freshness gate" pattern this needs) | new generator (~300-600 est.), stdlib pull path simplifies | Reduces self-compile memory churn; effect on everyday small compiles likely small (stdlib pull is already demand-gated per-symbol, this compresses *what's decoded*, not *whether*) | refactor-oracle + a new freshness test in the `self-compile-includes.js` family (source vs generated table must never silently drift) | Multi-day: new serialization format + round-trip tests + the generator itself | Should land *after* slice 9's HIR work reaches its "fact schema" milestone if both are in flight — the packed format wants to target the same fact shape, not be designed twice |
| **9. Demand-first function generation / one frozen reachability index before emission** (Porffor pattern #3, existing team ranking: P0) — jz currently emits every entry in `ctx.funcs.list` then tree-shakes after (`src/compile/index.js:2619+`); build the reachability index first and skip emission of provably-unreachable functions | `src/compile/index.js` (emit driver core), `call-target-index.js` | net negative (removes emit-then-discard work) | Fewer functions pay analysis/IR-allocation cost before being discarded; self-compile-scale effect likely larger than everyday-compile effect (self graph ≈2,234 functions per the prior audit) | Full battery + kernel-parity + kernel-oracle + self-compile timing before/after | Multi-day, touches the emit driver's core sequencing | **Must** consume `RepresentationPlan` + the canonical `call-target-index.js` — explicitly no name-guess fallback (this is the existing team audit's own condition, repeated here because it's the right constraint, not because it's new) |

**Slice 7 — LANDED, 2026-08-29** (`e58e2aee` + test-pin follow-up `b9b56aaa`,
worktree/branch as above). Measured `assertProgramFactsShape`'s own cost
directly (isolated `performance.now()` around its one call site,
`plan/index.js`, called exactly once per compile): **0.02-0.024 ms**,
sampled on the watr specimen at all five optimize levels —

| level | whole-compile wall | assertProgramFactsShape | share |
|---|---:|---:|---:|
| O0 | 0.70 s | 0.0217 ms | 0.0031% |
| O1 | 0.79 s | 0.0220 ms | 0.0028% |
| O2 | 4.37 s | 0.0199 ms | 0.0005% |
| O3 | 6.27-6.38 s | 0.0209-0.0242 ms | 0.0003-0.0004% |
| size | 4.07 s | 0.0206 ms | 0.0005% |

— several orders of magnitude under the 0.5% threshold even at O0 (the
least favorable ratio, since it's one fixed-cost check against the
smallest compile). Removed the `JZ_DEBUG_INVARIANTS` gate and the now-dead
`DBG_INVARIANTS` import entirely (the whole function was already the
"cheapest always-on subset" — a single `Object.keys` allowlist scan, no
larger body to partition). wasm output byte-identical before/after
(confirmed via refactor-oracle and via matching wasmBytes in the timing
run). One pre-existing test (`test/invariants.js`, "assertProgramFactsShape
rejects an undocumented programFacts key, only under JZ_DEBUG_INVARIANTS")
pinned the old gated contract and needed updating to match — a real,
expected companion change, not a regression (`b9b56aaa`). Battery:
refactor-oracle CLEAN 560/560, `test/kernel-parity.js` 33/33,
`test/kernel-oracle.js` 605/605, `test/pointers.js` 132/132,
`test/data.js` 1098/1098, `test/invariants.js` 28/28 tests (107
assertions — 106 before this slice's test-pin update, +1 from the more
thorough rewrite), full `test/index.js` battery all green.

### (iii) Re-architecture — say so plainly, with a migration path

**10. Compact typed HIR, replacing WAT-array-with-expandos as the first
semantic IR** (§2a, Porffor pattern #1). This is the single highest-leverage
item in the whole audit and it is **not** a slice — it touches essentially
every file under `src/compile/`, `src/optimize/`, `src/wat/` (>60K lines
combined). Effort: multi-month, many-agent-week campaign. Say so plainly: do
not schedule this as if it were slice-sized. Migration path, phased so the
compiler stays shippable throughout:
  1. Define the fixed-shape node (opcode, result representation, provenance,
     effects as dense fields) as an **additional** layer alongside the
     existing WAT array, not a replacement — every node still carries its
     WAT-array form.
  2. Build a differential fact-checker (dev-only): for a chosen fact (start
     with purity/effects — the highest-measured redundant-recompute cost,
     §1.5's `hasHardOp`/`loopInvariance`), compute it both the old ad-hoc
     way and read it off the new HIR field, assert equality on the whole
     corpus. This tool is itself a real deliverable and should land *before*
     any consumer migrates — it is what makes every subsequent step provable
     rather than hopeful.
  3. Migrate one fact family at a time to read from the HIR field instead of
     re-walking, starting with the family §1.5 shows costs the most
     (LICM's purity/invariance checks). Each migration is its own
     refactor-oracle-gated slice.
  4. Only once every consumer of a given expando (`.type`, `.ptrKind`,
     `.ptrAux`, `.schemaSid`) has moved to the HIR field does that expando
     get retired. WAT stays the lowering target, produced from the HIR at
     the very end — matching Porffor's own framing exactly ("Keep WAT as a
     lowering product, not the first authoritative semantic IR").
  Gate for the *whole* campaign, not just its slices: the differential
  fact-checker from step 2 must show zero disagreements across the full
  corpus for a sustained period before any expando is deleted, in addition
  to refactor-oracle/kernel-parity/kernel-oracle at every step.

**11. Reduce what's handed to `watr`, as an experiment before any
commitment to owning convergence** (§3.6). Do **not** start by trying to
replace or absorb `watr/optimize.js` — jz's own architecture doc is explicit
that this split is deliberate (index.js:23-25). Instead: as a measurement,
make jz's own `optimizeFunc` sequence loop to a real per-function fixpoint
(run the 24-pass sequence repeatedly until no pass reports a change, bounded)
and measure whether `watOptimize`'s share of wall time (§1.6: currently
38.8%) drops proportionally on the same corpus. If it does, that's real
evidence for gradually absorbing more convergence responsibility into jz's
own (typed, once the HIR from #10 exists) optimizer over time. If it
doesn't, the "two budgets" framing is less actionable than §3.6 suggests and
effort should redirect to #10/#8 instead. Effort for the experiment alone:
2-3 agent-days; the full re-architecture this might justify is
multi-month, same caveat as #10.

**12. General dependence-based loop vectorizer** (§3.7, §5). Re-architecture
class, not a slice — building a real dependence/reassociation-based
vectorizer is a multi-month research effort, and it would likely *grow*
`src/optimize/vectorize/` before enabling any deletion (the general framework
has to prove it subsumes specific recognizers bit-exact, per
`CONTRIBUTING.md`'s own existing discipline, before those recognizer files
can retire). Migration path: build the general framework alongside the
existing 24 recognizer files; prove bit-exact subsumption of 2-3 recognizers
first (start with the simplest, e.g. `map.js`); retire subsumed files one at
a time, each its own gated slice. See §5 for why this ranks where it does on
expected bench impact specifically (loop-carried-dependency cases are a
self-documented, currently-scalar gap).

### Porffor patterns — judged individually, not as a package

| # | Pattern | Verdict | Reasoning |
|---|---|---|---|
| 1 | Fixed six-slot typed/effect IR | **Adopt** | This audit's own §2a/§1.5 evidence (uncached `hasHardOp`/`loopInvariance`, expando-property IR) independently arrives at the same conclusion the prior team audit already ranked P1. Concur, elevate to the top of §4(iii). |
| 2 | Optimize-while-constructing, no post-hoc optimizer | **Adapt, not adopt whole** | jz cannot drop its optimizer — direct Wasm quality is the stated product claim (`.work/porffor-alpha3-audit.md`'s own "what not to copy" list agrees). The *transferable* half — fold obvious garbage (dead conversions, constant chains) at IR-construction time, before any pass has to rediscover it — is cheap and compatible with keeping a real optimizer; adopt that half only. |
| 3 | Demand-driven function/builtin generation | **Adopt** | Concur with existing P0 ranking; independently motivated here by this session's own measurement that jz emits every `ctx.funcs.list` entry before tree-shaking (§4(ii) slice 9). |
| 4 | Precompiled/compressed/lazily-decoded builtins | **Adopt** | Concur with existing P0 ranking; targets a previously-measured real cost (`pullStdlib` churn). Scoped as §4(ii) slice 8, sequenced after the HIR's fact schema stabilizes so the packed format isn't designed twice. |
| 5 | Static selfhost linking (one bundled source pre-compile) | **Adapt** | Real shipping-build accelerator, but the existing team framing is exactly right that it must never replace the 162-module jz×jz acceptance gate — that gate is what's currently proving (or failing to prove, at 4 GiB) the thing that actually matters. Adopt as a *fast path*, never as a substitute measurement. |
| 6 | Scoped typed-temp reuse | **Adopt** | Straightforward, low-risk, standard compiler technique (mark/release lifetimes on a per-function temp pool); the existing team condition (preserve source evaluation order, land behind exact IR-parity tests) is the right gate. |
| 7 | Direct-only ABI specialization via escape-proof call scan | **Reject wholesale copy — jz's existing mechanism is already more precise** | `RepresentationPlan`/`FunctionPlan` (this audit's §1.4 table, systems #4/#11 and narrow.js phases D-J) already do call-site-census-driven param specialization with a sounder provenance story than Porffor's simpler escape scan. The transferable lesson (one canonical call-target/escape authority feeding every consumer, no per-emitter name-guessing) is *already* the direction jz is moving (`call-target-index.js`, built to close exactly the "Shape #8" member-callee gap) — continue that direction, don't import Porffor's simpler mechanism as a regression. |
| 8 | Compiler PGO (self-profile, build with that profile) | **Adopt, narrowly** | Low-risk, high-specificity: profile the self-compiler compiling its own bundle, use that profile only to order/specialize the self-compiler artifact. Reject explicitly: any source-level hint, any benchmark-specific branch — this would violate the project's own "general techniques, never per-bench tweaks" rule (`AGENTS.md`). Wasm has no branch-metadata PGO surface like native LLVM, so the transferable win is call-target specialization and hot/cold layout, not classic PGO. |
| 9 | A reclaiming compiler runtime (real GC) for the self-hosted compiler | **Adapt — already correctly scoped by the team, concur** | Full GC in user-facing jz output is a rejected idea for good reason ("No runtime" is a load-bearing product principle, `CONTRIBUTING.md`). But the self-hosted *compiler* is itself jz output and currently uses a bump arena that must prove releases manually (§1.3's region-reclaim rounds). The existing team framing — compiler-only phase/function arenas plus streaming output, not a GC — is the right adaptation; this audit's §4(iii)-11 experiment is a concrete next step in that direction. |

---

## 5. Generic-optimization gaps ranked by expected bench impact

Per `AGENTS.md`'s own constitution, every item below is a **class of program
shape**, never a specific bench case, and every fix is an **engine**
capability — nothing here is a suggestion to touch a bench or example
source file. Current measured standing (context, not from this session):
per `.work/handoff-2026-08-22.md`, JZ already leads Porffor-native on 43/43
comparable rows by both runtime and artifact-byte geomean, and `AGENTS.md`
states JZ is the fastest Wasm producer on every currently-covered bench case.
The items below are gaps in **general capability**, most of which the
current fixed corpus does not yet expose as a loss — that is exactly why
they are worth closing pre-emptively rather than only when a specific
case fails, per the project's own "a case where another wasm target wins is
a bug to fix... never silently accepted" standard: a hole the corpus hasn't
found yet is the cheapest time to close it.

**1. Codegen slack vs. `wasm-opt -Oz` — highest confidence, already
measured and gated by the team itself.** `CONTRIBUTING.md`'s own performance
invariant: "`wasm-opt -Oz` should find little to remove in JZ's own output —
whatever it shrinks is latent size headroom... Gated with margin today
(`WASMOPT_SLACK_MIN=0.70`... ~25-30% slack on size builds); target is
0.95+, ratcheted down as codegen tightens." This is the single most directly
quantified generic-optimization gap in the codebase: on `optimize: 'size'`
builds, an external, general Wasm optimizer can still find on the order of a
quarter of the bytes jz's own pipeline (its own passes + `watr`) leaves
behind. **Engine-level fix:** this is precisely the `watr/optimize.js`
question from §2e/§3.6 — whatever generic pass classes `wasm-opt -Oz`
applies that neither jz's own `src/optimize/` nor `watr`'s fixpoint yet
reaches (candidates: more aggressive global/constant propagation across
function boundaries, duplicate-code folding of near-identical blocks, tighter
local coalescing) is exactly the content of that 25-30%. This gate already
exists and already measures the right thing; closing it is "make the ratchet
move," not a new measurement.

**2. Loop-carried recurrence vectorization — self-documented, whole-class,
still open.** README: "Loop-carried dependencies remain scalar" — stated
as a current, real boundary of the vectorizer (§2e, §3.7), not a hypothetical.
`CONTRIBUTING.md`'s own coverage note names the concrete open items
precisely: **i32x4 cellular automata** (game-of-life/ising/rule30 — flagged
"feasible") and **lyapunov's carried-recurrence outer-strip** — both named
by the team as open, neither claimed done. (`biquad` is explicitly
**out of scope for this list** — `CONTRIBUTING.md` attributes its gap to
wasm-v1 lacking a scalar `fma`, "hand-written WAT ties it too," i.e. an ISA
limit, not an engine gap; listing it here would violate this section's own
"engine-level fixes only" rule.) **Engine-level fix:** a general
reduction-reassociation pass — recognize a carried scalar accumulator whose
update is associative/commutative (sum, xor-mix, min/max) and split it into
N independent lane accumulators combined at the end, which is the general
form the existing named recognizers (`dot-slp.js`, `reduce.js`) already
special-case for specific shapes. Generalizing the *reassociation* step
(not each specific idiom around it) is the highest-leverage single addition
to `src/optimize/vectorize/` short of the full re-architecture in §4(iii)-12.
**Expected impact:** any program with a hot carried-accumulator loop —
checksums, mixing/hash functions, running statistics, cellular automata,
small IIR-style recurrences where the ISA doesn't block it — a whole class,
per the project's own doctrine for what counts as a real fix.

**3. General, budget-driven inlining — medium confidence, latent risk more
than a proven current loss.** Three narrow named heuristics
(`inlineHotInternalCalls`, `inlineLocalLambdas`, `specializeFixedRestCalls`,
§2e) versus Binaryen's cost-modeled whole-program inliner
(`inlining-optimizing`, one of the 271 measured `wasm-opt` flags, §2e).
The current bench corpus does not expose this as a loss (`tokenizer` — a
call-heavy shape — is already a `win` per `test/bench.js`'s claims table),
which is exactly why this ranks below items 1-2: no measured evidence of
present harm, only an architectural gap that a call-heavy program shaped
differently from the current corpus could expose. **Engine-level fix:** a
general small-function inliner gated by a size/call-count budget (inline
when the callee is below a size threshold AND the call site is proven hot
or the calling convention overhead dominates), not a fourth named heuristic
for a fourth specific shape.

**4. SSA-level global value numbering / partial redundancy elimination
beyond `watr`'s array-level CSE — lowest confidence, flagged for
investigation, not asserted as a loss.** There is no SSA form anywhere in
jz's pipeline (§2a); whatever cross-block redundancy elimination happens is
whatever `watr/optimize.js`'s CSE finds on the WAT-array shape, and this
audit did not (and, per its brief, should not) reach into `node_modules` to
characterize that file's own algorithm depth. **Recommendation before
ranking this further:** add one targeted bench case with genuine
cross-basic-block redundant subexpressions (not currently in the corpus, by
inspection of `bench/`'s case list) and measure whether jz trails a GVN/PRE-
capable target on it — this is a "find the case, then fix the class" item,
not yet a "fix the class" item, and inventing a ratio here would be an
opinion dressed as a measurement, which this audit's own rules forbid.

---

## Summary for the record

Every number above was measured in this run or cited from a dated `.work/`
document with its date stated; every architectural claim is a file:line
citation, most from the codebase's own doc comments, not this audit's
inference. Two candidate "overdone" items (§3.8, §3.9) were checked and
found to be already-fixed or already-correctly-scoped rather than confirmed
as waste — reported as such rather than padded into the overdone list to
hit a length. The instrumentation (`src/ast.js` counters, `scripts/_audit-*.mjs`,
`.work/prof/*.cpuprofile`) is left in place in this worktree, uncommitted,
for the next agent to rerun or extend.

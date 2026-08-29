# Pipeline minimality — post-v1 campaign record

Source of the mandate: `.work/handoff-2026-08-22.md` (audit 2026-08-26 item 3:
"pipeline minimality backlog: 181 hand walkers remain (walkAst in 4 files),
analyzeBody ~6 traversals, 10 files >3k lines, outlier functions") and
`.work/archive/pipeline-audit-2026-08-20.md` Finding 1 (no shared traversal
combinator → 227 hand-rolled descents; walkAst since landed, used only in
optimize/index.js, vectorize.js, recurse.js) and Finding 5 (file/function
outliers, causally downstream of Finding 1).

Branch: `refactor/pipeline-minimality` (worktree off `main` @ d2c04d32).
Rule for every slice: compiled output byte-identical, or the exact set of
changed programs documented with cause. Gates: corpus WAT hashes (126 sources
= every `bench/<case>/<case>.js` graph except `jz`, plus every gallery example
and its extra kernels, × O0/O2/speed = 378 rows), `npm test`, O0/O3 legs,
kernel-parity, kernel-oracle, functional self-compile, ratchet.

## Census at branch base (d2c04d32)

Two counts, both machine-derived, different denominators:

- Name-based (the audit's regex, `(const|function) (walk|visit|scan|traverse|
  recurse)…`): **185** definitions in 35 files. Top: optimize/index.js 19,
  narrow.js 15, prepare/index.js 13, type.js 12, wat/assemble.js 10,
  vectorize.js 10, program-facts.js 10, analyze.js 10, plan/scope.js 8.
- Idiom-based (name-agnostic: `for (let i = 1|0; i < n.length; i++) f(n[i]…)`
  self-recursion lines, minus combinator call sites): **260** lines in 40 files.
  Top: type.js 25, optimize/index.js 23, narrow.js 20, analyze.js 19,
  analyze-scans.js 18, prepare/index.js 16, representation-plan.js 11,
  program-facts.js 11, plan/scope.js 10, emit.js 10.

Not every site is redundancy. The classes, decided per site:

| class | example | verdict |
|---|---|---|
| pre-order side-effect collector, generic child loop | `advise.js` heap-loop scan | → `walkAst(n, {enter})` |
| any-predicate with early exit | `loop-recurrence.js` scanStore/scanChain | → `some(n, pred, opts)` |
| post-order in-place rewriter | `prepare/index.js` walkSparse | → `walkAst(n, {exit})` (exit hook added this slice) |
| env-threading evaluator / abstract interpreter | `type.js` scanIntervalIdx, `analyze.js` analyzeBody walk | keep — traversal IS the semantics |
| mapping rewriter returning replacement nodes | `prepare/index.js` export-rename walk | keep |
| irregular child iteration (skip slots, reverse, restart after splice) | `plan/scope.js` walkStraightLine | keep |

Conversion contract (byte-identity): same visit order (children 1..n-1 in
order; slot 0 is never an array so `forEach`-style walkers that touch it are
order-identical for array-only predicates), same node set (`some` skips arrow
bodies by default — pass `{skipArrow:false}` where the original descended),
same pre/post placement of side effects, comments carried over.

## Slice M1 — traversal retrofit, batch 1 (files no in-flight branch touches)

Files: prepare/index.js, type.js, plan/scope.js, plan/advise.js,
analyze-scans.js, loop-recurrence.js, analyze.js, peel-stencil.js,
loop-model.js, inplace-store.js, call-target-index.js, plan/loops.js,
plan/common.js, flow-types.js, lift-iife.js, emit-assign.js,
dyn-closure-tables.js, cse-load.js, closure-plan.js.

Deferred to batch 2 (under fix/* branches in flight at branch time:
member-callee-binding-write, pure-stdlib-init, string-method-guess,
param-mutation-propagation, shape8-member-callee; plus uncommitted main
edits): optimize/index.js, narrow.js, program-facts.js, wat/assemble.js,
vectorize.js, emit.js, representation-plan.js, early-errors.js, kind.js,
ir.js, infer.js, compile/index.js, module/typedarray.js, module/regex.js,
module/object.js.

Results (branch tip vs base):

- 89 walker sites read one by one: **45 converted, 44 kept** (kept = env-threading
  evaluators, mapping/splicing rewriters, irregular child iteration, or a form that
  would be longer than the original — each recorded in the per-file agent tables
  behind this slice). `walkAst` gained an `exit` hook (post-order, for in-place
  rewriters); no other combinator was added — `some`/`someDeep`/`refsName` already
  covered the predicate shapes.
- Census: name-based 185 → **145**; idiom-based 260 → **224**; `walkAst` call sites
  146 in 3 files → **196 in 19 files**. Diff: 17 files, +169/−284 (net −115).
- Byte identity: corpus 378/378 rows identical (0 differ, 0 missing).
- Style: every new site uses the one existing idiom `walkAst(x, { enter: n => { … } })`
  (no method-shorthand / multi-line object forms), so the diff is the conversion only.
- Refactor oracle (scripts/refactor-oracle.mjs, merged to main after this slice was
  cut): `check --ref main` CLEAN — 560 entries identical (140 specs × O0/O2/O3/size,
  baseline 0d785f9c). This oracle supersedes the ad-hoc corpus hash used above
  and is the gate for every later slice (`.work/refactor-oracle.md`'s rule).
- Gates (scripts/battery.mjs, 15.5 min): native 3723/3724 (1 skip), O0 3723, O3 3723,
  wasi 3722, kernel (test:wasm on the rebuilt dist) 2974, functional self-compile
  21/21 (206), fuzz 30,173 programs × 4 tiers no divergence, fixpoint PASS,
  build dist/jz.wasm 17,483.9 kB. The `dbg` leg (O3 + JZ_DEBUG_INVARIANTS) reports
  one pre-existing failure — test/jsstring.js "jsstring opt-in" trips the ctx
  invariant "post-compile: active function record restored after
  analysis/emission" identically on a clean d2c04d32 checkout (4/10 standalone,
  same assertions) — not introduced here, left for its own root-cause session.

## Division of labor (2026-08-28, from the branch list)

Concurrent slices by other sessions — not duplicated here: vectorize.js split
(merged: src/optimize/vectorize/, 24 modules), stdlib generators (merged),
`refactor/optimize-split` (optimize/index.js → licm/peephole/locals/… modules,
in flight), `refactor/analyze-traversals` (analyzeBody's traversal chain — the
walk-count design A2 item, just opened). This branch owns the walker retrofit
(batches 1–3) and the outlier-function/file items not claimed above.

## Slice M1b — traversal retrofit, batch 2

Opened once the fix/* branches merged: narrow.js, program-facts.js,
wat/assemble.js, representation-plan.js, kind.js, ir.js, infer.js, emit.js,
compile/index.js, early-errors.js, src/optimize/vectorize/*.js, recurse.js,
module/typedarray.js, regex.js, object.js, jzify/generators.js, jzify/async.js.
No-go regions (main's uncommitted hunks at the time): narrow.js 2950–2975,
emit.js 5935–5980, compile/index.js 66–76 + 1700–1735, early-errors.js 205–410,
prepare/index.js 1105–1115 + 2395–2420 + 3835–3955, collection.js 280–290 +
1785–1865, core.js 2445–2800; whole optimize/index.js (split in flight).

Results: 78 sites read; **43 converted, 35 kept** (env-threading evaluators, mapping
rewriters, whole-walk-abort validators, slot-0-inclusive IR walks, leaf-order-sensitive
diagnostics), 4 grep false positives (IR emitters named `scan`/`walkDyn`). Census:
name-based 145 → **122**, idiom-based 224 → **191**, `walkAst` sites 196 → **235 in 48
files**, `some` sites 26. Diff: 16 files, +236/−315 (net −79). No hunk inside or
adjacent to a no-go region. Gates: refactor oracle `check --ref main` CLEAN (560/560,
baseline 0d785f9c); battery 15.5 min: O0 3732/3733 (1 skip), O3 3732, wasi 3731,
kernel 2983, self-compile 21/21, fuzz 30,173 × 4 tiers clean, fixpoint PASS, build
17,474.8 kB. Two red legs, neither this slice's: `dbg` = the pre-existing jsstring
invariant trip (same on clean main); `native` = test/statements.js "clearInterval:
stops interval" (a 20 ms-tick wall-clock test) failed under the 7-leg load and passes
3/3 standalone on the branch and on clean main — timers are untouched here.

Follow-ups surfaced by the agents, queued for batch 3: (a) `some` needs a `boundary`
option so jzify's `FN_BOUNDARY_OPS`-gated predicates (`refsAwait`, `refsSuspend`,
`hasYield`) can reuse it; (b) module/typedarray.js `hasWrite`/`hasSameRead` (any-
predicates) and `safeRmwAst` (an every-predicate — no combinator yet); (c) the six
verbatim load/store validator ports across vectorize map/stencil/reduce are one
walker copied six times — a semantic DRY slice, not a mechanical swap; (d)
optimize/index.js's 19 sites after `refactor/optimize-split` lands, in the new modules.

## Slice M1c — traversal retrofit, batch 3 (name-agnostic sweep)

Two parts. (a) `some` gained an optional `boundary(node)` predicate (default
behaviour unchanged: the `=>` stop), so jzify's `FN_BOUNDARY_OPS`-gated
`hasYield`/`refsAwait`/`refsSuspend` and typedarray's `hasWrite`/`hasSameRead`
became direct `some` calls. (b) A sweep for every remaining self-recursive descent
regardless of name (`collect*`, `find*`, `count*`, `has*`, `contains*`, …) over
the free files: program-facts, plan/literals, plan/inline, ops.js; type.js,
representation-plan, plan/scope, kind, ir; cse-load, call-target-index,
loop-recurrence, flow-types, closure-plan, lift-iife, wat/assemble, plan/common,
plan/loops, loop-model, emit-assign, dyn-closure-tables, peel-stencil,
inplace-store, plan/advise. Discovery needed more than the C-for idiom regex
(early-exit `if (f(n[i])) return true` shapes, one-line `.some(f)` arrows) —
the agents supplemented it with self-call scans and full reads.

Results: **57 converted** (5 + 8 + 28 + 16), ~110 examined and kept (value
dispatchers, env-threading evaluators, mapping rewriters, dual-tree comparators,
irregular child selection; two "considered" `!some(…, {boundary})` rewrites of
safety gates left in their direct form on purpose). One collector replaced by
the existing `refsName` (inplace-store `containsName`). Census: name-based 124,
idiom-based 191 → **165**, `walkAst` sites 235 → **265 in 51 files**, `some`
sites 48. Diff: 22 files changed, 197 insertions(+), 324 deletions(-). Gates: refactor oracle `check --ref main` CLEAN (560/560, baseline 0feb9e29);
battery 15.7 min: native 3771/3772 (1 skip), O3 3771, wasi 3770, kernel 2983,
self-compile 21/21, fuzz 30,173 × 4 tiers clean, fixpoint PASS, build 17,458.2 kB.
Red legs: `dbg` (the pre-existing jsstring invariant trip) and `O0` on the same
20 ms-tick "clearInterval: stops interval" wall-clock test that flaked under load in
M1b — it passed in the native/O3/wasi legs of the same run and 2/2 standalone at O0.

Oracle catch (the reason this gate exists): the first run reported 9 differences —
bench:qoi, bench:tokenizer, example:schrodinger at O2/O3/size (qoi +11–18 % bytes).
Bisecting the 22 files by reverting each to HEAD isolated plan/inline.js:
`eagerCallFreeBooleans` renames `&&`/`||` to `__eager&&`/`__eager||`; the original
tested `pureCanonicalBool(n)` pre-order (children still `&&`/`||`) and renamed
post-order, and the conversion had moved the test into `exit`, after the children
were already renamed — so only the innermost node of a chain still qualified.
Testing and renaming in `enter` is exactly equivalent (a parent's rename never
affects a child's own subtree test); all 9 outputs are byte-identical to HEAD
again. Rule added to the conversion contract: a rewriter whose predicate reads
its children's ops must evaluate that predicate pre-order.

Side findings: `src/ops.js` (118 lines, integer op-tag seed, "parked as a dormant
option" in 610ba822) has zero importers — a delete-or-keep decision for the owner,
not taken here. analyze.js's three M1 conversions were dropped again in 44f03e1a
so `refactor/analyze-traversals` (which splits that file and retires its
collectors itself) merges without conflict.

## Slice M1d — traversal retrofit, batch 4 (the split optimizer modules)

Opened by `refactor/optimize-split` landing on main (optimize/index.js → 16 pass
modules). globals.js 3 converted (`bases`, `ids`, and `guardMaskedVectorSuffix`'s
post-order walk), devirt.js 1, specialize-mkptr.js 1; licm.js 0.
**Kernel-leg catch**: the first battery converted `hoistLoopGlobalPtrOffset`'s
`inspect`/`replace` too — native suite, oracle and fuzz all clean, but the
self-compiled compiler (test:wasm on dist/jz.wasm) failed its own ablation pin
("hoistLoopGlobalPtrOffset hoists a string-global scan loop past a call to a
provably-clean named function"). Same class as the loop-hoist trio in
.work/handoff-2026-08-22.md: walkAst callbacks capturing that pass's per-loop
state miscompile under self-compile. Reverted those two sites with a comment
pinning the reason; the kernel-target root cause (closure capture through
walkAst callbacks) is a compiler defect worth its own session, not a walker
question. Note the battery's kernel leg is the only gate that sees this class —
the oracle and the native suite cannot. — every walker there
is threaded-state analysis (depth+abort flags, SSA def-chain follows, a
control-flow-sensitive CSE table). peephole/locals/cse-address: mapping rewriters
and dataflow evaluators, kept. One "moderate doubt" keep recorded by the agent:
licm.js `narrowLoopBound`'s processNode (two boundary shapes + splice hazard) is
convertible at equal length — left for a reviewer. Census: name-based 122,
idiom-based 165 → **159**, `walkAst` sites 265 → **272 in 63 files**.
Diff: 3 files, +10/−27 after the revert. Gates: battery on the 7-conversion tree
(before the revert): native 3771/3772, O0 3771, O3 3771, wasi 3770, self 21/21,
fuzz clean, fixpoint PASS, oracle CLEAN, `dbg` = the known jsstring trip, kernel
RED on the ablation pin above; after the revert: dist rebuilt, kernel leg
2983/2984 (1 skip), oracle CLEAN vs 3149278d.

## Landed (2026-08-28)

Merged into main as ffac902c via a subset branch: everything except the
conversions in emit.js, compile/index.js, narrow.js, early-errors.js and
prepare/index.js, which main's working tree held uncommitted edits in (git would
refuse to overwrite them, and nothing here stashes or commits someone else's
in-progress work). Those conversions landed the same day as ba77ce78 once the owner committed the
five files (e79fc619): a revert of the subset's revert, 3-way clean over the new
edits, oracle CLEAN vs 47edac89, battery green (native/O0/O3/wasi 3803, kernel
3000, self 21/21). The walker retrofit is now fully on main; the branch is
deleted. The three split plans (emit/narrow/prepare) are unblocked but not
started — a new campaign, to be sequenced after jz-45's dead-exports sweep
(it edits the same import lines).

## Queue after M1d (same campaign)

1. `analyzeBody` 6 → 5 traversals: fold `scanNumericFill` (walk-count design
   A2; needs the assert-gated old-vs-new run it prescribes).
2. Schema-liveness scan re-derives facts from emitted WAT
   (compile/index.js ~:3158-3273) → emission-time used-sid fact (handoff item 2).
3. Outlier functions (re-measured 2026-08-28; the audit's list was partly stale):
   `genUpsertStrictPrehashed` (~2.5k ln, collection.js — main has uncommitted edits
   inside it, wait); `narrowSignatures` (1,085 ln, narrow.js's default export —
   `.work/narrow-split.md` §6: one mutable `sharedSiteState` shared by ~20 nested
   closures for a measured perf reason, needs its own audit); `emitInstanceof` is
   14 lines now (already split); `inferTypedValueRanges` is 181 lines, keep nested
   (closure matrix in narrow-split.md — hoisting has zero reuse payoff).
4. Files >3k lines (10): vectorize 8500, emit 8129, optimize/index 5537,
   prepare/index 4430, collection 3974, narrow 3934, compile/index 3476,
   core 3474, analyze 3301, typedarray 3055.

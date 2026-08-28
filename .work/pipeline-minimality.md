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
- Gates (scripts/battery.mjs, 15.5 min): native 3723/3724 (1 skip), O0 3723, O3 3723,
  wasi 3722, kernel (test:wasm on the rebuilt dist) 2974, functional self-compile
  21/21 (206), fuzz 30,173 programs × 4 tiers no divergence, fixpoint PASS,
  build dist/jz.wasm 17,483.9 kB. The `dbg` leg (O3 + JZ_DEBUG_INVARIANTS) reports
  one pre-existing failure — test/jsstring.js "jsstring opt-in" trips the ctx
  invariant "post-compile: active function record restored after
  analysis/emission" identically on a clean d2c04d32 checkout (4/10 standalone,
  same assertions) — not introduced here, left for its own root-cause session.

## Queue after M1 (same campaign)

1. `analyzeBody` 6 → 5 traversals: fold `scanNumericFill` (walk-count design
   A2; needs the assert-gated old-vs-new run it prescribes).
2. Schema-liveness scan re-derives facts from emitted WAT
   (compile/index.js ~:3158-3273) → emission-time used-sid fact (handoff item 2).
3. Outlier functions: `genUpsertStrictPrehashed` (~2.5k ln, collection.js),
   `emitInstanceof` (~2.1k, emit.js), `inferTypedValueRanges` (~1.3k, narrow.js).
4. Files >3k lines (10): vectorize 8500, emit 8129, optimize/index 5537,
   prepare/index 4430, collection 3974, narrow 3934, compile/index 3476,
   core 3474, analyze 3301, typedarray 3055.

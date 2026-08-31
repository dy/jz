# ledger-refactor.md: the pipeline-minimality record

The campaign retiring hand-rolled AST walkers, consolidating `analyzeBody`
traversals, and splitting outlier files/functions. Every slice below:
what moved where, deviations from the plan, retirements, battery. Every
module table is kept; per-commit session narrative is dropped (commit
shas are kept where they mark a real landing point). `refactor-oracle.mjs`
is the gate for all of it: its section keeps the tool's own usage intact
since `scripts/refactor-oracle.mjs`'s own doc comment depends on this
prose staying in sync.

---

## refactor-oracle.mjs: the gate

Proves a refactor changed **no compiled output**: same source in,
byte-identical wasm out, across the whole corpus at every optimize level.

**What it proves**: for every specimen (bench cases, examples,
`test/kernel-parity.js`'s CORPUS, watr's own entry) at O0/O2/O3/size,
`sha256(compile(src, {optimize}))` is unchanged between two trees. A
compile that used to fail and still fails with the same error class also
counts as "unchanged" (error hashes are compared too); a failure that
starts or stops happening is reported as a difference.

**What it cannot prove**: runtime behavior of host-nondeterministic paths
(`Math.random` without a fixed seed, host timers, WASI clock/env imports)
- byte-identical at the wasm level can still observably differ when RUN;
this oracle never instantiates or executes anything, it is a static
compile-output proof only. Correctness of either side: byte-identity
certifies "didn't change," not "was right"; a refactor that reproduces an
existing bug exactly is reported clean, by design (`test/kernel-oracle.js`/
`test/kernel-parity.js` are the correctness oracles). Corpus drift: if a
refactor branch also edits `bench/`, `examples/`, or
`test/kernel-parity.js`'s CORPUS, `check` diffs by spec name (an added/
removed specimen shows as a "before/after (missing)" difference, not a
silent vanish) but a specimen whose source changed on purpose will
legitimately show a byte diff unrelated to the compiler internals under
test: read the diff before treating it as a regression. The self-host
compile (`bench/jz/jz.js`'s whole-compiler-through-itself graph) is
excluded by default (68s at O0, 246s at O3, alone): `--full` opts it
back in for a deliberate deep run; the default corpus is what every
refactor slice runs.

**The rule**: a pipeline-minimality slice merges only with `check --ref
main` clean, **or** with every difference it reports listed and justified
in the PR/commit message: which specimen, which level, what changed, why
it's expected.

**Usage**:

```
node scripts/refactor-oracle.mjs snapshot .work/oracle-baseline.json
node scripts/refactor-oracle.mjs check .work/oracle-baseline.json
node scripts/refactor-oracle.mjs check --ref main
node scripts/refactor-oracle.mjs diff .work/oracle-baseline.json bench:mandelbrot O3
```

Full option/command reference lives in the script's own header: that is
the canonical doc (this section is the campaign-level "why", not a
duplicate usage reference).

---

## Schema-liveness scan: queue item found already landed (2026-08-31)

`plan.md`'s "Remaining queue" carried an item verbatim from
`archive/pipeline-minimality.md`'s post-M1d queue (2026-08-28): "Schema-
liveness scan re-derives facts from emitted WAT (compile/index.js
~:3158-3273) → emission-time used-sid fact." Picking it up as its own
slice found the item stale: `b8c858d9` (2026-08-26, "fix kernel-target
objects regression: emission-time PTR.OBJECT schema-liveness tags replace
the post-treeshake WAT-text scan") already landed exactly this fix, two
days before the queue text above was written, and it has ridden unbroken
on main ever since — confirmed `b8c858d9` is an ancestor of this slice's
base (`3814c151`), and no commit in between touches
`src/compile/index.js`/`src/ir/pointers.js`/`src/ctx.js`'s schema-liveness
code. No source change was made this slice; `.work/` only.

**What used to be re-derived**: `scanMkptrAux` (deleted by `b8c858d9`, zero
references anywhere in the tree today outside its own historical mention
in `src/compile/index.js`'s comment) walked the post-treeshake
`sec.stdlib/funcs/start/globals/elem` arrays and pattern-matched
`f64.const`/`i64.const` operand STRINGS and `$__mkptr`/`$__mkptr_*` call
NAMES to recover a schema id that was already a plain number before
`mkPtrIR`/`boxPtrIR` (`src/ir/pointers.js`) encoded it into a WAT literal —
the wrong-level-architecture pattern the audit flagged, and a real bug: a
self-hosted-only folded `f64.const nan:...` literal (a recursive OBJECT
param's re-box, `narrow.js`'s `applyPointerParamAbi` devirt) failed the
scan's strict 16-hex-digit parser and silently dead-marked a live schema,
native-only correct.

**Where the fact is published now**: `mkPtrIR`/`boxPtrIR`
(`src/ir/pointers.js:97-111`, `:26-74`) — the only two sites a PTR.OBJECT
pointer is ever IR-constructed — stamp a `.schemaSid` property directly
onto the node they return, additive metadata in the same family as
`.type`/`.ptrKind`/`.ptrAux`, at the exact moment the WAT literal/call that
carries the sid is produced (this IS emission time: both run from inside
`emit.js`/`emit-assign.js`/the `module/*.js` builtins, never after).
`src/compile/index.js:841-857` (`usedSchemaIds`) still walks the
already-treeshaken `sec.*` arrays once to collect these tags, plus
`ctx.schema.namedUses` (`{sid, funcName}` pairs the handful of raw-WAT-text
stdlib templates push directly, `src/ctx.js:550-572`) — but this reads a
plain numeric property off already-built nodes, not text reformatted back
into a number, and it stays scoped to the one, deliberately-final,
post-treeshake snapshot.

**Why the literal ask ("a ctx Set, no post-hoc walk, appended purely at
mkPtrIR-call time") was not implemented as a further change**: it would be
a regression, not a simplification. `mkPtrIR`/`boxPtrIR`'s own doc comment
(`src/ir/pointers.js:85-96`) states the reasoning this slice re-verified
independently: walking the POST-treeshake arrays keeps the fact
treeshake-accurate FOR FREE — a construction whose sole containing
function treeshake later removes is simply never visited, no separate
reachability accounting needed. A flat Set populated unconditionally the
instant `mkPtrIR` runs (before treeshake has decided which functions
survive) would over-approximate liveness for exactly the case this
mechanism was built to get right (`test/objects.js`'s "dead opaque-length
TypeError schema" pin, the original size-gate regression, `e867c3af`) —
safe for correctness (the file's own comment: over-approximating "only
costs bytes") but NOT output-identical, which is this slice's actual bar.
Recovering treeshake-precision without the post-hoc walk would mean
extending the `namedUses` `{sid, funcName}`-plus-survival-filter pattern to
every one of the ~20 `mkPtrIR(PTR.OBJECT, …)`/`boxPtrIR(…, PTR.OBJECT, …)`
call sites across `emit-assign.js`, `module/object.js`, `module/json.js`,
`module/core/error-object.js`, `src/ir/sentinels.js`,
`src/wat/assemble/start-fn.js`, `src/compile/emit/dispatch.js` — a larger,
riskier diff whose failure mode (one missed call site) is silent
UNDER-approximation, explicitly the unsafe direction ("would silently
corrupt a live interop decode," `src/ctx.js`'s own schema-liveness
comment) — to eliminate a single cheap linear walk over an already-pruned
tree. Declined for the same reason this campaign declines other
decompositions with no proven payoff (§ elsewhere in this ledger): no
reader needs it, no correctness gap exists, and the risk is asymmetric (a
silent wrong value vs. a walk that costs nothing observable).

**Proof of equality** (no behavioral change was made, so "equality" here
is: the mechanism is sound and nothing regressed since `b8c858d9`):

1. `scanMkptrAux` has zero definitions anywhere in the tree (grep-confirmed)
   — the re-derivation the queue item names is gone, not merely improved.
2. `usedSchemaIds`'s two consumers (`jz:schema` positional serialization,
   `jz:errcls` entry filter, `src/compile/index.js:892-895`/`:904`) are
   unchanged since `b8c858d9`.
3. `node scripts/refactor-oracle.mjs check --ref 3814c151`: **CLEAN — 568
   entries identical**.
4. `node test/kernel-parity.js`: **3/3 groups, 39/39 assertions, 0 fail**
   (13 specimens × O0/O2/O3, including `dvnested`).
5. `node test/kernel-oracle.js`: **15/15 groups, 738/738 assertions, 0
   fail** — this is the native-vs-kernel-vs-JS-oracle three-way check;
   `b8c858d9`'s bug was exactly a native/kernel divergence on a recursive
   OBJECT param, so a clean run here is the most direct evidence the fix
   still holds.
6. `node test/pointers.js`: **73/73**. `node test/data.js`: **210/210
   (1171 assertions)**. `node test/invariants.js`: **29/29 (169
   assertions)**.
7. `JZ_TEST_TARGET=jz.wasm node test/index.js` (kernel-hosted full suite —
   the exact configuration `b8c858d9`'s regression only showed up under):
   **3059 total, 3058 pass, 1 skip, 0 fail (15181 assertions)**.
8. `node test/index.js` (native): **3895 total, 3894 pass, 1 skip, 0 fail
   (29286 assertions)**.

All eight green against a freshly built kernel (`dist/jz.wasm`, 14,105.5 kB,
built this session).

**Action taken**: `plan.md`'s queue item 4 removed (list renumbered),
replaced with a one-line pointer to this section, so a future session
doesn't re-open a closed item from stale queue text again.

---

## Traversal-combinator retrofit: walkAst/some adoption (2026-08-27/28)

Retires hand-rolled recursive AST walkers onto `walkAst`/`some`
(`src/ast.js`), consolidating "how many times does this program get
walked" toward one canonical combinator. Branch `refactor/pipeline-
minimality`, base `d2c04d32`. Gates: corpus WAT hashes (126 sources ×
O0/O2/speed = 378 rows, superseded mid-campaign by the refactor oracle's
560-row corpus), `npm test`, kernel-parity, kernel-oracle, functional
self-compile, ratchet.

**Census at branch base**: name-based regex count (`(const|function)
(walk|visit|scan|traverse|recurse)…`) 185 definitions in 35 files.
Idiom-based count (name-agnostic self-recursion shape, minus combinator
call sites) 260 lines in 40 files. Not every site is redundancy -
classified per site: pre-order side-effect collectors and any-predicates
with early exit convert to `walkAst`/`some`; env-threading evaluators/
abstract interpreters (traversal IS the semantics), mapping/splicing
rewriters, and irregular child-iteration walkers stay hand-rolled.

**Conversion contract** (byte-identity): same visit order (children 1..n-1
in order); same node set (`some` skips arrow bodies by default: pass
`{skipArrow:false}` where the original descended); same pre/post
placement of side effects; comments carried over. Rule added mid-campaign
(Slice M1c's oracle catch, below): a rewriter whose predicate reads its
children's ops must evaluate that predicate pre-order, not post-order -
testing and renaming in `enter` is exactly equivalent to testing before
rename, since a parent's rename never affects a child's own subtree test,
but testing in `exit` sees already-renamed children.

**Slices M1 (batch 1) through M1d (batch 4, the split optimizer
modules)**: four batches converting 45+43+57+~5 sites respectively across
successive waves of files (batch boundaries were the files other in-flight
branches held at the time). Census progression: name-based 185→145→122→
124→122; idiom-based 260→224→191→165→159; `walkAst` call sites 146 in 3
files → 272 in 63 files by the end. Each batch's own gate: refactor oracle
clean (baselines `0d785f9c`→`0feb9e29`→`3149278d` across the batches, 560
entries each), full battery (native/O0/O3/wasi/kernel/self-compile/fuzz/
fixpoint) green modulo two pre-existing, unrelated flakes carried
throughout: the `dbg` leg's `test/jsstring.js` "jsstring opt-in" ctx-
invariant trip (present identically on a clean checkout, not introduced
by any slice) and one 20ms-tick wall-clock timer test that flaked once
under machine load and passed standalone.

**Kernel-leg catch (M1d)**: the first battery converted
`hoistLoopGlobalPtrOffset`'s `inspect`/`replace` too: native suite,
oracle, and fuzz all clean, but the self-compiled compiler (`test:wasm`)
failed its own ablation pin ("hoists a string-global scan loop past a
call to a provably-clean named function"). Reverted those two sites with
a comment pinning the reason; root cause is walkAst callbacks capturing
that pass's per-loop state miscompiling under self-compile: a compiler
defect, not a walker-conversion question, still open (see `plan.md`'s
remaining queue). Only the battery's kernel leg sees this class; the
oracle and native suite cannot.

**Landed 2026-08-28** as `ffac902c` via a subset branch: everything except
the conversions in `emit.js`, `compile/index.js`, `narrow.js`,
`early-errors.js`, `prepare/index.js`, which main's working tree held
uncommitted edits in at the time. Those five landed the same day as
`ba77ce78` once the owner committed them (`e79fc619`): oracle CLEAN vs
`47edac89`, battery green (native/O0/O3/wasi 3803, kernel 3000, self
21/21). The walker retrofit is now fully on main; branch deleted.

**Follow-ups queued for a later batch** (some since subsumed by other
slices below): `some()` needing a `boundary` option for jzify's
`FN_BOUNDARY_OPS`-gated predicates (landed, M1c below); typedarray's
`hasWrite`/`hasSameRead` (any-predicates) and `safeRmwAst` (an
every-predicate, no combinator existed): still open;
`optimize/index.js`'s 19 sites, unblocked once `refactor/optimize-split`
lands (see below).

**Slice M1c (name-agnostic sweep, batch 3)**: two parts. (a) `some`
gained an optional `boundary(node)` predicate (default unchanged: the
`=>` stop), so `hasYield`/`refsAwait`/`refsSuspend`/`hasWrite`/
`hasSameRead` became direct `some` calls. (b) a sweep for every remaining
self-recursive descent regardless of name (`collect*`/`find*`/`count*`/
`has*`/`contains*`): discovery needed more than the C-for idiom regex
(early-exit `if` shapes, one-line `.some()` arrows), supplemented with
self-call scans and full reads. Results: 57 converted, ~110 examined and
kept. **Oracle catch, the reason the gate exists**: the first run of this
slice reported 9 differences (`bench:qoi`, `bench:tokenizer`,
`example:schrodinger` at O2/O3/size): bisected to `plan/inline.js`'s
`eagerCallFreeBooleans`, whose predicate tested pre-order but renamed
post-order; moving the test into `exit` (after children were already
renamed) meant only the innermost node of a chain still qualified. Fixed
by testing in `enter`: the pre-order-predicate rule above, now part of
the conversion contract. All 9 outputs verified byte-identical to HEAD
again after the fix.

---

## src/optimize/vectorize.js split (8,500 lines → `src/optimize/vectorize/`)

**External contract**: exactly 4 exported names, 1 consumer
(`src/optimize/index.js`). `vectorize.js` becomes a re-export shim.

**Module map** (24 files, topological order: shared infra first, then
recognizer families, then the entry dispatcher): `node-utils.js` (generic
predicates), `lane-tables.js` (the op-whitelist "single source of truth"
data + `PPC_CALL2`/`SIMD_PINNED`, relocated here since `liftExprV`: the
lift engine: is their real caller, not per-pixel-color despite physical
proximity), `addr-model.js` (BodyModel address/alias analysis, +
`_isAddressLocal`/`_isPixelIndexLocal` relocated here to keep the
dependency one-directional against `aos.js`), `idioms.js` (NaN-canon-
select/int-minmax-reduce matchers), `dot-slp.js` (straight-line f64
dot-product/SLP packer, self-contained), `scaffold.js` (canonical
`(block (loop))` scaffold matcher), `outer-scaffold.js` (outer pixel-loop
scaffold, shared by 5 recognizers), `aos.js` (AoS de-interleave gather),
`inline-pure.js` (pure user-function-call inliner), `lift.js` (the
mechanical SIMD lift engine + `peelNarrowConv`/`PACK_I32_TO_I16/I8`/
`narrowStore` relocated here: lift-engine shared, not ramp-private
despite sitting next to ramp-map originally), `cost-model.js`
(profitability model for the 3 `tryGeneral*` fallbacks), then the 12
recognizer-family files (`strength-reduce.js`, `map.js`, `stencil.js`,
`reduce.js`, `memcpy.js`, `ramp.js`, `blur-channel.js`: with
`matchChannelAccum`/`matchChannelGroup`/`matchChannelReducePixelLoop`
confirmed called ONLY from `tryChannelReduce`, never `tryRampMap`, despite
original physical proximity: `divergent-escape.js`, `per-pixel-color.js`,
`outer-strip.js`, `tone-map.js`, `butterfly.js`), and `index.js` (the
entry dispatcher, `vectorizeLaneLocal`).

**Mutable-state note**: `_whyNotActive`/`_whyNotReason`/`_relaxF32`/
`_crPow` were bare module-private `let`s written by the dispatcher and
read by `reduce.js`: ES modules forbid assigning through an imported
binding, so these bundle into one exported mutable object, `vecState =
{whyNotActive, whyNotReason, relaxF32, crPow}`; every read/write site
became `vecState.x`. The one place this split is more than a textual
move.

**Deviations**: none from plan; every cross-check (which helper belongs
to which family) was grep-verified against real call sites, not physical
proximity: physical proximity misled twice (channel-group scan, above;
`peelNarrowConv`/`narrowStore` used by both the lift engine and
`tryVectorize`, not ramp-private).

**Retirements/decompositions**: deferred to a later phase, named but not
executed in this slice: `tryDivergentEscapeVectorize` (567 ln, the
largest function in the file, once isolated look for a match-scaffold vs.
rewrite-body seam); `tryGeneralStencil`/`tryGeneralMap`/`tryGeneralReduce`
(share the alias-versioning/profitability shape, check whether it's
identical enough to hoist); `tryReduceReassoc`/`tryStencil`/`tryToneMap`/
`tryRampMap` (evaluate match/rewrite split per-function once moved).

**Battery**: only `src/optimize/index.js` imports directly from
`vectorize.js`, confirmed via grep across `test/`, `module/`, `src/`.

---

## src/optimize/index.js split (5,537 lines → `src/optimize/`)

Off-limits at the time: `vectorize.js` (sibling session), `recurse.js`,
`watr-tail.js` (unrelated, pre-existing siblings).

**Pass order** (the driver, `optimizeFunc`): `foldStaticConstArrayReads →
recursionUnroll → hoistPtrType → hoistInvariantPtrOffset → narrowLoopBound
→ hoistInvariantLoop → fusedRewrite → [unswitchStringRepLoop?] →
[boolConvertToSelect?] → hoistAddrBase → hoistInvariantLoop → cseScalarLoad
→ promoteGlobals → [unswitchTypedParamLoop → vectorizeLaneLocal →
foldV128Memargs]? → [inlinePtrOffsetFastPass]? → [splitLoopPrivateScratch
+ hoistInvariantLoop]? → propagateSingleUse → foldSetToTee →
[splitLoopPrivateScratch + hoistInvariantLoop]? → devirtConstFnArrayCalls
→ devirtSchemaReads → [rotateLoops]? → simplifyBoolContexts →
sortLocalsByUse`. Whole-module passes (called from `wat/assemble.js`, not
`optimizeFunc`: untouched by this split): `treeshake`,
`hoistConstantPool`, `specializeMkptr`, `arenaRewindModule`,
`collectVolatileGlobals`, `collectReachableGlobalWrites`,
`collectReachableMemoryWrites`, `stablePtrGlobalNames`,
`buildPureFuncMap`, `hasIROp`.

**Module map** (17 files): `ir-scan.js` (`containsV128`/`hasIROp`, used by
3 otherwise-unrelated families, extracted to break the fan-out),
`config.js`, `cse-address.js` (`regionTrackCSE` shared by
`hoistPtrType`/`hoistAddrBase`: one LICM family, not two passes),
`licm.js` (the shared LICM predicate set + `hoistInvariantPtrOffset`/
`hoistInvariantLoop`/`splitLoopPrivateScratch`/`narrowLoopBound`/
`cseScalarLoad`), `locals.js`, `globals.js` (imports
`simplifyBoolContexts` from `peephole.js`: a genuine cross-family edge,
`promoteGlobals` calls it at its tail: required exporting it, since it
wasn't exported before), `const-pool.js`, `specialize-mkptr.js`,
`pure-funcs.js` (`buildPureFuncMap` + `foldStrDispatchF64`, must stay
together: direct call), `unswitch.js`, `driver.js` (`optimizeFunc`),
`peephole.js` (`fusedRewrite`+`walkRewrite`: one inseparable unit -
`+boolConvertToSelect`/`rotateLoops`/`simplifyBoolContexts`, kept together
by explicit pipeline-ordering doc comment: "simplifyBoolContexts runs
after rotateLoops so its fused back-edges get cleaned too"),
`treeshake.js`, `devirt.js` (`devirtSchemaReads`+`foldStaticConstArrayReads`
+`devirtConstFnArrayCalls`: share a TECHNIQUE, compile-time-known-table
devirt, and cross-reference each other in comments, imports
`inlinePureCallExpr` from `vectorize.js` unchanged), `sort-locals.js`,
`arena-rewind.js`, `index.js` (stable barrel).

**Found defect, not fixed (flagged only)**: `sortLocalsByUse`'s docstring
was physically stranded 537 lines before its actual function: an
artifact of past edits. The split fixes it as a side effect (the comment
moves with the function) but this wasn't a targeted fix.

**Deviation found before executing**: `narrowLoopBound` declares its OWN
function-local `I32_MIN`, not the top-level `ir.js` import: only
`walkRewrite` uses the imported one. Confirmed via grep before moving, to
avoid a dead import left in `licm.js`.

**Retirement candidates named for step 3, after all moves land**:
`walkRewrite` (351L, peephole.js) into match/dispatch vs. rewrite halves
if a real seam exists; `devirtSchemaReads` (306L) similarly;
`unswitchTypedParamLoop` (270L): "only if the oracle stays clean, else
record why not."

---

## src/wat/assemble.js split (1,713 lines → `src/wat/assemble/`)

**Assembly order** (from `compile/index.js`, the sole real caller, 11
phases): `buildStartFn → syncImports → dedupClosureBodies →
finalizeClosureTable → pullStdlib → stripStaticDataPrefix → optimizeModule
→ hoistConstGlobalInits → stripDeadLazyTables → stripDeadInternedSpans →
stripLocalRenameSuffixes` (the last much later, post section-ordering).
`clearStdlibParseCache` is a separate warm-instance reset hook
(`session.js`/`scripts/self.js`), not part of this per-compile sequence.

**Dead import found and dropped**: `strPoolString` (from
`static-data.js`): zero real uses anywhere in the file.

**Exactly one cross-seam call edge in the whole file**:
`optimizeModule → appendLateStdlib` (late-vectorizer stdlib top-up): the
split is a clean DAG because of this, not a cycle: one new module
(`optimize-module.js`) imports one named export from another
(`stdlib-pull.js`); nothing imports back.

**Module map** (6 files): `assemble/closure-table.js` (dedup helpers +
`dedupClosureBodies` + `finalizeClosureTable`: adjacent phases in call
order), `assemble/static-data.js` (`stripDeadLazyTables`/
`stripDeadInternedSpans`/`stripStaticDataPrefix`: data-segment-tail
lifecycle phases sharing the `dataString`/`dataReset`/`dataAlign`/
`dataPush` substrate, none calls another), `assemble/rename-locals.js`
(`stripLocalRenameSuffixes`, standalone late-stage), `assemble/start-fn.js`
(everything that builds or simplifies the synthetic `$__start` function),
`assemble/stdlib-pull.js` (parse-cache + `reachableStdlib` +
`appendLateStdlib` + `pullStdlib` + `syncImports`), `assemble/
optimize-module.js` (`applyArenaRewind` + `optimizeModule`, imports
`appendLateStdlib` from `stdlib-pull.js`, the one real cross-seam edge).
`assemble.js` (barrel) re-exports every current export; per-file imports
trimmed to what each actually calls, which mechanically drops the dead
`strPoolString` import.

**Decomposition candidates named for step 3, not executed**: `pullStdlib`
(347 ln: the `injectTable` closure, and the repeated
`if (ctx.core.includes.has(X)) { inc(Y); resets.push(...) }` guard
shape); `buildStartFn` (264 ln: `boxInit`/`needsSchemaTbl`/
`strPoolInit`/`typeofInit`/`closureEnvInit` blocks, each an independent
IR list spliced into the start func in a fixed order: the PUSH ORDER
into `startFn` is part of the byte-identity contract, so any future split
must keep that order textually identical, only moving list construction
into named helpers). `stripStaticDataPrefix`'s `shift()` closure and
`finalizeClosureTable` are explicitly declined as decomposition
targets: both already lean, correctness-critical, heavily doc-commented.

---

## src/ir.js split (2,487 lines → `src/ir/`)

**Exported surface**: 140 top-level declarations, ~113 exported, 76
external importers across `src/`/`module/` (26 files)/`test/`/
`scripts/self.js`: none of these 76 import lines change (the barrel
keeps re-exporting every currently-public name).

**Family map** (11 files, leaf-first build order: tag → locals → pointers
→ classify → control → numeric → bigint → vars → arrays → sentinels →
coerce): `tag.js` (`typed`, the one universal zero-dep primitive, kept its
own leaf so no "bigger" family has to be the thing everyone imports),
`locals.js` (temp-local factories), `pointers.js` (NaN-box pointer
construction/extraction + tag dispatch: `ptrTypeEq`/`dispatchByPtrType`
relocated here from the original "IR scaffolds" grab-bag, since they're
pointer-tag dispatch, not generic scaffolding), `classify.js` (constants +
literal/purity checks, merged since `MEM_OPS` is a real shared dependency
of both), `control.js` (whole-IR-tree structural utilities +
control-flow/tail-call helpers, depends on nothing but tag.js),
`numeric.js`, `bigint.js` (the phase-C box/unbox pairing family: moved
**verbatim, same relative order**: this is the file `ledger-correctness.md`'s
BigInt-boundary family names as load-bearing, no logic touched),
`vars.js`, `arrays.js`, `sentinels.js` (**merged** with what would
otherwise be a separate "truthy.js": `boolBoxIR` calls `truthyIR` and
`truthyIR` calls `isNullish`, a genuine two-way cycle in the ORIGINAL
code, not a splitting artifact: kept as one family), `coerce.js`
(ToNumber/ToString/ToPrimitive coercion). Two previously-private names
needed `export` added for cross-family use: `boxPtrIR` (pointers.js →
numeric.js) and `PURE_F64_OPS` (classify.js → coerce.js).

**Retirements landed** (`93cfcf50`): `buildRefcount`'s hand-rolled `walk`
and `nextLocalId`'s hand-rolled `walk` both retired onto `walkAst`
(verified byte-identical by construction: an `enter` returning `false`
exactly when count>1 reproduces the early-return-prunes-children
behavior), independently verified beyond the oracle's 140-spec corpus by
a 1012-case differential harness (deliberate shared-subtree aliasing,
non-contiguous ids, fuzz): 0 mismatches. `verifyFn` already called
`walkAst`; `hasExpensiveOp`/`dataDependentFlag` already called `some()`.
**Declined** (not walker-shaped): `cloneIR` (a structural transform, not
a visit: `walkAst`/`some` have no "rebuild the tree" contract);
`isPureIR` (a short-circuiting AND-fold rooted at the top: forcing
through `some`'s OR-fold contract needs De Morgan double-negation for no
proven benefit); `f64Range`'s inner helpers (value-computing recursive
transforms with per-op arithmetic); `toPrimitiveChain`/`toNumF64`/
`toStrI64` (single-level dispatch, no tree recursion at all).

**Dead-code sweep** flagged 6 candidates for a post-move grep pass
(`resolveValType`, `toBoolFromEmitted`, `litVal`, `isNullLit`/
`isUndefLit`/`isNullishLit`, `dispatchByPtrType`, `buildRefcount`): of
these, `isNullLit`/`isUndefLit` were confirmed zero external importers and
dropped from the barrel's public re-export list in `8697e400` (underlying
functions untouched, still used internally).

**Two real bugs caught by the process** (not the corpus): `numeric.js`
shipped once without `isLeaf` (a used-vs-imported symbol audit is now
mandatory *before* building each new file); a regex-`lastIndex`-reuse bug
in the scratch dependency-graph tool produced false negatives on the
first pass, fixed before it drove any real decision.

**Barrel cleanup** (`8998c700`): every `import{...};export{...}` pair
collapsed to one `export {...} from` once `ir.js`'s own body reached zero
declarations; ~15 fully-unused top-of-file imports dropped; 9 orphaned
section dividers swept (4 kept, still accurate in their new home).
Exported-name SET verified byte-identical before/after (116 names).

**Battery**: 11 families landed as 11 separate commits (`068b3743`…
`328df592`), each individually gated (oracle 560/560, kernel-parity
33/33; bigint.js/sentinels.js/coerce.js additionally `test/data.js`
171/171). Final: native suite excl. bench-c 3782/3781/0/1 (28044
assertions); kernel build succeeds (17,787,829 bytes vs. baseline
17,788,852: a ~0.006% delta, explained: the self-compiled bundler now
concatenates a different file order, shifting some LEB128-encoded
function-index widths: not a behavior change, kernel-parity and
kernel-oracle both fully green against this exact binary); kernel-parity
33/33; kernel-oracle 14/14 (605); `bench-size.mjs --json` byte-identical;
`test/pointers.js` 73/73, `test/data.js` 171/171 standalone.

---

## src/type.js split (2,561 lines → `src/type/`)

**Family map** (8 files): typed-array loop-versioning (single loop, incl.
the NEST-level `versionableTypedNest` layered on top), canonical
single-loop bounds proof, interval abstract interpreter, loop-unroll AST
transforms, `exprType` (i32/f64 inference, mirrors emit.js), integer-
certainty fixpoint lattice.

**Cycle found and fixed before extraction**: `idxKey` was defined inside
loop-versioning but the interval interpreter's `scanIntervalIdx` also
calls it directly, while loop-versioning calls the interval module back -
a direct cycle. Fix: `idxKey` relocates to `canonical-bounds.js`, already
the one true leaf both sides depend on for other reasons
(`redeclaresName`/`collectDecls`/`isUnitDecrement`/`isUnitIncrement`/
`lengthRecv`, the last three promoted from file-private to
exported-for-siblings).

**Module map**: `canonical-bounds.js`, `loop-unroll.js`, `int-certain.js`
(all leaves), `interval-proof.js`, `expr-type.js`, `clone.js`,
`loop-versioning.js`, `loop-versioning-nest.js` (extracted from
loop-versioning as a clean one-directional seam: substantial size,
one-directional dependency, its own doc comment frames it as a layer
built on top).

**Decompose-outliers, all DECLINED with reasons**: `interval-proof.js`
(~955 ln): `scanIntervalIdx` is one function by necessity, ~15 nested
closures share mutable state the proof's soundness depends on threading
correctly (2-round widening fixpoint, break/continue snapshot hulling,
closure-write poisoning): matches the pipeline-minimality campaign's own
classification, "env-threading evaluator: traversal IS the semantics -
keep." `expr-type.js` (~308 ln): `exprType` is one dispatch chain and
half of a two-file SHARED CONTRACT with `emit.js` ("decided in TWO places
that must agree... edit one side only with the other open beside it");
splitting the dispatcher would scatter that audited contract. The
remaining `loop-versioning.js` (~500 ln after extracting the nest file) -
its affine/cursor helpers have ZERO consumers besides
`versionableTypedFor` itself and read as one continuous proof narrative,
not independent reusable utilities.

**Retirements**: none needed: already landed by the sibling walker-
retrofit session before this branch was cut (confirmed on read-through:
every traversal is already `walkAst`/`some`/`someDeep` or a documented
keep).

**Deletions**: none found: every import and declaration has a real call
site.

---

## src/kind.js split (1,692 lines → `src/kind/`)

**Families**: literal lattice, VT dispatch table + `valTypeOf`/
`valTypeOfWithLocals` (incl. bare-name and `.`-member call-target
resolution via `ctx.types.callTargets.resolveMember`), dict/map
value-kind census (the "three prior attempts to promote this exact axis
globally were reverted as unsound" family: moved **verbatim**, no gate
touched), JSON shape propagation, object-literal shape constructor.

**Module map**: `kind/lattice.js`, `kind/dict-census.js` (the census
family, verbatim, minus one required substitution: see below),
`kind/shape.js` (JSON shape family minus `shapeOfObjectLiteralAst`, which
relocates to val-type-of.js since it's the one shape-family function that
calls the general `valTypeOf`), `kind/val-type-of.js` (VT table +
`hasAmbiguousBoolMerge` + both `valTypeOf` variants + the relocated
`shapeOfObjectLiteralAst`).

**Cycle constraint found empirically, not by static analysis**: jz's own
`prepare/index.js` module-graph walker (used when jz compiles itself)
hard-rejects ANY import cycle, full stop: even a cycle every binding of
which is a hoisted `function` declaration, provably TDZ-safe under native
execution and confirmed loading fine via a plain `node -e "import(…)"`.
This forced `dict-census.js`'s one `valTypeOf(name)` call site
(`mapValueKindSet`) to substitute `lookupValType(name)`: required, not a
style choice: `valTypeOf`'s own string branch IS `return
lookupValType(expr)`, so the substitution is behavior-identical, but it's
the only way to make `dict-census.js` buildable as a separate module at
all under jz's own bundler (which linearizes module init order, unlike
native ESM's live bindings). Verified: self-host build succeeds after the
substitution, oracle clean, kernel-parity clean.

**Battery**: 5 commits (`dcd6d1f7`…`aac31710` + a dead-code deletion of
the zero-consumer `typedCtorElemValType` re-export). Gate per commit:
oracle CLEAN 560/560, fresh kernel rebuild (the check that actually
matters: confirms each intermediate state is a buildable DAG under jz's
own self-host graph, not just `resolveModuleGraph`), kernel-parity 33/33.
Post-merge with main (`a18f0027`, clean merge, no conflicts): oracle
CLEAN 560/560; native 3802/3803/0/1 (28301); kernel-target 3000/3001/0/1
(14509); kernel-parity 33/33; kernel-oracle 605; `test/data.js` 171/171;
`bench-size.mjs --json` clean. **Kernel bytes**: +1 byte vs. baseline -
investigated in detail, isolated entirely to the `jz:schema` custom
section (same total length, 330 differing bytes inside it: property-list
registrations at shifted positions, since `jz:schema`'s ids are
assignment-order-dependent and the split changes when-first-encountered
order for entries downstream of the split point). Same class of drift the
pipeline-minimality campaign's own battery already showed as normal
slice-to-slice noise; confirmed inert via the full kernel-target suite and
kernel-oracle (both target exactly this class of mismatch) passing 100%.

---

## src/compile/narrow.js split (3,934/4,027 lines → `src/compile/narrow/`)

**Corrections to the original task framing, found on direct inspection**:
62 top-level declarations, not 61 (a naive grep silently drops `export
default function narrowSignatures`, the file's own default export and
largest function). `inferTypedValueRanges` is 181 lines (not ~1,270 -
that figure conflates it with the separately-declared `narrowSignatures`,
1,085 lines, immediately following it; `1633–2900` spans both).

**External contract**: exactly 3 importing files
(`plan/index.js`, `plan/advise.js`, `compile/index.js`), all 10 exported
bindings (1 default + 9 named) live.

**No module-level mutable state** (unlike `vectorize.js`): no top-level
`let`, no top-level side effects, no module-level cache, TDZ is a
non-issue (every top-level `const` is a self-contained literal). No
`vecState`-style wrapper needed anywhere.

**Dependency graph** (script-derived, 66 edges, 0 cycles):
`narrowSignatures` fan-out 22 (by far the largest, confirming it as the
file's root/entry node); `inferTypedValueRanges` and
`inferInternalArrayLengths` both fan-out 0 at the top-level graph and are
structural twins (both build a per-caller `Map<func, Map<name, fact>>`
called `locals`, consumed identically downstream): direct evidence for
grouping them into one module. Fan-in-0 set matches the 10 exported
bindings exactly: nothing dead.

**Module map** (9 files, `src/compile/narrow/`): `caller-ctx.js` (shared
per-caller context builders, 14 decls), `param-abi.js` (wasm-type/
pointer-ABI specialization, depends on caller-ctx's `PTR_ABI_KINDS`),
`results.js` (numeric/VAL-kind/pointer/bool result narrowing, 13 decls,
incl. `narrowBoolResults`: see concurrent-edit note below), `summaries.js`
(whole-program interprocedural analyses feeding `narrowSignatures`, incl.
`inferTypedValueRanges` with its 3 phases kept nested: see decision
below), `jsstring-carrier.js` (externref string-param boundary opt-in),
`strict-boundary.js` (host type-conflict rejection, freestanding),
`index.js` (`narrowSignatures` itself, the default export, landed whole -
see outlier disposition below), `specialize.js` (call-site specialization/
cloning via `materializeVariant`, depends on caller-ctx), `dyn-keys.js`
(dynamic-key refinement, freestanding).

**`inferTypedValueRanges`'s 3 nested phases: kept nested, not hoisted**
(weighed both ways): for hoisting: matches the file's dominant
convention elsewhere (`narrowI32Results`/etc. are top-level "Phase"
functions); against, and deciding: zero reuse (all 3 phases have exactly
one call site each, always in the same fixed order); the real hoist
footprint is ~10 names, not 3 (7 more pure helpers would need to move too
to keep `computeLocalRanges` at a clean signature); already well-
documented in place. Verdict: keep nested: "nothing is actually gained
by moving code whose entire reason to exist is serving one 181-line
function, once, in a fixed order."

**`narrowSignatures` (1,085 ln): the file's real outlier, landed whole,
not decomposed**: it deliberately reuses ONE mutable `sharedSiteState`
object across every call-site visit in ~20 nested closures, and its own
comment states why: "the former fresh 13-field object + method closure
+ Map per site was the largest attributed HASH-sidecar source in
self-hosted narrowing... this mutate-in-place form is required to stay
under [the warm-instance perf ratio cap]." A measured, documented
performance constraint on the closure-sharing shape itself, not just
readability. Decomposing it would need either preserving object-reuse
across a parameter-threaded version (unverified against that perf cap) or
risk regressing it. Sized and flagged, not solved: same treatment
`vectorize.js`'s own `tryDivergentEscapeVectorize` got.

**Two small dead-field findings, not touched** (logic-level, out of a
pure move's scope): `inferTypedValueRanges`'s `paramReps` parameter is
dead (never referenced in its 181-line body); its returned `.summaries`
field has zero readers anywhere in the repo.

**Concurrent-edit hazard, handled correctly**: another session held
uncommitted edits in main's copy of `narrow.js` around lines 2950–2975
(inside `narrowBoolResults`'s body) at analysis time: `narrowBoolResults`
was moved into `results.js` only after that work landed.

**Corrections found during re-verification, mechanical**: (1) a stripper
bug in the re-verification's own dependency scanner blanked
`${...}`-template-literal interpolations as inert string content, hiding
`kindName`'s real call site: fixed with a proper stack-based stripper,
re-confirmed 66 edges, no family reassignment needed. (2) `export {
default } from './narrow/index.js'`: standard JS, but **jz's own
`early-errors.js` rejects the bare `default` specifier as a reserved-word
binding** (its parser represents an export-specifier list with the same
node shape as a destructuring pattern and doesn't special-case `default`
there): caught by the kernel rebuild, fixed with `export { default as
default } from './narrow/index.js'`. Recorded for the next split that
re-exports a default binding through a barrel. (3) `jsstringEnabled` and
`applyJsstringBoundaryCarrier` needed `export` added (both module-private
originally, both called directly from `narrowSignatures`): a gap the
mechanical fan-out check closed before cutting that family.

**Hand-rolled walker survey, none retired this slice** (all declined,
verification-cost or structural-fit reasons): `inferInternalArrayLengths`'s
`collect`/`verify` pair (plausible `walkAst` port, but `verify`'s abort is
a GLOBAL flag, not a per-branch prune: "provably equivalent" needs a
differential harness, not a read); `computeDirectEffects`'s inner walk
(the most promising candidate: its `inClosure` parameter never actually
reaches a recursive call as `true`, so it's likely dead and this is a
clean single-callback port, still declined for verification cost);
`paramAllUsesJsstringMappable`'s `walk` (hard decline, not time-boxed: it
visits bare string leaves, which `walkAst`'s `enter` never independently
fires on; retiring it would silently change behavior); `speculateTypedParams`'s
`arrowPathTo` walk (structural non-fit: a find-with-backtracking
path-stack walker, neither `walkAst` nor `some` has a matching contract);
`speculateTypedParams`'s `findBind`/`findCalls`/`findDecl` (clean
candidates, declined for verification cost only).

**Battery**: 9 families landed as 9 pure-move commits (`322f3592`…
`4ad9659a`), leaf-first, each gated (cycle check, oracle 560/560 against
`a45ce6ca`, kernel-parity 33/33 against a freshly rebuilt kernel every
time). Total 4,215 lines vs. pre-split 4,027 (+4.7%, same import-overhead
class as every other split). Final: oracle CLEAN 560/560; native
3858/3858(sic)/0/1 (28,505 assertions, 1 skip); kernel-parity 33/33;
kernel-oracle 605; `test/pointers.js` 73/73; `test/data.js` 204/204;
`test/eager-stdlib-parity.js` 22/22; kernel-target 3034/3035/0/1 (14,639);
`bench-size.mjs --json` byte-identical to baseline across all 61
programs. Kernel size: net **zero** byte delta vs. baseline (17,898,864
both), though internally NOT byte-identical (differs from byte 32,329,
different sha256): same module-graph-reorder mechanism every other split
in this campaign shows, here netting to exactly zero; confirmed
behaviorally identical via kernel-parity 33/33 + kernel-oracle 14/14
against this exact binary.

---

## src/compile/program-facts.js split (2,010 lines → `src/compile/program-facts/`)

**Fact families** (5 builders + 2 cache helpers): `observeNodeFacts`
(family A, feeds `collectProgramFacts`'s whole-program walk),
`collectProgramFacts` (the only external call site is `plan/index.js`'s
`facts()`), `resetProgramFactsCache`/`invalidateProgramFactsCache`
(cache-lifecycle leaves), `observeProgramSlots` (family B, populates
`ctx.schema.{slotFacts,slotConstInts,dictValueTypes,mapValueTypes,
hasTypedSlots}`), `effectiveWriteValue` (pure, zero external consumers
today, kept exported for API stability), `collectSlotWriteHazards`/
`applySlotWriteHazards` (family C, zero external consumers today),
`analyzeParamNeverGrown` (family E, mutates the `paramReps` Map argument
in place), `analyzeSchemaSlotIntCertain` (family D).

**Textual position misled twice** (flagged explicitly per this slice's
own method): `isSelfPreservingPropWrite`/`SELF_PRESERVING_OPS` sit
textually between families B and C but are family-B-only (`observeProgramSlots`'s
`.prop=` branch: works today only because `function` hoists);
`collectBodyElemSids` sits textually in "C territory" but is genuinely
shared by C (late mode) and D.

**Two dead imports found and dropped**: `ASSIGN_OPS` (zero uses in the
file body), `lookupValType` (only mentioned in doc-comment prose).

**Module map** (7 files + barrel): `program-facts/shared.js`
(`ARR_RESIZE_METHODS`/`collectBodyElemSids`/`effectiveWriteValue`: cross-
family primitives owned by neither builder outright), `cache.js`,
`slot-write-hazards.js`, `slot-kind-census.js` (`observeProgramSlots`,
depends on slot-write-hazards + shared), `slot-int-census.js`
(`analyzeSchemaSlotIntCertain`, same deps), `param-never-grown.js`,
`walk-facts.js` (`observeNodeFacts`+`collectProgramFacts`, sits on top,
depends on both slot-census modules). Verified with the refactor oracle
after every commit: CLEAN throughout.

**Fusion/retirement scan (step 3), none attempted, recorded why**: no two
traversals in this file visit the same node set in the same order with
independent per-node actions: B's `visit` and C's `visit` both stop at
function-body boundaries and install a per-function overlay, but B
additionally threads branch-local integer refinement C doesn't need, and
C additionally threads late-mode param-resolution state B doesn't need;
forcing them together means threading the union of both parameter sets
for zero reduction in visited-node count (they already run back-to-back,
once each). D's `visit` is a THIRD independent per-node walk with its own
fixpoint state (`sweep`, ≤64 rounds): not fusable without smuggling the
intCertain fixpoint's re-entrancy into the single-pass kind census.
`walkAst` retirement: every hand-rolled walk in this file either
special-cases a bare-string leaf directly (the hard `walkAst`
incompatibility named by the sibling `analyze-traversals` slice) or
threads caller-specific state through the recursion signature in a shape
`walkAst`'s single `{enter}` callback doesn't accommodate: none of this
file's walks are the iterative-by-necessity or fixpoint-outer-loop shape
that DOES get retired elsewhere in this campaign.

**Discrepancy note**: the originating task brief named a
`synthesizeComputedDispatchCallSites` function as already added "for the
call-target index": no such name existed in the repo at this slice's
base ref. The closest real code (`collectSlotWriteHazards`'s
`sitesByCallee`) is call-site RESOLUTION, not synthesis, and predates
`call-target-index.js`. (The function with that exact name was built
later, by the `string-method-guess` branch: see `ledger-correctness.md`
§3: unrelated to this slice.) Recorded rather than silently reconciled.

### §7: Freeze audit (`refactor/program-facts-freeze` slice): fact lifecycle rules

*(Load-bearing: kept verbatim per the v1 architecture-convergence gate 5
finding: "call-target authority + program-facts separation block v1 -
they cause wrong-value classes.")*

**Scope**: `programFacts.paramReps`, `.callSites`, `.callTargets`: the
three fields mutated or stapled on after publication.

**Fact lifecycle table**:

| fact | producers, in true execution order | last producer WITHIN `plan()` | freeze point chosen | mechanism |
|---|---|---|---|---|
| `paramReps` | (1) `collectProgramFacts` publishes empty → (2) `narrowSignatures` fixpoint (`narrow.js`, via `ensureParamRep`) → (3) `analyzeParamNeverGrown` IFF `optimizing()` → (4) `specializeBimorphicTyped`, UNCONDITIONAL, last stmt of plan round 2 → (5) `specializeValKindDichotomy` IFF `optimizing()`, round 3 → (6) `speculateTypedParams` IFF `optimizing()`, round 3 → **(7) `specializeUnionCursorParams`, called NOT from `plan()` but from `src/compile/index.js:2556`, during EMIT's `unionClones` phase, AFTER `plan()` has already returned** | end of plan round 3 | end of plan round 3, between the round-3 `round()` call and round 4's | read-only VIEW `{ get: k => paramReps.get(k) }` installed for rounds 4-5 + `solveRepresentationBoundaries`, then **restored to the real Map right before `plan()` returns** (both return points) so step (7)'s later legitimate write keeps working |
| `callSites` | (1) `collectProgramFacts` builds via the whole-program walk → (2) `narrowSignatures` entry: `filterLiveCallSites` truncates in place → (3) entry-level retarget via `materializeVariant`'s `eligibleSites`, from `specializeFixedRestCalls` (pre-narrowing, legitimately reads the pre-filter census), `specializeBimorphicTyped` (round 2), `specializeValKindDichotomy` (round 3) | end of plan round 3 | same point as `paramReps` | `Object.freeze(callSites)` + `Object.freeze()` each entry: **permanent, no restore needed**: `specializeUnionCursorParams` never touches `programFacts.callSites` at all, so unlike `paramReps` this fact IS fully closeable for the whole program run |
| `callTargets` | (1) `buildCallTargetIndex` returns `Object.freeze({resolveMember})`: value already sound/frozen at construction | `plan/index.js:230`, the ONLY `programFacts.X =` staple-on site anywhere in `src/compile/` | immediately at staple-on | value was already frozen; the actual defect is the CONTAINER (`programFacts` has no closed shape): fixed via a `DBG_INVARIANTS`-gated `assertProgramFactsShape` allowlist check, not a container freeze |

**Readers, and the premise this audit corrected**: full-repo grep of every
`paramReps`/`callSites` reader outside `narrow.js` found no reader
reading either fact before its relevant producer settled: the two
early-plan `callSites` readers legitimately want the raw, pre-filter
census; every post-narrowing reader already runs in plan round 2+. So
this audit found **no live wrong-value bug**: the finding is that the
architecture is sound today only by pass-ORDERING DISCIPLINE, not by
construction, exactly gate 5's complaint ("a shared mutable bag the next
edit can silently misuse"). The premise correction: the task brief named
`narrowSignatures` as `paramReps`'s last producer; tracing every
`materializeVariant({...paramReps...})` call site shows FOUR more writers
after it returns, ending in `specializeUnionCursorParams` which isn't
called from `plan()` at all. `paramReps`'s true lifecycle therefore spans
TWO pipeline stages (PLAN, closed at round 3; EMIT, reopened for
newly-materialized clone functions only): "one documented producer
phase" holds for PLAN's own contribution but not the whole program run.
The freeze protects the portion this slice can reach and hands back the
live, mutable Map, unwrapped, before `plan()` returns, so the EMIT-phase
writer is unaffected. `callSites` has no second stage and is frozen for
good.

**Why the mechanism is a plain read-only view, not `Proxy`/`Object.seal`**
(three subset limits, grep-verified before picking a mechanism, since
this code is itself compiled BY jz when building `dist/jz.wasm`): **no
`Proxy`**: jz registers no Proxy global in any module, Proxy traps
aren't in the self-compilable subset, a throw-on-write wrapper is
inexpressible, not merely costly. **`Object.freeze` is a no-op under
self-host**: jz objects have no per-property protection; freezing
`callSites` is real under native `node test/index.js` and inert-but-
harmless self-hosted, matching `call-target-index.js`'s own existing
`Object.freeze({resolveMember})` precedent, not a new risk. **`Object.seal`/
`Object.preventExtensions` are not implemented at all**: calling either
from kernel-reachable code risks an outright self-host compile failure.
The chosen `paramReps` mechanism (a plain frozen object exposing only
`{get}`) sidesteps all three: it needs no Proxy trap and no freeze
semantics, since its protection comes from ordinary property lookup (a
caller reaching for `.set` gets a plain "not a function" TypeError) -
identical behavior natively and self-hosted. `programFacts`'s shape check
is a `DBG_INVARIANTS`-gated `Object.keys(programFacts)` allowlist scan
(`Object.keys` IS implemented): mirrors the existing
`assertValKindConsistent`/`assertMidCompile` convention exactly: opt-in
via `JZ_DEBUG_INVARIANTS=1`, zero cost when unset.

---

## src/compile/analyze.js + analyze-scans.js traversal map/split (4,739 lines combined)

Companion to the walker-retrofit campaign: inventories every traversal
over a function body before any split/fusion/retirement (`analyze.js`
3,301 ln + `analyze-scans.js` 1,438 ln). Prior art already folded in, not
re-derived: `archive/walk-count-design.md` §1's dependency analysis for
`analyzeBody`'s own sub-passes; a sibling `refactor/pipeline-minimality`
commit's 7-traversal conversion for these two files (its own claim was
checked against a narrower corpus than this slice's 560-row oracle -
drift found elsewhere in that commit's 19-file diff, not isolated to
these two files; each of its 7 conversions independently re-verified
here, not trusted from its commit message).

**Traversal count**: `analyzeBody` alone is **13** distinct full-body
descents transitively, once analyze-scans.js's contributions are counted
(down from the walk-count-design's original 8-at-the-top-level count
since 3 of its calls were already fused into `scanObjectArrayFacts`,
prior art, landed per that doc's own recommendation).
**Total distinct hand-written traversal FUNCTIONS across both files: 32**
(counting each named `walk`/`collect`/`verify` closure once, not its
call-site count: more granular than a "six hand-rolled walkers" phrasing
that counts only headline exports, not their private helpers; both
readings recorded so the discrepancy is auditable).

**Order dependencies** (cannot reorder): `walk → widenLocalTypes` (data
dependency on the `locals` map); `widenLocalTypes → narrowUint32`
("Runs post-widen so a local already demoted to f64 above is
reconsidered with final types," per its own doc). `stampCoInductionRanges`
must precede `widenLocalTypes` but doesn't consume `walk`'s output -
repositionable, not fusable (different node-kind selection).

**Module map** (`src/compile/analyze/`, 7 files): `trackers.js`
(`makeValTracker`/`makeTypedTracker`, shared by body-facts.js and
val-types.js), `body-facts.js` (`analyzeBody`, the cache-lifecycle
functions), `val-types.js` (`analyzeValTypes`, the dict/map helpers),
`ptr-eligibility.js` (`unboxablePtrs`+`inheritPtrAliases`+
`cseSafeLoadBases`, grouped since all three are per-function
pointer/CSE-eligibility passes imported together at every call site),
`struct-inline.js`, `union-inline.js`, `func-namespaces.js`.
`analyze-scans.js` was NOT moved or renamed: already its own well-scoped
module with 4 direct external importers.

**Retirements landed** (`91f21bec`, 12 total, oracle 560/560 clean): from
analyze-scans.js: `selfPreservingWrittenKeys`, `collectComparedNames`,
`stampCoInductionRanges`'s outer walk, `collectF64StridedIndexVars`,
`collectI32SafeIndexVars`'s `collect`+`seed` passes, `boxedCaptures`'s
`collectDecls`; from `val-types.js`: `dictValueTypeOf`, `mapValueTypeOf`;
from `ptr-eligibility.js`: `inheritPtrAliases`'s walk, `cseSafeLoadBases`'s
`scanStores` pass; from `struct-inline.js`: `analyzeStructInline`'s
`collectCursors` pre-pass. Each hand-traced against its original
(enter-returns-false ⟺ the old early return; enter-falls-through ⟺ the
old unconditional trailing recursion).

**Hard incompatibility sharpened during implementation**: `walkAst`'s
`enter` only ever fires on ARRAY nodes: a bare string leaf is never
independently visited. `narrowUint32` and `collectBareEscapes` both
special-case a bare string node FIRST, before any array check: retiring
either would silently stop seeing every bare-name leaf entirely, not
merely lose closure-state threading. A hard incompatibility (wrong
answer, not awkward), sharper than the original "env-threading" framing.

**Declined, each for a stated reason**: `analyzeBody`'s own main `walk`,
`widenLocalTypes`'s `widenPass`/`recheck` fixpoint, the `dictWalk*` family,
`narrowUint32`, `collectBareEscapes`, `analyzeStructInline`'s `verify`/
`verifyCall`, `analyzeUnionInline`'s `collect`/`verify`,
`analyzeFuncNamespaces`'s `visit`, `cseSafeLoadBases`'s Pass 1/Pass 2,
`scanBindingUses`'s `walk`: string-leaf visits, env-threaded state,
fixpoint iteration, or documented iterative-recursion necessity
(`dictWalkLean`/`dictWalkI32`/`dictDomainOf` are iterative BY DESIGN: the
original nested-closure recursive form miscompiled under self-host,
`83d6add5` bisect).

**One genuine redundant-computation win, found and fixed** (distinct from
retirement and fusion): `widenLocalTypes` called `collectBareEscapes(body,
locals)` up to TWICE: once inside `collectI32SafeIndexVars`, again
conditionally in Pass D. `locals` is provably dead in that function and
the call has no side effect, so the two calls are byte-identical whenever
both fire: a real duplicate full-body-walk-plus-sub-walk, not just a
duplicate function call. Fixed via an optional lazy-memoizing thunk
parameter, computed at most once and not at all when neither consumer
needs it (preserves both early-exit paths).

**No traversal fusion found beyond prior art** (`scanObjectArrayFacts`)
and the dedup above: every re-examined pair either has a genuine data
dependency or visits a different node set under a different closure-
descent rule; forcing them together needs an unproven internal fixpoint
or changes visit timing, outside "provably equals the original" territory.

**Dead code found**: an orphaned doc comment in each file (describing a
function that no longer exists at that location), dropped, not moved; 31
of ~76 imported symbols into `analyze.js` unused anywhere in the file -
dropped mechanically by the split (each new module imports only what it
calls).

---

## src/compile/representation-plan.js split (2,565 lines → `src/compile/representation-plan/`)

**Phase map**: primitives (packed-fact algebra), provenance fixpoint
(`solveBigintProvenance`, 632 ln), local provenance (`deriveLocalProvenance`),
boundary solving (`makeBoundaryData`/`solveRepresentationBoundaries`),
shared op/def vocabulary, body data/materialization (`buildBodyData`, 806
ln: the file's other outlier), mint (`mintRepresentationPlan`), debug
invariant, query/materialize (the frozen-plan read API every emit.js/
ir.js call site consults), call-arg actions.

**Cross-cutting concerns, not separate phases**: closure forwarding and
index-resolved `.`-member callees (`resolveMemberCallee`): per
`ledger-correctness.md`'s "member-callee-binding-write" family (a sibling
branch not yet merged into this slice's base): kind.js's `valTypeOf` now
resolves `.`-member callees itself through the frozen call-target index,
so two of the four per-site widenings that branch added were already
reverted to baseline form before that branch's tip: confirmed:
`edgeMaterializable` here already reads the plain baseline form, nothing
redundant remained to delete. The other two widenings that branch
correctly kept (`calleeNameOf`/`directCallBoundary`,
`representationActiveMaterializedRep`'s `()` branch) are exactly what
this file's own "index-resolved `.`-member callees" cross-cut already
names: they carry plan-internal facts `valTypeOf`'s kind-only vocabulary
can't express, not redundant.

**Module map** (6 files + barrel, layered DAG): `common.js` (the packed-
fact algebra: kept as one unit: mutually-referential one-liners defining
a single shared vocabulary, not splittable by usage count without
fragmenting the notation; `edgeAction`, the most cross-cutting function
in the plan), `boundaries.js`, `provenance.js` (`solveBigintProvenance`+
`deriveLocalProvenance`, plus 4 hoisted helpers: see decomposition
below), `body-data.js` (`buildBodyData`+`mintRepresentationPlan`, plus 1
hoisted helper + a new dedup), `materialize.js` (the emission-time query
API), `call-args.js`.

**Decompositions (step 3)**: `solveBigintProvenance`: 4 free-standing
functions hoisted to module scope (`paramNeedsHostTag`,
`isStorageReadArgShape`, `seedBigintTyped`, `paramEntryExcludesBool`),
each computing a pure answer from explicit inputs with zero real
dependency on the fixpoint's own mutable Maps. **Declined**: `exprMay`/
`exprRep`/`scan`/`visitCallSites`: each closes over 4+ of the fixpoint's
mutable Maps and is mutually recursive with the others; campaign history
(the phase-c-unification "fixpoint suspicion one layer too deep" pattern,
`ledger-correctness.md`) shows this exact code is unusually sensitive to
ordering/staleness mistakes; not a "collect vs. decide" seam either -
every one of these functions does both, node by node, in one pass.
`buildBodyData`: `edgeMaterializable` hoisted (byte-identical). The
"collect facts vs. decide actions" split named by the originating brief
was evaluated in depth and **declined**: `semanticOf`/`currentOf` are
called LIVE by the decide-actions half, and their memo Maps are
intentionally `.clear()`-ed at specific fixpoint points: a caller-side
data-only handoff isn't sufficient, the closures themselves must cross
the boundary; a correct split needs bundling ~20 shared bindings into a
context object threaded through every read site in the half of the
function with the most extensively documented history of subtle
staleness/ordering bugs (Shape #6 layers 1-6, Shape #7, C4b, C5, C5b -
`ledger-correctness.md`). "Never speculative abstraction": declined;
stays one function. **New, real dedup**: the "BOOL-veto" guard
(`semanticClosed(X) && (semanticKinds(X) & bitOfKind(VAL.BOOL)) !== 0`)
appeared byte-identical at 7 sites: extracted to one named predicate,
`hasClosedBool`, called at all 7.

**Retirements**: `collectLocalClosures`'s and `collectDispatchTableClosures`'s
inner `collect` functions, both retired onto `walkAst`: verified
byte-identical (neither inspects a bare string leaf, neither has a
root-vs-nested asymmetry). **Correction post-merge**: a `root`-
parameterized-`=>`-boundary class was initially mis-analyzed as a hard
`walkAst` incompatibility: `walkAst`'s `enter(node, parent, index)`
receives `parent`, and `parent === null` identifies the root call, so
`if (parent !== null && n[0]==='=>') return false` inside `enter`
replicates the old root-exemption exactly, no `boundary` option needed.
The sibling walker-retrofit campaign found this independently and retired
`deriveLocalProvenance`'s `scanStorage` this way; merged verbatim rather
than re-derived. **Declined**: `collectDefs`'s `walk` and `buildBodyData`'s
`walkEdges` (both additionally have an `Array.isArray(op)` "op is itself
a list" branch the `parent` trick doesn't resolve); `solveBigintProvenance`'s
`seedBigintTyped`/`scan`/`visitCallSites` (same list-shape incompatibility,
used for the top-level `ast` walk specifically); `semanticOf`/`currentOf`/
`plannedOf`/`emittedCandidate` and provenance's `exprMay`/`exprRep` are not
traversals in walkAst's sense at all (memoized recursive value functions).

**Battery**: pure move (`8d27e543`), merge with main's concurrent
152-walker retirement campaign (`c963c418`, 3 of those 152 landed inside
this exact file: reapplied verbatim to their new homes), decompose
(`1f127c42`). Full: oracle CLEAN vs. `b76a34b3` at every commit; native
3771/3770/0/1 (27,416); kernel-target 2984/2983/0/1 (14,348); kernel-parity
33/33; kernel-oracle 605; `test/data.js` 171/171; `test/pointers.js`
73/73; `bench-size.mjs --json` clean. Kernel bytes: baseline
17,881,876 → after pure move 17,881,862 (−14) → after decompose
17,878,294 (−3,582, the `hasClosedBool` dedup removing 6 duplicate inline
copies of the BOOL-veto guard from the self-compiled kernel's own body).
Reproducible (rebuilt twice, identical sha256) but not byte-for-byte
identical to baseline: expected, benign, same module-count/discovery-
order mechanism every split in this campaign shows. A `--full` oracle run
(covering the self-host leg directly) was attempted but its temp
worktree was removed mid-run by unrelated concurrent multi-agent activity
- inconclusive, not re-attempted given the direct behavioral evidence
already in hand (the full suite run THROUGH this exact rebuilt kernel,
0 fail: the strongest available proof for this file specifically, since
its documented history is full of self-host-only divergences that
manifest as test failures, not silent byte mismatches).

---

## Stdlib generator moves: `module/collection.js` + `module/typedarray.js`

**Premise check, corrected**: the originating task described
`genUpsertStrictPrehashed`/`genSimdMap` as spanning ~2,533/~2,886 lines -
at the branch base neither claim holds (60 and 68 lines respectively,
already small, already-parameterized template generators). The cited
line counts are reproduced exactly by measuring to the next TOP-LEVEL
declaration, which happens to be the START of each file's `export
default (ctx) => {...}` module-registration closure: a "span to next
top-level name" heuristic silently swallows that whole ~65/dozens-of-
entry closure. Both named functions and their immediate sibling families
are already well-factored: no further de-duplication is safe or
provable; what IS real and matches the task's own named example paths
(`module/collection/upsert.js`, `module/typedarray/simd-map.js`) is
extracting each file's one genuinely cohesive, self-contained, already-DRY
subsystem into its own file with zero logic change.

**collection.js** (3,974 → moves): the probe/grow/zombie template-fragment
helpers + the 10 probe-family generators (`genUpsert`/`genLookup`/
`genDelete`/`genUpsertGrow`/`genSlotUpsert`/`genEphemeralSlotUpsert`/
`genEphemeralFixedSlot`/`genLookupStrict`/`genLookupStrictPrehashed`/
`genUpsertStrictPrehashed`) → `module/collection/upsert.js`. The durable-
heap-log family (`heapResetWat` + 8 `durable*IR` helpers) → **also**
extracted, to `module/collection/durable.js`: required by a cycle jz's
own `resolveModuleGraph` rejects even though plain Node ESM tolerates it
(see below).

**typedarray.js** (3,055 → moves): the SIMD family (`analyzeSimd`,
`genSimdMap`, the `simdOp`/`scalarOp` factories) → `module/typedarray/
simd-map.js`. `STRIDE`/`SHIFT`/`LOAD`/`STORE` → **also** extracted, to
`module/typedarray/elem-tables.js`: same cycle-avoidance reason.

**Cycle constraint, found the same way as the `kind.js` split**: a first
cut had `upsert.js` import its 5 `durable*IR` helpers back from
`../collection.js` while `collection.js` imports the 10 generators from
`upsert.js`: plain Node ESM tolerates this (every use is inside a
function body evaluated lazily, never at module-evaluation time), and
`node --check`/`import()` both looked clean: but **jz's own
`resolveModuleGraph`** (used to compile `bench:jz`, jz compiling itself)
rejects circular module imports outright. The task's own oracle catching
a real defect, not a false alarm. Fix: pull the cohesive "durable heap
log" family out to a true leaf (`durable.js`, only dependency: `ctx`) so
the graph becomes a one-directional diamond. Same fix shape for
`elem-tables.js`.

**Dead-variant check**: none found in either generator: every parameter
combination of `genUpsertStrictPrehashed` is exercised across its 3 real
call sites; `genSimdMap`'s `elemType<4` null-return branch is a declared
non-support tier, not dead code, and the caller already handles it.

**Side finding, not acted on** (out of scope, flagged): `scalarOp`'s
bitwise arms always target `i32.*` regardless of type-prefix: would emit
invalid WAT if `analyzeSimd` ever matched a bitwise pattern on a
Float32/Float64Array callback. A comment asserts this doesn't arise but
nothing enforces it; whether it's actually unreachable depends on
upstream type inference this task didn't touch.

**Battery**: sed-diff byte-identity per extraction; a temporary compiled-
output sha256 oracle (predates the general refactor-oracle) across
`test/kernel-parity.js`'s CORPUS + every bench/example + watr's full
module graph, diffed to empty after each commit; full battery (native
excl. bench-c, kernel build + kernel-target, kernel-parity, kernel-oracle,
`bench-size.mjs --json`, kernel byte count before/after).

---

## Stdlib generator moves: `module/math.js`

**Shape difference from the collection/typedarray precedent**: math.js
(2,296 lines) is ONE closure: `export default (ctx) => {` opens at line
22 and doesn't close until EOF, no top-level pre-closure helper at all.
Every family below is extracted FROM INSIDE the closure (the target
module imports the `ctx` **singleton** directly from `ctx.js` instead of
receiving it as a parameter: confirmed safe by reading
`src/autoload.js`'s `loadModule`, which calls every module's default
export with the same singleton). A second wrinkle: the WAT-string kernels
(back two-thirds) have almost zero JS-level coupling to the front-third
emit-dispatch helpers: but most of the WAT section (trig/exp/log/pow-
core/hypot/cbrt/atan) is declined for extraction anyway, since those
kernels WAT-call each other constantly and have no author-drawn
sub-boundary beyond one whole-section header: moving them would be
relabeling the interconnected bulk under an invented name.

**Four families DO clear the bar**: the correctly-rounded pow kernel
(~500 ln, already delimited by the original author's own `if (crPow) {}`
wrapper and comment: the wrapper itself stays in math.js as the call
site, the interior becomes `registerPowTranscend()`) → `module/math/
pow-transcend.js`; trig coefficient tables + SIMD f64x2 variants
(two-piece leaf+consumer extraction, mirroring `elem-tables.js`←
`simd-map.js` exactly) → `module/math/trig-tables.js` + `module/math/
simd.js`; `Math.sumPrecise` (2 cuts, zero shared helpers with anything
else in the file) → `module/math/sum-precise.js`; `Math.random`/seed (4
cuts, interleaved with sumPrecise's own WAT body in the original) →
`module/math/random.js`.

**Declined, each with a reason**: integer ops (too small, embedded in the
general built-in-op cluster); `fround`/`hypot`/`cbrt` as a group (no
author-drawn boundary tying them together, cutting just two would be
arbitrary); the 8 `Math.PI`/`E`/etc. constant-fold emits (genuinely
self-contained but too small for their own file, mirrors the collection.js
precedent's identical `numConstLiteral`/`ASCII_KEY` decline); trig/exp-log/
pow-core-ladder (deeply interconnected, no sub-boundary: the file's own
`if (crPow) {}`-wrapped `math.pow_fold` specifically declined too, since
it only invokes `$math.pow_transcend` by WAT NAME, a runtime dep with no
JS symbol, and its comment is written against the ladder it sits beside).
No de-duplication commit: the file already routes every shared shape
through one generator (`horner`/`horner2`/`minmax`/`foldPow`).

**Dead code found and deleted, pre-existing, not created by any move**:
`exp2Call` (`emitter(['math.exp2'], ...)`): zero call sites anywhere in
the repo, grep-verified. The real base-2 fast path lives inline inside
`emitPow` itself, unaffected. Also: an unused `asI32` import from `ir.js`.

**Battery**: line counts math.js 2296→1383 (−39.8%); new files total
1,009 lines (the 96-line gap over the 913 removed is JSDoc headers +
imports, every moved body diffed byte-identical against its origin).
`resolveModuleGraph` re-run after every move: clean throughout, module
count climbing by exactly 1 per new file (216→221). Oracle CLEAN 560/560
after every one of 8 commits. Full battery green (native, kernel build +
kernel-target, kernel-parity 33/33, kernel-oracle 605, `bench-size.mjs
--json` byte-identical). **Kernel bytes**: baseline 17,957,537 → this
branch 17,861,447 (−96,090, −0.53%): a DIFFERENT question from the
oracle/bench-size proofs (those confirm every ORDINARY program compiles
identically; the self-hosted kernel's own size is a function of the
compiler's OWN source shape, which this refactor deliberately changed -
6 files instead of 1). A second baseline rebuild to confirm determinism
was started but killed by an environment restart before finishing: NOT
re-verified; direction and magnitude are consistent with the source-shape
change, not asserted with unearned confidence.

---

## Stdlib generator moves: `module/string.js` + `module/array.js`

**Shape difference from the collection/typedarray precedent**: registration
calls (`wat()`/`bind()`/`ctx.core.emit[name]=`/`ctx.core.stdlib[name]=`,
the two stdlib registration dialects) are interleaved THROUGHOUT the
closure body in both files, not built by a separate generator called
later: there is no large detached "generator family" of the collection.js
probe-family shape.

**string.js** (2,883 lines): two genuinely self-contained encoding
subsystems near the end, each already delimited by the original author's
own structure: the URI percent-codec (`encodeURIComponent`/`encodeURI`/
`decodeURIComponent`/`decodeURI`) → `module/string/uri.js`; the base64/hex
codec (`btoa`/`atob`/`Uint8Array.fromBase64`/`toBase64`/`fromHex`/`toHex`/
`setFrom*`) → `module/string/base64.js`. `__uri_hex` is called from the
base64 family's `__hex_dec_raw` at the WASM level via `call $__uri_hex`
inside a WAT template string, not a JS symbol: needs no import either
direction (name-keyed registration is order-independent). The SSO codec
and the "Method emitters" dispatch bulk (dozens of methods sharing small
helpers) are deeply interconnected and stay.

**array.js** (2,790 lines): the core (allocation, indexed read/write,
grow/relocate, push/pop/shift/splice/unshift, map/filter/reduce/forEach +
their upstream-fusion optimization) is one deeply-interconnected web, same
verdict as collection.js's general primitives. Two genuinely
self-contained families DO exist: the callback-invocation strategy
(`makeCallback`'s inline-vs-closure fast path + `callbackArgReps` +
`hoistArrayValue` + the pure-expression-check trio + `idxF64`/`idxArg`) -
extracted to a true LEAF, `module/array/callback.js`, since `Array.from`
AND `earlyExitMethod` AND array.js's own remaining map/filter/reduce/
forEach all need it (extracting it into either consumer directly would
create the same 2-node cycle `resolveModuleGraph` rejects, per the
collection.js precedent); `Array.from`'s own family (207 ln, all-private
helpers + the one registration) → `module/array/from.js`; the early-exit
iterator factory + its 6 registrations (`.some`/`.every`/`.find*`) →
`module/array/early-exit.js`.

**Dead code found and deleted**: `arrMethod` (array.js): grep-verified
zero call sites anywhere in the repo, defined once, never called
("factory for simple arr→call stdlib patterns" per its own comment, but
nothing ever used it).

**Battery**: sed-extracted body text diffed byte-identical against each
new file for every move; `refactor-oracle.mjs check` CLEAN 560/560 after
every commit; `resolveModuleGraph` clean, module count climbing by
exactly 1 per new file (211→214); full battery (native 3753/3752/0/1;
kernel build + kernel-target 2983/2982/0/1; kernel-parity 33/33;
kernel-oracle 605; `bench-size.mjs --json` byte-identical; kernel byte
count recorded in the landing report).

---

## Dead-exports sweep

Cross-referenced every `export` in scope against static import/re-export
graphs (TypeScript parser), a repo-wide textual grep fallback (dynamic
`import()`, WAT template strings, string-matched build markers), and a
same-file self-usage grep: every deletion verified against all three
before acting.

**Summary**: 37 commits, 31 files touched, +52/−256 lines. 1 whole dead
file deleted: `src/ops.js` (118 lines, an integer-tagged-union op seed
parked dormant since `610ba822`, zero importers of any of its 5 exports -
flagged unresolved in the pipeline-minimality campaign's own M1c side
findings, resolved here). 8 dead functions/constants deleted outright
(zero callers anywhere, including their own file): `cost-model.js`'s
`computeAliasGuards` (its doc comment's aspirational "shared verbatim by
tryVectorize and tryStencil" helper: both callers actually carry their
own independent inline computation instead); `analyze-scans.js`'s
`BINDING_USE_CALLEE`/`BINDING_USE_ARG_INDEX`; `flow-state.js`'s
`withFlowBlocked`; `scripts/self.js`'s `compileProfile` (see kernel-export
note below); `ast.js`'s `isSeq`; `reps.js`'s `isKind`+orphaned
`KIND_UNIVERSE_SET`; `infer.js`'s vestigial `export {typeofPredicate}`
re-export; `session.js`'s vestigial `export {getFactStore}` re-export.
46 exports demoted (kept the code, dropped the `export` keyword: used
only within their own file) across 15 files. 34 unused named imports
dropped across 11 files.

**Kernel-export note**: `scripts/self.js` is compiled BY jz into
`dist/jz.wasm`, not imported as a JS module: its top-level `export
function`s become the compiled kernel's WASM exports. Deleting
`compileProfile` (zero callers) is the one change in this sweep that can
shrink `dist/jz.wasm`'s own export table; reported separately as a
kernel-bytes delta in the battery, not folded into "byte-identical" (it's
outside the refactor oracle's corpus).

**One caught mistake, left in for the record**: a hand-transcription error
briefly removed `undefExpr` from `typedarray.js`'s `ir.js` import: that
name was never on the verified unused-imports list. `refactor-oracle.mjs
check` caught it immediately (`watr:watr.js` O3/size legs: "internal:
undefExpr is not defined"). Reverted before committing; every other
removed name in that batch was cross-checked programmatically afterward -
all correct. Lesson recorded: batch `git diff` review against the
verified candidate list before committing, not just before editing.

**Barrel-only candidates, NOTED, not acted on**: 7 exports reached only
through a barrel created by one of the module splits above, where the
barrel's re-exported name ALSO has zero importers: left alone since a
barrel re-export is a deliberate public-surface decision from the
splitting session, not obviously this sweep's call to make without that
context. **Methodology caveat found and corrected**: the barrel detector
only follows one re-export hop: two names that looked like this pattern
(`vectorize/inline-pure.js: inlinePureFnsInFn`, `vectorize/lane-tables.js:
SIMD_PINNED`) turned out to be live through a SECOND hop (both flow
`file → vectorize.js (hop 1) → optimize/index.js (hop 2) → real caller`)
and were dropped from the candidate list after verification.

**Held-file findings, NOT touched** (another session's in-flight work at
sweep time): dead-or-underused exports flagged in `jzify/hoist-vars.js`,
`module/collection.js`, `src/compile/emit.js` (5 self-use-only functions);
43 unused named imports across those same held files, largest
concentration `src/compile/index.js` (23 unused names from `ir.js` alone).

**Explicitly reviewed and left alone**: `scripts/refactor-oracle.mjs`
itself (the gate this whole sweep depends on: excluded on outsized-risk
grounds, not investigated); `scripts/self.js`'s `REGION_HOOKS_ACTIVE`
(looks like a normal export-drop candidate but ISN'T: two files
literal-string-match the exact substring `export const
REGION_HOOKS_ACTIVE = <bool>` in self.js's own source text; dropping the
keyword would silently break both: the "a name referenced only from
template/source text is LIVE" case, a different string-matching consumer
than the WAT-string case); the `src/abi/*.js` carrier family (named-vs-
default-export redundancy the barrel detector doesn't fully model, judged
too risky for the value); the `scanFlatObjects`/`scanSliceViews`/
`scanNeverGrown` trio in `analyze-scans.js` (zero current callers,
superseded by the fused `scanObjectArrayFacts`, but the file says outright
"they stay exported for any other caller / direct test coverage" -
deliberate kept-dormant API, left alone on the author's explicit word);
`index.js`/`interop.js` (package entry points, public API surface external
npm users depend on, invisible to this repo's own import graph).

**Scope note**: main advanced mid-sweep (13 in-scope files touched
elsewhere); `git merge` was blocked by the session's own permission
classifier: this branch stayed based on its original commit, none of
its 37 commits touch any of those 13 files, so a future merge/rebase is
conflict-free. Every candidate whose liveness could plausibly depend on
those 13 files' new content was re-verified by reading main's actual
current content directly, not the stale pre-merge snapshot.

**Gate**: every commit individually `refactor-oracle.mjs check --ref
<base>` clean (560 rows). No registration order, manifest order, or
Map/Set iteration order was touched by any change in this sweep: each
change is either a whole unreached file, a function/const with zero
readers, or an `export` keyword removed from a binding whose only readers
are in the same file (removing `export` cannot change iteration order).

---

## Typedarray `every()` combinator + the six vectorize load/store validators

Closes the two remaining items from the M1b follow-up list ("Follow-ups
queued for a later batch", above) and `.work/archive/pipeline-minimality.md`'s
batch-2 items (b) and (c). Branch `refactor/vec-combinators`, worktree off
`b4e36f0f`. `hasWrite`/`hasSameRead` in `module/typedarray.js` were already
closed by slice M1c (`025e2a7a`, converted onto `some()`'s new `boundary`
option) — only `safeRmwAst` (an every-predicate, no dual combinator existed)
and the six validator ports remained open.

**`every()`** (`src/ast.js`, next to `some()`): same contract, dualized —
`pred` sees every array node before a `boundary` node's children are
pruned; a non-array node is vacuously true (nothing left to disprove) where
`some()`'s is vacuously false. `safeRmwAst` (`module/typedarray.js`, the
checked-typedarray RMW-fusion guard in `.typed:[]=`) rewritten on top of
it: the `()`-call special case (only a `math.imul`/`Math.imul` callee's
FIRST argument is ever safe to fuse; the callee itself and any further
argument are never inspected) is expressed as a `boundary` so `every`'s own
child loop doesn't re-walk what the call arm already resolved. 1 site,
14 → 8 lines of logic (`+15/-16` incl. the new `isImulCallee` extraction
and doc comment). Byte-identical by construction (hand-verified node-by-
node against the original before landing, then oracle-confirmed).

**The six validator ports** (`.work/archive/pipeline-minimality.md`
batch-2's own words: "the six verbatim load/store validator ports across
vectorize map/stencil/reduce are one walker copied six times"): each of
`tryGeneralStencil` (`stencil.js`), `tryGeneralMap` (`map.js`), and
`tryGeneralReduce` (`reduce.js`) carried its own copy of a `matchOffset` +
`matchAddr` pair — a tee-CSE "`base + (IDX << K)`" address matcher, ported
verbatim from one to the next per their own header comments ("exactly like
tryStencil's own matchAddr (ported, not re-derived — same soundness
argument)", map.js; "identical contract to tryReduceReassoc's own
scanExpr, generalized ONLY in the address proof", reduce.js). Diffing all
three confirmed the six functions are CODE-IDENTICAL (not merely similar):
`matchOffset` byte-for-byte across all three including the byte-lane
fallback clause (tryGeneralMap's own addition — "needed here for the first
time because tryStencil never reached i8 lanes at all" — ported on to the
other two from there); `matchAddr` identical modulo one cosmetic default-
parameter presence (`reduce`'s omits `= stride` because its caller, unlike
the other two, never invokes it without an explicit stride — dead
either way). `isInvBase` (`(b) => global.get or a local.get never in
writes`), inlined into each `matchAddr`, was also identical across all
three and had no other call site in any of the three functions.

Unified onto two new exports in `addr-model.js` (already this family's
shared home — `isI32Const`/`isLocalGet`/`matchLaneAddr`/`matchLaneOffset`
all live there and all three files already import from it):
`matchStrideOffset(off, expectStride, offTees, ivCoeff)` and
`matchStrideAddr(addr, expectStride, writes, offTees, addrTees, ivCoeff)`
(`isInvariantBase` folded in as a private helper — no external caller).
`ivCoeff` deliberately stays a per-recognizer callback, NOT unified:
`tryGeneralStencil`'s own carries the toroidal wrap-select and float-
domain grid-index arms (needed for periodic-boundary stencils and 2-D row-
base loops) that the plain map/reduce recognizers never need — see the
"port, don't share" design note directly above `tryGeneralStencil` in
`stencil.js`, which explains that duplication there is deliberate
(insulating each recognizer's own gated corpus from a future change to a
sibling's acceptance criteria). Unifying only the mechanical tee-chasing
shape — which has no acceptance criteria of its own — respects that intent
instead of overriding it; each of the six call sites becomes a 1-2 line
wrapper closing over its own `writes`/`offTees`/`addrTees`/`ivCoeff`, so
every call site elsewhere in each function (load path, store path, the
`local.tee` offset-record path, and — `tryGeneralStencil` only — the
later alias-versioning section) needed no change at all.

**`tryStencil`'s own original** (the ancestor these three ported their
SHAPE from) is untouched on purpose: it predates the byte-lane fallback
clause (an f64/f32-only recognizer that hard-declines every other lane
never reaches stride 1), so it is not one of "the six" the campaign names
and folding it in would mean either giving it a dead unreachable branch it
never had, or adding a flag back to the shared functions for a single
caller — both worse than leaving one 3-line-smaller original in place.

**Battery** (worktree `b4e36f0f`, HEAD `9f7b4f2f`): refactor oracle CLEAN
568/568 after each of the two commits individually (baseline `b4e36f0f`),
and again 568/568 at final HEAD; `kernel-parity.js` 3/3 (39 assertions)
after each; vectorizer-specific suites (`cond-vectorize.js`, `simd.js`
[242/242, 7205 assertions], `simd-intrinsics.js`, `slp.js`,
`unswitch-typed-param.js`) all green after the validator unification.
LOC: `+15/-16` typedarray.js, `+19/-0` ast.js, `+63/-0` addr-model.js (new
shared home), `+7/-29` map.js, `+6/-27` reduce.js, `+6/-25` stencil.js —
six ~10-22-line duplicated validators collapsed to six 1-2-line wrappers
over one ~35-line (plus doc comment) shared implementation.

**Kernel size**: `dist/jz.wasm` (jz's own compiler self-compiled — the
oracle's default corpus excludes this exact graph as too slow for a
per-slice gate) 14,116.4 kB at `b4e36f0f` → 14,113.0 kB at HEAD, a genuine
−3.4 kB self-compile reduction — expected and correct, not a divergence:
the kernel is jz's OWN compiler source compiled by itself, so deleting
net duplicate logic from that source (comments compile away; the six
collapsed validator bodies don't) legitimately shrinks it.
`scripts/bench-size.mjs --json` (the per-CASE compiled-output sizes this
kernel then produces for bench/example programs, a materially different
question from the kernel's own size) diffed `b4e36f0f` vs HEAD: 0 lines
differ, byte-identical — consistent with, and independently confirming,
the refactor oracle's own CLEAN result.

**Final battery** (HEAD `9f7b4f2f`, after both commits): `npm run build`
clean; `test/index.js` 3895 total, 3894 pass, 1 skip, 0 fail (29,286
assertions — matches `plan.md`'s recorded 3,894/3,895 baseline exactly);
`kernel-parity.js` 3/3 (39 assertions); `kernel-oracle.js` 15/15 (738
assertions); `pointers.js` 73/73 (132 assertions); `data.js` 210/210
(1171 assertions — the four open wrong-value families in `plan.md` are
pinned KNOWN-WRONG, not newly introduced, and this run doesn't touch
them); `invariants.js` 29/29 (169 assertions); `eager-stdlib-parity.js`
30/30 (68 assertions); `JZ_TEST_TARGET=jz.wasm test/index.js` (the
kernel-target leg) 3059 total, 3058 pass, 1 skip, 0 fail (15,181
assertions — matches `plan.md`'s recorded 3,058/3,059 baseline exactly).
Every leg 0 fail; every total matches its documented baseline count
exactly, so nothing in the surrounding suite moved either.

## `scanNumericFill` fold — declined

`.work/archive/walk-count-design.md` §5 item A2 ("fold `scanNumericFill`
into `walk`'s own dispatch", `analyzeBody`'s 6th named sub-pass, after A1
already fused three others into `scanObjectArrayFacts` — see
`.work/evidence.md`'s "Walk-count reduction — B1 + A1 landed" entry) was
attempted and declined, per the queue item's own precondition ("needs the
empirical check... run both old-and-new... THEN delete the separate
call"). No code changed for this item; declining IS the precondition
doing its job, not a formality skipped.

**Why it isn't a mechanical fold.** `scanNumericFill` (`analyze-scans.js`)
is a per-candidate recursive predicate, `numFillSafe(body, name,
isNumericRhs)`: default-deny, visits EVERY node including bare-string
leaves, and disqualifies `name` on any mention that isn't one of a fixed
set of recognized-safe shapes (the fill-write itself, a `.length` read, an
index read, a decl initializer). `walk` (`body-facts.js:521`, the pass
this would fold into) is a different kind of traversal: an op-dispatch
visitor that recurses only into ARRAY children (`if
(!Array.isArray(node)) return` at its own top) and has no generic bare-
string visiting at all — the closest it has, `markEscapeValue`, is called
at specific value-position sites for its OWN (different) escape-tracking
purpose, not everywhere `numFillSafe` needs it. Two concrete gaps found
while attempting the fold, not merely suspected:

1. **A bare-alias miss.** `let b = a` (aliasing a fill candidate `a`)
   is a `let`/`const` decl whose init is the bare string `'a'`. `walk`'s
   own decl handler calls `walk(rhs)` on it, which is a no-op for a
   non-array argument — this specific disqualifying shape has no path to
   get checked without adding a new value-position-visiting discipline
   `walk` doesn't have today, not just a new dispatch arm.
2. **A write-shape gap.** `numFillSafe`'s own fill-write rule matches
   `a[i] = val` (an `=` node whose LHS is a `[]` node) directly. `walk`
   has no branch for `op === '=' && Array.isArray(node[1])` at all — that
   shape currently falls through to `walk`'s generic bottom loop, which
   treats the `['[]', 'a', 'i']` LHS exactly like an ordinary read (its
   own `escapes`-tracking purpose doesn't distinguish read/write position
   for this shape). A correct fold needs this as a new, explicit branch,
   not a repurposing of something already there.

**Why the assert-gate wouldn't have been decisive here either**, unlike a
pure control-flow refactor (where a clean corpus diff is strong evidence):
`valTypes` (the overlay `isNumericRhs` reads) is populated by
`makeValTracker` (`analyze/trackers.js`), a POISON-based join — a name's
entry can read as `NUMBER` mid-walk and later be deleted (poisoned) by
conflicting evidence seen further down the SAME body. `scanNumericFill`'s
current placement (strictly after `walk(body)` completes) reads the fully-
settled join; an inline fold evaluating the same read mid-walk could see
an interim, not-yet-poisoned value — a genuine flow-sensitivity hazard,
not a hypothetical one, confirmed by reading `makeValTracker`'s actual
join logic. This shape (a fill-write followed LATER in the same body by
conflicting evidence for the same name) is a narrow, specific pattern a
real-world corpus (bench cases, gallery examples, kernel-parity's CORPUS,
the vectorize test files) has no particular reason to contain — so "zero
disagreements on the corpus" would fail to distinguish "correct" from
"the hazard shape never came up," unlike A1/A2's sibling slices where the
change is a pure reordering/fusion with no analogous latent-input-
dependence. Given `plan.md`'s own standing priority ("Wrong-value classes
outrank performance work"), shipping a fold whose corpus-clean result
wouldn't actually rule out a new wrong-value class — for a sub-1%-of-
compile-time site whose own measurement (`walk-count-design.md` §1.2)
shows it as one of the SMALLER contributors even within that 1% — is the
wrong trade.

**Not implemented, noted for whoever picks this up**: a strictly smaller
and safer optimization exists one level down — `scanNumericFill` already
calls the (cached) `scanBindingUses(body)` once, cheaply; the real
remaining cost is that `numFillSafe` re-walks the WHOLE body once per
candidate name (K candidates → K full-body walks). Generalizing
`numFillSafe` to accept a Set of candidate names and disqualify each
independently in ONE shared walk (the same K-scans-into-1 shape A1 used
for `scanFlatObjects`/`scanSliceViews`/`scanNeverGrown`) would cut the
K-way blowup without touching `walk` or `valTypes`'s flow-sensitivity at
all — safe by the same argument A1 was. This is NOT what A2 specifies
(it doesn't reduce `analyzeBody`'s named sub-pass count, 6 stays 6) and
was not implemented here on that basis: doing a smaller, different-shaped
optimization and reporting it as A2 would misrepresent what was asked.

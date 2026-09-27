# Fold ledger

Campaign: make the compiler smaller in concepts and cheaper to run with every
compiled byte, test and product metric equal or better. Branch `fold`, own worktree.

## Summary

Twenty-five folds (two partly reverted after the full suite caught them) and one codegen
fix landed on its own. No compiled byte changed: not in the corpus (oracle at six levels)
and not in any of the ~50,000 compiles the four test legs make. The fix changes only
programs of the shape it repairs.

Against main 673a38d7 (after merging it), every row measured side by side:

| metric | main 673a38d7 | fold 2e2d1e29 | Δ |
|---|---|---|---|
| dist/jz.js | 2,738,840 B | 2,717,989 B | −20,851 B (−0.76 %) |
| dist/jz.js gzip -9 | 756,441 B | 750,101 B | −6,340 B |
| dist/jz.wasm (self-compile) | 20,191,586 B | 20,025,631 B | −165,955 B (−0.82 %) |
| dist/interop.js | 37,927 B | 37,927 B | 0 |
| compiler source (src, module, jzify, index.js, vs 36553d6f) | 307 files | 305 files | 82 files changed, +205 −1,758 lines |
| oracle O0/O2/O3/size + O1/fast | | | CLEAN, 870 entries |
| default leg | 4848/4849 | 4849/4850 | 0 of 16,182 outputs changed |
| opt0 leg | 4643/4644 | 4645/4645 | 0 of 10,032 |
| opt3 leg | 4644/4644 | 4645/4645 | 0 of 9,878 |
| wasi leg | 4697/4697 | 4698/4698 | 0 of 14,584 |
| test:self, test:self:perf | | 79/79, 5/5 | |
| test:262 | pass 3195, neg-reject 4045, fail 0, skip 16418, xfail 2 | identical | |
| test:262:builtins | pass 880, fail 0, xfail 43, skip 8445 | identical | |
| lint:imports, audit:files | | clean | |
| compile time, watr / jessie (4 alternating runs, load ≈ 6) | 6515 / 1602 ms | 5847 / 1541 ms | −10.3 % / −3.8 %, faster in every paired round |
| allocation, watr / jessie (scavenges at a fixed 16 MB young generation) | 1,685–1,689 / 401–405 | 1,278–1,281 / 369–373 | −24 % / −8 % |
| peak RSS at a fixed young generation, watr / jessie | 801–816 / 443 MB | 708–797 / 406–433 MB | lower |

The failures on the main side are main's own: web-smoke reads assets/grid-life.js, which
e408a309 deleted (both sides fail it), and a wall-clock perf assertion ("spread concat
14.9 ms < 5 ms") hit under a load average above 100 (0 changed outputs there). The one
extra test on the fold side is the fix's regression test.

compile-budget's own row flagged watr at +11 % peak RSS once; with V8's default young-
generation sizing, identical code swings by up to 30 % between runs (822 and 1151 MB on
the same head), and the fixed-size measurement above removes that heuristic.

What went wrong and was caught: folds 14 and 15 were gated on the corpus oracle alone.
A full-suite census of every node reaching the compiler then showed that
test/summary-queries.js hands the parser's `'?'` to the summary (three failures from
f8e1f9f5 on) and that a sloppy-mode `let yield;` carries `['yield', null]` into the
compiler, which compiled one program differently. Both parts were restored (a382dc2b,
03d1adbe); the rest of each fold stands, checked against the census. Every later batch
ran the whole suite before merging.

Found beyond the folds: a miscompile at O2 and O3 where load CSE reused a typed-array read
across a template literal whose interpolated object's `toString` wrote it (the frame
census named the parser's template op; prepared templates are `strcat`). Fixed in
74822a57 with a regression test; all four legs pass and no other compile output changes.

Stopped here: the remaining candidates (dead template tokens in the summary, five copies
of the `for`/`while` loop set, unused `export` keywords) each save far under 1 KB and 50
lines. Test runs were capped at 15 GB total by a watchdog after a machine reboot; the
campaign's own peak was 7.1 GB.

## Baseline (d98a122f)

| metric | value |
|---|---|
| dist/jz.js | 2,732,874 B (gzip -9: 754,245 B) |
| dist/jz.wasm | 20,121,459 B |
| dist/interop.js | 37,927 B |
| build-dist wall | 88 s |
| oracle | 580 entries (145 specs × O0/O2/O3/size), 2 m 36 s, deterministic (second run CLEAN); watr specimen pinned (JZ_ORACLE_WATR → a copy of watr d09bd06) |
| compile budget (loaded machine, ±20 % noise) | jessie 3995 ms / 365 MB, watr 10474 ms / 524 MB |
| jz-own compile time (total minus watr's optimizer and encoder, min of 9, `.work/fold-time.mjs`) | jessie 590 ms, watr 2992 ms |
| supplementary oracle at O1 and 'fast' (watr off, `.work/fold-oracle-extra.mjs`) | 290 entries |
| `npm test` (default leg) | 4837 tests, 131,189 assertions, all pass; 38.7 min on the loaded machine, peak RSS 2.6 GB |
| widened oracle (`test/_hashes.mjs`), default leg | 16,144 compile keys |
| `npm run test:opt0` | 4632 tests, 104,423 assertions, all pass |
| `npm run test:opt3` | 4632 tests, 105,022 assertions, all pass |
| `npm run test:wasi` | 4685 tests, 119,325 assertions, all pass |
| `npm run test:262` | pass 3195, neg-reject 4045, neg-accept 0, fail 0, skip 16418, xfail 2 (4.5 min) |
| `npm run test:262:builtins` | pass 880, fail 0, xfail 43, skip 8445 (1.6 min) |

Where compile time goes (CPU profile, oracle corpus): watr's optimizer ~53 %;
jz's single hottest function is the vectorizer's `liveOutOf` scan (8.3 s of
219 s, computed eagerly for every block: quadratic), then `walkAst` (8.4 s),
interval-proof (7.2 s).

## Candidates

candidate | evidence | est. saving | files | status
---|---|---|---|---
ClosureEnvPlan: a pre-emission record of what `ctx.closure.make` derives again at emission | plan and emission derivation asserted equal under DBG_INVARIANTS; `id`/`bindingId` never read; oracle CLEAN with the plan deleted | 1 file, 2 ctx fields, a walk and a free-var scan per arrow; ~280 lines, ~2 KB dist | closure-plan.js, function.js, analyze-for-emit.js, closure-emit.js, call.js, ctx.js | folded
Vectorizer `liveOutOf` computed eagerly for every block | 8.3 s self time on the oracle corpus, 1.6 s of 3.8 s jz time on watr | ~10 % of jz compile time; not a concept | vectorize/index.js | done (cost)
DictKindIndex (dict-kind-index.js): `resolveDictKind` has no caller since d6a219ca moved parameter kinds to the summary | `git log -S 'resolveDictKind('`; oracle CLEAN at all six levels with it deleted | 539 lines, a whole-program walk, a ctx field | dict-kind-index.js, plan/index.js, freeze.js, phase-marks.js | folded
emitFunc re-applied the call-site parameter facts analyzeFuncForEmit had seeded into the FunctionPlan (its own comment: "duplicates that seeding"), and kept a ctx.schema.vars overlay no emission-time writer uses | knockout: oracle CLEAN at all six levels; only `maybeNullish` is seeded nowhere else, so it stays | ~65 lines | emit-func.js | folded
Functions with no caller outside their own body (`.work/fold-uncalled.mjs`, verified by grep over src, tests, scripts, bench, examples) | eleven found; the rest of the scan's hits were parse noise | ~110 lines | ten files | folded
`opts.profile.memory`: GC-forcing heap and table-size sampling around each phase; no test, script, CLI or bench sets it | grep over test, scripts, bench, examples | ~40 lines | index.js | folded
Phantom AST ops `for-in`/`for-of`/`for-await`/`do-while`: 38 checks across 23 files and `ctx.core.emit['for-in']` (module/collection.js, ~90 lines), none reachable (subscript's feature/loop.js emits `for`/`for await`/`do`; prepare lowers in/of heads; grep finds no constructor) | function coverage: the emitter never ran in tests or corpus | ~160 lines, ~3.7 KB dist | 23 files | folded
Destructuring patterns after prepare: summary `destructure` (+`entriesOf`), slot-write-hazards `patternTargets`, declare-written-keys `patternNames` | function coverage: none ran in the suite or corpus; a throwing probe in `destructure` never fired across 1005 destructuring-heavy tests; prepare's pushPatternAssign lowers every pattern | ~50 lines | 3 files | folded
infer.js evidence registry (`SOURCES`, `registerEvidence`, the merge in `inferParams`) holding one source since the method-evidence rungs retired | one `registerEvidence` call in the tree | ~30 lines | infer.js | folded
`__is_map`/`__is_set`/`__is_typed` emitters: nothing constructs these calls since instanceof became a node (8182e465); a user call to an undeclared `__is_map` is not valid JS | grep over jzify/prepare/src; function coverage: never ran | ~45 lines | 5 files | folded
Raw parser forms after prepare: grouping `['()', x]` and `'?'` ternaries checked by summary, kind, type, plan and emit code (prepare strips grouping and rewrites `'?'`; no compile-stage code builds either; arrow parameter wrappers never reach these walkers) | knocked out: oracle CLEAN | ~45 lines, 1 KB | 12 files | folded; `static.js`, `ast.js` keep theirs (they also run during prepare)
`var`/`function`/`yield`/`await` in compile-stage checks (38 sites, 18 files): jzify lowers each and prepare rejects a survivor; nothing after prepare builds them | oracle CLEAN | ~0.6 KB | 18 files | folded
State nobody reads (`srcPtrAux`, `elemWidth`, `schema._byKey`, `schema.errorClassesUsed`, `types.loopGuardLo` never written), constants nobody references (`bitEq`, `FINISH_SIGNIFICAND`, `AUTO_CFG_*`), a tuning key nobody sets (`valKindDominance`) | `.work/fold-ctxfields.mjs`, `.work/fold-unrefconst.mjs`, grep; `ctx.plans.start` stays (tests read it) | ~40 lines | 10 files | folded
Unused exports (knip): `intExprChecker`, `litBoundArrIdx`/`affineIdxOfIV`/`bodyAffineEnv` re-exports, `ENUM_SET`, `BINDING_USE_SELF`, `runsAccessor`, `seedSummaryShape` | `npm run audit:files` exports view | small | type.js, int-certain.js, … | below threshold: an `export` keyword on a function the file itself uses is not a concept
Barrels (`narrow.js`, `analyze.js`, `representation-plan.js`, `program-facts.js`, `emit.js`, `ir.js`, `optimize/index.js`, `wat/assemble.js`, `kind.js`, `type.js`): re-export-only files kept so imports survived splits | 0 own exports each, ~500 lines | 10 files; touches most importers | many | rejected: the large ones are import boundaries (ir.js 101 importers, kind.js 59, representation-plan.js 33, type.js 31); dissolving one moves its imports without removing a concept
Grouping parens after prepare: 20 post-prepare `op === '()' && n.length === 2` arms | prepare's `'()'` handler returns `prep(callee)` for a grouping | ~20 lines, one concept | summary, interval-proof, inline, … | folded (fold 14)
`LEVEL_PRESETS[3]` and `.speed` are the same literal twice | config.js | 1 line | config.js | folded with the row above

Statement and literal forms prepare removes: `switch`/`case`/`default` (rejected in strict mode, lowered by jzify), `try` (becomes `catch`/`finally`), `do` (becomes a flag-guarded `while`), the parser's array literal `['[]', x]` (becomes `['[', …]`), for-of/for-in heads (lowered to index loops), templates (become `strcat`) | prepare's handlers; a probe at compile entry never saw them; each function edited checked for prepare-time callers (`observeNodeFacts`, `recordGlobalRep`, `findFreeVars`/`findMutations` run during prepare and keep theirs) | ~100 lines, ~1.5 KB | many | folds 19, 21–23; template checks feed the codegen fix below
`JZ_DEBUG_INVARIANTS` assertions (`assertBodyModelSound`, `assertRepresentationPlan`, `verifyFn`, `assertLoopPlanAgrees`, `assertValKindConsistent`, `assertRepFields`, `summaryInputs`; 57 sites) | never run by the suite (no test sets the variable) | ~6 KB source, 0 dist (the release build bakes the flag false) | 23 files | rejected: a supported debug mode; test/self-compile-source.js asserts the debug build keeps more than 20 uses
`optimize.inlinePureFns` (inline-pure.js `inlinePureFnsInFn`, optimize-module.js) | never ran in the suite or corpus: test/simd.js sets the option, but plan-level inlining removes its helper first; a single-call helper outside a loop reaches it and the output is unchanged | ~120 lines | 2 files | kept: the owner's recorded decision ("kept as the architectural home for semantic inlining … until a real case pays"); pin candidate

## Folds

fold | concept | Δsrc lines | Δdist bytes | Δcompile time, RSS | commit
---|---|---|---|---|---
1 | ClosureEnvPlan, a second derivation of a closure's captures | −279 | −1,948 | noise (loaded machine) | 9d5d53d4
2 | (cost) vectorizer live-out scan runs only when a recognizer asks | +3 | +41 | jz time on watr −30 % (2992 → 2092 ms), jessie ±0 | 022ef049
3 | DictKindIndex, a whole-program per-key kind index nothing has read since the summary took over its one consumer (d6a219ca) | −561 | −6,822 | one whole-program walk less (4 ms on watr) | a28aa172
4 | emission-time re-seeding of parameter facts the FunctionPlan already carries from analysis, and the empty schema-binding overlay it once needed | −64 | −828 | one per-parameter pass less per function | 18dcf984
5 | functions nothing calls (`containsEffect`, `dictValueKindSet`, `mapValueKindSet`, `localOf`, `callFree`, `literalOf`, `hasLoopJump`, `retargetLoopJumps`, `hashCapFor`, `linearIndexOf`, `intExprChecker`) and type.js re-exports nothing imports | −111 | −12 (esbuild already dropped them) | — | 7a26016a
6 | the compile profiler's `profile.memory` sampling mode, set by no caller (its own comment: "Never set by any real caller") | −39 | −590 | — | 40e43f8b
7 | the phantom loop ops `for-in`, `for-of`, `for-await`, `do-while`: the parser emits `for`/`for await` with an `in`/`of` head and `do`, prepare lowers the heads, and nothing synthesizes the hyphenated ops; 38 checks for them and the unreachable `for-in` emitter go | −137 | −3,726 | — | 7ebcaf07
8 | destructuring patterns in compile passes: prepare lowers every declaration and assignment pattern (pushPatternAssign), so the summary's `destructure`, the slot-hazard `patternTargets` and the written-keys `patternNames` never run | −48 | −1,099 | — | d323b3b2
9 | state, constants and a knob nothing reads: `srcPtrAux`, `elemWidth`, `ctx.schema._byKey`, `ctx.schema.errorClassesUsed`, the never-written `ctx.types.loopGuardLo`, `bitEq`, `FINISH_SIGNIFICAND`, the removed auto-tuner's `AUTO_CFG_*`, the `valKindDominance` tuning key; `3` and `speed` share one preset | −36 | −445 | — | 09e8929a
10 | the inference evidence registry: a sources list, a register call and a first-wins merge around the one evidence source left (`notStringEvidence`) | −27 | −187 | — | c137ffff
11 | the `__is_map`/`__is_set`/`__is_typed` predicate emitters jzify synthesized for `instanceof` before 8182e465 made it a real node, with their autoload, kind-trait and refinement entries | −44 | −785 | — | e096db89
12 | index.js comments describing code that moved away (the U+E000 guard now in front.js, a watr-tail re-export that no longer exists), the removed auto-tuner's history, and a second copy of the no-post-watr-optimizer note | −25 | 0 | — | 59d7f5a6
13 | ctx.js comments naming fields' former homes, the deleted `varsBarred`, and an orphaned half-sentence about a `slotFacts` table that no longer exists | −8 | 0 | — | 555d22ab
14 | raw parser forms after prepare: grouping parens `['()', x]` (prepare's `'()'` handler returns `prep(callee)`) and the `'?'` ternary (prepare rewrites it to `'?:'`), handled in 20 places across the summary, kinds, interval proof and plan | −42 | −924 | — | f8e1f9f5; summary part reverted in the next commit (test/summary-queries.js hands raw `'?'` nodes to `summarize`)
15 | `var`, `function`, `yield` and `await` checks in compile-stage code: jzify lowers them and prepare rejects any survivor (op-policy.js REJECT_OPS) | −2 (37 checks narrowed) | −570 | — | b1820926; the `yield`/`await` part reverted in the next commit (a sloppy-mode `let yield;` reaches the compiler)
16 | raw unary `-x`/`+x` checks after prepare, which rewrites them to `u-`/`u+` (the normalized arms beside them stay) | −3 | −149 | — | 6fb408ca
17 | helpers whose last callers earlier folds deleted: `pureIntLiteral` (only `linearIndexOf`, fold 5, called it) and `containerValueKindSet` (only `dictValueKindSet`/`mapValueKindSet`, fold 5) | −20 | 0 (esbuild already dropped them) | — | 0963bce8
18 | local copies of the shared name scans: two `mentions` (func-entry.js, struct-inline.js) and `referencesAny` (const-fold.js) equal to ast.js `refsName`/`refsAny` under an existing option record, three `readsName` (outer-strip.js), `containsName` (unswitch.js) and `readsLocal` (recurse.js) equal to outer-scaffold.js `readsVar`; copies that differ (op-position scans, literal skips, function boundaries) stay | −45 | −1,035 | — | 866ff63d
19 | `switch` after prepare: jzify lowers every switch in default mode and prepare's `'switch'` handler rejects one in strict mode, so the `switch` emitter, interval-proof's switch frame (its frame `kind` field and three `kind === 'loop'` tests with it), the summary's `switch`/`case`/`default` arms and 11 op checks never ran | −28 | −855 | — | 2e33e2fa
20 | val-types' conditional-position flag: `walk(node, cond)` threads `cond` through if/?:/&&/\|\|/??/loop/try arms, but its one reader (the bigint param-write rule) went in 76e235fd; every arm now walks what the plain loop walks | −13 | −241 | — | 2f433206
21 | `try` after prepare: prepare's `'try'` handler returns `catch`/`finally` nodes, so 11 checks for the parser's `try` beside them never matched. Where `try` stood without `catch`/`finally` (collectStepRange, load-CSE CONTROL, written-keys OBSERVES) the prepared nodes are handled soundly as they are: step bounds sum every write, CSE tables are per statement list (probes against Node agree), and a throw past a store leaves only an unreachable literal | −1 | −91 | — | 99599a7d
22 | `do` after prepare: prepare's `'do'` handler (and jzify in default mode) rewrites do/while into a flag-guarded `while`, so the 26 checks for `do` in compile-stage code, interval-proof's `do` frame and the summary's `do` arm never ran. walk-facts' `TEST_SLOTS` and ast.js's jzify tables keep theirs: `observeNodeFacts` and jzify see raw ASTs | −6 | −410 | — | f29dd8a9
23 | the parser's array literal `['[]', x]` after prepare, which returns `['[', …]` for a literal and a three-element `['[]', obj, key]` for an access: dropped beside the prepared form in isEmptyArrayLit, freshArrayInit, isFreshArrayCtor (whose prepared empty literal staticArrayElems already covers) and looksNonNumeric. typedStaticLen keeps its: recordGlobalRep runs it during prepare | −3 | −116 | — | 7c5315ef
24 | for-of/for-in heads after prepare, which lowers both into a classic index `for` (its `'for'` handler): frame-effects' head-binding notes, its iterator-record allocation and the loop filter's head exclusion never matched | −6 | −345 | — | 31ccfb45
25 | the bare-block op `{`: subscript parses every block as `{}` and nothing builds `{`, so prepare's `'{'` handler, `OP_MODULES['{']` and four compile-stage checks never ran | −10 | −137 | — | this commit

## Validation runs (default leg, widened oracle against the baseline)

Every run compares each compile's output hash for identical source and options.
Keys that differ only in source are expected: fixtures embedding the worktree's
absolute path, `scripts/phase-marks.js` (edited by fold 3), and
test/allocation.js, which compiles `firstRefKind.toString()` (edited by fold 7).

| through | tests | changed outputs | note |
|---|---|---|---|
| a28aa172 (folds 1–3) | 4837/4837 | 0 | |
| 40e43f8b (folds 4–6) | 4837/4837 | 0 | |
| d323b3b2 (folds 7–8) | 4836/4837 | 0 | `clearInterval: stops interval` (statements.js) counted 2 ticks of 3 under machine load: wall-clock timers, passes on rerun |

Merge with main (9b983689, folds 1–13 on main 36553d6f) against main's own tip, every leg run
side by side on the same machine; keys differing only in source are the expected ones above:

| leg | main 36553d6f | 9b983689 | changed outputs |
|---|---|---|---|
| default | 4840/4840, 1601 s | 4840/4840, 1578 s | 0 of 16,153 |
| opt0 | 4635/4635, 400 s | 4635/4635, 394 s | 0 of 10,016 |
| opt3 | 4635/4635, 4142 s | 4635/4635, 4134 s | 0 of 9,860 |
| wasi | 4688/4688, 2023 s | 4688/4688, 2010 s | 0 of 14,555 |

Fold head 5c4b4f01 (folds 14–25 and the two restorations) against main 36553d6f, same way:
oracle CLEAN (870); default 4840/4840 both, 0 of 16,153 changed; opt0 4635/4635, 0 of
10,016; opt3 4635/4635, 0 of 9,860; wasi 4688/4688, 0 of 14,555; test:self 79/79,
test:self:perf 5/5; test:262 and builtins identical; dist jz.js 2,733,405 → 2,712,541 B,
jz.wasm 20,124,950 → 19,959,008 B.

The codegen fix (74822a57) against 5c4b4f01: default 4841/4841, opt0 4636/4636, opt3
4636/4636, wasi 4689/4689; 0 changed outputs in every leg, the new keys are its test's.

Merged with main 673a38d7 (2e2d1e29): the Summary table above.

## Codegen candidates (output changes; logged, not landed)

- `plan/lanes.js` PURE_OPS lists the raw `'?'` ternary, which never exists after prepare, but not `'?:'`: a record-lane function whose body has a ternary is treated as impure. Adding `'?:'` would widen lane records.

- `compile/analyze/frame-effects.js:530` and `summary/query.js:272` recognize a literal element key by the parser's `[null, 'k']` form, but after prepare a literal key is `['str', 'k']` (prepare's `'[]'` handler). The frame-effects arm therefore never resolves an accessor setter for `o['k'] = v`: a possible soundness gap in the census that gates arena rewind and load CSE. Not a fold: fixing it changes output.

- `compile/analyze/frame-effects.js` names the parser's template op `` ` `` in CONVERTING_OPS and in walkExpr's allocation test, but prepare turns every template into `strcat` (or a folded string), so neither fires: a template's ToPrimitive call and its allocation are invisible to the frame census. Miscompile, O2 and O3 (O0/O1 correct): `a[0] = 1; const x = a[0]; const s = `${o}`; const y = a[0]; return x * 100 + y + s.length` with `o.toString()` writing `a[0] = 42` returns 102, Node 143 (the stale load is reused); the same program with `'' + o` returns 143. Fix: `strcat` where `` ` `` is (and in plan/scope.js `looksNonNumeric`, which also names only `` ` ``; no repro there). Output change: load CSE and arena rewind see the conversion and allocation. **Landed** as its own commit after the fold batch: `strcat` in CONVERTING_OPS, the allocation test and looksNonNumeric, with a regression test in test/to-primitive.js; the oracle is CLEAN at all six levels (so the bench gates measure byte-identical binaries) and the default leg changes none of 16,153 compile outputs; only the new test's programs differ.

- `compile/plan/advise.js` `isHeapAlloc` counts the parser's array literal `['[]', x]`, which prepare turns into `['[', …]`, so the heap-growth advisory never counts an array literal. Fix changes warnings.

- Names for ops that no prepared tree carries (op census below): `compile/array-view.js` skips `'regex'` (a regex literal is `'//'`), `compile/param-numeric.js` treats `'template'` as a string literal (a template is `strcat`). Each test never matches; replacing the name changes output.

- `new` with an expression constructor (`new (c ? A : B)(n)`) keeps prepare's `['new', ctor, …]` fallback when jzify does not run (strict mode) and fails at emit with "Unknown op: new". Its 19 compile-stage checks only run on programs that end in that error; a prepare-time rejection would give it a proper message (error text change).

Op census (full default leg, f29dd8a9): every node reaching compile entry, by op and arity, 88 ops. Absent: `switch`, `try`, `do`, `{`, `new`, `` ` ``, `of`, the parser's `['[]', x]`, raw unary `-`/`+`, `var`, `function`, `await`. Present though prepare "removes" it: one `['yield', null]` (sloppy `let yield;`, test/parser-bugs.js), and 6,117 `['()', x]`, all of them arrow parameter lists in ten sampled files.

## Rejections and owner decisions

candidate | evidence | reason
---|---|---
The summary's raw `'?'` and grouping arms (fold 14's summary part) | the census run and a bisect over the fold commits: test/summary-queries.js fails 3 of 42 from f8e1f9f5 on | the white-box tests build ASTs with the parser's `'?'` ternary and hand them to `summarize` and its queries, so for the summary the raw form is part of what tests assert; restored
`yield`/`await` checks in compile-stage code (fold 15's `yield`/`await` part: callback purity, frame-effects arena safety, SIDE_EFFECT_OPS, inplace-store, return carriers, written-keys OBSERVES, the summary's `await` arm) | the census saw one `['yield', null]` reach the compiler: sloppy-mode `let yield;` (test/parser-bugs.js) keeps the parser's binding node; `let yield; const o = { a: n }; o.b = 2; return Object.keys(o).length` compiled differently at O2, O3, size and speed with the checks gone (both return 2) | not every valid program is byte-identical; restored. The `var`/`function` part stays: reserved words, never a binding name
`synthesizeComputedDispatchCallSites` + `synthesizeMemberDispatchCallSites` (walk-facts.js, ~210 lines) | oracle knockout: 0 diffs at every level, watr included | a test-suite knockout changes 7 outputs (HANDLER dispatch tables, `i32.parse`/`i64.parse` member calls; one becomes a compile error): load-bearing where the corpus has no instance
Other corpus-inert passes and sweeps (`bindNestedRowLengths`, `laneRecordParams`, `scalarize*`, `promoteIntArrayLiterals`, `materializeAutoBoxSchemas`, `refineDynKeys`, `foldStaticConstAggregates`, `inplaceStore`, `maskedSuffixGuard`, `jsstring`, `hoistConstLit`, `tryGeneralStencil`, `tryGeneralReduce`) | oracle knockouts: 0 diffs; function coverage: their code runs in the suite | each has its own tests pinning the shape it produces; a corpus with no instance is not evidence of subsumption
`link/fold` (optimize/fold.js) | 0 diffs at O0/O2/O3/size | 7 diffs at O1 and 'fast', where watr does not run after it
Legacy option spellings (`optimize.experimental*`, top-level `stencil`/`outerStrip`/`toneMap`, `profile.names`) | aliases for renamed options | test/simd.js, test/examples.js and test/perf.js assert they still work: removing them changes what tests assert
`ctx.plans.start` | written, never read by src | test/invariants.js and test/session-reentrancy.js read it

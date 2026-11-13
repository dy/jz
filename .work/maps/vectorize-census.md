Scout report (Sonnet 5.5, 2026-11-12), tree `d50ccbfbf`, read-only. Leads, not facts: V = the
scout read the line or measured it, I = inferred. The nine programs of `vectorize-leads.md` were
run again by the integrator on `d50ccbfbf` and on the published `v1.0.2`: all nine differ from
Node on both. The scripts the text names (`leads-minimal.mjs`, `ablate.mjs`, the raw rows and
tables) were session scratch and are not in the repo.

# B. Ablation: what each recognizer holds (measured)

## Method (V)

- Instrumentation: `instrumentation.patch` (a diff of `src/optimize/vectorize/index.js`, uncommitted in the worktree). The 13-way `??` chain and the 5-way retry chain are arrays of `[name, thunk]`; `JZ_VEC_SKIP=a,b` does not call the named recognizers (a bare name also skips its retry call, `retry:name` only the retry one; `canonicalizeCounters`, `tryPrefilter`, `tryPairIterations`, `tryStrengthReduceIV`, `slpPairsIn`, `hoistReductionInvariantsIn` are skippable too); `JZ_VEC_ORDER=generalFirst` puts tryGeneralMap, tryGeneralStencil, tryGeneralReduce directly after tryMemCopyFill (tryDivergentEscapeVectorize stays first: the brief says "after tryMemCopyFill" but it sits before it in the chain; I kept it where it is); `JZ_VEC_WHY=1` turns why-not on. One row per block that matches a scaffold (`bl || op`): unit, function, block label, ordinal, chain taker, retry taker, gateStrips-rejected taker, prefilter, pair-iterations, deferred strength-reduce, why-not reason (the last one a recognizer set).
- Behavior check (V): uninstrumented `d50ccbfbf` against the instrumented tree, no skip, why-not on: SHA-1 of the wasm bytes of every unit, **423 of 423 equal at `'speed'` and 423 of 423 equal at level 2** (`raw/orig-*.jsonl` against `raw/base-*.jsonl`; tables begin with this line). Each unit is compiled in a fresh node process (`child.mjs`, `run.mjs`), so no compile state is shared.
- Settings: level 2 (default) and `'speed'`. `'speed'` is the same preset object as level 3 (config.js:199); flags per level in `flags.txt` and map.md section 0. The bench builds at `{level:'speed'}` (bench/_lib/compile.js via compileJzAt; `compileJzHost`, bench.mjs:710), the examples at `optimize:'speed'` (examples/build.mjs:11); both settings are run on the whole corpus.
- Corpus (`corpus.mjs`): 423 units = 105 bench cases (every `bench/<id>/<id>.js`, single-file and module-graph, via `compileJzAt`), 83 example kernels (`examples.js` names and kernels, `rfft`, `zzfx`, each `jukebox` beat, each `rfft` tune, `resolveModuleGraph` + compile as examples/build.mjs does), 200 perf-corpus programs (the spelling gate's 10 categories x 2 seeds x 10 loop styles), 35 hand-kernel spellings of test/spellings.js. NOT run: bench case `jz` (the self-compile; a single compile of the compiler is on the order of 20 minutes, AGENTS.md, 40 runs were not affordable), `examples/threejs-math` (needs the vendored three.js tree its build script writes; `bench/three*` cover three.js). 4,484 loops with a matched scaffold at `'speed'`, 4,343 at level 2.
- Runs (each over the units where the skipped step took a loop at baseline, and where it did not, bytes are unchanged by construction; for `general-only` and `general-first`, every unit with a chain or retry lift): the 13 recognizers one at a time, `canonicalizeCounters`, `tryPrefilter`, `tryPairIterations`, `tryStrengthReduceIV`, `slpPairsIn`, `hoistReductionInvariantsIn`, `general-only` (skip all chain recognizers but tryMemCopyFill, tryGeneralMap, tryGeneralStencil, tryGeneralReduce), `general-first`. Driver `ablate.mjs`, tables `analyze.mjs`, raw rows `raw/*.jsonl` (one line per unit, with its loop rows) and `tables/*.json`.
- "Taker" of a loop = chain taker, else `retry:` taker, else prefilter, else pair-iterations; `(scalar strength-reduce)` and `(none)` are not SIMD. "Lost the lift" = the loop's status after the skip is not a SIMD one. A loop moving to the same-looking code (tryStencil to tryGeneralMap) is "taken by another" whether or not the bytes change; the per-unit byte tables show where they do.
- Caveat on "loops with a matched scaffold nothing took": `why` is filled only when a lifter reached a `liftFail`; most unlifted loops fail earlier (scaffold, bound, address form) and carry `(no reason recorded)`: 3,178 of 3,895 at `'speed'`. The table by reason is therefore a table of late failures only.

## Headline numbers (V, from the tables below)

`'speed'`: 589 loops are lifted (chain and retry 581, 4 of them retries; prefilter 5; pair-iterations 3). Skipping a recognizer alone, **341 of those 589 have no other taker** (tryVectorize 156, tryStencil 118, tryGeneralMap 11, tryReduce 11, tryOuterStripRest 10, tryRampMap 10, tryChannelReduce 8, tryToneMap 5, tryPrefilter 5, tryPairIterations 3, tryGatherMap 2, tryGeneralStencil 1, tryMemCopyFill 1). tryDivergentEscapeVectorize's 5 loops go to tryPairIterations (a different lift: 2 pixels side by side, not a SIMD strip; bytes change in all 5 units). tryGeneralReduce takes 0 loops at baseline but takes 41 of tryReduce's 52 when tryReduce is gone. tryMemCopyFill's 53: tryVectorize takes 45, tryGeneralMap 4, tryStencil 2, retry:tryGeneralMap 1, 1 is lost; bytes change in 37 of 37 units (mostly +66 to +94 bytes, dithering +10,597, biquad +756; a few shrink). tryStencil's 181: tryGeneralMap takes 60, tryGeneralStencil 3, 118 lost. tryVectorize's 239: tryGeneralMap 53, tryRampMap 19, tryToneMap 11, 156 lost.
Level 2: 425 lifted, 207 with no other taker (tryVectorize 103, tryStencil 40, GeneralMap 11, Reduce 9, OuterStrip 7, Ramp 10, ChannelReduce 8, DivergentEscape 5, ToneMap 5, Prefilter 5, GatherMap 2, MemCopy 1, GeneralStencil 1); at level 2 divergent-escape's 5 loops are lost (pair-iterations is off at level 2).
`general-only` at `'speed'` (177 units): of 587 lifted loops, taker unchanged 75, another recognizer 162, **lift lost 350 (60%)**. At level 2 (175 units): 73 unchanged, 139 moved, **211 lost**. The 350 lost: tryStencil 118, tryVectorize 185, tryOuterStripRest 10, tryRampMap 10, tryReduce 10, tryChannelReduce 8, tryToneMap 5, tryGatherMap 2 (rows of Table 3).
`general-first` at `'speed'`: **157 loops change taker, none lost, and only 3 units change bytes** (fftplan, same size, different code; stdlib-ddot +20; matmul +5). At level 2 the same 3 units (-21, -5, same size).

# C. The spelling gate (`test/spellings.js`)

## How it measures (V, read)

- Programs: every perf-corpus program (`scripts/perf-corpus.mjs`: 10 categories x 2 seeds x 10 loop styles = 200 programs) and three hand kernels (`dot`, `map`, `ring`: 16 + 12 + 7 = 35 spellings), each at level 2 and at `'speed'` = 470 cells (`spell-cells.mjs`, V; the `cells()` formula, test/spellings.js:150-154).
- A cell is one spelling of one program at one level. Per program: (a) every spelling answers what the default spelling and Node answer (test/spellings.js:112-143 `sweep`); (b) `simd` = some spelling's entry function (`$f`, or `$run` for the hand kernels, and its `$f$...` kind variants) contains an op matching `/"(v128|[if](8x16|16x8|32x4|64x2))\./` (test/spellings.js:34, 112-115). Among spellings with the same SIMD status as the best, the fewest loop-body ops are compared (`loopBodyOps`, test/_loop-ops.js:19); a spelling whose SIMD status differs from the best's is `{simd: 'lost'}`, one with more ops is `{ops: n}` (test/spellings.js:142-145).
- Table: `test/spellings.json` lists every gap; the test fails on any difference, smaller gaps included (test/spellings.js:23-26).

## Present counts (V, measured)

- Run: `node test/index.js spellings` from the worktree (output `spellings-run.txt`): `# total 28 (64 assertions)`, `# pass 28`, zero failures. So the listing equals what the compiler does now.
- Cells: 470. Listed gaps: 76 (`spell-count.mjs`): 71 `{ops: n}`, 5 `{simd: 'lost'}`. By program: fgather 28, kernel/dot 14, kernel/map 22, kernel/ring 12. No other corpus category has a gap.
- The gate is blind where NO spelling vectorizes (it compares against the best spelling's status): the 10 corpus categories whose best spelling has no SIMD cannot show a lost cell.

## Cells where the best spelling has v128 in the entry function and this spelling has none (V: spellings.json; 5 cells, 2 spellings)

| spelling | program | levels | cells |
|---|---|---|---|
| `reverse i--` (`for (let i = N - 1; i >= 0; i--)`) | kernel/dot | 2, speed | `kernel/dot/reverse i--/2`, `.../speed` |
| `reverse i--` | kernel/map | 2, speed | `kernel/map/reverse i--/2`, `.../speed` |
| `two counters i,k` (`for (let i = 0, k = 0; i < N; i++, k++) s += a[i] * b[k]`) | kernel/dot | speed only | `kernel/dot/two counters i,k/speed` |

## Which check rejects each (V unless marked)

Method: compile the cell with the census instrumentation (`spell-why.mjs`, `spell-dump.mjs`): the instrumented `index.js` records a row for every block that matches a scaffold; a block that matches none leaves no row. All three cells leave no row for `$run`.

1. `reverse i--`, both kernels, both levels. The vectorizer's input IR (`spell-dump.mjs map "reverse i--" 2`) is
   `(br_if $brk0 (i32.eqz (i32.ge_s (local.get $if3_0) (i32.const 0))))` ... `(local.set $if3_0 (i32.sub (local.get $if3_0) (i32.const 1)))`.
   - Exit test: `matchExitBrIf` accepts only `i32.eqz (i32.lt_s|lt_u iv bound)` (addr-model.js:41; `cmp[0] !== 'i32.lt_s' && cmp[0] !== 'i32.lt_u'` returns null), and scaffold.js:316-317 (`if (!exitInfo || exitInfo.ind !== incVar) return null`) turns that null into `bl = null`.
   - Step: `matchIncN` needs `i32.add` with a constant (addr-model.js:26) and the scaffold needs `c === 1` (scaffold.js:302-303), then `if (!incVar) return null` (scaffold.js:314). `i - 1` is `i32.sub`, so it fails first at step.
   - `matchOuterPixelLoop` (`op`) does not match either (needs a pixel IV run of `+1`, outer-scaffold.js:79-86, 97-106). So no recognizer is called. Note for the plan: this is a scaffold gap, not a recognizer gap: all 13 recognizers are blind to a descending counter, and so is `canonicalizeCounters` (which needs `ivRun`, scaffold.js:274-299, a step of exactly +1 on the exit counter, :288).
2. `two counters i,k` at `'speed'`. IR at the vectorizer (`spell-dump.mjs dot "two counters i,k" speed`): the loop is already unrolled by two, `i += 2` with the body copied and a guarded remainder (`$if2_1int4` steps by `(i32.const 2)`, bound `(i32.const 1023)`, then `(if (i32.lt_s i 1024) (then <one more body>))`). The scaffold's step check fails: scaffold.js:302-303 (`inc1?.c === 1`) and :314. I (not read): the unrolling is `unrollScalarChains` (src/compile/loop-recurrence.js:333, called src/compile/analyze-for-emit.js:110 under `unrollScalarChain`, a level-3-only flag, config.js:66 against L2_PRESET's `false` at :67); its predicate evidently lets the two-counter loop through but not the one-counter canonical spelling, which is vectorized at the same level. At level 2 the same program is lifted: `{"taker":null,"retry":"tryReduce"}` (`spell-why.mjs` output; the counter rewrite `canonicalizeCounters` makes `k` a function of `i`, counter-run.js:55-139, and `tryReduce` takes the rewritten loop, index.js:313-318).

## What the gate says about the 71 `{ops: n}` cells (V: spellings.json; reasons not run down)

The `ops` gaps are in `fgather` (28 cells, 15 ops each in the listing, all styles), `kernel/dot` (11), `kernel/map` (20), `kernel/ring` (12) (counts from the listing, the five `simd: lost` cells excluded). They are not SIMD losses: the spelling has the same SIMD status as the best one and more loop-body ops. I did not trace their causes.

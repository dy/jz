# Campaign after checkpoint-45868ec5 — `campaign-5763b63f`

Base `5763b63f` (the `checkpoint-45868ec5` candidate, kept frozen there; `handoff-03cf346d` kept at `44309407`). Worktree `$S/camp-wt`, branch `campaign-5763b63f`. Main's pending files are not in this lineage. Dependencies: the worktree's own `node_modules` (symlinks to the main checkout's packages; `watr` a copy of the private watr worktree `$S/watr-wt`, branch `campaign-locals`, base `5ff0037`, parity verified by `$S/scratchpad/sync-watr.sh` after every watr commit; watr's generated `types/` absent from the copy, unused at run time). Nothing in main, the shared `node_modules`, the coordinator's watr checkout or `dist/` was written. No push, publication or merge.

## Commits, in order

watr (`$S/watr-wt`, on `5ff0037`):

| commit | subject |
|---|---|
| `747d7ef` | Keep propagated values in evaluation order past a nested call |
| `b7a4647` | Keep a trapping value before the stores, global writes and calls it was defined before |
| `52ac0d0` | Exercise the local propagation family as a differential (`test/propagate-locals.js`) |

jz (`$S/camp-wt`, on `5763b63f`):

| commit | slice | subject |
|---|---|---|
| `870eabf2` | A | Share the private build transaction and fail closed on ambiguous overlays |
| `b250dc4e` | A | Pin the BigInt boundary by its semantics, not by an i64 parameter |
| `b665649e` | A | Prove the checkpoint on literals, on recording after the rewind and on an encoder failure |
| `c8c42680` | A | State the wrapper evidence and the park lane's memory figures precisely |
| `917cb005` | B | Judge reachability from the source, and catch a compiler that drops a root or an edge |
| `87925b99` | C | Replace the two local passes with watr's propagation family at the same point |
| `49a4db0e` | D | Turn the kernel gates into one runner with a manifest |
| `71ce1f31` | E | Pin the wrong-code families, native and hosted |

Files owned: `test/_self-build.js`, `test/_self-overlay.js`, `test/_self-overlay-build.mjs`, `test/self-build.js`, `test/self-checkpoint.js`, `test/bigint-boundary.js`, `test/reachability.js`, `test/reachability-mutants.js`, `test/_mutations.js`, `test/_mutant.mjs`, `test/_mutant-hooks.mjs`, `test/kernel-gate.js`, `test/_families.js`, `test/self-families.js`, `scripts/kernel-gate.mjs`, `scripts/kernel-gate-corpus.js`, `scripts/recursive-self-check.mjs`, `.github/workflows/kernel-gate.yml`, `src/optimize/driver.js` (the scheduling point), `src/optimize/locals.js` (deleted), `src/passes.js` (one flag), `scripts/build-profile.mjs` (one export), the registrations in `test/index.js` and `package.json`, this record. No summary, representation, emitter, ProgramIndex or runtime file was changed.

## A. Checkpoint slice

- Overlay selection (`test/_self-overlay.js`): one module per suffix on a path boundary (the entry competes by its own path), one occurrence per find, a pair of non-empty strings per edit, literal replacement; zero or several modules or occurrences reject the whole overlay. Tested on a synthetic graph. `selfBuild` and `selfBuildWith` share one private transaction (`build()`), and every lifecycle case of `test/self-build.js` runs against both entry points; the overlay JSON is the builder's one argument.
- `test/self-checkpoint.js` (9 tests, 108 assertions, two fresh kernel builds): WAT literals (empty, quotes, backslashes, NUL, raw UTF-8, escaped bytes including an invalid UTF-8 byte, `\u{…}`, control escapes, UTF-8 and empty export names, import names, data segments, a custom section) park as text or as byte arrays and encode to the direct bytes, which are the host watr's; a program's own literals through the forced kernel are the fresh kernel's and read back as themselves after later compiles; in the kernel every literal reaches the checkpoint as watr's byte array (census 0 quoted / 15 byte arrays / 49 ordinary arrays: watr's optimizer sizes through the in-place cleanup the self build specializes). Why `valueOf` is safe: the transport domain is watr's IR, whose arrays are plain nodes (`Array.prototype.valueOf` returns the array) or `str()` byte arrays with an own `valueOf`, and watr's encoder discriminates them by that same test (`compile.js isStr`); no user object enters the tree.
- Recording after the real rewind: the first `recordPhase`, 300 more past the capacity with an unlisted name, and a stage mark leave `__heap` unchanged (names prepared before the measured calls); capacity 0, overflow at 3 and reset to 256 hold across actual checkpoints with the checkpoint's stage mark kept.
- A labeled failure inside watr's encoder for a program exporting `__fail_after_unpark`: front, emit, watr and checkpoint marks and every phase record hold, earlier output executes, A and B recompile at once to the fresh kernel's bytes, failure and recovery repeat.
- The shipping-threshold checkpoint (1 GB of growth) is not exercised: the recursive compile fails before it (below).
- `test/bigint-boundary.js` (2 green / 4 red by design): the `param.type === 'i64'` assertion is replaced by semantics and ABI consistency (exact bits of every payload from the program and the host, the JS TypeError for a Number or an absent argument, `jz:i64exp`/`jz:hostabi` agreeing with the plan's boundary lane; the reference `g` rides the boxed f64 carrier behind an i64 lane and is green). Red: the numeric-demand seeding (runtime mixing for the LAYOUT shape; compile-time `RepresentationPlan host-box param lacks i64 boundary` with literal BigInt arguments), and, pinned apart, a plain host BigInt whose top 13 bits are `0x7FF8` (`0x7FF8000000000000n`, `0x7FF8000200000000n`, `0x7FFFFFFFFFFFFFFFn`) taken by `interop.js isBox` for a jz box and reaching the program as NaN, undefined or an object.

## B. Independent reachability evidence

`test/reachability.js`: ten programs with hand-authored roots, needed and dead functions, call order and results (export aliases and a default, a re-exported entry, import startup, recursion and a mutual SCC, closures returned and stored, higher-order callbacks with a callee reached only from a closure, class dispatch, a named function expression, address-taken calls, a dead callable), each checked against Node, executed at O0 and O2; deleting the dead callable from the source leaves results, order and bytes identical; ProgramIndex and the emitted census compared as a separate diagnostic block; empty, unsatisfiable and reuse cases. 21/21.

`test/_mutant.mjs` applies a named compiler mutant (`test/_mutations.js`) as Node loads the module (no tree edit, no production switch), with the overlay rule that the find occurs once. `test/reachability-mutants.js`: `root-export-alias` (only the syntactic export flag roots) and `edge-closure-call` (a call inside an arrow body is no call site) each make the behavioral tests fail (`'f' is not a known function`, `'__m_js$h' …`, `'dbl' …`) with the census agreeing; the unmutated suite passes; unknown and stale mutants reject the run. 4/4. Command: `node test/reachability-mutants.js`, or `JZ_MUTANT=root-export-alias node --import ./test/_mutant.mjs test/reachability.js`. No ProgramIndex defect surfaced on this corpus.

## C. Shared-optimizer consolidation

Ablations on `5763b63f` over the bench corpus (58 cases, `$S/scratchpad/locals-ablate*.log`): with watr's fixpoint on, jz's two passes were byte-neutral (size +28 B, speed −102 B without them) while watr's `propagate` carried 3.4 KB (size) / 11.6 KB (speed); at `fast` (fixpoint off) the two passes were worth 3.9 KB (2.2%), and watr's family invoked at the same point 7.9 KB more. Invoking the family early with the fixpoint on was measured and rejected: shapes/synth grew through watr's `unroll2` heuristic and `vm` ran 2.2x slower because the merged guard temps hid `narrow`/`unclamp`/`intguard`'s shapes.

Two watr defects, proven at `5ff0037` by WAT differentials and fixed in their own commits: a load defined before a call nested in a later statement (`(local.set $v (call_indirect …))`, or a call beside the use) was substituted after the call (`m = load 0; v = call_indirect(stores); v + m + load 0` gave 12 for 11); a pure trapping value (div/rem/trunc) was moved past a store or a global write by forwardPropagate and sinkSets (`q = 100 / d; store 0 7; q + load 0` with `d = 0` stored 7 and then trapped). `test/propagate-locals.js` runs the listed shapes before/after/through the pipeline with results, traps, host log and memory compared and no growth. watr: 349 pass / 2 skip; spec suite 268 pass / 20 skip (the main checkout's `test/official` linked for the run, link removed). `src/optimize.js` +52/−25.

jz `87925b99`: `locals.js` (266 lines), `localRefTallies`, the re-export and both flags deleted; one flag `propagateLocals`; the driver invokes watr's `propagate` per function after the vectorizer and before devirt only when watr's fixpoint is off (`fast`, `watr: false`), never on a v128 function. Bytes vs base: size +62 B (+0.05%, 23/58 identical), speed −70 B (−0.04%, 25/58 identical), fast −5,082 B (−2.66%); the watr fixes' share +18/+16 B. Timing (load 13–35, alternating, `$S/scratchpad/locals-time2.mjs`): vm 1.01x, dispatch 1.00x, shapes 1.00x, synth 0.97x, json 0.99x, lz 1.00x, checksums equal. Gates: optimizer 223/223; passes, bool-identity, closures, types, simd, determinism, differential, minimal-output, watr 714/715 (`watr bug: memory64 limits` red at the base too); fresh kernel 14,528,346 B (−26,086 B); self gate 20/26 with the base's six reds. Four `promoteIntArrayLiterals` pins read the storage shape instead of a local the family forwards. Maintained lines: jz −269 net in `src`; watr +27 net in `src`, +242 test lines.

## D. Kernel gates

`scripts/kernel-gate.mjs`: one runner, one manifest (jz head, dirty files and diff hash, self graph hash and module count, installed watr version and source hash, build profile, kernel bytes and hash, node, load), gates in their own processes under a timeout, kernel by `--kernel|--build|--dist` and never dist by default. Gates: functional (corpus by family at O1 and O2, fresh instance per case, validity, authored results, byte identity with native; compiler subgraphs), sequences, recursive, memory (judged only against a baseline manifest), speed (only under load 2, against a baseline kernel). `test/kernel-gate.js` 4/4 (corpus vs Node; fixture kernels: no diagnostics ABI, garbage output, a throw, a hang, no baseline). CI `kernel-gate.yml`: functional+sequences required, recursive+memory reporting, no speed job. `recursive-self-check.mjs` is `--dist --gate recursive`.

Fresh private kernel (`7928e201…`, jz `87925b99`) results (`$S/scratchpad/gate-c.json`, `gate-c-recursive.json`): sequences GREEN 9/9; recursive RED at `compileAst after publishParameterAbi: Cannot mix BigInt` (heap cursor 3.27 GB, memory 3.41 GB, front 648 MB, 51 phases, 69 s, RSS 1.95 GB); memory INCOMPLETE (no baseline); functional RED: green numeric-loop, numeric-bits, typed-arrays at O1/O2; red closures-classes (bytes differ, results right), maps-properties O1 (119 for 231, OOB), strings-parser O1 (OOB), encoder-json O1 (OOB), the three at O2 `[watr] Cannot mix BigInt`, `src/ir/tape.js` (O1 differs, O2 BigInt after optimizeModule), `src/abi/number.js` (differs), `src/abi/array.js` (BigInt after publishParameterAbi). Timing was not judged: load 6–35 throughout.

## E. Reductions (for the coordinator; nothing repaired here)

1. **A BigInt read through an internal call boundary, then `|=`/`+=`, is stored or converted as its box** (native, O0 and O1; O2's inliner removes the boundary):
   ```js
   const buf = new BigInt64Array(2); const rd = (i) => buf[i]
   export let f = (n) => { buf[0] = BigInt(n); let v = rd(0); v |= 0x100n; buf[1] = v; return Number(buf[1]) }   // 9221823924482868000 for 261
   ```
   Producer: the callee's return of a typed-array read (boxed carrier). Consumer: the BigInt64Array element store and `Number()`, which take the box bits. This is watr's `f64()` encoder exactly (`value = i64.parse(tail); value |= F64_NAN; _i64[0] = value`, `i64.parse` returning `_i64[0]`), so the kernel, built at O1, mis-encodes every `f64.const nan:0x…` payload as a NaN-boxed heap pointer: kernel WAT identical to native, binaries differing in those payloads only (`$S/scratchpad/kbin.mjs`). Every hosted program carrying a NaN-box constant (a string literal, a typeof test) differs from native; Map/string/JSON programs misbehave. A diagnostic kernel with the boundary removed in `encode.js` (`$S/scratchpad/diag-encode.json`, `k-diag-encode.wasm`) makes `x === "a"`, Map and `for-in` programs native-identical and right; other divergences remain behind it (below).
2. **`typeof v === "object"` is false for `null`** in a guard, expression and statement form, at every level, while `typeof null` itself is `"object"` (`src/compile/emit/comparisons.js`, the TYPEOF.object arm). Pinned in `test/_families.js`.
3. **`String.fromCharCode(c)` for `c > 0x7f` writes one truncated byte** (0x100 → 0); natively at every level; in the kernel this is the parser's escape decoder, so `"\xff"`/`"\uHHHH"` literals above 0x7f differ from native. Pinned.
4. **Host BigInt payloads with the box prefix** (`0x7FF8…`) are taken for jz boxes at the boundary (A). Pinned in `bigint-boundary`.
5. Behind reduction 1, with the diagnostic encoder: `strings-parser` still tokenizes wrongly through the kernel (`"1|2| |+| |3|4|5|*|6"`), and a typeof-guard program compiles in the kernel to a module without memory or `jz:hostabi` (157 B against native's 356 B): an analysis-level native/hosted divergence, not reduced further.
6. The numeric-demand seeding and the recursive blocker are unchanged (`checkpoint-45868ec5.md`).

## Gates on this lineage (literal)

| gate | result |
|---|---|
| `node test/self-build.js`, `kernel-marks` | 39/39 |
| `node test/self-checkpoint.js` | 9/9, 108 assertions |
| `node test/bigint-boundary.js` | 2 pass / 4 red (design) |
| `node test/reachability.js`, `reachability-mutants.js` | 21/21, 4/4 |
| `node test/optimizer.js` | 223/223 |
| passes, bool-identity, closures, types, simd, determinism, differential, minimal-output, watr | 714/715 (`watr bug: memory64 limits`, red at base) |
| `node test/kernel-gate.js` | 4/4 |
| `node test/self-families.js` (native) | 19 pass / 4 red (reductions 1–3) |
| `JZ_SELF_FAMILIES=1 node test/self-families.js` (hosted) | 24 pass / 24 red: the four above plus 20 hosted cases whose O1 bytes differ from native (reduction 1) or fail as recorded; `$S/scratchpad/families-hosted.log` |
| `node test/self-compile.js` (fresh private kernel) | 20/26, the base's six reds |
| watr `node test`, `npm run test:spec` | 349/2 skip, 268/20 skip |
| full native `node test/index.js` | see `$S/scratchpad/full-native.log` (run at the end of the campaign) |
| opt0/opt3/WASI legs, matrix, conformance, recursive completion | not run (the recursive compile fails in emitFuncs; timing needs an unloaded machine) |

## Smallest next blockers

1. Reduction 1 (the boxed BigInt across an internal call boundary into a typed store / `Number()`): the representation of a BigInt callee result and the typed-store/ToNumber consumers; it gates hosted byte identity for every string-bearing program and the kernel's own encoder.
2. The numeric-demand seeding (`i64Hex`), which gates the recursive compile at emitFuncs.
3. The TYPEOF.object arm for `null`.

## Scratch retained (`$S/scratchpad`)

`sync-watr.sh`, `locals-ablate.mjs`, `locals-early.mjs`, `locals-final.mjs`, `locals-time.mjs`, `locals-time2.mjs`, `locals-ablate-{size,speed,fast,1}.log`, `wat-of.mjs`, `fnsz.mjs`, `kdiff.mjs`, `kwat.mjs`, `kbin.mjs`, `fam-probe.mjs`, `corpus-check.mjs`, `red/bigint-store*.js`, `diag-encode.json`, `gate-c.json`, `gate-c-recursive.json`, `gate-diag-encode.json`, `families-hosted.log`, `ck-camp-*.log`, `self-compile-c.log`, the kernels `k-camp.wasm` (before C), `k-camp-c.wasm` (after C), `k-diag-encode.wasm` (diagnostic). The kernels are expendable; the logs and manifests are the evidence.

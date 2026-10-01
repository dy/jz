# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants. This file holds the decisions
that shaped the tree, the work left before release and the latest gate reading.

## Element ranges, September 30

Static array lengths, all-writer element intervals and scalar argument intervals
now refine one another across direct calls. Each incoming call must establish the
fact. Runtime-sized private index buffers also carry an equal-length relation
through direct helper parameters; zero initialization, own-index stores and
same-buffer copies preserve it. Unknown writers, aliases, backing-buffer exposure,
optional calls and escaped allocation-count receivers retain checks.

Review also corrected conditional/rest writes, parameter defaults and nullable
length-cache reads, computed typed-array accessors, SIMD select operand order,
and integer literal normalization. Mixed owned/view descriptor words now hoist
as complete expressions under a present-receiver proof. Word-index arithmetic
retains full overflow and intermediate-rounding checks; wide integer saturation
avoids floating round trips when per-site conversion expansion is enabled. The
size tier retains compact conversions. The compatible two-lane cbrt change is
included from audiojs-math without changing the selected scalar Math contract.

The current three.js PR source is 22,357 bytes, SHA-256
`b263693a9a1c993d1e69675a77bb9f167b2fd76fc010abf1a25dab2ad6a09da9`.
It is the same unmodified input for each compiler. With prepared dependencies,
main at 8066a3e7 emits 78,936 bytes; the candidate emits 77,682. Tangents agree
bit for bit with JavaScript under Node and Bun for empty/single-triangle inputs,
both ShaderBall meshes, 20,000 random triangles, and repeated/changed inputs.
Rotating 120-run probes including host copies give Node 22.91 -> 19.25 ms
(JavaScript 29.18), Bun 20.95 -> 19.61 ms (JavaScript 14.90). These are local
diagnostics; JSC remains faster. The original a4e3da3a build remains smaller
and faster than consolidated main, whose additional correctness handling is
retained. The earlier consolidation measurement below used a different port and is not
a comparable reading of this PR source.

The remaining element-proof gaps are returned allocation summaries, symbolic
element domains with sentinels, dominated scalar copies and affine/divisible
lengths, filtered initialized prefixes, resized scratch capacities, and DFS stack
occupancy. Remaining guards alone do not explain or quantify the full JSC gap.

A comparison with a4e narrows one immediate follow-up: the normal face-derivative
fast loop has 544 instruction nodes in a4e, 637 in main and 740 in this candidate.
All execute the same 15 float loads and 26 float multiplies. The candidate removes
the descriptor reloads (12 -> 3), but expands 18 saturations into 36 integer
comparisons. The existing preheader already bounds the three triangleVertices
counter-based indices; carrying that occurrence proof into integer lowering
would remove their redundant clamps. Element-derived position/texcoord indices
need wide bounds comparisons before wrapping, preserving tee side effects.
Across the kernel, in-loop integer loads fall from 417 to 222 (a4e: 207).
These static counts locate work; they do not measure its runtime contribution.

A new review finding also reproduces on untouched 8066a3e7 at O0/O2/O3/size:
Object.defineProperty can shadow a typed array's length in JavaScript, but jz
continues reading the internal length. For a four-element sizes array shadowed
with length 1 between two allocations, Node returns [1,4,1,-2991], jz [4,4,4,9].
The new relational proof rejects the escaped size receiver, pinned by
`element bounds: escaped size receivers cannot establish equal allocation lengths`.
The existing behavior falls under README's unsupported property-descriptor
reflection semantics. It is not a new supported-surface regression; the new
analysis still rejects that escaped receiver conservatively.

Validation on candidate c3bf85f7, with the prepared watr fixes and subscript 10.8.1:

- Core: default 5,740 tests / 227,053 assertions. O0 5,584 / 157,185;
  O3 with invariants 5,600 / 167,429; WASI 5,642 / 212,318. The latter three
  preceded the final test-only lifetime pin and unused-import cleanup; the
  added lifetime test also passed all five tiers under WASI (90 assertions).
- Import lint and public types pass. Poisoned range suites: 45 / 2,727.
- Language conformance: 3,222 positive cases, 4,045 required rejections,
  zero unexpected failures/accepted invalid programs, two unchanged expected
  async-ordering divergences. Builtins: 904 passes, zero unexpected failures,
  43 unchanged expected failures.
- Three.js: 3 / 90. Integration: default 179 / 1,793; O0 and O3 each
  74 / 589; WASI 77 / 357. All pass.
- Generated native: 37 / 102; WASI: 37 / 92. All pass. The previously red
  fgather loop-body instruction count now meets its unchanged 12,560 limit.
- Every example and the browser assets build.
- The claims gate retains exactly its 15 baseline failure categories (7 pass,
  2 skip): stale/missing reference evidence, memory/RSS, rival coverage, parity
  evidence, native lowering, and speed/size leadership. No bar was changed.

The measured benchmark passes 258/277 checks (597 assertions). Remaining
failures are speed leadership, two strict AS size comparisons, TinyGo build
coverage, and two unavailable stdlib timings. This is not a passing v1 performance
gate. The speed geomeans are jz/V8 0.500, jz/C 0.682 and jz/AS 0.486; artifact
size geomean is jz/AS 0.775. Floatbeat and example timing checks pass. These
loaded-machine readings do not replace committed reference evidence.

Deterministic comparison against untouched 8066a3e7 confirms both size failures
already exist: FFT is byte-identical at 1,806 B (AS: 1,758); slices improves
1,721 -> 1,709 B (AS: 1,657). The blur speed artifact is also byte-identical.
Fresh baseline and candidate builds both reproduce stdlib-special's out-of-bounds
trap at the same top two function indices/offsets, and stdlib-dists' missing
env.globalThis import in the benchmark harness. None is a new candidate failure.
The watr size artifact grows 139 B to 314,913, below its unchanged 320,000 cap.

An alternating, warmed baseline/candidate check of the changed speed binaries
retains identical checksums. Candidate/baseline median runtime ratios are noise
0.860, stdlib-ddot 0.998 and watr 1.001 (12 alternating measured pairs after two
warmups). It does not close the broad benchmark's speed gaps or certify cold/tier-up
performance. Artifacts and raw pairs: /private/tmp/jz-element-bench-audit-r5/;
stdlib failure reproductions: /private/tmp/jz-stdlib-audit-20260930/.
Ecosystem performance checks pass (2 tests / 4 assertions).

Fresh bootstrap builds 24,061,484 bytes in 204 seconds. Round-trip passes
85 / 2,932; O0/O2/O3 parity and oracles pass 15 / 750; checkpoint passes
9 / 112. The hosted suite passes 4,908 / 4,912 tests (197,594 assertions);
its four failures match the existing concat-memory, JSON folding/property-order
and nullable BigInt unary cases listed below. Recursive compilation reaches
the same 4 GiB heap limit after `plan:splitByListKinds`; it remains red. The retained ordinary kernel
is /private/tmp/jz-element-r5-ordinary.wasm, SHA-256
9a65c87103894d14e0fb6c9ca15f13bffa18ef85559d09aaba516192d168ebc7.
Final source and dependency digests match their frozen manifests.
The r4/r5 source manifests and logs are under /private/tmp/jz-element-gate-r4*
and /private/tmp/jz-element-gate-r5*. r4's conformance legs were deliberately
interrupted after lint found the unused import; r5 reran both successfully.

## Earlier consolidation, September 30

**The perf, stdlib, memory and mikktspace handovers are consolidated locally
on main at `ce77709c`. V1 is not ready to tag.** Main retains perf `293db798`,
stdlib `4c77ec62`, the memory lineage from `86a47904`, and all five mikktspace
commits through `a4e3da3a`, with merge resolutions and the review corrections
below. The active benchmark, site and test-runner edits are preserved
separately. The original dirty tree remains on `wip/pre-v1-consolidation-20260930`.

Verification is on frozen `ce77709c`, using the prepared watr fixes. Subsequent
cleanup removes an unused import, clarifies the example-builder comment and
confines a native-scope test assertion to the native compiler leg. Lint and the
affected test pass after those corrections; compiler behavior is unchanged.

| Check | Result |
| --- | --- |
| Default core | **5,705 tests / 221,682 assertions pass**. |
| O0 core | **5,550 / 152,726 pass**. |
| O3 core with invariants | **5,566 / 162,967 pass**. |
| WASI core | **5,608 / 207,011 pass**. |
| Browser build | Pass; five parity probes agree. Strict bundle **2,996.2 kB**, **845.5 kB gzip**. |
| Fresh compiler | **23,940,717 bytes**; **20/20 functional** and **9/9 reuse/error-recovery** cases pass. |
| Recursive compiler | Fails at the 4 GiB heap limit after list-kind specialization. |
| Enumeration poisoning | All four regression tests pass at five tiers: **420 assertions**. |
| Types/package/lint | Public types pass; package dry run includes all required entries and no scratch/test/Wasm artifacts (**369 files, 4,272,606 B packed**). Import lint passes after removing one unused import. |
| Numeric differential sweep | **5,000 programs**, **91,235 inputs compared**, **8,765 excluded**, no mismatches or malformed programs; O0/O1/O2/O3. |
| Memory poisoning | **89 tests / 21,278 assertions pass** across release, fixed-memory, guarded-view and typed-sort tests. |
| Language conformance | **3,222 positive cases / 4,045 correct syntax rejections**, zero unexpected failures; two unchanged expected failures. |
| Builtins conformance | **904 pass**, zero unexpected failures; 43 unchanged expected failures. |
| three.js | **3 tests / 90 assertions pass**. |
| Integration matrix | Default **179 / 1,793**, O0 **74 / 589**, O3 **74 / 589**, WASI **77 / 357** tests/assertions pass. |
| Generated checks | Native correctness passes; one unchanged `fgather` cost failure (**36/37 tests, 102 assertions**). WASI **37/37, 92 assertions pass**. |
| Examples | Complete gallery, siblings, custom assets and standalone demos build successfully. |
| Claims | **7 pass / 15 fail / 2 skip**, with exactly the same failing claims as the preceding snapshot. |
| Self-compile round trips | **85 tests / 2,932 assertions pass**, using the fresh compiler above. |
| Kernel parity/oracles | **15 tests / 750 assertions pass**; byte-identical WAT at O0/O2/O3. |
| Checkpoint overlay | **9 tests / 112 assertions pass**, including empty and repeated inputs, changed inputs, park/unpark, error recovery and allocation-free recording. |
| Hosted suite | **4,876/4,881 tests pass, 195,712 assertions**. One invalid native-scope assertion is corrected and retested (native: 4 assertions; hosted: 2). The four remaining program failures also reproduce on a fresh pre-mikktspace compiler from `88f5f193`. |

The merge keeps main's asked/several results, held views and nested-return
restoration together with `memory.fixed` and receiver-only array-growth taint.
Review corrected guarded-view identity, unsafe wide-i64 interval facts,
saturation and stale guard refinements. Fixed-memory exports retain their
no-allocation proof. Exact integer-conversion guards now share one lowering
rule; short typed sorts keep main's stable radix kernel above 32 elements.
Class parsing, typed indices/coercion, builtin reflection/shadowing, string
lifetime, BigInt carriers and split-local lifetime fixes remain included.

Self-hosted array copies now preserve named properties, including IR schema
metadata. The same ordered property walk serves arrays, typed storage/views,
Sets, Maps and buffers. Runtime enumeration checks Number values before pointer
tags, rejects nullish public receivers, and retains the empty-source semantics
of copy/spread/for-in. Four regressions compare **420 results with Node** across
O0/O1/O2/O3/size, including empty inputs, shifts, initialized/runtime keys,
delete/reinsert, repeated and changed inputs, and receiver evaluation counts.
A separate poisoned-memory probe retains nested objects and dynamic strings
across copying, return and subsequent allocation at all five tiers.

The shared example builder resolves transitive imports and runs custom builders
on every request. Its two regression tests cover empty inputs, A/A/B/A rebuilds,
changed dependencies and propagated failures. The complete gallery build
passes on local main at `ce77709c`, including custom three.js assets, sibling
kernels, rfft, zzfx and all twelve jukebox beats.
The local browser build also passes all five parity probes using installed
registry watr 5.11.8; the release matrix above uses the prepared dependency fixes.

The numeric oracle uses `Object.is` and excludes only executed bitwise operands
whose magnitude reaches 2^63. The final 5,000-program sweep on `ce77709c`
compares **91,235 inputs**, excludes **8,765**, and finds no mismatches or
malformed programs. Its per-operation Node comparison disables rational
constant folding; the documented round-once rule is separately tested.

Local cost probes retain correct outputs and show no timing loss for 128
64-element array enumerations/copies: medians **0.065 / 0.170 ms**, previously
**0.068 / 0.176 ms**. Correct property handling grows those O3 modules from
**11,725 → 13,902 B** and **23,813 → 25,173 B**. The earlier MikkTSpace comparison
on unchanged ShaderBall inputs retains byte-identical tangents (849,696 and
209,472 values), with median **27.22 ms** versus main's **65.41 ms** and module
size **101,009 B** versus **81,946 B**. These loaded-machine measurements are
diagnostics, not reference-machine claim certification.

Release remains blocked by:

- **Recursive memory use.** The first summary allocation fell from 628 MB to
  287 MB, but repeated rebuilt summaries still exhaust the heap. Functional
  and reuse passes do not establish recursive completion.
- **Hosted compiler compatibility.** Imported/shared memory options are not
  forwarded through `test/kernel-target.js` and `scripts/self.js`; the long
  literal-fragment test reads the wrong memory. Constant JSON folding of an
  inline RegExp or a nested literal object emits a function that incorrectly
  throws a BigInt serialization error when called. Nullable BigInt array reads
  under nested unary operations return encoded data instead of the value:
  `const a = [17n]; return ~~a[k]` fails the `[0, 1, 1, -1, 0]` call sequence
  at all five tiers. All four failures reproduce on a freshly built compiler
  from main immediately before mikktspace (`88f5f193`), with the same prepared
  watr dependency; native runs pass. The tests remain enabled in
  `test/strings.js`, `test/json.js`, `test/js-parity.js` and `test/bigint-tag.js`.
- **Dependency release.** Gates use the three prepared watr fixes for handler
  ordering, argument evaluation order and signed block-type encoding. Native,
  compiled and offline package-consumer checks pass. Publication approval is
  pending; this checkout still requires `^5.11.8` and locks 5.11.8. A clean
  registry installation must pass before release.
- **Performance, size and evidence.** The final frozen claims run retains 15
  failures covering freshness, rival coverage, RSS, w2c, per-case speed and
  size. Final native generated correctness passes, but `fgather` costs **12,840**
  against **12,560** (main was **14,400**). The previous `slice` cost failure
  is closed. No acceptance bars were relaxed. Fresh reference measurements
  and the [math follow-up](.work/math-followup.md) remain open.

`audiojs-math` remains the separate exact-V8 Math alternative documented in
CONTRIBUTING; it changes the selected accuracy/performance contract. Earlier
browser/UI, color-space and package-integration checks belong to their recorded
snapshots. Nothing has been pushed or published from this consolidation.

## Consolidation review pins

| Regression | Direct evidence |
| --- | --- |
| Hosted inference test inspected the native scope | `receiver-HASH: a module literal whose keys functions add is a dictionary, dot-written or not` in `test/inference.js`: private scope inspection stays on the native leg; both compiler targets compare dictionary enumeration/JSON before and after the same dot-write. |
| Array copies lost named IR metadata | `array enumeration and copies retain named properties beside elements`, `array enumeration merges initialized and runtime properties without stale keys`, and `collection enumeration includes named properties on owned storage and views` in `test/objects.js`: zero/one/many elements, shifts, undefined own values, typed views, DataView, Set/Map/ArrayBuffer, initialized/runtime keys, delete/reinsert and A/A/B/A at every tier. |
| Numeric fractions were read as pointer tags; nullish enumeration silently returned empty | `runtime enumeration distinguishes numeric payloads and nullish copy sources` in `test/objects.js`: twelve finite numeric payloads, ±0, NaN, infinities, booleans, BigInt, empty/repeated strings, null/undefined; keys/values/entries, copies, spread and for-in, with exact receiver-evaluation counts. |
| Shared example builds skipped module graphs/custom builders | The two shared-builder regressions in `test/examples.js`: transitive reexports, sibling kernels, zero-work rebuilds, A/A/B/A, dependency edits and propagated failures. |
| Guard views changed receiver identity | `guard view: storage access preserves identity through calls, methods and callbacks` in `test/guard-views.js`: helper equality, `fill` return and `every` callback receiver; lengths 0/1/3, same/same/different/same receivers. |
| Large i64 constants rounded onto adjacent payloads | `int-narrow: i64 comparisons retain bits beyond exact Number integers`: five adjacent pairs near ±2^53, signed i64 limits and NaN-box payloads; six comparisons, repeated 0/0/1/0 selections. |
| Saturation used the input's magnitude | `int-narrow: saturating i64 conversions keep their actual magnitude`: ±1e30, infinities, NaN, ±2^52 and zero; compare optimized Wasm with the original conversion. |
| Guard facts survived a later operand's write | `int-narrow: guard refinements follow later operand writes`: `x < (x = (n + 1) & 7)` at n=6, conditional expressions, reverse comparisons and compound tests; O0/O1/O2/O3/size. The sibling eager-compound-guard test checks the IR directly. |
| Guard specialization allocated inside a fixed-memory export | `fixed memory: typed guards keep borrowed receivers allocation-free`: empty, A/A/B/A, wrong typed kind and null, repeated 32 times at every tier; unchanged memory use and final `noAllocation` proof. |
| Exact conversion wrapped twice | `typed store: a clamped sum converts inline at the speed tiers, through the kernel at -Os` requires one magnitude guard and one cold call at O2/O3/speed. The inference sieve stays within its original conversion budget (23 against 25). |
| Conversion temporary shadowed a parameter | `late integer conversion preserves parameters whose names match its temporaries` uses a `$__ti0` parameter, repeated inputs, signed/word/2^63 boundaries, huge values, NaN and infinities; original and optimized Wasm agree, and a second lowering pass is byte-identical. |
| Late typed-length facts tightened an early range | `word local: the weld hash of a vertex` runs at 0/1/7/20 vertices with invariants enabled and matches Node. The invariant continues rejecting range widening. |
| Sort algorithm boundary | `typed sort: NaNs keep their order past the numbers` checks payload order at 31/32/33; the per-kind differential sweep includes empty, singleton, boundary and large arrays. |

The `int-narrow` tests above are in `test/int-narrow.js`; the fixed-memory and
sort pins are in `test/fixed-memory.js` and `test/typed-sort.js`. All four incoming
histories remain ancestors of main. Gate logs, frozen source/dependency manifests
and the two compiler builds are retained outside the checkout for review;
temporary validation worktrees are removed after the checks finish.

## Release status, September 27

**V1 is not ready to tag, and the claim reading is still September 26's.**
Nothing after c5f5c408 has been measured on a reference CPU: this tree is
unpushed. The M4 ran at load averages of 25 to 280 through this work (other
sessions building on it), where one build's median moves 3× between runs, so
no local timing below is evidence for a claim. What is recorded is what load
does not move: emitted code, the x64 code V8 makes of it (jsvu `v8-debug`
under Rosetta, `--print-wasm-code`), checksums, differential results against
Node, and binary size.

The ledger (209f67e0) is the record that ends the circling: `bench/ledger.jsonl`
holds one line per measured run, `node scripts/ledger.mjs status` shows each
case's worst claim ratio per machine, `show <case>` its history and `diff`
what moved between two runs of one machine net of the rivals' drift. The
`jz-base` target (e408a309) times the compiler of another checkout in the same
alternating rounds, so jz/jz-base is a change's own effect whatever CPU the
runner drew. A change counts as a win when a probe on a reference CPU says so;
until then it is a candidate.

Candidates on top of the September 26 table, general forms:

| Change | General form | Evidence (M4 timings are diagnostics) |
| --- | --- | --- |
| Conjunct fold (911f0be2) | `if (A && B) x = V` with a data-dependent `B` keeps the bound `A` as the branch and folds `B` into a select | sort 0.86 of the c5f5c408 build |
| Function-level flow facts (64bb366f) | Top-level statements thread range facts as blocks do | a clamp at function level bounds what follows |
| Output cursor (673a38d7) | A cursor stepping beside the counter is the counter scaled and shifted; clamped lanes truncate as a vector | wav's sample loop converts two samples per step |
| Sparse guard (8926a583) | A loop of one guarded statement over a typed element tests 4 to 16 elements per compare and runs the statement for the set bits | trace 739 → 392 µs, checksum intact |
| Present binding (9bee5a75) | A binding initialized from an in-range typed load is a number for its block | no missing-value conversion on its uses |
| Typed decode (H7) | A typed receiver of open element kind is decoded once per loop; each access tests `i < n`, loads or stores directly inside and calls the helper outside (speed tier) | a gain kernel over mixed Float32Array and Float64Array buffers: 2.05× of Node before, 0.97× after; Web Audio paired jz/jz-base median 0.772 |
| Field cache (H10) | A field read a statement repeats is a `const` before the statement, ended by a store of that name through any receiver | Web Audio: 114 functions change, `getEventTime` 30 loads → 15, checksum 2866527759 unchanged |
| Loop step (H9) | The counter of a comma step (`j++, k += step`) is found, so the load cache knows the bound positive | fft's butterfly keeps `re[a]` and `im[a]` across the store of `re[a + half]` |
| Number or missing (H4) | `+` with a side the summary holds to a number or a missing value is `f64.add` behind a self-compare | field sums leave the generic helper |
| Typed payload (H6) | A store through a typed binding that may be missing writes by the payload's constructor after rejecting the missing receiver | no generic writer |
| Bulk fill (H5) | `fill` writes one element and doubles the run with `memory.copy` | log2(n) copies for n elements, every element kind |
| Guarded read (H11) | A checked read that decides a branch loads under its guard, without the address clamp, against the length the binding fixes | vm on x64: 25 → 22 instructions an interpreted operation, Rust's build 21; the freed register keeps the program's base out of the stack |
| Shift remainder (H12) | `x - ((x >> k) << k)` is `x & (2^k - 1)`, the quotient in a local or in place | delayline on x64: 46 → 44 instructions a sample, Rust's build 44 |
| Scalar unroll (H13) | The plan copies a loop out for a small typed array only when its counter reaches an index of it | bezfit's speed binary 16351 → 3814 B: six identical copies of the nest gone, its kernel was 5832 x64 instructions against Rust's 975 |

Correctness, each found by a differential sweep against Node at four levels
and pinned by the sweep itself:

| Class | Before | Pin |
| --- | --- | --- |
| A read that finds nothing, used as a number (H3, 0ea57ea1) | 747 of 10472 probes differed: the undefined box is a NaN whose payload arithmetic carries, so `a[n] + 1` read as undefined; a Float32Array store kept the payload too | `test/missing-read.js`, every receiver × binding form × use |
| A shift right of a comparison (H8) | `a < b >> c` compiled as `(a < b) >> c`; 56 of 5490 operator-pair probes differed | `test/shift-precedence.js` |
| Statements before `super(…)` (H1) | ran after the base's constructor | `test/super-order.js` |
| A field read before its store (H2) | a method the constructor calls, or the base's constructor, read a later field as a number | `test/definite-init.js` |
| `fill('12')` (H5) | stored NaN in a float array, 0 in an integer one | `test/typed-fill.js` |

The shift error is subscript's (10.8.1 and its head f5506dc): the dispatcher
tries a first character's operators newest first and commits on the first
text match, and `>`, registered after `>>`, matches the text `>>` begins with.
jz orders each character's operators longest first at its parser entry; the
fix belongs in subscript's `register`.

The core suite passes 4931 of 4936 tests (169356 assertions) on a private
copy of this tree: web-smoke fails for the asset above, two bench-harness
tests for the copy not being a git checkout, the interval-proof detector
before it learned the guarded read (22 of 22 alone), and one timer test under
a load of 40 (172 of 172 alone). Self-compile passes 79 of 79. Every corpus
checksum matches its reference except the five color cases, which differ
identically without these changes. `test/simd.js` passes 236 of 236, the
op-count ratchet holds in every category (ring 53800 against a baseline of
54040), and every pair of binary operators agrees with Node.

What the x64 code says of the losses the M4 does not show: V8 has about
eleven general registers to hand out there against arm64's thirty, and every
value a loop keeps beyond them is a stack slot it reloads. jz's loops keep
more than LLVM's do. qoi holds seven array bases in registers where the C
source's static arrays are constant addresses (274 stack references in 1327
instructions of the kernel against 79 in 734), and watr's `unroll2` writes
its encode loop's whole body out twice. vm kept a register for a length the
binding fixes. bezfit's kernel was six copies of itself. Where both
compilers emit the same loop (delayline: 44 instructions each now) the ratio
is the runner's noise around 1.000, and a strict bar of 1.000 passes or
fails by it.

Diagnoses, no change made:

- **Array bases.** Typed arrays a function allocates in a row at constant
  sizes lie at constant distances from each other (the bump allocator), and
  an array allocated once in code that runs once lies at a constant address.
  Either fact folds a base into the access's offset and frees its register:
  the general form of what static arrays give C, Zig and Rust kernels, and
  the largest lever the x64 listings show. Not built.
- **Web Audio.** Its channel arrays are polymorphic by construction
  (Float32Array views, Float32Array and Float64Array blocks written into one
  `_channels` list), so the element kind is a run-time fact and the decode is
  the tool. After it the profile is parameter automation, where V8 spends the
  same time.
- **Peak RSS.** Web Audio: 82.0 MB against V8's 74.8 MB with 9 MB of Wasm
  memory; the rest is V8's own Wasm code memory (73.3 MB with the baseline
  compiler alone), so the heap is not the lever. Jessie: 111.5 MB against
  98.5 MB with 64 MB of Wasm memory, because the timed loop is not rewound.
  The census declines it for a `charCodeAt` on a receiver it cannot type
  (`hashNode`), a store of the source string into a module binding (`parse`:
  the string exists before the iteration), the zero-argument host import
  `performance.now`, and closure-valued callees (`parse.space`, `parse.step`,
  the `lookup` table); the link pass also vetoes `call_indirect`. Four census
  refinements are designed: a method name no program function or own property
  can carry is its builtin; a stored value that exists before the scope is no
  escape, with a per-parameter escape fact for callees; a closure value the
  summary resolves (`view.calleeOf`) is a known callee; a zero-argument host
  import receives no pointer. Each needs its own soundness pins.
- **fft.** jz's vector butterfly is about 28 x64 instructions against clang's
  25, with 8 spill reloads; the reloads of `re[a]` and `im[a]` are what the
  loop-step fix removes. TinyGo does not build locally (Go 1.26 against its
  1.19 to 1.23), so the 1.130× row is a CI question.
- **lorenz.** A latency-bound recurrence: the spilled state and the
  rematerialized constants sit off the critical path.

Pending your hand, in order: land the site work that removes
`assets/grid-life.js` (e408a309 took its deletion, staged in the shared index
by that work, into an unrelated commit; `index.html` and `test/web-smoke.js`
at this tree still name the file, so the tree fails web-smoke and the light
theme's hero until the site work is committed); `git pull --rebase` (origin
holds one CI refresh of `bench/results-ci.json` this tree lacks), `git push`;
publish watr 5.11.9 from d09bd06 and bump jz to `^5.11.9`; then the A/B probe
on each runner CPU:

```
gh workflow run bench-probe.yml -f base=c5f5c408 -f repeats=6 \
  -f cases=webaudio,trace,sort,wav,fft,biquad,base64,dispatch,qoi,vm,delayline,bezfit \
  -f targets=jz,v8,bun,jsc,c-wasm,rust-wasm,zig-wasm,as
node scripts/ledger.mjs pull <run-id>
node scripts/ledger.mjs status
```

Open: provenance, fftplan and jessie against JSC have no diagnosis yet. A
call's result is not yet typed for `+` (the closure-table pins count the
generic `+` it would remove). Whether `unroll2` pays on x64 is a probe of
two builds, one with `watrOpts.unroll2 = false`.

## Release status, September 26

**V1 is not ready to tag.** Two fresh reference runs now bracket the release
claims on the two runner CPUs CI hands out, and every claim must hold on
both. The [reference at c5f5c408](https://github.com/dy/jz/actions/runs/36248472545)
(EPYC 7763, the nine fixes after 15f7243f included) fails 7 of 23 claims;
the [reference at 15f7243f](https://github.com/dy/jz/actions/runs/36195665330)
(EPYC 9V45) failed 9. The CPU moves whole cases between the lists: watr is
1.55× behind every engine on the 9V45 and within 1.03× on the 7763; trace is
1.04× behind C-Wasm on the 9V45 and 1.39× on the 7763; biquad loses to Zig
by 1.28× on the 9V45 and wins on the 7763; Bun's dispatch time is 6× slower
on the 7763 (9345 µs against 1549 µs), so jz trails it 1.39× there instead
of 5.6×. The nine fixes hold on the 7763: bytebeat, radixsort and biquad
leave the red lists, base64 moves from 1.47× to a 1.006× tie with C-Wasm,
sort from 1.78× to 1.20× of AssemblyScript.

Red on the 7763 (c5f5c408): peak RSS jessie 1.119×, watr 1.322×, Web Audio
1.178×; Wasm rivals trace 1.386× (C), sort 1.197× (AS), fft 1.130× (TinyGo),
wav 1.101× (Zig), qoi 1.095× (C), delayline 1.070× (Rust), vm 1.061× (Rust),
bezfit 1.050× (Rust), and ties on lorenz, slices, crc32, base64, raytrace;
V8-family Web Audio 1.451×, wav 1.119× (Deno), and ties on slices 1.046×,
lorenz 1.044×, noise, watr, crc32; Bun/JSC Web Audio 1.414×, dispatch 1.391×
(Bun), jessie 1.290× (JSC), wav 1.168× (JSC), provenance 1.097×, fftplan
1.088×, and ties on bezfit, fft, watr. Porffor and the wasm2c band pass on
this CPU. The union with the 9V45 list adds biquad (Zig), base64 (C, Rust,
TinyGo, Zig), bytebeat, sort (C, Rust, Zig), watr (all engines), lorenz
(Porffor 1.019×), shapes (wasm2c 6.98×) and the V8-family losses on bytebeat,
delayline, sort and wav.

Fixes on top of c5f5c408, local M4 evidence only (unpushed, so no x86 row):

| Change | General form | Local result |
| --- | --- | --- |
| Flow facts for ToInt32 (3d3fe481) | A comparison bounds a local in the arm it guards, arms hull at their join, loop-written locals are unknown at the head (`optimize/flow-range.js`); `f64Range` reads the facts through if-expressions and selects under its NaN-admitting query | wav's sample loop and conv2d's requant lose their ±∞ guards (V8 x64 lowers the guarded form in 17 instructions against 9); checksums unchanged |
| Byte-store merge (d98a122f) | Consecutive stores of one pure word's bytes at consecutive addresses become one store16/store32 (`mergeByteStores`) | wav 1338 → 1274 B, one `i64.store16` per sample; `writeU32` one store; 5.6 ms against 6.1 paired locally |
| Const seeding (3281b66a) | A name declared more than once seeds an integer constant only when every declaration evaluates to the same value | Correctness: the O1/O2 scalar unroller copied `const sb = s * 4` under one name and every stage wrote stage zero's slot (a two-stage cascade returned -0.137 for -0.0065 at the default level); `test/const-seed.js` |
| Unroll cost (ddd0625f) | A copy is measured with its counter substituted and its consts resolved, so addressing over the counter costs nothing | biquad's eight stages unroll into constant-address stages (7 loops, 78 loads); noise stays rolled; timing neutral on the M4, the 9V45 loss is the target |

The full core suite passes 4840 tests / 131198 assertions on this tree,
self-compile passes, the differential fuzzer passes 5000 programs at four
levels, and every non-LAB corpus checksum matches. The x64 instruction
selection was read from a V8 debug shell (jsvu `v8-debug`, mac64 under
Rosetta): every f64→i32 conversion is 7–17 instructions where arm64 uses
one, `f64.min`/`f64.max` are eight branchy instructions, and an f64 `select`
is a branch, so integer-ness and range proofs matter more on x86 than the
M4 shows.

Pending your hand: publish watr 5.11.9 from d09bd06 (`npm version 5.11.9
--no-git-tag-version && git commit -am 5.11.9 && npm publish && git push`
in the watr checkout; its suite passes 268 tests, and jz's suite and
self-compile pass with that optimizer patched in) and bump jz to `^5.11.9`
for the dispatch select trees; push this tree; then probe the changed cases
on both CPUs (`gh workflow run bench-probe.yml -f cases=wav,biquad,conv2d,
base64,sort,dispatch,trace,qoi -f targets=jz,v8,bun,jsc,c-wasm,rust-wasm,
zig-wasm,as -f repeats=6`) before the next reference run.

Open, with diagnosis: biquad's unrolled stages still load and store every
state slot per sample; a register promotion across the sample loop needs the
emit-level twin of `carry-elements` (the source-level pass sees the rolled
loop). wav's remaining gap is the clamp's two branches and the checksum's
serial FNV chain that every target shares; the loop vectorizes only with
if-conversion to f64x2 min/max and an f64 → u16 narrowing store, which the
tone-map island does not cover. trace, qoi, fft, delayline, bezfit and vm
lose on one CPU each by 5–39% and need x86 probes before any change. The
memory rows and Web Audio are unchanged from the diagnosis below.

## Release status, September 25

**V1 is not ready to tag.** Published watr 5.11.8 and subscript 10.8.1 are
installed from the registry and locked. Local dependency links had hidden the
CI parser-location and allocation failures. The supported `loc: false` option
and published literal/printer allocation fixes pass their regressions. The full
self-compile suite and fresh functional, sequence and recursive attestation
pass. The full core suite passes 4805 tests / 125310 assertions, and the full
Wasm-hosted suite passes 3824 tests / 105287 assertions. Fresh release
performance evidence and the Jessie/watr memory gaps remain open; no release
cap was relaxed. The [strict reference CI run](https://github.com/dy/jz/actions/runs/36173446401)
used the repaired native adapters at 53257033 and failed its claims gate. All four
CI test-matrix legs, fuzz, self-compile, conformance and native smoke are green
on that commit. The committed-evidence claims gate remains red.

The next memory candidate reduces the speed-tier array reserve from 16 to 4
elements. The allocation sweep passes 16 tests / 1439 assertions, self-compile
passes 76 / 2496, and all 62 non-self-host benchmark checksums match the control.
Fresh functional, sequence and recursive attestation passes; conformance is
green in CI. The full Wasm-hosted CI suite passes 3825 tests / 105423 assertions,
and differential fuzz passes all 5000 seeds. Local core passes 4807 / 125453;
the remaining local matrix legs are running. CI opt0, opt3 and WASI are green.
[Reference CI for 695a8b6b](https://github.com/dy/jz/actions/runs/36179691942)
finished measurement but failed 7 of 23 claims: peak RSS plus strict leadership
and parity bands for Wasm, V8-family and Bun/JSC rivals. It records 15 strict
Wasm losses, 11 V8-family losses and 14 non-exempt Bun/JSC losses. Size passes
on all 51 comparable AssemblyScript cases (geomean 0.768×); peak RSS still
loses on Jessie (1.118× V8), watr (1.306×) and Web Audio (1.161×).
The [reference run at 15f7243f](https://github.com/dy/jz/actions/runs/36195665330)
(EPYC 9V45; toolchain versions identical to the 695a8b6b run on EPYC 7763)
clears resample and SDF but fails 9 of 23 claims. Strict Wasm leadership fails
on 14 cases: sort 1.780× (AS), base64 1.466× (C), bytebeat 1.288× and biquad
1.284× (Zig), fft 1.239× (TinyGo), wav 1.124× (C), trace 1.091×, bezfit 1.085×,
delayline 1.062×, vm 1.057×, and radixsort, raytrace, lorenz and shapes inside
the tie band. V8-family fails on 11 cases (watr 1.576×, Web Audio 1.472×), Bun/JSC
on 12 (dispatch 5.623×, watr 1.541×, Web Audio 1.345×). Peak RSS still loses on
Jessie 1.114×, watr 1.299×, Web Audio 1.161×. Porffor native beats lorenz by
1.019×. jz-w2c trips its band on shapes (6.98×): V8 runs the shapes Wasm 7×
faster on this CPU than on the 7763, while the native lowering does not follow.
The CPU alone moves several ratios between runs (dispatch/JSC 1.39× → 5.62×),
so every claim must hold on each runner CPU. No diagnostic rows have replaced
the public snapshot.

Fixes after that reference, local M4 evidence only (CI pending):

| Case | General change | Local result |
| --- | --- | --- |
| sort | A load-CSE temp caching an in-bounds typed read is present, so swaps store it without nullish folds (25ba37ae) | 8.3 → 4.3 ms; 1748 → 1536 B speed, 1417 → 1288 B size |
| base64 | An integer element used as a key keeps the gather in a word (6f2cacd5); an offset guard `i + K <= n` compares in i32 within the counter's test range (9c2ca91a) | 3.39 → 3.14 ms; paired JZ/C-Wasm 0.862, Rust-Wasm 0.882, AS 0.757, Bun 0.724 |
| bytebeat | A loop-declared counter carries its test range into the body's typing; `x & y` with a bounded non-negative operand is bounded (b176bee6) | 1.42 → 0.69 ms, the loop vectorizes |
| dispatch | watr d09bd06 (unpublished): converts hoist out of guard ifs; exact rings collapse across a shared scratch temp; select trees accept temps exclusive arms write before reading | 7.3 → 1.78 ms; Bun 2.4 ms locally |
| radixsort | A local typed binding assigned only buffers of one length keeps that length across a swap (cd593751) | speed binary 3784 → 2464 B, size 1323 → 1231 B; checked reads 14 → 2; ≈2.5% faster |
| construction | `TypedArray.from` runs its map function; `from` and `new T(array)` convert every element with ToNumber (9f0c601e). Before, `Int16Array.from([1, 2], v => v * 1000)` ignored the map, `Float64Array.from(['1.5'])` kept the string and `Uint8Array.from('123')` read garbage | correctness; watr +96 B, Web Audio +414 B, checksums unchanged |

Across the 62-case corpus only these cases, hash (neutral) and bezfit, conv2d
and synth (smaller, timing neutral) change bytes; every checksum is unchanged.
Open, with diagnosis: Web Audio's hottest paths run generic typed-array and
length helpers (≈17% of Wasm time) because `AudioParam._tick` results join
object layouts with typed arrays; biquad needs loop-invariant typed-slot
promotion after its eight-stage unroll; wav's clamp remains an unpredictable
branch (branchless form +2% locally, unproven on x86). Radixsort still trails
Rust/Zig Wasm by ≈1.05–1.09× locally after the swap fix. Memory: the watr case's
excess RSS over V8 (≈33 MB) is its whole Wasm heap (32 MB), because the timed
loop cannot rewind its arena. `TypedArray.from` no longer blocks it (148c9180);
two blockers remain: `assemble`'s `sizeOnly ? b.length : b` joins a number into
the compile result, and `wasm.metadata = md` sets a dynamic property through
`__dyn_set`, whose enumeration-epoch write the rewind census treats as an escape.

| Gate | Current evidence | Remaining action |
| --- | --- | --- |
| Dependency | Official npm watr 5.11.8 and subscript 10.8.1, pinned by lockfile integrity; both installed as registry directories, not sibling links. | Keep the registry artifacts through final verification. |
| Correctness | Full local core passes 4805 tests / 125310 assertions. Registry self-compile passes 76 / 2496. WAT token storage passes 125 assertions across tiers; printer allocation fell from 2850519192 to 128312744 bytes. CI at bd3147fb passes all four matrix legs, fuzz and both conformance jobs. Forwarding `_compactCollections` through the test adapter clears the remaining Wasm-hosted allocation failure: the full local suite passes 3824 / 105287, kernel allocation 15 / 570 and two formerly skipped layout tests 2 / 45. Harness regressions pass 7 / 66, Porffor recovery 1 / 54 and merge 23 / 186. | Cleared in CI at 53257033: all four matrix legs, fuzz and self-compile pass. |
| Recursive bootstrap | Fresh registry kernel at 695a8b6b is 19842756 bytes, SHA-256 prefix 8d78c5ae91e0, attested to graph fee31f8c34c5. Functional, reuse-sequence and recursive gates are green, certified true. Recursive output is 19299633 bytes; final heap 1201128480 bytes. | Correctness attestation renewed. The compiler reserves 4 GiB for the checkpoint lane; heap headroom does not certify RSS parity. |
| Conformance | Final-tree runs pass: language 3195 passes, 4045 correct rejections, zero unexpected failures, two documented ordering exceptions; builtins 880 passes, zero unexpected failures, 43 expected failures. | Cleared for the supported subsets; these do not establish full test262 coverage. |
| Build/package | Browser assets and all 81 examples build; types pass. Package dry run includes both JS bundles and excludes the compiler Wasm. | Repeated after the function-order fix; cleared for this tree. |
| Size | All 59 speed and size checksums match after the linker-order fix; all binary sizes are unchanged. Current size binaries are smaller than the stored parity-valid AssemblyScript artifacts on all 50 comparable cases (geomean 0.779×), including all eight old recorded losses. | Refresh pinned reference evidence; the private size comparison does not update the public snapshot. |
| Performance claims | CI at 14e357b3 has 15 failed claims against stale committed evidence. The snapshot carries 14738.81 MB swap, above the 4096 MB limit. Superseded reference run 36155865964 was cancelled and its logs retained; the repaired harness needs a fresh reference run. The ordinary bench timing flake is fixed: 23 merge tests / 186 assertions pass with controlled anchor timings. | Run `bench` with `reference=true` against the final committed compiler; close every strict failure in the retained artifact before release. |
| Rival coverage | Entity checksum 1275530752 matches JZ, Node, native C, Go-Wasm, Zig and Porffor. Go/Zig resample match 1711808418. TinyGo 0.42.0 with Go 1.26.0 passes all 45 comparable cases. Native Go/Porffor resample FMA variants are independently verified. | Refresh all 45 rows for each rival on the reference machine. |
| Native adapters | Installed WABT headers and w2c2's changed ABI caused the remaining ordinary bench smoke failure. The adapters now pass real-tool checksum checks: WABT nqueens/tokenizer/wordcount and pinned current w2c2 nqueens/wordcount. W2c2 does not support tokenizer's multi-value returns; that smoke case stays on WABT. Source/installed headers, both w2c2 ABIs and unknown-header rejection pass 2 tests / 14 assertions. | Native smoke passes in CI at 53257033; fresh reference coverage is pending. |
| Web Audio | Fresh JZ and Node runs match checksum 2866527759; the stored mismatch is stale. | Refresh reference evidence. |
| Memory | Registry-package paired diagnostics: Jessie 106.4 MiB vs V8 95.3 MiB; watr 116.8 MiB vs V8 70.5 MiB. The allocation reductions have not closed those gaps. | The CI reference gate requires each allocation-heavy case to use no more peak RSS than V8. Fix any measured loss before release. |

The recursive build now fits through general allocation reductions: diagnostic
work only when requested, reused interval maps and summary views, no copied AST
declaration tails, one emission after failed static probes, captured cells only
on paths that use them, and numeric formatting that retains only its result.
Closure dedup hashes numeric bits and shares canonical declaration ordinals.
Minimal allocation tests pin the individual shapes; compiler input sources and
benchmark kernels remain unchanged.

Checkpoint serialization exposed a separate correctness defect: the writer
could wrap past wasm32's end before its final capacity check, overwriting static
state and heap diagnostics. Each write now checks its complete extent first;
reads use the recorded stream end retained across rewind. Integer lengths,
indexes and payloads use bounded unsigned LEB128. The boundary test covers all
five widths, empty and repeated checkpoints, truncated headers/payloads,
overflowing encodings and allocation collisions (456 assertions across O0–O3).
The final review adds missing-final-byte cases for every multi-byte reader and
checks that rejected partial writes preserve both bytes and the cursor.
The expanded memory sweep passes 88 tests / 1742 assertions across O0–O3;
the subsequent full core run passes 4749 tests / 120287 assertions, with the
same existing TODO and no compiler changes since the matrix above.
The worker also waits for its JSON report to drain before exiting, and preserves
the original compile failure if its diagnostics are damaged.

The full-suite exception failure came from address/tag CSE exporting an
initializer across an exit that could bypass it. Regions now close at abrupt
block exits and exception boundaries, while blocks without exits retain reuse.
A minimal branch kernel returned 88, 0, 0, 88 before the fix and 88 on every
path after it; both cache families are pinned against unoptimized Wasm. The
caught typed-store program matches Node through normal, throw and recovery
calls at every tier. The integer-loop assertion now checks integral locals
after slot reuse instead of requiring the optimizer to keep a particular name.

Native/kernel parity exposed a non-transitive function-order comparator: a
user function compared equal to two runtime helpers that compared unequal to
each other. Tied runtime functions now precede tied user functions, with
name order within the former and source order within the latter. Direct tape
tests cover empty, singleton, interleaved and repeated ordering; the self gate
checks native-identical bytes at O1/O2 through A → A → B → A compiles. The
59-case speed and size sweep changes eight binaries in each tier, with no
size or checksum changes.

## Performance priorities

The cancelled [partial reference run at 84f5cb6](https://github.com/dy/jz/actions/runs/36171204130)
retains six-pair diagnostics. Synth leads Bun and JSC at 0.847× runtime;
delayline leads them at 0.741× / 0.717× but trails Rust-Wasm at 1.072×.
Resample trails V8 / Deno / JSC at 1.140× / 1.186× / 1.222×.
SDF trails Deno / JSC / Rust-Wasm at 1.129× / 1.309× / 1.331×.
These are real optimization targets, beyond the stale committed snapshot.
The run predates the native-adapter repair and did not finish the corpus, so
it cannot certify release claims. All nine priority binaries are unchanged
by the current array-reserve candidate; await the complete repaired run for
the remaining cases and final gate verdicts.

**Active focus, September 25:** resample, sdf, spmv, synth, vm, colorlog,
crc32, delayline and dict. Recontest all nine against both Bun and the
standalone JSC shell. The vm/dict/crc32 claim exception remains a
regression band, not a reason to stop optimizing these cases.

| Case | Current diagnosis and next proof |
| --- | --- |
| resample | Checked gather-map SIMD preserves scalar address generation and each rounded phase addition, then packs the pure Float64 arithmetic suffix. Exact binary-grid bounds remove proven read checks without changing the recurrence. Distinct owned parameters and unconditional address caches prove independence; aliases, views, writes and live-out arithmetic retain scalar execution. Current speed binary 2290 bytes (2336 before this work; the initial SIMD candidate was 3492), size 1315 bytes, checksum 1711808418. Latest twenty-round probes win every pair against every measured rival on EPYC 9V74 and 7763; JZ/JSC medians 0.9566 and 0.9203. Full reference confirmation and a wider margin remain open. |
| sdf | Numeric scratch initialization, assignment-valued bounds and complete scalar-writer hulls retain integer gather indices and bounded square/difference arithmetic. Cached reads still preserve missing-value conversion; the sentinel regressions pin NaN and undefined separately. Current speed binary 3215 bytes (3427 before this work), size 2015 bytes, checksum 1749682117. Latest twenty-round probes win every pair against every measured rival on EPYC 9V74 and 7763; JZ/JSC medians 0.8896 and 0.9653. The narrowest median lead is 1.7% over Rust-Wasm on 7763. Full reference confirmation and a wider margin remain open. |
| spmv | Leads JSC in every round of both contests: earlier JZ/JSC 0.403–0.437, latest 0.421–0.481. Keep the indirect-gather path pinned and confirm on a quiet machine before refreshing the older public loss. |
| synth | Implemented as lazySelect in published watr 5.11.5: defer costly pure initializers to exclusive value arms before local reuse. Fresh six normal and six forced-optimized pairs both give 0.740× runtime; checksum 41574153 is unchanged. Speed grows 1676 → 2509 bytes; default/size stay unchanged. Of 59 standalone cases, the other 58 are byte-identical with the pass off/on. Four engine rounds favor JZ (JZ/JSC 0.793, JZ/Bun 0.828); an isolated six-round repeat remains favorable on median (0.911 / 0.893) but includes losses, so stable JSC leadership is still unproven. Watr source/Wasm suites and all 71 self-compile tests pass. Review also fixed partial-operand stack handling in the shared guard, with regressions for lazy select, value numbering and scheduling. JZ now depends on published watr ^5.11.6; fresh builds of all 59 cases in both speed and size modes match the verified candidate byte for byte and retain every checksum. |
| vm | Earlier near parity (JZ/JSC median 0.989; range 0.814–1.018); the latest four rounds lead at 0.863–0.950. The binary is unchanged by lazySelect. Keep dispatch and dependent operand loads under review; these noisy readings do not justify removing the claim exception. |
| colorlog | Checksum 297103274 still matches the existing exp2 exception in test/bench.js (within 1 ulp of V8, separately checked against a 200-bit reference); the JS engines give 3137122272. Preserve that numerical gate when optimizing the table/polynomial path. The runner correctly excludes this case from checksum-identical paired rankings. |
| crc32 | The dependent byte/table recurrence still trails JSC (latest paired median 1.401). V8 emits a wrapped 32-bit table-base addition before its load; JSC uses a native base plus scaled index. Adjacent-byte load widening regresses six normal / six forced-optimized pairs to 1.030× / 1.070×; moving the byte mask inside XOR gives 1.018× / 1.002×. Both stay out. A private WAT-only static-data experiment removes that base addition: ten paired after/before medians are 0.873 normally and 0.920 with V8 optimization forced, checksum 304463882 unchanged; binary 1485 → 2514 bytes. The experiment leaves runtime table construction in place and redirects only the fixed corpus reads. Next prove constant initialization and nonescape generally before adopting static placement; the experiment alone is not a compiler transformation. |
| delayline | Leads JSC in the public snapshot and both private contests (latest four-round median 0.862, every round below 1). Keep masked ring indices and the feedback recurrence as regression controls. |
| dict | The JSC gap persists: latest four-round median 1.408, isolated six-round repeat 1.350 with every round slower. The earlier slot-cache experiment removed two instructions but regressed ten normal pairs to 1.266× and ten forced-optimized pairs to 1.188×; keep it out. The V8 median moves from 1.200 to 0.748 between the two new contests, so leadership is not certified by these noisy readings. Next inspect branch prediction and address generation; fewer emitted loads alone do not prove faster execution. |

The initial nine-case readings used the unchanged corpus, four alternating
rounds per target, and the current uncommitted compiler tree. Later controlled
experiments are identified in the rows above. Large timing drift
makes them diagnostic only. Reproduce with
`JSC_BIN=~/.jsvu/bin/javascriptcore node bench/bench.mjs --targets=jz,bun,jsc,v8 --cases=resample,sdf,spmv,synth,vm,colorlog,crc32,delayline,dict --paired=4 --json=/tmp/jz-focus.json`.
Review also found that rounding a SIMD bound near INT_MIN could wrap an empty
range into work. The shared map/ramp/reduction/stencil/gather bound now
preserves signed entry guards and complete read spans. The native and
self-hosted gather regressions cover nonzero entries and negative limits.
All 62 corpus checksums and 234 SIMD tests (6675 assertions) pass. This
follow-up leaves resample at 3492 speed bytes and moves SDF to 3215 bytes;
the [boundary repeat](https://github.com/dy/jz/actions/runs/36190901654) wins
all sixteen pairs against every measured rival (JZ/JSC medians 0.9660 for
resample and 0.8892 for SDF). The [final repeat at b3f8f69](https://github.com/dy/jz/actions/runs/36191369808)
on EPYC 7763 is weaker: resample wins 13/16 JSC pairs, median 0.9779,
range 0.9019–1.0403; SDF wins 11/16, median 0.9678, range 0.9034–1.0636.
Neither row is closed by these measurements. The c2ab346 core suite passes
4813 tests / 127075 assertions; b3f8f69 conformance, opt0, opt3 and fuzz are green.

The next resample candidate bounds constant fractional recurrences on an exact
binary grid, then propagates only their truncated integer hulls. No addition
is reassociated. Proven reads keep the gather SIMD path through unconditional
shared-address caches, which are invalidated by writes. Speed size falls
3492 → 2290 bytes; size mode stays 1315 bytes. SDF stays 3215 / 2015 bytes.
All 62 corpus checksums, 236 SIMD tests / 6862 assertions, 62 performance tests /
1267 assertions and 78 fresh self-compile tests / 2763 assertions pass.
The [twenty-round CI probe](https://github.com/dy/jz/actions/runs/36193695518)
on EPYC 9V74 wins every pair against every measured rival. Resample/JSC is
0.9566 (range 0.9540–0.9577), SDF/JSC 0.8896 (0.8841–0.9124).
This does not erase the weaker EPYC 7763 repeat above.

Review also found a shared accumulator-proof bug: consecutive loops could
reuse one declaration as if it reset the accumulator before each loop. Both
integer and fractional indices then incorrectly dropped bounds checks.
The proof now requires independent initializers before joining loop hulls.
Direct regressions cover both forms; all 62 corpus checksums and binary sizes
are unchanged. The expanded performance sweep passes 62 tests / 1347 assertions.
The full suite and final CI checks remain required for this correction.

The [twenty-round repeat at 226fe198](https://github.com/dy/jz/actions/runs/36194596041)
on EPYC 7763 wins every pair against every measured rival. Resample/JSC is
0.9203 (range 0.9101–0.9244), SDF/JSC 0.9653 (0.9558–0.9774).
Both cases now have 40/40 JSC wins across the latest 9V74 and 7763 probes.
SDF's median lead over Rust-Wasm on 7763 is only 1.7%; these probes establish
measured leadership, not a large hardware-independent margin.

Final review reproduced another integer hull bug: a `continue` or short circuit
can skip an opposing step, so net motion does not bound repeated iterations.
The collector now bounds each direction separately and no longer computes a
net delta. Direct tests cover positive, negative and fractional opposing steps,
plus the short-circuit form; the fresh self-compile corpus pins the skipped
decrement case. The targeted sweep passes 920 assertions, self-compile passes
79 tests / 2790 assertions, and all 62 corpus checksums and sizes are unchanged.
Resample and SDF binaries are byte-identical to 226fe198, so the paired timing
evidence above still applies. CI at 15f7243f passes all four matrix legs, fuzz,
both conformance subsets and self-compile.

Keep the published snapshot unchanged until the tree passes its gates and
quiet measurements support a refresh.

Before the release fixes above, the integrated matrix reproduced baseline
failures (core/opt0/opt3/WASI: 3/3/5/13). The corrected tree now passes all four
legs with the scheduler-only candidate, plus self-compile and both conformance
subsets. The complete optimizer candidate separately passes self-compile.
Watr 5.11.6 is now published and locked; the release-status table above tracks
the registry-package verification. Private candidate results remain historical.

## Decisions

Architecture

- One lowering pipeline: parse → jzify → prepare → summary (a fixpoint solver
  behind a query view) → plan sweeps → narrow → emit → optimize → link. Watr
  owns generic propagation, folding, LICM, local-slot allocation and the final
  optimizer. There is no second IR layer, and no context, vectorizer or
  semantic-IR rewrite is a v1 prerequisite.
- The summary is the authority for shapes: construction identity, side
  properties, bounded shape sets, collection cells, positional rest facts and
  closure properties. Plan passes consume its views (`openSidOfExpr`,
  `spreadSidOfExpr`, `sideKeysOfSid`) and the frame-effects census
  (`writesOuter`, `arenaUnsafe`, `callsUnknown`, transitive callees). No source-plan pass
  keeps a private call or effect analyzer; where the shared evidence is
  silent, the optimization declines.
- Frame effects gate the arena rewind by age: an escape lowers the escape
  flag, where it runs, to the address it wrote into, and a frame restores the
  heap when the flag stands at or above its own mark. A temporary a call
  builds of closures, cells and objects goes with the call; a state made on
  the first call is kept once; a call the census cannot name is no escape,
  since what it runs lowers the flag itself. A store of no heap value lowers
  it only where the store allocated, an assignment only for a value a running
  call made. An escape with no address that every call runs, and a frame
  that suspends, keep the frame whole; a loop whose iteration lets nothing
  escape restores the heap pointer per iteration, and `whyNotRewind` names
  each candidate that keeps its heap and each flagged frame's first site. A
  store into a parameter the export boundary types is a number into fixed
  storage, not a growth; the loop to rewind is found by its label, which the
  peephole walk keeps where it copies the loop's node. A render loop with a
  block per iteration holds the memory flat (`test/mem.js`). A frame that
  ran an escape keeps what the escape reaches and what lies below it
  (`arenaReach`, module/core/reach.js): the walk from the receivers its
  escapes wrote into moves nothing and frees the heap above the highest block
  reached. What a call replaces in older storage is never freed: that needs
  a collector.
- Only a DEFINITE store declares a key in a literal's layout. Static
  enumeration stands down whenever the layout is open; the open-layout for-in
  unrolls the closed keys only when neither the layout nor the keys added at
  the receiver's construction sites contain an array index, since JS
  enumerates integer keys first (a layout's added-key facts are per site: two
  literals of one layout keep their own).
- Class identity survives serialization: `jz:brand` names each class layout
  (`Name#id`) beside `jz:schema`, `jz:fields` and `jz:errcls`, so two classes
  with one field list stay two schemas, and a host object that matches only
  such layouts by keys is ambiguous. A pointer carries the schema id its
  module compiled with, so a module whose schema would bind at another id in
  the memory it joins is rejected at instantiation, before the memory's tables
  change: modules sharing a memory are one compilation or the same module
  again, and their host references live in one table.
- A class is a schema across modules: prepare brings a module's imports in
  ahead of its lowering, so a base class of another module resolves; async
  and generator methods hoist with their kind; `'m' in o` sees members. A
  class keeps its closures only inside a function, under a base the module
  cannot see, or as an expression with statics (`class-generic` says which).
- The summary consumes what the emitter does: `fn.call`/`fn.apply`, a static
  call through its lifted function, an optional call, a call through a nullish
  slot, `Object.defineProperty` as a store, an inlined callback's element
  parameter as the element, a class member on an unknown receiver with the
  family of classes that share it. A method inherited by a family reads its
  fields as slots (`commonSlot`) and calls a member every layout resolves to
  one function directly. `why` and any `warnings` sink report `shape-lost`,
  `class-generic` and `deopt-prop-read`: the census a dynamic library is read
  by (`scripts/why-census.mjs <case>`).
- Warnings are delivered after the pipeline returns, so a warning callback
  may compile again; a compile attempted while the pipeline is active is
  rejected. The compiler context is a singleton by design.
- `E[Symbol.iterator]()` is the iterator over E for every receiver
  (`__it_from`); the protocol lowerings are gated by the program's iterator
  producers, witnessed over every module before any is lowered, so a module
  iterates what another one mints. The summary names each minted record by
  its call node and keeps the source (or a generator's own closures) beside
  it: `it.next().value` is the element, not the join of every mint. A class
  initializer runs once per receiver layout in the summary (initializer
  contexts), so a derived class's `super(…)` no longer joins its arguments
  into every layout of the family; a lost shape escapes only the fields a
  read through an unknown receiver cannot answer precisely. The summary
  walks what the program reaches (exports, escaped and host-held callables,
  module initializers, and what their walks call): an API surface the
  program never exercises cannot pollute the allocations the exercised one
  shares.
- Booleans ride either carrier, the raw 0/1 or the atom box. A test of a
  BOOL-typed f64 is the number test, then the atom compare.
- Export boundary: an array argument runs in its own element kind (the
  export's Float32Array variants, chosen by the host), is copied back after
  the call nested arrays included, and is released with what the call made
  unless the call keeps it; a typed array stored on a host object stays the
  module's storage.
- Export boundary: a parameter an exported function never uses as a string is
  compiled as a number and converted at the boundary (README lists it);
  typed-array index parameters are numeric; property keys cross as strings.
  Named typed-array keys use property storage, canonical numeric keys convert
  to elements. Array indices follow the documented i32-truncating contract;
  object keys keep fractional names.
- Numeric lowering (CONTRIBUTING has the forms): range-proven values avoid
  general conversion helpers. Checked integer reads stay in words through
  integer conversions and comparisons; missing elements remain undefined
  until the consumer decides their result. Load CSE keeps an exit-only
  `if`'s loads, small-constant unrolling has a cost budget, and watr's `ifset`
  leaves a branchy condition alone.
- Transcendental polynomials share one evaluation tree (`polyTree`) across the scalar
  WAT, the two-wide WAT and the JS constant folder, so the three agree bit
  for bit. exp and exp2 are one table kernel at 0.5 ulp; atan keeps its
  minimax speed trade. Asin and acos use fdlibm with a 1-ULP gate. The LAB colour cases gate
  through `LAB_SPEED` with a named, measured divergence from V8 instead of
  checksum equality.
- The source inliner splices a multi-declarator declaration only in an
  innermost loop, the loops the vectorizer takes. A `let`-declared local
  arrow inlines like a const one.
- The bench measures the first call of a fresh process, so a large speed-tier
  module pays Liftoff until TurboFan lands. watr's ratio is that tier-up; its
  steady state is 1.24× of V8's warmed JS. The lever is a smaller hot module
  (cold paths out of line, a size-aware branch-speculation budget), not a
  different steady state.
- Gated invariant checks stay: frame effects, kernel parity, output-size and
  loop-count ratchets and the speed pins in `test/bench.js` protect compiler
  development and are not the source of complexity.
- A per-iteration rewind is registered under its function's name by the
  loop's label: labels count from zero in every function, and a module-wide
  registry handed the first function's loop of that label another function's
  proof.
- A module joining a shared memory is validated before it is instantiated:
  its tables are read from the custom sections and merged on copies, so a
  rejected module's start function, data segments and tables never touch the
  memory, and a merge commits whole or not at all.
- An object literal's accessor is the one own property it defines wherever a
  property is listed, copied, keyed or deleted: Object.keys, values and entries,
  for-in, `in`, JSON.stringify, Object.assign, spread, structuredClone, a
  computed key and an object the host receives see it through the layout's
  enumeration view (`layoutView`), which reads it through its getter once;
  JSON.stringify calls a value's toJSON, its own or its class's, with the key
  (CONTRIBUTING has the forms).
- A layout slot marked hidden (`ctx.schema.hidden`) reads, writes and calls
  as before, but the enumeration view drops it: an Error's `message` and
  `name` and a closure-lowered class's methods and accessors are not listed,
  copied or serialized, as in JS. A program with neither pays nothing.
- A host object that matches no layout stays a host reference: `in`, keys,
  values, entries, for-in, spread, Object.assign and JSON.stringify go through
  the host, so the caller sees the module's writes (README states it).
- A runtime key reads a string's index and an array's `length` in the
  lookup chain's string and array arms, which ended at `length` and at the
  indices; a first-character digit test read in place keeps an identifier
  key off the index parse. A canonical index literal takes the index dispatch.
- Derived closure-class methods use a hidden rank in the existing property hash;
  growth preserves it and an own assignment restores enumeration. Runtime keys
  read Map/Set size and source function arity through the shared lookup chain.
  Function arities stay beside closure table entries after body deduplication.
- An array hole is an `undefined` element: `[1, , 3]` lists `"1"`. The
  divergence is in the README; a hole would need an element value apart
  from undefined, tested on every read.
- An array pattern over a value the summary proves an array reads by index
  (a plan sweep): the protocol's cursor record and its pool are module state
  no rewound frame may touch, and the protocol cost a call per element.
- The frame census names the class functions a member reaches on the
  receiver's listed layouts, a receiver that may be nullish or of several
  classes included, and reads through the function's own summary view; a
  loop's callee allocations belong to the iteration. Before this, every
  accessor-named read anywhere made its frame unsafe, and the census ran on
  the module's view, where a parameter had no kind.
- A loop marker is validated against the loop's own tape at link, not the
  whole function's; the schema-keyed inline caches and the coherent
  dynamic-get cache are no veto. webaudio's per-sample loops rewind: one
  render allocates 87 MB and keeps 9.
- A derived class's accessor is a class function of its own schema, not a
  dynamic install: the dispatcher's fallback probes for an accessor slot only
  where an object literal's schema or a static pair may carry it.
- `slice` yields an array with a cell of its own: the receiver's positional
  row carried over unshifted, so `['func', [..]].slice(1)[0]` read as a
  string.
- Object methods receive `this` at invocation through the closure ABI,
  including optional calls, accessors and callbacks with `thisArg`. Generators
  capture it before suspension. This removes the per-object receiver capture;
  programs without receiver reads omit the ABI slot. Class methods retain
  the documented bound-method contract.
- Prepared statement lists share the block emitter's flow facts and
  invalidation. A throwing typeof guard retains its callable proof, so an
  unshadowed closure `call` uses the invocation ABI without a property probe.

Dependencies

- subscript ^10.8.1 and watr ^5.11.8 from npm; watr carries the two
  optimizer rules the speed rows rely on (the mixed-sign truncation-of-convert
  fold for base64, `ifset` declining a branchy condition for sort), so a clean
  install includes those rules and the lazy-select/partial-operand fixes.
- CI runs one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check). The self-compile perf gate is
  `npm run test:self:perf`, a local release step.

## Remaining release work

1. **Runtime and self-host speed.** Close the red rows listed in the gate
   evidence below, plus webaudio and watr. Caps stay unchanged; benchmark
   sources stay fixed. Paired local measurements on this loaded machine
   are diagnostics, not release evidence.

   The active nine-case work is listed under [Performance priorities](#performance-priorities).

   | Remaining class | Evidence and next proof |
   | --- | --- |
   | SDF scratch-array gathers | Sentinel guards remove the hull cursor's checks on the fast path (below). The rest is loop-carried forwarding, read off V8's TurboFan code for both builds: clang's pass keeps `v[k]` (the `q` just stored) and `z[k]` (the `sMid` just stored) in registers, so the `f[v[k]]` gather issues at once and the first pop test is `fcmp` against a register; JZ reloads `v[k]` at the top of each pass, a dependent load before the gather and the divide. Carried elements now forward `v[k]` (below). The guarded pop and scan tests lower to `fcmp; cset; cbz`: watr's `conditions` pass chains only `local.tee` diamonds, and the guard's `&&` has a constant arm (below). `z[k]` would need the pop's first test peeled; its load issues beside the divide, off the critical path. |
   | Bounded byte/short accumulators | Twin locals give glyph parsing's versioned coordinate loops i32 locals of their own, and the word-storage census admits the flag loop's `rep`, whose checked read meets only `rep > 0` and the decrement that test guards (below). Glyph parsing reaches parity with C-Wasm; a clear lead needs quiet evidence. |
   | Noise's dependent lookups | The candidate preserves all-writers element hulls through in-place copies and swaps, and preserves intervals through load-CSE's unary plus. Four lookup checks disappear, but the Rust-Wasm gap is still open. |
   | FFT, sort, CRC32, wordcount | CRC32's red is timing noise: in V8's TurboFan code for both builds the per-byte recurrence is five dependent instructions (`eor`, mask, table add, `ldr`, `eor`); clang only fuses the mask with the shift (`ubfiz`) where JZ fuses the shift with the table add, and JZ's loop test adds one `cmp`. The committed rows lead (0.988×). FFT and sort vary between runs. Wordcount's duplicate tag check is removed and the latest row passes. The attempted FFT pointer advancement lost both speed and size. Require quiet paired evidence before treating a fluctuating row as closed. |
   | webaudio | Numeric-width loop versions retain all numeric input types and specialize floating outputs. Reprofile receiver reads and automation callbacks before adding another version. |
   | watr | Separate cold tier-up from steady-state helper work. Cold paths out of line and size-aware speculation remain the useful levers. |

   Retained diagnostics:

   - The checked-integer and global-length work makes percolation 7.6–8.0%
     faster across three grids and four occupancies, with identical outputs;
     its binary shrinks 13168 → 12969 bytes. Final paired V8/JZ is
     1.046–1.048×, with narrow margins that still need quiet evidence.
   - The validated candidate reuses the binding-use census to keep checked
     integer locals in words when every consumer already converts to a word.
     Glyph parsing shrinks 3124 → 3011 bytes, noise 2307 → 2116 bytes.
     SDF, wordcount and FFT remain byte-identical to 4b729882.
     Noise's final range fix measures 2987 → 2954 µs in ten alternating
     forced-optimized pairs, about 1%; glyph timing establishes no gain.
     Checksums match. An exposed pre-existing typed-store defect is also
     fixed: element dispatch and property storage convert an object key once.
   - Adjacent integer min/max updates now share the statement scheduler's
     loop walk. Deferring the recurrence input reduces Levenshtein's optimized
     paired median 1788 → 1232.5 µs (31%); normal-tier pairs give
     1939.5 → 1228 µs. All checksums are 981953199 and the speed binary stays 1920 bytes.
     Eight focused tests pass (1871 assertions), covering signed/unsigned
     comparisons, both operand orders, word boundaries, zero work, repeated
     calls, JavaScript parity and effects that forbid reordering.
     The combined benchmark closes the Levenshtein row: 1.22 ms versus
     AssemblyScript's 1.69 ms (0.721×). This agrees with the paired improvement.
   - Dictionary probes reuse the emitter's string-key proof, removing a
     duplicate tag test. Wordcount shrinks 4333 → 4318 bytes. Two sets of ten
     alternating normal-tier pairs improve 909.5 → 568 and 823.5 → 594.5 µs;
     forced-optimized measurements vary, so this is not a steady-state claim.
     The same audit fixed a pre-existing growth allocation: the optional
     four-byte hash lane was counted as a boolean byte. Host collection
     decoding now shares forwarding, tombstone filtering and insertion order.
   - Twin locals (`compile/twin-locals.js`) version a counted loop in the
     source when its checked twin would widen the fast copy's locals: the
     twin declares its own names, so glyph parsing's fast coordinate loops
     accumulate in i32 while the twins keep f64. Sixteen alternating rounds
     measure 1.162 → 1.060× C-Wasm with checksum 4073289688 unchanged; the
     speed binary grows 3082 → 3174 bytes. The fast loops match a scratch
     variant with hand-written `| 0` hints op for op; that variant also
     hinting the flag loop's `rep` reached about 0.96× C.
   - Carried elements (`compile/carry-elements.js`) keep an element a loop
     stores for its next pass in a local. In V8's code for SDF's first pass
     the `f[v[k]]` gather now issues from a register, as in clang's; the
     binary grows 4 bytes and the checksum is unchanged. Paired runs at load
     9 measure no difference (1.001 and 1.006 of the build without it):
     the gather was not the bound. C-Wasm runs at 0.839 of JZ in the same
     pairs.
   - watr's `conditions` pass now also chains a diamond with a constant arm,
     the boolean `a && b` / `a || b` (included in watr 5.11.5): each
     guarded SDF exit becomes one fused compare-and-branch per conjunct, and
     V8's `edt1d` drops 565 → 556 instructions and 11 → 2 `cset`s with the
     checksum unchanged. The shorter code is not faster: paired runs at load
     9 measure SDF 2.8–3.7% slower, with `edt1d` differing only in the
     `cset`s; glyph parsing measures 3% and sort 7% faster, LZ 2% slower,
     trace level. Almost every benchmark binary shrinks, the self-compiled
     compiler by 14.5 KB. JZ now receives it from the published dependency.
   - The word-storage census admits a checked integer read whose uses
     answer undefined and zero alike, including a constant step the test's
     true arm guards: glyph parsing's `rep` becomes a word. Sixteen rounds at
     load 11 measure the original 1.122×, twin locals 1.023× and both
     0.998× C-Wasm, checksum unchanged, 3144 bytes.
   - Sentinel guards (`compile/sentinel-guard.js`) version the reads that
     only SDF's `±∞` sentinels bound: the hull pop, the scan and the read after
     the scan run unchecked under one range test per pass. A relational test on
     a typed read now proves its index where the test held, and each access
     node keeps its own proof beside an unprovable twin. Paired SDF medians
     improve 1.407 → 1.190× C-Wasm and 0.974 → 0.820× V8 with checksum
     1749682117 unchanged; the speed binary grows 3056 → 3292 bytes and the
     size tier copies nothing. Removing every remaining check in the kernel
     (WAT surgery, measurement only) reaches about 0.75× of the original
     against the guards' 0.83×.
   - The interval proof iterated body-entry states and took a loop's exit
     from the body's end. Two pre-existing miscompiles followed: after
     `while (i < 5 && j < 3)`, `a[j]` read 0 instead of undefined, and after
     `i = 1; while (i < 10) i += 2`, `a[i]` read 0. Loop proofs now iterate
     the head state and exit where the test failed (`test/interval-proof.js`).
   - Loop rotation cannot rotate SDF's loops while their per-iteration
     arena-rewind markers remain; `arenaRewind` removes them only after
     `rotateLoops`. Running the rewind first rotated all six `edt1d` loops
     but measured about 1%, so the link order is unchanged.
   - Cursor guards require a local that exists at entry and whose writes are
     all covered by the body budget. Nested declarations, header writes and
     external mutation cannot borrow that proof. A nested gather formerly
     returned 7 instead of NaN. Removing its invalid loop version also shrinks
     SDF 3583 → 3056 bytes; ten optimized pairs measure 7574 → 7593 µs with
     checksum 1749682117 unchanged, so the size win is established, not a
     speed win. The corrected tree passes the correctness gates below.
   - webaudio's five paired runs improve 7.447 → 6.471 ms with checksum
     2866527759 unchanged, versus the earlier V8 diagnostic of 4.88 ms.
     Speed size grows 598817 → 616071 bytes; size mode skips width versioning.
     All 16 numeric input/output combinations remain covered.
   - colorpq's scalar/SIMD pow, value numbering and scheduling are implemented:
     49.4 ms with the passes versus 86.8 ms with both disabled, 16197 →
     15014 bytes, matching checksums. Ulam's early-return inlining improves
     1.440 → 0.780 ms versus V8's 1.313 ms, with identical pixels.
   - The combined tree passes self-compile speed: warm 0.969× (cap 1.03×),
     fresh 0.790× (cap 0.99×). The preceding tree measured 0.955× / 0.775×,
     with an earlier fresh run failing at 1.073×. These loaded-machine
     timings still need quiet reference evidence.
   - Published watr 5.11.2 closes the 320000-byte size backstop. The latest
     completed benchmark build is 319898 bytes. Its shared optimizer rules
     and JZ's dependency are implemented, not pending release work.

   Rejected experiments stay out of the compiler: a wordcount propagation
   extension saved 49 bytes but had inconsistent runtime results; stamping
   glyph-count bounds generated identical Wasm. A scratch guarded-i64
   accumulator extension increased glyph size 3011 → 3441 bytes and paired
   optimized time 8408.5 → 9422 µs with the same checksum. That result points
   to bounded i32 narrowing without an in-loop guard, not a larger wide loop.
   Earlier self-host wrapper isolation, forwarding inlining, leaf-skipping
   visitors and broader read reuse also measured no gain and were removed.
   Advancing six pointers in the SIMD butterfly instead of calculating
   addresses also loses: 2872 → 2947 bytes and 1082.5 → 1090.5 µs in ten
   optimized pairs. It remains out of the source. Making all checked SDF reads
   branchy saves 55 bytes but measures 7683 → 7821 µs, so that policy stays
   confined to its existing consumers.

2. **Memory.** Close the Jessie and watr RSS gaps. webaudio already measured
   70.3 MB versus V8's 70.6 MB on the earlier paired tree: per-sample arena
   rewind keeps one render's 87 MB allocation volume to 9 MB retained.

   Paired diagnostic readings with registry watr 5.11.8 and subscript 10.8.1 are
   Jessie 106.4 MiB vs V8 95.3 MiB and watr 116.8 MiB vs V8 70.5 MiB. Both gaps
   remain open. The measurements below record the earlier allocation work.
   Exact nonempty-literal capacity reduced Jessie's paired peak
   177.4 → 163.0 MB with unchanged checksum and median runtime; two-slot
   property sidecars saved approximately another 18 MB. Watr's paired peak
   moved 170.8 → 166.6 MB. These are diagnostic improvements, not parity.

   Array slice views (`compile/array-view.js`) remove `parse.asi`'s suffix
   slice: its `items = b.slice(1)` is spread straight from `b`. One Jessie run
   allocates 81.3 → 48.2 MB and its linear memory stays at 64 MB instead of
   128 MB; peak RSS measures 145.6 → 110.3 MB with checksum 2418067300
   unchanged. The speed binary grows 234 bytes; the size tier keeps the copy.

   Fresh allocator instrumentation at 53257033, with the published dependencies
   and unchanged corpus, measures Jessie at 50503412 requested bytes in 281803
   allocations. About 34.9 MB comes from new `parse.asi` statement lists:
   each recursive level copies the list below it, and only the outermost
   survives. The remaining work needs a general ownership/lifetime proof to
   reuse or reclaim those copies while preserving aliases and source locations.
   Checksum 2418067300 and 64 MiB linear memory are unchanged.

   The same trace measures watr at 25860734 requested bytes in 279670
   allocations, checksum 3419154861 and 32 MiB linear memory. The old 37.2 MiB
   buffer diagnosis is obsolete: `makeByteBuf` now contributes 4737024 bytes,
   using two 4 KiB buffers per assembly. Short empty arrays and named-property
   storage account for much of the remainder. The loop cannot currently rewind:
   `assemble` reaches unclassified calls and persistent encoder memo tables,
   as well as module error-source state. Recognizing `Uint8Array.from` alone
   would not prove that rewind safe. Closing this gap needs lifetime proof
   for individual temporary buffers, while preserving returned bytes and
   those persistent roots. Keep the dependency and benchmark input unchanged.

   The speed-tier candidate uses `arrayMinCap: 4`, reducing watr's requested allocation
   to 18940958 bytes (26.8%), with 286006 allocator calls; Jessie changes by
   only 96 bytes. Both checksums match. Eight alternating runtime pairs per
   case in normal and forced-optimized V8 give cap4/cap16 medians of
   1.023 / 0.994 for Jessie and 1.019 / 0.982 for watr. Watr peak RSS falls
   about 7–8 MB, but the noisy timings establish no reliable speed benefit.
   This is a memory reduction, with its runtime tradeoff still subject to the
   unchanged CI gates. All 62 non-self-host workload checksums match the old
   reserve; 56 binaries are byte-identical, including all nine priority cases.
   Entity, gainclass, Jessie, watr, Web Audio and wordcount change; none grows.
   Sixteen further alternating pairs per changed case, in normal and
   forced-optimized V8, give watr 0.816 / 0.951 and Web Audio 1.014 / 1.014;
   the other four medians stay between 0.956 and 1.006. Watr peak RSS falls
   6.8–7.2 MB. This loaded-host check contains large outliers, and Web Audio's
   small slowdown remains a reference-CI question rather than a dismissed loss.
   Self-compile passes 76 tests / 2496 assertions. The allocation regression
   covers empty and zero-work builders, growth across 4 and 16 elements,
   retained aliases, exact undefined holes and A → A → B → A construction.
   Instrumented runs measure allocation volume only; these local controls do
   not replace reference CI evidence. Jessie's copied lists still need a
   general ownership/lifetime proof; neither aliases nor host-observable
   properties may be discarded on the strength of the benchmark trace.

3. **Reproducible speed, size and memory evidence.** `bench/results.json` is
   stale: timed above the 4096 MB swap-validity cap, only 43 comparable
   Go-Wasm/Zig-Wasm/Porffor rows and no valid TinyGo rows against the current
   45-row coverage floor, and alpha's w2c row no longer
   describes the tree. Regenerate through the benchmark runner on quiet
   reference hardware with current compiler and memory-baseline provenance.
   Keep TinyGo 0.42.0 and the same-machine Porffor comparison. Local paired
   timings and standalone size sweeps do not replace this evidence. After the
   final matrix, this host still reports 19621.44 MiB of swap, above the
   4096 MiB evidence-validity limit.

   The manual benchmark workflow now measures six paired rounds on CI and
   runs `test:claims` against that exact JSON, retaining results and logs even
   on failure. Linux swap is measured from `/proc/meminfo`. Paired RSS includes
   both positions and rejects missing readings. The claims gate requires the
   complete corpus, ancestor commit provenance and valid machine metadata.
   Jessie, watr and Web Audio each have a strict JZ/V8 RSS floor.
   RSS provenance covers both JZ and V8 even without timing measurements;
   explicit invalid row stamps cannot borrow fresh snapshot metadata.

   Ordinary CI publication now compares the measured input tree with main,
   excluding the workflow's ignored documentation and generated evidence paths.
   A plan update during measurement no longer discards a valid snapshot without
   triggering a replacement run. Source, dependency, kernel and workflow changes,
   deleted inputs and rewritten history still prevent stale publication.
   The full tooling suite passes 24 tests / 206 assertions, including 20 direct
   assertions against the workflow's guard in an isolated Git repository.
   The Pages publication fixture distinguishes a staged snapshot from changed
   inputs; the full local site, headline, browser and guide smoke gate passes.

   The superseded reference run 36155865964 exposed two harness failures:
   a failed self-build was retried at its 600-second limit in every paired
   position, and JS runners lacked the self-compiler's native heap adapters.
   Failed builds now stop that lane; counted runtime failures also stop it,
   while a transient warm runtime failure may still recover. Other lanes and
   later cases continue. Module and bundled JS runners use the same zero-mark,
   no-checkpoint adapter already used by the self-compile performance gate.

   Latest benchmark CI run 36109730855 failed only the stored alpha wasm2c
   ratio (3.52× against a 3.5× cap). Native reference checks now live with the
   other claims, retaining the 20-row coverage, 3.5× per-case and 1.35× geomean
   caps. The manual run measures wasm2c before checking them, so stale evidence
   cannot prevent its own refresh. The repaired native smoke now passes in CI;
   reference run 36173446401 is measuring the reviewed tree. Self-compile and
   both conformance jobs, all four matrix legs and fuzz at 53257033 are green.

   The earlier TinyGo build covered all 44 cases then available. Forty-three
   match committed checksums; entity's 1275530752 matches the separate V8 reference run.
   That build defect is closed; the expanded 63-case corpus now requires 45
   comparable rows, so both coverage and committed evidence still need work. The latest
   focused run still used about 25.5 GB of swap. Its JZ/rival medians were
   glyfparse/C-Wasm 1.418×, SDF/C-Wasm 1.420×, noise/Rust-Wasm 1.148×,
   wordcount/C-Wasm 1.011×, watr/V8 1.546× and Jessie/V8 0.988×.

4. **VST follow-up after JZ v1.** The audio compiler's current README explicitly
   defers native release work until JZ v1 and requires verification from its
   installed tarball. The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Use
   `org.audiojs` for the permanent vendor root, matching the audio compiler
   contract and the user's audiojs choice. Restart-flagged edits take effect
   on next setup; active restart needs the component-handler interface.
   Events and wider layouts remain refused.

5. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation and work proofs unknown. Empirical block checks prove
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gates for independent review.
   Implementation alone is not expert approval.

## Gate evidence, September 23

Validated candidate on top of `b0f38d36`: dictionary key-proof reuse, corrected
collection growth, shared host collection decoding and sound cursor guards.
The full sequence ran with the same 318 source/test inputs, checked by digest
before each gate and after completion. The preceding checked-integer and
recurrence-scheduling changes are committed in `22a9712f` and `b0f38d36`.

- Core: 4651 passed, one skip (118756 assertions). Opt0: 4459
  passed (96342 assertions); opt3: 4459 passed (96805 assertions);
  WASI: 4512 passed (109317 assertions), each with one skip. All four ran
  on the same compiler tree with published watr 5.11.2. No compiler source
  changed during these gates.
- Self-compile: 70 passed (2369 assertions). Perf ratchet: 10 passed.
  The final self-compile speed run passes: warm 0.969× V8 (cap 1.03×), fresh
  0.790× (cap 0.99×). An earlier fresh run failed at 1.073×; the old/current
  comparison and loaded-machine limitation are recorded in item 1.
  Public types and import lint pass.
  The fresh private kernel passes the growing-dictionary and nested-cursor
  regression samples. Local `dist/jz.wasm` was also regenerated from the same
  source: 19048276 bytes. Generated artifacts remain uncommitted.
- Language conformance: 3201 pass, zero failures, two xfails; all 4045
  negative syntax cases reject. The receiver suite passes 23 tests in both
  hosts, including captured iterator operations, spread callback receivers
  and strict closure calls with effectful receiver arguments.
  Built-ins pass 878 cases, zero failures and 44 xfails.
  Ten invalid programs accepted by 070f9adb now reject: duplicate method
  parameters, restricted async grammar and mixed static/instance private
  accessor pairs. They reject through the Wasm-hosted compiler too. No xfail,
  negative ledger or coverage floor changed.
- The full benchmark: 266/271 pass. Speed geomeans are 0.473× V8,
  0.706× native C and 0.493× AssemblyScript; size is 0.781× AssemblyScript.
  Perf-fuzz passes (integer 0.88×, float 0.69×, mixed 0.85× V8), as does
  floatbeat (0.400×). TinyGo coverage passes. Watr's size backstop passes at
  319898 bytes against 320000; its runtime is 1.041× V8 in this run.
- Five checks remain red: SDF versus V8 1.016× and C-Wasm 1.526×,
  glyfparse versus C-Wasm 1.085×, CRC32 versus C-Wasm 1.053×, and alpha's
  stale committed w2c row. Levenshtein is 0.733× AssemblyScript and wordcount
  is 0.851× C-Wasm, following the measured changes above. FFT, sort and noise
  pass this run; those flips alone do not close their standing gaps.
  Timing bands and all caps remain unchanged.
- The example driver had stale arguments for Ulam, waves, attractors and
  raymarcher. Their calls now match the current kernels, and an untimed
  arity check validates all 21 drivers. Lenia's effective zero seed is
  explicit. Kernel sources and timing caps are unchanged. Ulam's zero-size,
  repeated-view and changed-view outputs match JS pixel for pixel at O0,
  O3 and WASI. The current example run has a 1.60× V8/JZ geomean and 21/21
  strict wins; the new candidate run measures 1.58× and also wins 21/21.
  The preceding run measured Ulam 1.66×, waves 1.12× and percolation 1.09×. Percolation's
  separate three-grid paired comparison establishes the 7.6–8.0% improvement
  recorded above; the benchmark alone does not establish a waves improvement.
  Ulam's five alternating before/after/V8 measurements give
  a 45.9% runtime reduction and 1.68× V8 speed, with identical pixels at
  three camera settings.
- The focused typed-loop suite passes 19 tests and 3671 assertions, including
  primitive signed-zero comparisons that the array deep-equality helper omits.
- The machine uses 23999.56 MB of swap, above the 4096 MB reference-evidence
  cap. These are diagnostics,
  not refreshed release evidence. No timing, size or memory cap was changed.
- The original four review fixes have regressions in `test/destruct.js`,
  `test/value-number.js` and `test/schedule.js`. Addition carriers and
  private inlined parameters are pinned in `test/bigint-tag.js` and
  `test/optimizer.js`; self-hosted dictionary output remains byte-identical.

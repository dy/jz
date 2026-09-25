# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants. This file tracks open work
and current evidence. Superseded measurements remain in git history.

## Current status, September 25

**V1 is not ready.** The recursive self-host overflow, seven earlier kernel
failures and Watr's size overage are fixed. Runtime speed, library peak memory
and current reference evidence still block release. No cap, benchmark source
or conformance allowance was relaxed.

The candidate is on `codex/v1-review-ci-20260924`; main is untouched.

| Gate | Latest completed evidence |
| --- | --- |
| Native default, O0, O3, WASI matrix | All pass at `6e41b9e3` |
| Conformance and fuzz | Pass at `6e41b9e3` |
| Full self-compile workflow | Pass at `6e41b9e3`, including the complete Wasm-hosted suite and recursive compiler check |
| Conditional tuple follow-up | `28978e54`: 273 affected native tests, 161 WASI and 231 hosted assertions pass; all 20 kernel parity cases and recursive child compilation pass locally; full CI pending |
| Fixed typed-storage follow-up | 282 affected native tests / 7330 assertions, 2316 WASI and 1575 hosted assertions pass; 20/20 kernel parity and recursive child compilation pass locally |
| Instruction ratchet | 10/10 after the tuple and fixed typed-storage changes |
| Watr size backstop | 311185 bytes after fixed-storage decoding, below the unchanged 320000-byte cap |
| Benchmark CI at `6e41b9e3` | Sole hard failure: alpha's committed w2c/JZ size ratio 3.52× exceeds 3.5×; timing diagnostics still contain losses |
| Reference claims | 13 failed checks against stale evidence; this is not a claim that 13 new compiler regressions appeared |

## Architecture decisions

- Keep one pipeline: parse → jzify → prepare → summary → plan → narrow → emit
  → optimize → link. Summary owns shapes and callable facts; its query view
  and the shared frame-effects/binding-use censuses feed consumers. Watr owns
  generic propagation, folding, LICM, local-slot allocation and final WAT
  optimization. No new IR, context or vectorizer rewrite is required for v1.
- Optimizations must cover a class of programs and have a minimal regression
  kernel. Bench and example sources are fixed specimens. Emission cannot
  invent a proof where shared analysis is silent.
- Keep UTF-16 strings with encoding at explicit byte boundaries. Only proven
  private builders may grow in place; aliases keep immutable values. Copied
  concat correctness runs at every tier, allocation bounds at O0–O3 under the
  existing tier contract. Size mode may merge concat helpers.
- Use schema identity through analysis and interop. `jz:brand` disambiguates
  classes with the same fields. Shared-memory tables validate before an
  instance can write; host references stay in the host table. Hidden Error
  and closure-class fields share the enumeration view. Runtime keys use the
  same lookup chain as static keys.
- Reuse frame-effects proofs for function and iteration arena rewinds. A
  retained allocation vetoes rewinding. Scalar results alone do not prove
  that a function retained nothing. Typed storage does not relocate; generic
  collection forwarding belongs only on receivers that can grow.
- Numeric bounds and consumer proofs permit word storage without changing
  unbounded JS addition into wrapping i32 addition. Checked reads retain
  undefined until the consumer decides its result.
- Equal-width conditional and literal tuples share the multiple-result ABI.
  A block must prove all paths return before choosing it. Statement and
  expression returns share boxing, evaluation order and finalizers.
- Keep the compiler context singleton contract. Deliver warnings after the
  pipeline returns; reject a nested compile while it is active. Development
  invariant checks and gates stay outside product diagnostics.

Dependencies are Subscript `b0e3a65` (on 10.8.0) and Watr `0dc48ac` (on
5.11.3), both public pins. The Watr pin also carries the scheduler, printer,
parse-location and buffer changes used by this candidate. Return to published
versions when they include these changes. CONTRIBUTING records their contracts.

## Remaining release work

### 1. Runtime and self-host speed

The completed seven-pair CI probe at `28978e54` used AMD EPYC 7763, Node
24.21.0. Checksums match. JZ/V8 medians are WebAudio 1.431×, Watr 1.040×
(range 0.743–1.194), and Jessie 0.748×. The preceding `6e41b9e3` probe ran
on Intel Xeon 8573C: WebAudio 1.503×, Watr 1.294× (0.829–1.620), Jessie
0.738×, sort 1.031×, CRC32 1.250×, SDF 1.206× and noise 0.600×. Different
hosts prevent attributing changed ratios to the intervening optimization.
Watr's wide variation prevents a stable leadership claim even on one host.

| Workload class | Next useful proof |
| --- | --- |
| WebAudio automation and typed accesses | Conditional tuple returns removed a temporary array in the automation helper; its local profile share fell from about 15% to 2%. `getValue` and typed element helpers remain hot. Reprofile after fixed-storage decoding; preserve numeric-width, bounds, coercion and alias contracts before extending specialization. |
| Watr | Separate cold tier-up from steady-state helper work. Keep cold paths shared and price speculation by output size. A smaller hot function matters more than blanket inlining. |
| SDF dependent gathers | Carried-element forwarding and sentinel guards are implemented. Compare the remaining dependent loads, guarded pop tests and loop entry in machine code. Peeling the first pop test may expose `z[k]`; it is not yet a measured win. |
| Bounded byte/short accumulation, including glyfparse | Checked reads retain i32 where all consumers permit it. Establish a lead over C-Wasm on quiet hardware; a wider guarded-i64 clone increased both time and size. |
| CRC32, FFT, sort | CRC32's emitted hot loop already has raw loads and no array bounds checks. The x64 recurrence still trails V8. Compare machine-code dependencies and scheduling before adding a pass. FFT and sort vary between runs; advancing FFT pointers already lost both size and speed. |
| Noise | Element hulls survive copies/swaps and load CSE. Four checks were removed, but leadership over Rust-Wasm still needs evidence. |
| Resampling | Adjacent taps retain separate checks around a floating phase index. Extend the shared range enclosure only while preserving rounding and out-of-range behavior. |
| Synth and dictionaries versus JSC | Inspect polynomial speculation, phase conversion, probe branches and repeated slot reads. Loaded-machine diagnostics were 1.110× and 1.441× JSC respectively. |
| Colorlog | Still has a checksum difference in the older diagnostic. Isolate exp2 accuracy from speed and apply the documented numerical contract; never count a mismatching result as a win. |

SPMV, delayline, VM, wordcount and percolation remain controls in the next full
comparison, not excuses to remove rows. JSC's documented VM/dict/CRC32 exception
retains its 1.5× sanity band. It does not exempt those cases from the V8 bar.

Self-compile's last local speed result was warm 0.969× V8 (cap 1.03×), fresh
0.790× (cap 0.99×), before the latest memory work. An earlier fresh run failed
at 1.073×. Re-run `npm run test:self:perf` on suitable reference hardware;
those loaded-machine readings do not establish the current tree's speed.

Rejected experiments stay out: broader wordcount propagation, glyph guarded-i64
clones, FFT pointer advancement, blanket branchy checked loads, reordered arena
rewind/rotation, wrapper isolation and broader forwarding inlining did not
produce reliable gains. Revisit only with new evidence.

### 2. Library memory

The recursive compiler now fits; ordinary library peak RSS still trails V8.
Seven CI pairs at `28978e54` measured:

| Library | JZ peak RSS, KiB | V8 peak RSS, KiB |
| --- | ---: | ---: |
| WebAudio | 97484 | 79328 |
| Watr | 119448 | 76816 |
| Jessie | 112008 | 100316 |

- Jessie: exact literal capacity, smaller property sidecars and array slice
  views are implemented. Slice views reduced a diagnostic run's allocation
  from 81.3 to 48.2 MB. The remaining ASI statement-list construction copies
  the preceding list at each recursive level, retaining only the outermost.
  Reuse or reclaim those copies through a compiler proof; keep parser source
  unchanged.
- Watr: the encoder starts at 4 KB and grows geometrically, instead of
  reserving 64 KB for every assembly. Linear memory fell from 64 to 32 MiB
  in the diagnostic. The assembly loop still retains a module buffer, so a
  blanket arena rewind is invalid. Separate retained storage from temporary
  parser/encoder allocations before changing lifetime policy.
- WebAudio: preserve the proven render-loop rewinds and investigate retained
  allocations after the tuple optimization. An earlier near-parity RSS row
  does not close the gap shown by current CI.

Number formatting (`6e41b9e3`) reuses private digit scratch for its final
string. Short decimal results retain 0 instead of 192 bytes; a 13-character
result retains 32 instead of 224. Shared/imported heaps keep the copy path.
The 10000-retained-string probe fell from 2417520 to 495408 allocated bytes,
with every value checked. Allocation tests use the exported heap counter;
the raw ABI hides it, so its tests verify values and aliases without reading
an unrelated memory word as a counter.

That change lowered recursive helper-parsing allocation from 4.222 to 3.713
GB; optimization completed at 3.890 GB. The existing checkpoint then reclaimed
working state, leaving a 1.253 GB final cursor. The recursive gate's 64 MiB
post-compile headroom check passes. The final cursor is not the peak.
Fixed typed-storage decoding removes the generic relocation call from three
helpers without adding a pass. WebAudio's named speed build shrinks by 191
bytes and a standalone dynamic-width reverse/store kernel by 128 bytes.
All three library checksums match; size-tier Watr, Jessie and WebAudio each
shrink by three bytes. Local paired timing is too variable for a release claim.

Subscript's span lexer, shared analysis walks, schema-index reuse and Watr's
printer/template-location changes also remain implemented and regression-tested.

### 3. Reproducible speed, size and memory evidence

`bench/results.json` and `bench/memcheck-results.csv` are stale. The committed
speed snapshot was measured with 15830.94 MB swap, above the 4096 MB cap;
58 JZ rows predate compiler changes. It still contains WebAudio DIFF, missing
rival coverage, old speed/size losses and alpha's native-size overage. The
memory snapshot predates the current compiler. Refresh both with provenance.

- Use the benchmark runner and the same-machine comparisons, including
  Porffor alpha 4 and TinyGo 0.42.0. TinyGo builds all 44 local cases now;
  fresh valid coverage must be recorded, not inferred from build success.
- Preserve per-machine evidence. CI probes are useful x64 diagnostics; they
  do not silently replace the committed M4 reference dataset. Quiet reference
  hardware remains necessary under the current evidence contract.
- Run the full matrix, conformance, self-host, instruction ratchet and bench
  on the final source. Keep source stable during each run. Refresh evidence
  after compiler changes stop, then verify claims against that exact revision.
- A good geomean does not close individual losses. The stale reference still
  fails strict wasm leadership on 16 rows and strict size leadership on eight;
  remeasure and fix each remaining loss instead of changing its cap.

## After compiler v1

- VST: verify the installed audio-compiler tarball. The builder currently
  supports JZ/macOS/mono-or-stereo. Use `org.audiojs` as the permanent vendor
  root, matching the user's audiojs choice. Porffor needs a public state-object
  adapter and build verification. Active restart needs the component-handler
  interface; restart-flagged edits currently apply at next setup. Events and
  wider layouts remain refused.
- Independent review: present one pinned candidate and its complete gates.
  Reachable dynamic calls may leave static allocation/work proofs unknown;
  empirical block tests prove neither universal allocation freedom nor audio
  deadlines. Reuse entry-range facts where they prove useful bounds.

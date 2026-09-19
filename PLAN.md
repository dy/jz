# JZ v1

Compile audiojs.dev DSP through JS → Wasm → VST, with the compiler selected
at build time. Release requires correct audio, reproducible installation and
passing conformance, speed, size and memory gates. README owns the public
contract; CONTRIBUTING owns compiler invariants.

## Implemented

- Binding/use census, allocation-site summaries and settled representation
  plans feed one lowering pipeline. Watr owns generic propagation, folding,
  LICM, local-slot allocation and the final optimizer; no additional IR layer.
- UTF-16 strings, shared exact integer conversions, proven builder capacities
  and lengths, guarded i64 accumulators, generic SIMD and scalar optimizations.
  Immutable table values survive fill helpers; full signed-word intervals prove
  dependent integer loads. Counted reductions share those bounds, including
  peeled regions. Escaping sums retain their magnitude through local copies.
  Counter proofs reject additional header writes. SIMD integer narrowing
  preserves scalar conversion semantics instead of substituting saturation.
- Closure argument facts and disjoint ProgramIndex identities, scoped active
  function state, recycled iterator bindings and recursive self-compilation.
- Coercion, method lookup, enumeration and internal errors preserve JS effects.
  Generic addition retains BigInt payloads, rejects mixed numeric domains and
  accepts BigInt results from conversion methods. Nullable numeric addition
  reuses existing payload facts to omit string dispatch; a Map lookup example
  shrinks from 8408 to 3007 bytes at the size tier.
  BigInt loose equality converts object operands through the shared primitive
  conversion, including arrays and dynamic receivers; strict equality does not.
  Both comparisons reject Number/BigInt raw-bit collisions. `Array.from` boxes
  typed BigInt elements through the common tagged reader, with or without a mapper.
  Loose string comparisons with unknown operands use the shared conversion
  path; strict comparisons and proven string pairs retain their direct shortcuts.
  Generic nullish field/index reads and writes throw instead of decoding memory.
  Direct nullable reads retain their loads behind presence checks; speculative
  loop extents leave zero-work calls untouched. Plain local receiver identity
  remains available to schema dispatch and repeated-read caching.
  Computed object keys retain evaluation and conversion order. Generated Wasm
  and interop must be rebuilt together for the private error transport.
- Summary fields retain construction identity, side properties, bounded shape
  sets, collection cells and positional rest facts. Pending effects propagate
  only when changed; the redundant layout-set census is removed.
  Construction and layout IDs index field rows directly instead of hashing them.
  Passive arguments are proven in one walk per function, including direct
  forwarding and field predicates. Testing a field does not merge unrelated
  layouts' unused values; defaults, accessors and escaping uses stay conservative.
  Tuple positions retain nested shapes through array literals, rest arguments
  and collection entries. A mixed dynamic read, mutation, union or host escape
  exposes their identities to effects; constructing the tuple alone does not.
- All prepared, imported, synthesized and specialized functions share one
  constructor. Variant queue entries are records. Function registries and
  active frames use the same constructors initially and at reset; registry
  lookups and export queries no longer allocate intermediate entry arrays.
  Inlining builds its exported subset once per pass and reuses body maps for
  membership and nested-call hoisting.
- Array-pattern parameters use the existing positional initialization path
  for ordinary functions and generators, avoiding synthetic rest allocation.
  Object-only patterns retain their existing lowering; generalizing that path
  exposed a parser ambiguity in block statements followed by arrows.
- Concatenations retain cached hashes, Map/Set probes reuse their capacity
  load when following relocation, wide schemas use a static key index, and
  dynamic reads beyond the specialization budget retain an inline cache.
  Numeric/pointer hashes mix into low bucket bits, avoiding the quadratic
  clustering of consecutive integer-valued doubles. Dictionary and proven Map
  updates share one lowering and upsert implementation, removing a duplicate
  grow/probe loop and repeated get/set probes.
  Map reads depend on hashing/equality directly instead of mutation helpers.
  Slot fusion declines throwing/effectful RHS and object key coercion. Nullable
  coercion reads once, avoiding duplicated key conversions and table probes.
- Schema indexes write binary words directly, preserving capacities and signed
  relative offsets through self-compilation. JSON's schema cache explicitly
  clears reused arena storage; repeated object-form compiler options stay intact.
  Runtime-table setup resolves declared helper dependencies before selecting
  tables, so an indirect object write updates the same slot as a static read.
  Template constants are still generated later, preserving dead-data removal.
  Source inlining preserves spread calls for runtime argument marshalling.
- Stateful native VST lifecycle fixtures, block-size/automation checks,
  allocation counters and concurrent processing exist. Public VST scope and
  proof limits remain below.
  Native VST buses now use the SDK's mono and stereo arrangements per bus.
  Mono and asymmetric bundles pass the repository host and direct native
  negotiation checks. The host carries independent channel counts, validates
  planar buffers and processes final short blocks without advancing extra state.

- Frame effects gate the arena rewind. A function whose fresh allocation was
  stored into module state rewound and handed out a dangling pointer (reads
  through it returned the next allocation); the per-function census now vetoes
  every escape, and rewind widens to functions with parameters, numbers stored
  into outer storage, fresh local containers and kernel tail calls. Load CSE
  survives calls to callees that write no outer storage. `whyNotRewind` names
  each declined candidate. A loop whose iteration lets no allocation escape
  restores the heap pointer per iteration. A record parameter read field by
  field becomes scalar lanes at every call, and a literal record at a call
  site is never allocated. The export boundary is numeric for
  typed-array index parameters again (the usage scan reads typed kinds from the
  summary), restoring the four typed/static output checks; property keys cross
  the boundary as strings. `charCodeAt` on a dissolved concatenation read
  bytes, not UTF-16 units (the strbuild checksum); constant-exponent `**`
  and the fifthroot fold were million-ulp approximations, now the pow kernel
  and a four-step root within about 40 ulp of the exact rational power (the fold's
  test compares against that power, decided in integer arithmetic, since
  `Math.pow(x, 1.6)` raises to the double 1.6 and differs by x^(1.6 − 8/5)).
  A bare `super()` in a derived constructor, `static async` methods and
  `async #m()` (a Subscript parse fix, mirrored in the installed copy), an
  optional method call on a known class (`o.m?.()` kept no binder) and
  `fn.call(this, e)` / `fn.apply(null, args)` on a stored closure, and an
  `await` anywhere but statement position (`return await a + 1`, an argument,
  a condition, an arm) all compiled or ran wrong; the Web Audio bench renders
  under jz now, with parity, ten times slower than V8 (a speed candidate, not
  a defect). At level 0 a store through a literal or folded string key
  (`o['x'] = 1.5`) escaped the slot's integer census and `Math.floor(o.x)`
  was elided (1.5 came back); a typed array that may be unset (`let x; … x =
  new Float64Array(n)`) indexed through the generic keyed read; an in-bounds
  element read (`rows[i].x` under `i < rows.length`) still carried the
  nullish throw and its message strings. Under wasi a command entry
  returning a scalarized tuple emitted an invalid module (one drop for five
  values), and the perf ratchet now holds on the JS host alone: the wasi
  export wrapper carries the argument conversion loops the JS bridge
  performs outside the module. Two classes with the same field names but
  different field representations still collide at instantiation
  (`incompatible field contracts for a schema already bound to this
  memory`, a structural schema shared by name): open.

The handoff has been folded here and removed. Watr remains pinned
to `d6d140d`; Subscript to `0f65c86` plus the uncommitted async-member parse
fix in its checkout (`feature/async.js`, `feature/class.js`), mirrored into
the installed copy until it is published.

## Candidate verification — September 16

The final full matrix passes core 4359 tests (73973 assertions), O0 4165,
O3 4165 and WASI 4217, each with one skip and zero failures. BigInt conversion,
typed BigInt copies and equality-domain regressions pass at O0/O2/O3/size;
optimizer, SIMD, inference, performance/minimal-output tests and the
10-category loop ratchet pass. Matrix evidence is in
`/private/tmp/jz-eq-complete-matrix.log`; baseline self-host, conformance and
size logs use `/private/tmp/jz-eq-complete-`.

Self-host correctness passes all 52 tests (2333 assertions). Language conformance
passes 3151 positives and rejects 4045 negatives, with zero failures and 8
expected failures. Built-ins pass 874, with zero failures and 45 expected
failures. Public types and import lint pass.

The baseline full size sweep wins all 51 comparisons against AssemblyScript at
0.782× bytes. The VM size build is 1399 bytes against AS's 1694. No timing,
size, memory or instruction-ratchet cap changed. This standalone sweep does
not refresh the committed benchmark dataset. Consolidating loose string
equality reduces the WATR size build from 297444 to 291256 bytes (2.08%).

Immutable-table propagation restores integer VM dispatch without assuming that
missing reads are integers. The speed artifact shrank from 2166 to 1700 bytes.
Six alternating pairs against `322b874c` measured a 0.376× runtime ratio
(2.66× faster), with the same checksum in every run. SDF and glyph parsing have
unchanged emitted WAT. Local timings are diagnostic, not release attestations.

This candidate passed the stateful native VST fixture: 12438 checks,
4000 concurrent blocks, zero sample error and fixed callback heaps. The public
compile-vst package's 30 tests and compile-wam's 22 tests passed. Packed consumers
and rendering/lifecycle checks pass in Chromium, Firefox and WebKit.
The host's VST package suite also passes. The mono/asymmetric and exact short-block
regressions are committed in audio compiler `87a6c9e`, using host `b31cd5b`.
Those tests do not establish callback deadlines.

## Remaining release work

1. **Finish validating typed-array property semantics.** The working tree routes
   named keys through property storage and canonical numeric keys through
   element conversion. Assignment values, aliases, views, missing keys and
   reference evaluation order have differential regressions. Checked writes
   convert before bounds checks, including programs without BigInt syntax.

   All ten loop-count gates pass without raising their caps. These count
   runtime-helper loops as well as application loops, so they are a structural
   check, not a timing result. The four typed/static output checks are
   closed; the final full-suite results and sizes are in the gate evidence
   below. The arrays
   already use static storage; the allocator serves arbitrary property keys
   and values. Preserve these semantics unless the public contract explicitly
   changes; do not narrow an exported parameter to satisfy a size check.
   Refresh the full release gates on the final tree before committing.
   The owner has been asked whether v1 index-only exports should take numeric
   parameters or retain arbitrary property keys. Keep the current generic-key
   behavior until that public boundary contract is resolved.

   Exported module-level typed-array keys now retain their property semantics.
   Usage-only scans no longer assume that typed receivers coerce every key or
   stored value; the summary owns proven element-store coercions. This fixes
   `a['length']` returning element zero and named string values becoming NaN.
   The allocation-free and compact getter/setter assertions previously
   depended on incorrect narrowing of unproven keys and values.
   Proven element stores still avoid ToNumber helpers: fixed-index and explicit
   integer-index probes are 177 and 271 bytes. All caps remain unchanged.

   Typed accessors share the string equality helper instead of repeating
   character decoding. The getter shrinks 8916 → 8782 bytes at O2 and
   7835 → 7624 at the size tier. Shared string-pool initialization now follows
   helper realization, so its copy includes literals emitted by helpers.
   Repeated reads, sliced/NUL-extended/empty keys, empty receivers and multiple
   modules sharing memory have direct regressions.

   Pointer review fixed direct and computed reads through missing array slots:
   schemas and ctor provenance no longer erase undefined during local narrowing.
   Catch analysis retains these failures. Tests cover object/typed fields, sparse
   arrays, BigInt elements, changing receivers, class method values and zero-work
   loops at O0/O2/O3/size. The stencil keeps one entry base decode and none in
   its loops by sharing the function-wide hoist's snapshots with the loop hoist.
   Guard stability now includes helper calls that replace a buffer or change an
   offset/bound. Presence guards do not grant bounds to unrelated accesses.
   Induction cursors retain their modeled header update; duplicate updates reject.
   Example and FFT SIMD remain intact.
   Ordinary array bounds still do not exclude holes.

   Missing typed-store receivers now throw TypeError after key/RHS evaluation
   and before value coercion/header loads. Both direct and runtime paths are
   covered, including empty arrays and subviews. Checked property reads retain
   their exact schema, fixing BigInt returns through catch without dynamic
   lookup; optional fields box within their successful branch. Dynamic-key
   typed assignment results retain their tagged carrier instead of double-boxing.
   Regressions cover repeated calls, throwing RHS expressions, unknown typed
   constructors and tag-shaped i64 payloads. Expression field writes such as
   `xs[0].x=8n` now use the same schema carrier as construction and reads,
   capturing the receiver before an RHS that can replace that array element.

   Latest focused checks pass: 117 property tests (7330 assertions), 81 memory
   tests (1038 assertions), and 57 fresh self-host checks (2343 assertions).
   Four affected property tests also pass across O0/O2/O3/size (676 assertions).
   The earlier 158 object, 22 coercion and 143 inference tests pass.
   Two old inference assertions requiring dynamic reads were replaced with
   the original record-layout corruption cases and empty/nonempty spread values;
   a checked schema read need not use dynamic dispatch. Import lint passes.
   Earlier optimizer/SIMD/structural-performance/example checks passed 259, 224,
   56 and 22 tests respectively. FFT is 1689 bytes, SDF 2115, radix sort
   1259 and glyph parsing 2265 at the size tier. Normalized local flow and
   settled i32 index bounds avoid pulling property/string helpers into these
   kernels. The latest size sweep wins all 51 AssemblyScript comparisons at
   0.792× bytes. Evidence is `/private/tmp/jz-prehash-size.log`; all 51
   comparable byte counts are unchanged from the preceding callback candidate.
   The separate WATR workload is 309295 bytes: sharing the truthiness helper
   first reduced it to 305362, then corrected spread argument collection added
   3933 bytes (1.29%). The other 59 measured outputs are unchanged. No size cap changed.
   The latest full core run records 4453 passes of 4458 tests (86693 assertions),
   four failures and one skip (`/private/tmp/jz-index-layout-final-core.log`).
   Four typed/static output assertions remain: the typed helper is 8555 bytes
   against 930, `.map` retains its key check, static elements retain allocation,
   and the typed getter/setter is 15283 bytes against 400. Ring now passes at
   50360 operations against 50400 (previously 52040). The conditional-reference
   loop now passes at 85543 against 89053 (previously 89218). No cap changed.
   This is not an all-green full-suite result. The inference assertion
   checks the hot function before watr inlining, excluding cold position
   coercion helpers, plus empty/aliased/replaced view behavior.
   Fresh self-hosting passes 68 tests (2365 assertions), including bounded
   fractional recurrences, string-key collection probes, position
   coercion, unsigned boundaries, nullable BigInt method receivers and fixed
   method spreads, bulk mutations, empty callback validation and BigInt origins
   without literals (`/private/tmp/jz-index-layout-final-self.log`). Method
   arity comes from the shared builtin-signature catalogue in both hosts;
   a registration-coverage test prevents dependence on unsupported function
   reflection. Focused coercion passes 31 tests (2540 assertions), spread
   tests pass 58 with one skip across O0/O1/O2/O3/size (1841 assertions,
   `/private/tmp/jz-spread-final-focused-3.log`), and array methods pass 151
   tests (673 assertions, `/private/tmp/jz-spread-final-arrays.log`).
   Five additional kernel probes cover Date, regex, BigInt, nullish spread
   sources and string ranges (`/private/tmp/jz-fixed-spread-kernel-extra.log`).
   This is not an all-green release run.
   FFT SIMD, compiler-state
   reuse and kernel checkpoint checks pass. No output or timing cap was raised.
   Read dispatch now uses the integer-key parser instead of full canonical
   Number/String conversion, and preserves a proven-present receiver tag. These lower
   the getter from 11646 to 8916 bytes while adding correct computed length and
   byte accessors. Own values, including undefined, shadow those accessors.
   Review also fixed a nullable BigInt
   result being double-boxed through a local; the regression now proves load
   reuse runs and checks reuse disabled, raw identity, negation and complement.
   Focused checks do not replace the complete release gates on the final tree.

2. **Runtime and self-host speed.** Missing integer reads now preserve
   `undefined` through locals, copies, computed indices and helper returns.
   Uint32 locals retain unsigned magnitude, and signed/unsigned comparisons
   share one proof. Local/result narrowing reuses existing interval and
   canonical-loop proofs; validated caller lengths also reach result analysis.
   Exact integer expression folding is shared by emission and optimization.
   NaN-aware coercion bounds remove unnecessary arbitrary-number conversions
   while keeping missing-index guards. Implicit zero is part of local ranges.

   SDF's data-dependent scratch cursor still lacks a presence proof. Its lower
   and upper bounds depend on sentinels stored in a mutable scratch array;
   payload types and loop syntax alone cannot prove them. VM's immutable opcode
   table now supplies the missing all-writers hull and restores integer dispatch.

   Warm self-compilation must meet the unchanged 1.03× cap; fresh compilation
   must meet 0.99×. This candidate measures warm
   1.177×/1.176×/1.190× (fails) and fresh 0.895× (passes), diagnostically on
   this loaded machine, before the final string-dispatch consolidation;
   evidence is `/private/tmp/jz-join-self-perf.log`.
   A controlled old/new join-runtime comparison compiling identical compiler
   sources yields 0.997× new/old across the six cases, with byte-identical
   output (`/private/tmp/jz-join-kernel-pair.log`). Separate loaded-machine
   runs do not establish that join caused the higher warm ratios.
   No timing cap changed.
   A fresh six-case self-host profile places about 15% of samples in Map/Set
   probes and hashing, 3% in pointer decoding and 4.5% in the AST visitor.
   Proven-present string lookup keys now reuse the prehashed Map/Set helpers;
   one shared emitter replaces three copies of the literal-probe lowering.
   Argument effects and nullable keys have differential and self-host regressions.
   Ordinary and prehashed lookup generation now shares one probe body, removing
   44 source lines. All 24 optimized comparison modules are byte-identical;
   six O0 modules shrink 7–21 bytes by removing redundant pointer masks.
   No runtime speedup is claimed (`/private/tmp/jz-lookup-fold-review.log`).
   The final paired probe measures 0.979× previous-JZ runtime, but 1.017× V8;
   its size tier grows 5767→5787 bytes and heap growth stays 9135904 bytes.
   All 60 corpus size outputs are unchanged. Evidence:
   `/private/tmp/jz-prehash-{final-metrics,memory,size,features,gating}.log`.
   This did not close the compiler speed gap: that gate recorded warm
   1.185×/1.191×/1.198× (fails), fresh 0.987× (passes), with unchanged caps
   (`/private/tmp/jz-prehash-self-perf.log`). Compiling identical compiler
   sources with the old/new probe lowering gives 1.004× new/old runtime and
   byte-identical outputs across all six cases: no measurable self-host gain
   (`/private/tmp/jz-prehash-self-pair.log`).
   Bounded floating recurrences now remove redundant ToInt32 infinity guards
   through the existing range query and write census. The arithmetic remains
   f64, including per-addition rounding; no wrapping assumption is added.
   The resample speed module shrinks 3034→2944 bytes with identical checksum
   1711808418. Six paired rounds measure 0.996× V8 (before: 1.033×), effectively
   parity on this loaded machine, not a reliable leadership claim
   (`/private/tmp/jz-phase-v8-final.{json,log}`). Unknown entries, nested resets,
   multiple writes, extra backedges, numeric local aliases, zero work, infinities,
   NaN, i32 boundaries, property keys and captured values have focused regressions.
   The affected optimizer suite passes 265 tests; the fractional cases also
   pass across O0/O2/O3/size (308 assertions). Controlled runtime is 0.953×
   previous JZ; compile time has no established win (the longer dictionary
   check is within 1%, WATR is 1.6% slower). The current self-host gate remains
   warm 1.163–1.220× against 1.03×, with fresh 0.939× passing its 0.99× cap
   (`/private/tmp/jz-phase-self-perf.log`). No cap changed.
   The fractional plain-array probe returning 18 instead of JavaScript's 16
   follows the documented i32 index contract, pinned by `array index contract:
   i32-truncating, typed raw, plain bounds-checked`. It is not a v1 defect;
   the earlier review classification was wrong. Object property keys remain
   separate and retain their fractional names.
   Expression-property dispatch now has one generator for its four entry
   forms, removing 66 source lines and selecting key normalization by receiver.
   The WATR compile-workload module changes 394511→394532 bytes; a controlled
   paired run measures 0.989× previous runtime, close to measurement noise
   (`/private/tmp/jz-get-dispatch-watr-controlled.json`). Small object/array
   probes remain byte-identical. This is a consolidation, not a closed speed gate.
   The two dispatch regressions pass 128 assertions across O0/O2/O3/size:
   conversion effects, array relocation, misses, throwing keys and repeated
   host reads. Import lint passes; the full core run retains exactly the prior
   nine output-gate failures, and fresh self-hosting passes 68/68.
   Computed reads now request host fallback from the receiver's existing kind
   facts, matching named reads, instead of consulting earlier emission demand.
   Their dispatcher selects its host arm at link time, after all producers are
   known, so an early reader also handles a later host-global caller. The existing
   ingress query is shared and its cache resets with the session; no new pass.
   Imported and exported receivers have cross-tier regressions for reordered
   declarations, lone computed readers, optional/nullish receivers, empty and
   missing keys, throwing getters and repeated use after errors. Numeric array
   boundaries and known internal receivers retain their existing helper gating.
   All 60 outputs supported by the compile benchmark's module loader retain
   their byte counts, including WATR at 394532 bytes; Jessie, recursive JZ and
   Web Audio require their separate loaders and are outside this comparison
   (`/private/tmp/jz-host-order-size-diff.json`). No speedup is claimed for this fix.
   String equality now passes resolved heap offsets and a checked UTF-16 length
   to its existing word loop, removing 61 net runtime-source lines. A paired
   string probe shrinks 3606→3340 bytes: equal heap/view comparisons take
   0.754×/0.711× previous time; length mismatches take 0.936×/0.931×.
   The speed-tier WATR workload shrinks 571753→571613 bytes with unchanged
   timing (1.000×). Warm self-compilation measures 1.008× previous runtime,
   with byte-identical output on six cases; no compiler speedup is established.
   Its artifact shrinks 16951684→16951522 bytes. These are local diagnostics,
   not a closed V8 gate; inputs, paired samples and review evidence are in
   `/private/tmp/jz-string-prelude-review.json`.
   Integer decimal formatting now writes directly into its final positions,
   using the same unsigned digit-count expression as concatenation sizing.
   This removes the decimal reversal loop and 12 net runtime-source lines;
   other radices reuse one reversal fragment. Three paired integer-formatting
   kernels take 0.942×, 0.949× and 0.946× previous time. The formatting module
   grows 1842→1851 bytes and ring grows 10105→10111; allocations are unchanged.
   All ten loop-count gates now pass: ring falls 52040→50360 under its unchanged
   50400 cap. Boundary regressions check exact signed/unsigned digits, guards
   and the end of linear memory; fresh self-hosting passes all 68 checks.
   Evidence: `/private/tmp/jz-itoa-review.json`. This is a formatting gain,
   not evidence that the warm self-compile or V8 timing gaps are closed.
   String-keyed typed-array value reads now delegate their bounds check to
   the checked element reader. Presence keeps its own check. Paired probes
   take 0.881× previous time for valid indices, 0.969× for mixed keys, and
   1.006× for invalid keys. The scan module shrinks 10418→10405 bytes and the
   typed helper 8563→8549. A separate unchecked-character parser rewrite was
   discarded after making the invalid-key probe 5.5% slower. Public key/value
   semantics and all caps are unchanged. Regression coverage includes empty
   arrays, subviews, BigInt tag-shaped values and repeated reads/presence checks.
   Measurements and validation: `/private/tmp/jz-key-read-review.json`.
   Generic typed indexing now reuses its decoded layout for bounds and the
   element load. It shares the element-count expression with `__len`; the
   eight element widths use straight-line arithmetic. Paired probes take
   0.583× previous time for Float64, 0.612× for Uint8, 0.516× for Float32
   subviews and 0.421× for DataView's missing indexed properties. Probe sizes
   move 10385→10386 and 8549→8555 bytes. The initial candidate's new typed-loop
   size failure (1550 bytes) was removed by simplifying width decoding:
   1534 bytes now fits the unchanged 1536-byte ceiling. The runtime source
   is three lines smaller. A separate existing subarray flag loss now uses
   the canonical aux encoder, retaining Float16 and clamped behavior after
   subtype erasure. All 66 buffer tests and 68 fresh self-host checks pass.
   A same-source warm compiler A/B is effectively flat at 0.999× across six
   cases, with byte-identical outputs; its artifact moves 16947131→16947130
   bytes. This local paired diagnostic ran alongside the core suite and does
   not establish progress on the V8 gap. Final review evidence:
   `/private/tmp/jz-index-layout-review.json`.
   Map hashing now classifies ordinary numbers and NaN boxes once; string
   and BigInt arms inherit the classification. Hash values and memory layout
   are unchanged. Three same-source compiler A/B runs take 0.985×, 0.990× and
   0.980× prior time with byte-identical output across six cases; the named
   compiler artifact shrinks 17193336→17193325 bytes and runtime source loses
   nine lines. A leaf-skipping AST visitor prototype was discarded after a
   1.021× slowdown. The refreshed self timing still misses warm parity at
   1.168×/1.199×/1.196× (cap 1.03×); fresh passes at 0.930× (cap 0.99×).
   Timings remain local diagnostics, including the gate run alongside the core
   suite. No cap changed. Evidence: `/private/tmp/jz-throughput-review.json`.
   Separating the warm Wasm call's costs rules out heap reset as the missing
   margin: `_clear()` averages about 0.002 ms against 9–19 ms compiling.
   `ctx.funcs` has an exact layout, but polymorphic profiling callbacks
   still merge `createFunction().sig` / `ctx.func.current` facts to unknown.
   Call-site wrapper isolation and blanket forwarding inlining did not help.
   Preserve callback effects and physical return carriers in any future change;
   a new context-specialization layer needs measured justification.

   Array join now converts once in order and copies into one result, preserving
   the original strings and tagged BigInt elements. Built-in-only conversions
   on owned heaps reclaim their temporary region; custom conversions and shared
   heaps retain allocations. At 1024 elements, the decimal Float64 probe uses
   36720 bytes instead of 14727600, runs about 2–3× faster, and shrinks
   6283 → 6172 bytes. The string probe retains its 28696-byte heap use and
   speeds up, but grows 6373 → 6427 bytes. Evidence:
   `/private/tmp/jz-join-metrics.log`. No cap changed.

   String operand conversion now shares interpolation's identity handling,
   and concat uses the same immutable builder. Regex dispatch delegates its
   plain-string cases instead of duplicating them. Split preserves argument/
   conversion order, undefined, ToUint32 limits and the captured boxed carrier.
   The final 104 string, 79 regex, 22 coercion and 58 fresh self-host tests pass;
   the 151 array-method tests also pass. New operand tests pass at O0 and O3.
   Evidence is `/private/tmp/jz-{strings-final,regex-final,coercion-final,strings-self}.log`.

   The review fixes padding's eager fill conversion, explicit-undefined default,
   empty-fill divide by zero and byte-size overflow. Regressions pin no-work
   returns, argument capture before mutation, both conversion errors and a
   valid call after an oversized request. The literal-fill loop probe grows
   4788 → 4838 bytes and measures roughly 1–3% slower for the checks
   (`/private/tmp/jz-padding-metrics.log`); no cap changed.

   The shared ToNumber helper now rejects BigInt; explicit `Number()` has a
   small BigInt-capable entry that shares the parser. Unary plus uses the same
   conversion instead of treating unboxed object offsets as integers. String
   positions reuse their existing conversion helper. Present typed BigInt
   reads carry their raw-payload proof; nullable reads retain their branch-aware
   boxing. Atomic value results reuse the operation catalogue and typed-element
   facts in the solver and queries: they return an element or throw, never
   undefined. This preserves direct i64 conversion through locals and calls.
   Regressions cover raw/tagged/nullable BigInts, tag-shaped payloads, string
   positions, scalarized typed stores, conversion effects, atomic bounds and
   repeated calls. Coercion passes 26 tests, data 210, optimizer 259, summary
   33 and summary queries 41. Atomic regressions also pass in O0/O3 runs.
   The generic typed getter/setter grows five bytes for BigInt rejection;
   no budget was raised.

   **Correctness closed on the final tree (September 18):**
   - Mixed Boolean/Number local storage keeps its identity: the binding is a
     tagged carrier (CONTRIBUTING, boolTaggedBinding), so
     `export function f(k){let v;try{if(k)throw 1;v=1}catch(e){v=true}return v}`
     returns `true` for `f(1)`, and the former compile-time rejection fires
     only where a plan typed the binding as one non-Boolean kind.
   - Typed-array constructors apply ToIndex to a primitive argument:
     `new Float64Array(1n)` throws TypeError, `new Float64Array('2').length`
     is two; a Set or Map argument iterates, a known object is an array-like.
   - Array positions (fill, copyWithin, slice, splice, with, fromIndex) are
     ToIntegerOrInfinity: `[7,8].fill(0,1n)` throws TypeError, `'1'` reads as
     one, and the search methods honor fromIndex. `splice(...args)` with
     dynamic positions reads them at run time (it returned wrong arrays).
   - Per-iteration arena rewinds now fire (the emission gate tested for a
     global the stdlib pull declares later, and the marker names disagreed
     between the loop pass and the link pass); a loop building a Map per
     iteration runs in constant memory, every escaping shape is left alone.

   The earlier notes on these items, kept for the history:
   - Mixed Boolean/Number local storage could lose identity instead of rejecting:
     `export function f(k){let v;try{if(k)throw 1;v=1}catch(e){v=true}return v}`
     returned `1` for `f(1)`, where JS returns `true`.
   - Typed-array constructors bypassed ToIndex conversion:
     `new Float64Array(1n).length` returned zero instead of throwing TypeError;
     `new Float64Array('2').length` returned zero instead of two. Preserve the
     constructor's distinction between primitive lengths and object sources.
     The sibling bypass is fixed for array/typed `at`, typed `slice`/`subarray`
     and buffer `slice`: shared argument capture precedes coercion, numeric
     operands stay numeric, and typed range clamps reuse `__clamp_idx`.
     Array `at` reads current storage after a hook mutates the receiver, using
     the original length for negative positions. Unsigned saturation no longer
     unwraps positive positions above INT32_MAX into negative ones.
     The raw casts of ordinary array `slice`, fill, splice, copyWithin, with
     and the search offsets are closed above (`[7,8].fill(0,1n)[0]` returned
     0 instead of throwing TypeError). Argument capture precedes user
     conversions. Indexed properties are a different contract: BigInt
     property keys remain valid and must not be rejected.
   - Fixed-arity method spreads now consume one positional argument list,
     preserving receiver identity, ignored argument effects and supplied arity.
     The summary also accounts for spreads when joining reducer initial values,
     callbacks and collection stores. Literal spreads avoid iteration and keep
     numeric proofs (typed-slice probe: 963 bytes versus 923 without spread).
     Nullish spread sources throw before later arguments; Set/Map constructors
     retain their nullish-as-empty contract. String slice/substring share typed
     ranges' capture/defaulting helper. `splice(...args)` with dynamic
     start/delete/insert positions is closed above.
     Push/unshift now capture one receiver and consume argument values before
     mutating it, return the length, and perform one bulk insertion. Argument
     reassignment cannot redirect the call or be overwritten by relocation.
     The shared collector uses existing IR purity facts to snapshot earlier
     spreads only before later potential mutations, preserves scalar identities,
     and boxes typed BigInt elements. Self-prepend reads its moved tail without
     allocating a copy. Empty unshift calls return length without mutation. The obsolete
     per-element mutation paths and duplicate spread census are removed.
     Three regressions pass 330 assertions across O0/O1/O2/O3/size, covering
     empty/throwing sources, self-aliases, reassignment, exact argument effects,
     and repeated growth through local, field and call receivers.
     Fresh self-hosting passes 66 tests (2361 assertions). Spread tests pass
     58 with one skip (1841 assertions) across O0/O1/O2/O3/size; array methods
     pass 151 (673 assertions).
     Eight paired insertion measurements give 0.258× previous-JZ runtime for
     prepend and 0.589× for mixed-prefix push; single-spread push is byte-identical.
     Heap use is unchanged: 8496 bytes for prepend and 16688 for mixed push.
     Size-tier probes grow 10822→11136 and 10889→11113 bytes respectively.
     WATR grows 305362→309295 bytes for the corrected argument collection.
     Evidence: `/private/tmp/jz-spread-final-metrics-2.log`,
     `/private/tmp/jz-spread-final-{size,self,arrays,focused-3}.log`.
     These are diagnostic comparisons against previous JZ, not V8 leadership
     evidence. No cap changed.
     Review closes the empty-loop callback hole: omitted, undefined and other
     noncallable callbacks throw before iteration, even with no function
     otherwise loading the closure module. Capture/check lowering is shared
     by ordinary and typed callbacks; reducer seed effects precede validation.
     Typed findLast/findLastIndex now share find's early exit and reverse the
     existing loop builder, preserving mutation order and stopping on a hit.
     Boxed `0n` now remains falsy through callbacks and logical expressions.
     Runtime and inline truthiness share one predicate builder; size mode
     retains the shared helper. Semantic BigInt gates for dynamic property
     reads, array stores and updates use the representation proof, including
     typed-array/DataView origins without BigInt literals. The identical
     64-bit typed-load arms are folded into one load.
     WATR size falls 308666 → 305362 bytes; the other 59 measured byte counts
     are unchanged (`/private/tmp/jz-truthy-size-final.log`). The speed-tier
     paired WATR comparison is 1.001× new/old over six counted pairs, checksum
     identical, while bytes rise 555455 → 560399 for correct inline BigInt
     handling (`/private/tmp/jz-truthy-pair.log`). Timings are diagnostic on
     this machine. Removing inline truthiness altogether was about 5% slower;
     retaining a single shared predicate avoids that speed regression.
     Focused optimizer checks pass 260 tests (4666 assertions), dynamic keys
     118 (8475), and array methods 151 (673). New regressions compare repeated
     zero/nonzero inputs, computed reads and updates, and callback/logical
     evaluation against JS at O0/O1/O2/O3/size; a following scalar-only compile
     still exports no memory. The full core and fresh self-host results above
     include these regressions. Import lint and whitespace checks pass.
   - Nullable builtin receivers now throw before evaluating arguments through
     the shared method-call path. The receiver is evaluated once; staging keeps
     typed view layouts and deferred BigInt boxing. Regression sequences cover
     present → present → null → missing → present at every optimization tier.
     The staged receiver keeps the existing tagged-local fact, so BigInt
     methods unbox payloads rather than formatting pointer bits, including
     tag-shaped payloads and repeated calls after exceptions.
     A separate pre-existing buffer-kind loss remains: an element of
     `[new ArrayBuffer(2), null]`, selected at index zero, answers
     `.slice(0).byteLength` with undefined rather than 2 (also on HEAD).
   - A conversion hook can change a captured field without widening its storage:
     `const a=new Int32Array(2),o={x:7};const i={valueOf(){o.x='changed';return 0}};Atomics.add(a,i,3);return o.x`
     returns zero instead of `'changed'`. The hook executes; the field carrier
     is wrong. Numeric conversion effects must reach the same field census as
     ordinary calls.

3. **Reproducible speed, size and memory evidence.** The committed benchmark
   dataset is stale, was timed above the 4096 MB swap-validity cap, and lacks
   complete Porffor/TinyGo coverage (43 comparable rows against 44 required).
   The last system read reported 11425.44 MB of swap, above that cap.
   Regenerate through the benchmark runner on quiet reference hardware, with
   the current compiler and memory-baseline provenance. Standalone size wins
   and local paired timings do not replace that evidence. Keep TinyGo 0.42.0
   and the current same-machine Porffor native comparison.

   The prior rival comparison also trailed Clang Wasm on glyph parsing, SDF,
   trace and wordcount, and AssemblyScript on SDF and shapes. Refresh those
   comparisons before ranking further work. No new leadership claim is justified
   by the current diagnostic machine or by smaller WAT alone.

   The latest four-round JZ/V8 comparison still trails on Jessie, WATR and
   resample: paired median ratios are 1.456×, 1.401× and 1.054× respectively
   (`/private/tmp/jz-v8-focus-before.{json,log}`). Checksums match between the
   two targets, but these scratch results have no reference-checksum provenance
   and swap remains above the validity cap; they are diagnostic, not release
   evidence. Jessie profiling concentrates in parser dispatch and scanning.
   An experiment extending duplicate property-read reuse to reassigned locals
   produced byte-identical Jessie output and a 1.002× runtime ratio, so it was
   removed. Runtime/inlining policy variants likewise established no useful
   speed gain. Preserve the existing policies; improvements need measured
   reductions in the remaining dispatch and generic-helper work.
   A closure-property precision prototype also gave no meaningful gain and
   was removed. The later string-key probe change leaves WATR's speed-tier
   Wasm byte-identical (571754 bytes with either lowering); its refreshed
   JZ/V8 ratio is 1.459× with matching checksums. That timing variation cannot
   be attributed to a codegen change in this case (`/private/tmp/jz-prehash-watr.log`).

4. **Public VST scope and identity.** The builder is JZ/macOS/mono-or-stereo.
   Porffor needs a public state-object adapter and build verification. Choose
   the permanent vendor root before publishing derived class IDs.
   Restart-flagged edits take effect on next setup; active restart needs the
   component-handler interface. Events and wider layouts remain refused.

5. **Proof and independent review.** Reachable dynamic calls can still make
   static allocation/work proofs unknown. Empirical block checks establish
   neither allocation freedom for all inputs nor callback deadlines. Reuse
   entry-range facts for useful bounds; a full-i32 domain proves no deadline.
   Present the pinned candidate and complete gate evidence for independent
   review. Implementation alone is not expert approval. Replace dependency
   source pins once published packages contain their fixes. Another context,
   vectorizer or semantic-IR rewrite is not a v1 prerequisite.

## Gate evidence — September 18

- Core suite 4493/4494 (one skip), opt0 4298/4299, opt3 4298/4299, wasi
  4351/4352 (one skip each) on the committed tree (the logs are in the
  session scratchpad, `suite-14.log`, `leg6-*.log`).
- Size: `bench:size` geomean jz/AssemblyScript 0.793×; `wasm-opt -Oz` finds
  0.2% slack in jz's own output.
- Self-compile perf: warm 1.008×, 1.017×, 1.014×, 1.012× and 1.009× on
  successive quiet-machine runs, each on its first round (cap 1.03×, passes;
  the same gate read 1.157–1.201× before the kernel-speed rules of this
  entry, 1.081–1.123× after the optional-chain alias, 1.051–1.076× after the
  inline forwarding hop, 1.026× after the inline array arm, then 1.008×
  with the inline nullish, strict-equality, boxed-boolean and string-hash
  forms); fresh 0.79–0.82× (cap 0.99×, passes). Per fft compile the kernel
  makes 180K `__ptr_offset` calls where it made 1.14M, 115K `__mkptr` where
  it made 319K, 29K `__is_nullish` where it made 201K; `__typed_idx_tagged`
  left the top thirty. The kernel-compiled compiler matches the native one
  on the BigInt receiver case that missed before (a lifted optional chain's
  BOOL continuation now joins the undefined arm as its atom).
- Bench parity: every corpus case matches its checksum, Web Audio included;
  the color cases differ from V8 by the fifthroot fold's ulps only.
- Self-compile gate 68/68 (`test/self-compile.js`); `bench:size` geomean
  jz/AssemblyScript 0.794× after the kernel-speed rules (the size tier keeps
  the `__ptr_offset` call; the speed tiers inline the hop).
- Parser and encoder speed (the `jessie` and `watr` bench cases, jz against
  V8, paired): jessie 1.48× → 1.13× through engine work on the dynamic
  shapes a Pratt parser is made of, each measured on the case, none on the
  input. What moved it: an `if (a && b)` condition was built as the `&&`
  value (the operand boxed) and the box tested through the generic chain,
  in every program (`toBool` now asks each operand in place, the right
  operand under what the left proved, so a guard's `x < W && a[x]` still
  indexes in bounds: 15% of the case alone); a `!` over a logical operand
  and `toBool`'s own `!` the same way; a Boolean left operand of a value-form `&&`/`||` tests its raw i32;
  a value the summary knows as a Boolean or a pointer kind tests as the
  TRUE atom or as presence (`kindTruthyIR`); a loop's test guards its body
  (summary and emitter), and `(d = ops[i++])` as a test proves `d` present
  (`notNullish` refinement, the query layer's `present` mark), so the
  cursor's members read as direct slots (`dotRead` gives a present shaped
  name the layout the guarded read retained); the summary types a
  closure's own properties (`closureProps`: `fn.ops = ops` on a dispatcher
  no longer escapes the array), the plan's flattened function-property
  globals (`parse.space`, `parse.comment`, `parse.newline` are closure
  sets, an object shape, a Boolean), a call through a binding not yet
  known and a spread of a nullish value (each escaped its operands before
  the first fixpoint round could type them); the generic truthiness reads
  the pointer tag inline instead of calling `__ptr_type`. What measured
  nothing on the case, kept for what it proves: `idx` numeric, the lifted
  functions' parameters typed. What remains on jessie (instruction-level
  profile, `--prof` ticks over `--print-wasm-code`): the dispatch closure's
  truthiness of AST nodes (`a`, `r`: ANY by nature), `node.loc = at`
  through `__dyn_set` on an array (5%), comment.js's for-in (the pooled
  keys loop), `parse.id`'s unicode layer. A `?:` whose condition is a
  logical shape still builds the value: routing it through `toBool` threw
  at run time on the parser and is reverted, to be understood. Two of the
  batch's first forms were wrong and the kernel found them: a Boolean
  rides either carrier, the raw 0/1 or the atom box, so a test of a
  BOOL-typed f64 is the number test then the atom compare, never the
  atom's aux bit alone (the do-while flag read false; the compiler's own
  `bool && expr` miscompiled in the kernel: "Cannot read properties of
  undefined" on every program with an object literal). The finder was a
  bisect over the changed files, one tree copy each with that file at
  HEAD, building a kernel and compiling one probe.
- watr's bench number moved from 1.31× V8 (the results snapshot, e36aab3b)
  to 1.5 to 1.9× before this work, with watr 5.10.3's sources as well as
  5.11.0's. A bisect over the 270 commits since the snapshot (`git archive`
  builds against today's node_modules, timed on a quiet machine) lands on
  63f4fe97 (the summary widening and the kernel's inline hot reads): the
  parent's watr build runs its first `main()` in 986 µs, that commit's in
  1569. The loss is tier-up, not steady state: by the second call every jz
  build of watr runs at 741 to 782 µs (the parent, that commit, today's
  tree), and the commit's module is 16% larger (525 → 607 KB), which V8's
  Liftoff tier runs slower until TurboFan replaces it. The bench measures
  the first call of a fresh process, where V8's own row warms as well (watr
  794 → 625 µs, jessie 1429 → 1138 by the third call): watr's steady-state
  ratio is 1.24×, its first-call ratio about 1.9×; jessie's steady state
  1.27×, its first call 1.06×, the paired bench's 1.13× between them. What
  a closer bench number needs is smaller hot functions for the speed tier
  (cold paths out of line), not a different steady state. watr's steady
  profile keeps its own targets: dictionary reads by parsed keys
  (`__dyn_get_expr`, 108 sites in `normalize`), small-array allocation,
  `__dyn_set`, and string hashing (a parsed key is hashed at every lookup;
  V8 caches a string's hash in the string).
- Gates on the tree with the parser work: core 4501/4502, opt0 4306/4307,
  opt3 4306/4307, wasi 4359/4360 (one skip each), self-compile 68/68,
  kernel parity byte-identical at O0/O2/O3, `bench:size` geomean 0.794×;
  the self-compile perf gate improves with the compiler it compiles: warm
  0.954× (was 1.006×), fresh 0.763× (was 0.836×).
- CI: one self-compile workflow (build, round-trip, the suite through
  `dist/jz.wasm`, the recursive check); `kernel-gate.yml` and `watr.yml`
  are gone, watr and jessie being bench cases with speed pins
  (`test/bench.js`: watr `trail`, jessie `trail` at its 1.13× standing, both
  to ratchet toward `win`); the self-compile perf gate is `npm run
  test:self:perf`, a local release step, out of `test:self`.
- The comment loop, the last named jessie residual (subscript's
  `for (s in cm = parse.comment)`): every call enumerated a flattened
  function property through the runtime merge, because shebang.js's
  `parse.comment['#!'] = '\n'` was invisible to every static-enumeration
  gate (the per-name write census predates flattening), and where the fold
  did fire it was wrong: a single-module `for (s in parse.comment)` after
  that write listed two keys of three. The root: a literal-key write outside
  a literal-bound name's layout landed in the sidecar. The plan now declares
  it in the literal (`plan/declare-written-keys.js`), the summary is the
  authority for static enumeration (`spreadSidOfExpr`: one closed layout),
  an unconditional top-level assignment or `??=` initializes a flattened
  property like a declaration (no nullish seed; `a ??= b` holds
  `core(a) ∪ b`), definite initialization covers an assignment-bound literal
  and a bracket store, a bracket string key reads as dot syntax on a
  summary-shaped receiver, and the for-in unroll takes an aliased source, a
  loop variable declared outside and `break`/`continue` (budget 384 nodes:
  the three-comment loop is 3 × 101). Found on the way: a flattened object
  property with a dot write was boxed like a function namespace
  (`materializeAutoBoxSchemas`), its store landing in the box layout's slot
  over the object's own field (`{'//', hb}` then `parse.comment.hb = 'y'`
  overwrote `'//'`); binding the literal's layout to the name closes it.
  The loop's function lost its key list, its three dynamic gets and its
  two enumeration helpers; the for-in micro-benchmark over a three-key
  record (a million iterations) runs 1.2 ms in jz against V8's 4.5.
  jessie, paired on a quiet machine: jz 1.32 ms, V8 1.33 (0.99×; the
  standing was 1.13×), so `test/bench.js` pins it `tie`; watr is unchanged
  at 1.77× first call (the tier-up finding above), 0.794× on size. The
  perf gate itself had crashed since jessie joined its speed table (no
  size row for it); it has one now, and a `trail` claim prints its mark.
  Gates on this tree: core 4502/4503, opt0 4307/4308, opt3 4307/4308,
  wasi 4360/4361 (one skip each), self-compile 68/68, `bench:size`
  geomean 0.794×. The perf gate's remaining reds are standings this round
  did not touch, each measured the same on a HEAD-source tree copy: watr
  1.79× against `trail` (the tier-up finding above), base64 1.18× and lz
  1.29× of AssemblyScript against `win` and `tie` (HEAD: 1.17×, 1.28×;
  neither case writes an object property), percolation 0.71× against its
  0.75 floor (typed arrays only). The committed snapshot has base64 at
  0.86× and lz at 0.79× of AssemblyScript with AssemblyScript's own times
  unchanged, so jz's lz and base64 slowed between the snapshot and this
  tree: item 3 (the dataset regeneration) is where that gets bisected.
- Gates on the tree with the defects below closed: core 4501/4502, opt0
  4306/4307, opt3 4306/4307, wasi 4359/4360 (one skip each), self-compile
  68/68, `bench:size` geomean 0.794× (byte-identical output), warm
  self-compile 1.006× (cap 1.03×), fresh 0.836× (cap 0.99×).
- Defects closed after the kernel-speed rules (regression tests in
  `test/async.js`, `regex.js`, `errors.js`, `classes.js`, `array-methods.js`,
  `objects.js`): the parser spelled a method shorthand as an arrow, so a
  one-statement body that was not a return or a control statement read as
  the arrow (`{ async m() { return 2 } }` resolved 2.78e-307, a NaN-box
  leak; `{ m() { this.x = 5 } }` failed "this not supported"; `{ m() { f() } }`
  returned f's value); methods now parse as `function` nodes (subscript
  commit fecc43f, `feature/accessor.js`; jz's `package.json` keeps
  its codeload pin until that branch is pushed, `node_modules/subscript`
  carries the change), strict mode rejects them as it rejects `function`,
  and jzify transforms parameter defaults with the function (a method
  shorthand in a default value reached the emitter raw). The regex `m`
  flag makes `^`/`$` line anchors.
  Strict mode rejected its own array-pattern lowering ("== is prohibited"
  from the `jz:` iterator modules). `class C { static get v() { return 7 } }`
  on one line failed "Unclosed {" and the multi-line form parsed as a static
  field `get` plus a method `v`; `{ async *[Symbol.asyncIterator]() {} }`
  hit an early error; class async generator members lower now, instance and
  static. `toSpliced` is implemented (a copy, then the splice strategy);
  `new Array(-1)` and `new Array(1.5)` throw RangeError where they trapped;
  `splice()` with no arguments deletes nothing; the strict-mode message for
  an async shape names every lowered form.
- Defects fixed with the kernel-speed rules: a lifted optional chain
  returned a BOOL continuation raw (`s?.has(k) === true` read false,
  `typeof o?.ok()` read "number"; the kernel-compiled compiler dropped the
  BigInt unbox of a method receiver through exactly this shape); a class
  dispatcher returned its class arms' BOOL raw into its tagged result; a
  class function's raw BigInt result crossed an optional chain's undefined
  join unboxed; the lane vectorizer lifted a loop whose lane-local was live
  out (`for (x in o) last = x` read "" at level 2 once the array read had
  no call to stop it); the typed-param unswitch lost its fast path behind
  the inline array arm.

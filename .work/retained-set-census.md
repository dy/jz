# Retained-set census — jz×jz self-hosted MEMORY residual (2026-08-14)

**Task**: attribute the retained bytes behind jz×jz's self-hosted 4 GiB trap
(274b6bd8's own goal-gate finding: both dormant and region-live configs trap
at exactly 4096.0 MB, identically — the region-arena program is complete and
sound, but doesn't close this wall) and design the compaction program.

**Headline verdict, stated first**: the 4 GiB wall is **not primarily a
retained-set problem** — region-arena's reclaim keeps the true retained
fact-table state small (≈23 MB at the last region round this session's
instrumentation caught). The wall is **unreclaimed churn inside
`analyzeFuncForEmit`'s per-function emission loop** (and its siblings
`emitFuncs`/`emitClosures`/`optimizeModule`'s per-func passes), which
region-arena's own design **deliberately does not wrap** (a documented
use-after-free risk, see §4). That churn is dominated (~70% of everything
measured) by **MAP/HASH-shaped allocations** — 28-byte-stride open-addressed
tables (`MAP_ENTRY`+`LANE`, `module/collection.js`), the same shape backing
`programFacts`/`ctx.scope`/`ctx.schema`'s per-sid census tables and every
per-function IR symbol table `analyzeFuncForEmit` builds and mostly discards.
None of the three named compaction levers (LANE removal, string interning,
schema-table bitfield packing), alone or combined, closes the gap — nor does
wasm64 alone, because the NaN-box's own offset field is *already* exactly
32 bits, matching (not smaller than) wasm32's 4 GiB ceiling. See §7 for the
full arithmetic and §8 for the honest "what would actually close it."

---

## 1. Method

**Self-hosted (two complementary WAT-level instruments, both diagnostic-only,
reverted)**: `scripts/self.js`'s `REGION_HOOKS_ACTIVE` hand-flipped `true`
(the established region-arena precedent, e.g. e640e77a/c8246307/274b6bd8's
own sessions), built a `names:true`, `memory:65536`-page (true 4 GiB
ceiling), `optimize:3` region-live kernel via `resolveSelfhostBuild`.
`wasm2wat --enable-all` decompiled it; a Node script (`splice-census.mjs`,
disposable, not committed) located `$__region_copy_rec` and `$__alloc_hdr`/
`$__alloc_hdr_n`'s bodies **by structural pattern match on the actual
compiled instruction sequence** (not by assuming source declaration order —
watr's O3 register allocator reorders/coalesces locals, confirmed empirically
before trusting any anchor), and spliced in two independent instruments:

- **Region-root census** — inside `$__region_copy_rec`'s own ARRAY/OBJECT/
  STRING/SET/MAP arms, at the exact point each arm commits to a fresh (not
  memo-hit) copy or durable in-place walk, incremented new exported i64
  globals (count+bytes per kind), gated by a **mark/delta change-detection
  reset**: `$__region_copy_rec`'s `mark`/`delta` params are identical across
  every recursive self-call within one region round and change only at a
  genuinely new top-level `region_exit`-inlined call site (confirmed:
  `$__region_exit` itself is fully inlined at O3, zero remaining call sites —
  the SAME class of elimination self.js's own header comment already
  documents for `$__ptr_type`/`$__ptr_aux`). This yields the retained set
  **as of the last region round that fully completed**, immune to a
  mid-traversal trap leaving a half-reset snapshot (verified: the reset
  fires once per genuine new round, not per recursive call).
- **Allocator-level cumulative census** — `$__alloc_hdr`/`$__alloc_hdr_n`
  are the *only* two functions that build a 16-byte-header block (every
  ARRAY/OBJECT/SET/MAP/HASH/TYPED-owned/BUFFER allocation in the whole
  runtime goes through exactly one, confirmed by direct read of
  `module/core.js`); hooking their own entry — unconditionally, regardless
  of call site or region-round boundary — gives **cumulative bytes-ever-
  requested by shape class for the WHOLE compile**, immune to the
  round-boundary blind spot the first instrument has (see §4).

Every insert is a stack-neutral sequence (`global.get`/i64 arithmetic/
`global.set`, or a read-only extra `i32.load` of an already-computed offset
local) — verified safe by construction, not just by hoping `wat2wasm`
accepts it (first two attempts *did* fail validation: one from inserting new
`(global ...)` declarations mid-file, shifting every later bare-numeric
`global.get N` reference — no globals name section exists in this
decompiled text, only function names; fix: append new globals strictly
*after* the last pre-existing one. One from hoisting a shared byte-count
computation above an `if`/`else` chain — a bare `if` with no `(param ...)`
requires each branch to be stack-neutral back to the block's own entry
height; fix: recompute the value fresh inside each branch.) Reassembled with
`wat2wasm --enable-all`, validated cleanly both times after the fixes.

**Validation**: run first against the established jessie corpus (46 modules,
matches the documented baseline exactly) — completes normally (642 ms), both
censuses read out sane, non-zero, internally consistent numbers (region-root
3.52 MB / allocator-cumulative 122.62 MB against a 73.5 MB final `$__heap` —
cumulative > retained, consistent with region rounds reclaiming real churn
along the way, exactly the expected shape). Only then run against jz×jz
(scripts/self.js's own 156-module/5.88 MB self-graph, `memPages:65536`).

**Native**: a fresh phase-by-phase `process.memoryUsage()` profile (259cd4fc's
own `profiler.time`/`time` seam — `frontHalf`'s bare `time(name,fn)` and
`compileAst`/`watrTail`'s `{time(name,fn){…}}` object — reused directly by
calling `frontHalf`/`compileAst`/`watrTail`/`watr`'s `compile` in a fresh
script, not by editing `index.js`), `--expose-gc` with a forced GC
immediately before and after every named sub-phase for a clean `heapUsed`
reading, on the identical 156-module jz×jz graph.

---

## 2. Self-hosted census — jz×jz, both instruments

Traps `unreachable` at 8.7 s (both instruments compiled into the same
kernel — one run). `$__heap` at trap: **4,279,008,760 bytes = 4080.8 MB**
(read as unsigned i32 — the raw export reads negative past 2 GiB, a display
artifact only, not a measurement bug), buffer at the hard 4096.0 MB ceiling
— matches 274b6bd8's own documented trap signature exactly.

**Region-root census** (last completed region round only):

| kind | count | bytes | share of this instrument's total |
|---|---:|---:|---:|
| ARRAY | 344,054 | 13,130,984 (12.52 MB) | 53.4% |
| STRING | 337,685 | 6,581,308 (6.28 MB) | 26.8% |
| SET | 3,333 | 3,479,248 (3.32 MB) | 14.2% |
| OBJECT | 21,092 | 860,352 (0.82 MB) | 3.5% |
| MAP | 1,664 | 529,728 (0.51 MB) | 2.2% |
| **total** | | **24,581,620 (23.44 MB)** | |

**≈23 MB out of 4080.8 MB heap (0.6%)** — this is the load-bearing finding.
Whichever region round this snapshot caught (this session did not add a
second breadcrumb layer to stamp the round's *name*; see §9 caveats), the
true root-reachable fact state at that boundary is small. Combined with
274b6bd8's own finding that region-live and dormant trap at the *identical*
byte count, this corroborates — does not contradict — the many prior
sessions' "region machinery sound" verdict: reclaim works, retention isn't
the problem.

**Allocator-level cumulative census** (whole compile, every `__alloc_hdr`/
`__alloc_hdr_n` call, ARRAY+OBJECT merged at this layer since both use
stride-8 headers indistinguishably):

| bucket (stride) | count | bytes | share |
|---|---:|---:|---:|
| `hdrn_map` (28B = MAP_ENTRY 24 + LANE 4) | 4,440,584 | 2,488,731,296 (2373.44 MB) | **69.8%** |
| `hdr8` (ARRAY\|OBJECT, 16B hdr + cap·8B) | 25,612,817 | 875,611,128 (835.05 MB) | 24.6% |
| `hdrn_set` (20B = SET_ENTRY 16 + LANE 4) | 372,940 | 201,283,360 (191.96 MB) | 5.6% |
| `hdrn_raw` (TYPED-owned/BUFFER, stride 1) | 0 | 0 | 0% |
| **total (allocator)** | | **3,565,625,784 (3400.45 MB)** | |
| residual (heap − allocator total) | | ≈680.35 MB | — STRING (raw `__alloc`, header inline, not via `__alloc_hdr*`) + BIGINT (8B cells) + CLOSURE env (raw `__alloc`) + region-round memo tables |

**MAP/HASH-shaped allocations alone (2373 MB cumulative) exceed the ENTIRE
native heap for the finished, encoded compile (1207 MB, §3)** — the single
most important number in this census.

Cumulative (3400 MB) exceeds retained-at-any-one-round (23 MB) by ~145×,
consistent with region-arena reclaiming real churn — but the *residual*
after reclaim still isn't what fills 4 GiB; the raw allocation traffic
itself, concentrated in an unguarded loop, is (§4).

---

## 3. Native cross-check — same 156-module graph, fresh phase profile

Full pipeline completes in 204.7 s, 13.71 MB output. Key checkpoints
(`process.memoryUsage()`, forced-GC before/after each named phase):

| phase (cumulative, end-of-phase reading) | wall ms | RSS MB | heapUsed MB |
|---|---:|---:|---:|
| `front` (parse+jzify+prepare+preEval) | 789 | 326.6 | 102.8 |
| `plan` (all 5 internal rounds incl. `narrowSignatures`) | 5,907 | 482.5 | 244.4 |
| `compileAst` (plan + analyzeFuncs + emitFuncs + emitClosures + buildStart) | 41,503 | 1,394.1 | 870.7 |
| `optimizeModule` (compileAst's own tail) | 24,797 | 1,391.7 | 898.9 |
| `optimizeTail`/`watOptimize` (watr's module-level optimizer) | 87,410 | 3,079.3 | 1,206.5 |
| `watrCompile` (final byte-encode) | 74,006 | 3,049.4 | 1,207.3 |

`compileAst` alone: **RSS 1394 MB / heapUsed 871 MB** — this is the closest
native analogue to "the compile finishing," and the figure the task's own
framing ("Native V8 compiles the same graph at ~2 GB RSS") most plausibly
refers to (this session's own number is somewhat lower — 1.4 GB vs ~2 GB —
plausibly a different sampling point or machine; order-of-magnitude
consistent, not independently reconciled this session). Full pipeline
(everything through encode): **RSS 3049 MB / heapUsed 1207 MB**.

**Per-pass corroboration, citing prior work directly** (0ae75f07's own
fine-grained dormant breadcrumb table, `.work/research.md`, already
documents the self-hosted-side number for the single hottest sub-phase):
`narrowSignatures`' own internal fixpoint (`narrowPointerResults`) costs
**+1564.9 MB self-hosted** (0ae75f07's table). This session's fresh native
measurement of the *same* phase (`plan:narrowSignatures` row, native
profile above): **+3.7 MB heapUsed / +38.5 MB RSS**. That is a
**~40–420× per-phase overhead ratio** (RSS-based / heapUsed-based) for the
single most expensive named pass in the pipeline — independently sourced
(one number from a prior session's own WAT breadcrumb, one fresh this
session), not fabricated, and it is the sharpest single data point this
census has for "why 2×+."

---

## 4. The mechanism — churn, not retention, and *why* region-arena doesn't reach it

Reconciling §2's two instruments with §3 and prior sessions' own dormant
fine-grained table (`.work/research.md`, the `analyzeFuncForEmit` checkpoint
curve: heap already at 4089.1 MB at call #1 of 1435, trapping around call
#98) gives one coherent, mechanistic story:

1. `plan()`'s 5 internal rounds + `compileAst`'s own scan-round (6 total,
   e640e77a's design) **do** reclaim their own churn — that's what keeps
   the region-root census small (§2) at whichever boundary this session's
   snapshot caught, and it's why 274b6bd8's own gate table shows the region
   machinery "SOUND" on every real-graph/kernel-oracle/kernel-parity check.
2. `analyzeFuncForEmit`'s own per-function loop (`for (const func of
   ctx.funcs.list) { analyzeFuncForEmit … }`, up to 1435 calls for jz×jz)
   is **explicitly, deliberately excluded** from region-arena's round
   boundaries — e640e77a's own design note names the reason precisely: *"a
   plain `for…of` iterator holds the array reference ONCE at loop start —
   if a nested exit relocates `ctx.funcs.list` mid-loop, the iterator keeps
   walking the STALE, about-to-be-reclaimed array"* — a genuine
   use-after-free hazard, not an oversight. `emitFuncs`/`emitClosures`/
   `optimizeModule`'s own per-func passes (native profile, §3: +260 MB,
   +248+24 MB, +135 MB RSS respectively) are siblings of the same shape —
   large, per-function-iterated, unguarded.
3. Every allocation inside that unguarded territory accumulates in
   `$__heap` with **zero chance of reclaim** until the whole compile either
   finishes or traps — this is exactly what the allocator-level cumulative
   census (§2) measures, and why it (3.4 GB+) is ~145× the region-root
   census (23 MB) while the *dormant* fine-grained table independently
   shows the SAME 4089→4096 MB climb happening in the SAME loop.
4. That unguarded churn is **~70% MAP/HASH-shaped** (§2) — strongly
   consistent with `analyzeFuncForEmit`/emission building a fresh
   symbol-table-shaped structure (locals, IR-node dedup tables, param
   binding maps) per function, most of it dead the moment that function's
   own emission finishes, none of it ever reclaimed.

**This reframes the "attribute by structure class" ask**: the dominant
retained-*at-trap* bytes are not a compact set of long-lived facts waiting
to be shrunk — they are one class of per-function scratch structure,
replicated up to 1435 times, each instance already garbage by the time the
next one is built, with no boundary to collect it.

---

## 5. Pointer-width budget — the wasm64 question, answered directly

`layout.js`'s `LAYOUT.OFFSET_MASK = 0xFFFFFFFF` — **the NaN-box carrier's
offset field is exactly 32 bits**, and the full 64-bit carrier budget is
already spent with zero bits to spare: 13 bits NaN prefix (sign+exponent+
quiet bit) + 4 bits tag (`TAG_MASK`, 12 kinds used of 16 addressable) + 15
bits aux (`AUX_MASK = 0x7FFF`, schema id / typed-elem code / closure
table index / symbol id) + 32 bits offset = 64 bits, exactly.

**wasm32's own 4 GiB linear-memory ceiling (`memory:65536` pages × 64 KiB)
and the NaN-box's own 32-bit offset field are precisely co-sized** — this
is not a coincidence, it's the natural consequence of using a plain `i32`
offset. **wasm64/memory64 alone does not extend addressable heap for this
representation**: growing memory past 4 GiB would produce offsets that no
longer fit in the 32 bits the box format allocates them, silently
truncating/aliasing pointers. Using more address space requires **widening
the offset field**, which requires taking bits from `aux` (capping distinct
schema ids / typed-element codes / closure-table indices at whatever
remains — real, load-bearing budgets, not padding) or from `tag` (already
tight at 12-of-16 kinds used) — i.e. a **NaN-box format redesign**, not a
build flag. **Verdict: "wasm64 or nothing" is not the honest framing —
it's "wasm64 *and* a NaN-box redesign, or nothing," a materially larger
undertaking than flipping a memory64 flag.**

---

## 6. Attribution table (the deliverable the task named)

| class | self-hosted bytes (cumulative, jz×jz) | native bytes (heapUsed, full compile) | overhead ratio | dominant cause |
|---|---:|---:|---:|---|
| MAP/HASH (`programFacts`/`ctx.scope`/`ctx.schema`-shaped + per-func symbol tables) | 2,373.44 MB | *(no native per-class snapshot taken this session — see §9)*; native's ENTIRE heap for the finished compile is 1,207.3 MB | **≥1.97×** against native's whole heap, likely far higher isolated per-class | 28B stride (24B entry incl. a redundant precomputed 8B hash word + 4B `LANE` probe array) vs V8's compressed-pointer hash table; capacity-not-count-sized (grow-then-half-empty); zero structural sharing across the many per-function/per-schema Maps created and discarded |
| ARRAY+OBJECT (AST nodes, schema-slotted instances) | 835.05 MB | (same caveat) | — | 8B NaN-boxed slots (every value, even a small int, costs a full f64) vs V8's compressed 4B pointers/inline SMIs; 16B fixed header per object regardless of size |
| STRING (+BIGINT+CLOSURE-env residual) | ≈680.35 MB (upper bound, not kind-isolated) | (same caveat) | — | per-string 4–8B header, zero interning beyond the STATIC literal pool (`STR_INTERN_BIT`) — explicitly does NOT cover runtime-built mangled names (`layout.js`'s own doc: "every prepareModule renameFunc mangled name" is exactly the un-interned case) |
| whole compile (single hottest phase, independently sourced) | narrowSignatures: +1564.9 MB (0ae75f07) | narrowSignatures: +3.7 MB heapUsed / +38.5 MB RSS (this session) | **~40–420×** | O(functions×params×callSites) fixpoint census, unboxed/compact natively, NaN-boxed+headered self-hosted |

**Honest gap**: a true per-class native breakdown (V8 heap snapshot,
grouping by constructor — `Map`, `Array`, string) was not taken this
session (time-boxed; §1's phase profile was the higher-priority, more
directly actionable measurement, and the qualitative attribution — jz's own
`ctx.scope`/`ctx.schema`/`programFacts` ARE literally JS `Map`s, matching
the self-hosted MAP bucket 1:1 by construction, not by inference — is
already solid without it). The ratios in the "MAP/HASH" row are therefore a
*lower bound* (2373 MB against native's *entire* graph, not an isolated
Map-only native figure, which would be smaller and the ratio proportionally
larger).

---

## 7. Compaction program — top contributors, levers, arithmetic

### Lever 1 — extend region-arena's round boundary to wrap `analyzeFuncForEmit` (and siblings) — RECLAIM-SCOPE, not byte-compaction, but the single highest-leverage lever named this session

Directly targets §4's mechanism. Requires solving the exact hazard e640e77a's
design note named: root `ctx.funcs.list` itself (not just its elements) so a
mid-loop relocation heals the iterator, or re-fetch `ctx.funcs.list[i]` by
index after every inner round exit instead of holding a `for…of` iterator.
**Savings, arithmetic**: if this loop's own churn is even half of the
allocator-cumulative MAP/HASH total attributable to it (a defensible
estimate given `emitFuncs`/`emitClosures`/`optMod:optimizeFuncs`'s own
native RSS deltas — 260+248+24+135 = 667 MB of the native pipeline's own
growth happens in exactly these per-func passes, ~54% of native's
compileAst-to-optimizeModule growth of 1394→1392+... MB range) — reclaiming
it at the self-hosted 3.4× overhead ratio observed elsewhere in this census
would remove on the order of **1–2 GB** from the peak. This is an estimate,
not a guarantee (the design note's own risk analysis is why no prior
session attempted it) — but it is the only lever in this census whose
target (unreclaimed churn) matches the actual measured mechanism, rather
than the (already small) retained set.

### Lever 2 — drop the `LANE` probe array / fold probe metadata into the entry itself (structural compaction)

`SET_ENTRY`(16)+`LANE`(4)=20B and `MAP_ENTRY`(24)+`LANE`(4)=28B
(`module/collection.js`). Removing the separate 4B/slot lane (e.g. a
tombstone-and-rehash scheme, or folding the probe distance into unused hash
bits) saves 4/28 = 14.3% on the `hdrn_map` bucket and 4/20 = 20% on
`hdrn_set`. **Arithmetic**: 2,373.44 MB × 0.143 + 191.96 MB × 0.20 ≈
**377 MB** saved (cumulative-allocation basis; retained-basis savings would
be smaller, since most of this bucket is already-reclaimed churn per §4 —
this lever helps whether or not Lever 1 lands, since it shrinks every
allocation regardless of when/whether it's reclaimed).

### Lever 3 — string interning in the kernel, extended to runtime-built names

`STR_INTERN_BIT` (`layout.js`) today covers only the static literal pool —
`layout.js`'s own doc names the gap precisely: hash-cache (`STR_HCACHE_BIT`)
strings are "most non-trivial runtime-built strings," e.g. every
`prepareModule` `renameFunc` mangled name (`${prefix}$${name}`), generated
in bulk across a 156-module self-compile with many structurally similar
names. **Arithmetic (estimated range, not measured this session)**: the
STRING residual is ≈680 MB (upper bound, un-isolated from BIGINT/CLOSURE-env
— §2). If duplicate-content mangled names across 156 modules collapse at a
30–50% rate (a plausible but unmeasured range for this specific corpus —
stated as a range, not a point estimate, precisely because the actual
duplicate ratio was not measured this session), interning saves
**~150–340 MB**.

**Lever 3 addendum (2026-08-16 session, `str-intern-2026-08-16`) — MEASURED,
estimate revised down, not pursued.** Task: runtime string interning,
census lever #3. Per the task's own "measure first" gate, instrumented the
actual construction sites (not `$__alloc` generically, which is shared with
BIGINT/CLOSURE-env — §2's own caveat) via source-level hooks gated by a
`JZ_STR_CENSUS` env var (not a shipped feature, fully reverted at session
end): `module/string.js`'s `allocCopyTail` (the shared fresh-allocation tail
of all four `__str_concat*` variants — deliberately excludes the heap-top
bump-extend fast path, which mutates an in-progress accumulator rather than
minting a final value), `__str_slice`'s non-view heap tail, `__str_repeat`'s
final (non-SSO-folded) tail, and `module/number.js`'s `__mkstr` (the single
choke point every number-to-string path — itoa/ftoa/toExp/radix — routes
through). Each hook appends `[site][len][bytes]` to a dedicated append-only
log region at a fixed high address (`0x40000000`, ~3 GiB of headroom below
the wasm32 ceiling) via a raw bump pointer **separate from `$__heap`** —
routing the log through `$__alloc` itself would move `$__heap` and silently
break the bump-extend heap-top check the concat fast path depends on,
biasing the very measurement being taken. Built a region-live kernel
(`REGION_HOOKS_ACTIVE` hand-flipped `true`, `resolveSelfhostBuild({regionArena:
true, memory:65536})`) and ran it against the jessie corpus (this doc's own
established 46-module baseline, `test/ecosystem-perf.js`'s driver shape),
reading the log back from `exports.memory.buffer` after the run completed.

*Note on method:* `optimize:3` and `optimize:2` kernel builds **both
produced an invalid wasm module** with the four hooks linked in
(`CompileError: local.set[0] expected type f64, found global.get of type
i64`, a different function index each time). `optimize:false` built and ran
cleanly, so the census ran on an unoptimized-but-otherwise-identical
region-live kernel; construction-site call counts and content are a
property of the algorithm the kernel executes, not of how efficiently its
Wasm is encoded, so this does not compromise the string-content measurement.

**Follow-up resolution (2026-08-16): the failure was in jz before watr, not
a watr miscompile.** The exact hooks were recovered from the original agent
transcript and reproduced at both historical jz `4d35ec62` and current jz
`6e75b8a3`, paired with watr `39b7437`. The same module is already invalid
with `optimize:{level:2,watr:false}`, while `promoteGlobals:false` validates.
The minimal trigger is `export const f=()=>[process,process,process]`: three
reads make `promoteGlobals` snapshot the host global, but host globals were
registered only as raw-i64 module imports, not in the optimizer's global
representation map. Its fallback therefore declared `$_pg0` as f64 and
assigned `(global.get $process)` (i64) into it. Registering the i64 carrier
when materializing the import fixes the whole class; the regression pins
both the pre-watr local type and final Wasm validation.

**Result — jessie, 46 modules, region-live, one full compile:**

| site | count | bytes | distinct | distinct bytes | dup bytes | dup% |
|---|---:|---:|---:|---:|---:|---:|
| concat | 32,016 | 1,176,765 | 6,223 | 856,788 | 319,977 | 27.2% |
| slice | 10,838 | 143,457 | 2,764 | 45,950 | 97,507 | 68.0% |
| numtostr | 2,760 | 377,950 | 273 | 355,758 | 22,192 | 5.9% |
| **total** | **45,614** | **1,698,172** | | **1,258,496** | **439,676** | **25.9%** |

`concat` + `slice` account for 95% of duplicate bytes (concat alone 72.8%)
— concentrated, meeting the task's own "≥70% in few sites" bar for a
site-targeted (not global) design **if** a design were to proceed.

**But the composition contradicts the census's own named hypothesis.** The
top duplicated strings by bytes wasted are **not** `renameFunc` mangled
names — they are the self-hosted kernel's own WAT-opcode vocabulary,
repeated across thousands of emitted instructions: `"local.g"` (×3,232,
site concat), `"i32.con"` (×1,517), `"local.get,"` (×1,003), `"i32.const,"`
(×932), `"call,$__mkptr,i32.const,1,i32.const,0"` (×98, a comma-joined IR
tuple — `Array.prototype.toString`-shaped serialization, not a template
literal), `"__ptr_type"`/`"__mkptr"`/`"__alloc_hdr"`/`"__is_truthy"` (site
slice). Mangled module-prefix names (`"m0_jessie$"` ×269, `"m43_accessor$"`
×162, `"m41_statement$"` ×139) are real and present but a minority of the
total — the census's named example was not wrong to exist, just not
dominant. (A second contamination source, noted for honesty: several
top slice/concat entries are this session's own scratch-worktree tmpdir
path components, e.g. `"_private_tmp_claude_501__Users_div_projects_jz…"`
— an artifact of where the jessie driver happened to be written for this
run, not a property of a real compile. Excluding them would shrink the
measured total slightly further, not change the verdict.)

**Scaling check against the census's own 150–340 MB estimate**: jessie's
own source is 66,654 bytes; jz×jz's self-graph is 5.88 MB — an 88.2×
scale factor. A flat linear extrapolation of jessie's 439,676 measured
duplicate bytes gives **≈38.8 MB** at jz×jz scale — 4–9× below the
speculated range (and duplicate-heavy short-opcode content, if anything,
scales *sub*-linearly per additional source byte once the small opcode
vocabulary saturates, not super-linearly, so this is if anything an
optimistic extrapolation, not a floor).

**Verdict: STOP, per the task's own "measurement says the census estimate
was wrong" gate — no interning machinery implemented this session.**
Weighed against all three named candidates:
- **(a) global intern-on-construction** — rejected. The dominant site
  (concat) already excludes the accumulator/bump-extend path by
  construction (correctly — an in-progress accumulator isn't a final
  value to intern), so the real target is the ~43K/compile fresh
  allocations measured above; scaled to jz×jz (~3.8M calls), a
  hash+probe on every one to recover ≈39 MB against a 4080→4096 MB wall
  is a poor trade even before implementation risk.
- **(b) hot-mint-point-only (mangled names)** — rejected by the data
  itself: mangled names are a minority of measured duplicate bytes, not
  the dominant site the census named. Narrowing to just that site would
  miss most of what little duplication exists.
- **(c) reject outright** — the closest to correct, though not for
  "flat profile" (it isn't flat — concat+slice are concentrated) but for
  **magnitude**: ≈39 MB against a wall that needs an order-of-magnitude
  reduction (§7's own verdict, unchanged by this addendum — no single
  lever closes the gap) does not clear the bar for the region-arena
  rooting complexity a durable runtime hash-cons table would need (a NEW
  mutable global reachable from every `regionHooks.exit(mark, [...])`
  root list — `src/front.js:93`, `src/compile/plan/index.js:107`
  (off-limits to this session by task scope), `src/compile/index.js:2556/
  2622/3066` — the exact root-completeness class of gap 274b6bd8's own
  session found and fixed for `getFactStore()`; a table piggybacked onto
  an already-rooted field like `ctx.facts` would sidestep touching
  `plan/index.js`, but that is a design note for a future session, not
  a reason to build it now against a 39 MB payoff).

**Retraction of the earlier caution:** the hook-expanded graph exposed a
real compiler defect, but it did **not** show fragility in watr or in the
string-construction helpers. The source of invalid IR was jz's generic
`promoteGlobals` pass losing an imported global's raw-i64 representation.
With that boundary fact registered, the exact four-hook region-live O2
kernel validates and executes a compiled sum oracle (`sum(100) === 4950`).
The string-interning rejection above remains unchanged—it follows from the
measured payoff and region-rooting cost, not from this now-closed defect.

All diagnostic-only hooks (`module/core.js`, `module/string.js`,
`module/number.js`) and the `REGION_HOOKS_ACTIVE` build flag
(`scripts/self.js`) were reverted before this addendum was committed —
zero functional/shipped changes this session. `resolveModuleGraph` graph
was jessie's 46-module `test/ecosystem-perf.js` driver shape; watr's own
7-module corpus was not additionally run this session (jessie alone was
sufficient to answer the measurement-first gate; time-boxed).

### Lever 4 — bitfield-pack `ctx.schema`'s per-sid census tables (post-heap-epoch-design.md's own "RepresentationPlan" note)

`.work/heap-epoch-design.md` names the shape directly: `ctx.schema` stores
`slotFacts`/`slotIntCertain`/`slotI32Certain`/`slotConstInts`/
`slotIntLevels` as **five separate `Map<SchemaId, …>`** (`ctx.js:520-546`,
cited verbatim in that design doc). Each is a *separate* MAP-shaped
allocation (16B header + `INIT_CAP`(8)×28B floor = 240B minimum *per table*,
regardless of how few schemas populate it) for what is conceptually **one
per-schema record**. Consolidating into one bitfield-packed struct-of-arrays
(one small typed record per sid instead of five hash-table entries) cuts
per-sid overhead by close to 5×. **Not quantified with a savings figure
this session** — schema count for jz×jz's own 156-module self-graph wasn't
measured, and fabricating a number here would be exactly the "hope, not
arithmetic" the task explicitly warns against. Named as real and
well-targeted (it's a direct instance of the dominant MAP/HASH mechanism),
sized as a follow-up measurement, not guessed.

### Does any lever, alone or combined, reach jz×jz < 4 GiB?

**No — stated plainly.** Lever 2 (~377 MB, arithmetic) plus Lever 3 (revised
down from its original ~150–340 MB *estimate* to **≈39 MB**, extrapolated
from the 2026-08-16 addendum's own jessie measurement above, and not
pursued — see that addendum for why) sum to **~377–416 MB** against a need
to go from ~4080 MB down under 4096 MB total *while still finishing the
compile* (native needs 1207 MB
just to reach the encoded end-state at a ~1× baseline — self-hosted's
overhead ratio, per §3's single hardest data point, runs 40–420× on the
hottest phase) — closing that gap needs an order-of-magnitude reduction,
not a 13–18% one. **Lever 1** (reclaim-scope extension) is the only
candidate whose target matches the actual measured mechanism (unreclaimed
churn, §4) and could plausibly move the needle by GB, not MB — but it is
an *estimate against a named, unresolved correctness hazard*, not a proven
number, and this session did not implement or measure it. **Lever 4** is
real but unquantified. Combining every lever named here — including the
unquantified ones at their most optimistic plausible read — does not
constitute an arithmetic proof of reaching under 4 GiB; it constitutes a
credible, prioritized *program*, with Lever 1 as the load-bearing item and
Levers 2–4 as compounding but individually insufficient compaction on top
of it.

**wasm64 is not a shortcut past this** (§5) — it requires a coupled NaN-box
redesign, a strictly larger undertaking than any lever above, and was not
attempted or estimated for savings this session (out of scope: it changes
the representation's own bit budget, not any one structure's byte count).

---

## 8. What would actually close it — honest, not hopeful

The evidence points at a program, not a single fix:

1. **Measure, don't estimate, Lever 1's real savings** — instrument
   `analyzeFuncForEmit`'s own loop the same way this session instrumented
   `$__region_copy_rec` (a WAT-level per-call heap-delta breadcrumb, the
   exact method 0ae75f07's own dormant table already used for the SAME
   loop) to get a real per-call churn number, not the ~54%-of-adjacent-
   native-phases estimate used above.
2. **Solve the `ctx.funcs.list` relocation hazard** e640e77a's design note
   named and left unattempted, then wire a region round around the loop.
3. **Land Levers 2–4** regardless of (1)/(2) landing — they reduce the
   *magnitude* of whatever churn exists, compounding with any reclaim-scope
   win rather than substituting for it.
4. If (1)-(3) together still don't clear the ceiling, the NaN-box
   redesign named in §5 (wider offset, narrower aux/tag) is the remaining
   lever this census can name but not size.

---

## 9. Caveats and methodology notes (stated, not glossed)

- The region-root census's "last completed round" was not independently
  named (front vs. one of the 6 plan/compileAst rounds vs. a watr-internal
  round) — a second breadcrumb layer stamping the round's source name would
  close this, not attempted this session (time-boxed; the allocator-level
  instrument answers the higher-priority "where do the bytes go" question
  without needing it).
- STRING/BIGINT/BUFFER/TYPED-owned-durable counting in the region-root
  census has a known bias: those four kinds skip the memo dedupe check on
  their *durable* (pre-round) early-return path (confirmed by direct read
  of `layout-kinds.js`'s generated arms — an existing, load-bearing design
  choice in the relocator, not a defect this session introduced), so a
  durable string/bigint reached via K live edges is counted K times, not
  once. Framed in §2/§6 as an upper bound / duplication-exposure proxy, not
  a precise distinct-object count.
- No native per-constructor V8 heap snapshot was taken (§6's stated gap) —
  the phase-level `process.memoryUsage()` profile was prioritized as the
  more directly load-bearing measurement within this session's time budget.
- Lever savings in §7 are explicit about which are arithmetic (2, partially
  3) vs. estimated-with-a-named-basis (1, 3's range) vs. unquantified (4) —
  no number in this document was asserted without saying which of those
  three categories it belongs to.

---

## Appendix — reproduction recipe (disposable, not committed)

Worktree at `274b6bd8` (main tip, confirmed fresh at session start).
`scripts/self.js`: `REGION_HOOKS_ACTIVE` hand-flipped `true` for the build
only, reverted before session end (`git diff scripts/self.js` clean at
commit time). Build: `resolveSelfhostBuild({optimize:3, snapshot:true,
regionArena:true, memory:65536})` + `compile(graph.code, {modules, memory,
optimize, names:true})`. Decompile: `wasm2wat --enable-all`. Splice: a
disposable Node script locating `$__region_copy_rec`/`$__alloc_hdr`/
`$__alloc_hdr_n` by structural pattern match (not source-order assumption),
inserting stack-neutral i64-global breadcrumbs, verified by `wat2wasm
--enable-all` validation (caught two real stack-shape bugs before landing,
§1). Run: `instantiate()` (`interop.js`) + `exports.default(memory.String
(code), 0, 0, memory.String(JSON.stringify(modules)), 0)` — the exact
calling convention `test/kernel-target.js` already uses for every
self-hosted-kernel test leg. Native profile: `frontHalf`/`compileAst`/
`watrTail` called directly (bypassing `index.js`'s public `compile()`, which
doesn't expose a custom profiler sink) with a `time`/`{time}` object that
wraps each named sub-phase in `--expose-gc`-forced `process.memoryUsage()`
sampling. All scratch scripts, kernel builds, and decompiled/spliced `.wat`/
`.wasm` intermediates deleted at session end; `scripts/self.js` reverted;
worktree removed.

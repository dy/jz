# Self-host perf — measured ground truth (2026-06-19)

**Goal:** make `dist/jz.wasm` (the jz compiler compiled to wasm by jz) compile the
**bench corpus** *faster* than `jz.js` (the same compiler running as JS in V8/Node).
Apples-to-apples: same compiler source, same input programs, same engine (V8 runs both
the JS and the wasm). Reference: `scripts/self.js` = the whole pipeline as one
`(source, strict, optJSON) → wasm bytes` function; built to wasm by `scripts/selfhost-build.mjs`.

## Headline numbers (Apple M4 Max, node 25.9, level 0 / optimize off at *runtime*)

Corpus = 22 bench programs (mat4, fft, mandelbrot, crc32, …) each inlining benchlib,
compiled via `compileSelf(src,0,'0')` (JS) vs `jz.wasm.default(...)` (wasm).
Methodology: per program, fresh wasm instance, warm in-budget, min of N runs.

| build of jz.wasm | corpus compile, wasm vs JS |
|---|---|
| current `dist/jz.wasm` (built `optimize:false`) | **1.42× SLOWER** (331ms vs 233ms JS) |

Per-program ratio is tight: 1.34–1.54× slower, every program. Not one outlier — a
uniform representation tax.

At **level 2** (real optimized output, what the bench drives): LOOP-shaped programs
work and wasm is **1.65× slower**; **closure- and string-heavy programs TRAP**
(`memory access out of bounds`) — the self-host optimizer path is not correct yet.

## Two distinct "optimize" axes (don't conflate)

1. **Build axis** — the `optimize` level used to BUILD `dist/jz.wasm`.
   Currently `optimize:false` → *the compiler wasm itself is unoptimized*. Obvious lever.
   An `optimize:2` build succeeds (99.5s, 4.8MB) and runs; speed delta measured separately.
2. **Runtime axis** — the level the wasm compiler USES when compiling user programs
   (the `optJSON` arg). The bench wants level 2; level 2 traps on closures/strings.

## Known correctness blockers (must fix before the win is even measurable end-to-end)

- **`_clear()` is broken in self-host.** Calling the exported heap-reset then `default`
  traps immediately (`__heap` reads 0 after). So you cannot reset the bump arena between
  compiles; without reset the no-free bump heap grows ~7MB per corpus compile and
  overflows 512MB (8192 pages) after ~70 compiles. This blocks repeated/batch compiling.
- **Level-2 (optimizer) trap** on closure/string programs — a `__set_add` GC/forwarding
  bug (today's WIP in `module/collection.js`, `.work/dbg*.mjs`). The watOptimize +
  optimizeFunc 'post' pass exercises Map/Set heavily inside wasm and corrupts.

## Profile — where the wasm spends time (node --prof over corpus compile, names build)

V8 JITs the wasm, so ticks attribute to the kernel functions by name. Hot 20% (% of total):

**NaN-box representation tax (~20%+):**
- `__eq` 6.9%  — generic NaN-box `===` (string-aware). The compiler does *enormous*
  numbers of `===` (AST tag checks, opcode compares) and they don't all hit i32 fast paths.
- `__ptr_offset` 6.6% — extract i32 offset from a NaN-boxed pointer. DESIGN claims this
  is "negligible 3 register ops"; in aggregate it's the #2 cost.
- `__is_truthy` 2.3%, `__len` 1.6% + `__length` 0.9%, `__mkptr` 0.7%, `__coll_order` 0.7%.

**String ops (~20%):**
- `__str_eq` 5.1% + `__str_eq_cold` 3.8% = 8.9% — string equality.
- `__str_hash` 5.7% — FNV-1a over string keys (every Map/Set/object key).
- `__str_indexof` 1.5%, `__char_at` 0.9%, `__str_byteLen` 0.8%, `__str_startswith` 0.6%.

**Hashing / collections / dynamic dispatch (~12%):**
- `__ihash_get_local` 4.0%, `__dyn_get_t_h` 3.2%, `__hash_set_local` 1.1%,
  `__map_hash` 1.1%, `__set_has` 0.8%, `__map_get` 0.5%, `__dyn_set` 1.0%.

**Allocation / arrays (~6%):**
- `__alloc_hdr` 1.2%, `__memgrow` 1.1%, `__arr_grow` 0.7%, `__arr_push1` 0.7%,
  `__arr_shift` 0.9% (O(n) shift on the hot path!), `__typed_idx` 2.1%.

**Compiler's own jz functions (small individually):** `m48_compile$normalize` 1.9%,
`m115_assemble$finalizeClosureTable` 1.6%, `reachableStdlib` 0.9%, `cleanup` 0.8%,
`isDroppable` 0.6%, `instr` 0.6%, `cloneTemplate` 0.5%.

C++ 13.1% (host: wasm tier-up, memgrow, the interop String marshalling per call).

## The core asymmetry

The compiler is exactly the workload jz's README lists under **"Not for"**: dynamic,
polymorphic, string-heavy, object/map-heavy, glue. V8 wins this with hidden classes,
inline caches, generational GC, string ropes/SSO, and adaptive JIT. The wasm pays a flat
NaN-box + linear-memory + manual-hashtable tax with no GC and a bump arena. Self-hosting
is the *adversarial* case for jz — which is exactly why beating V8 here is the real proof.

## Files
- Pipeline as one fn: `scripts/self.js`; build: `scripts/selfhost-build.mjs`.
- Kernel runtime (what the hot funcs above live in): `module/core.js` (alloc, NaN-box,
  dispatch), `module/string.js`, `module/collection.js` (Map/Set/HASH), `module/array.js`.
- Compiler stages: `src/parse.js`, `jzify/`, `src/prepare/`, `src/compile/`,
  `src/optimize/`, `src/wat/`, then `watr` encodes.
- Existing self-host bench (toy 3-prog): `bench/jz/jz.js`. Corpus harness to extend: `bench/bench.mjs`.

## UPDATE: _clear root cause (verified precisely)

`src/wat/assemble.js:705-716` computes `heapBase = (dataLen+7)&~7` and patches BOTH the
`__heap` global init AND the `$__clear` function's reset constant — but a LATER phase
appends more static data (interned string-constant pairs, `src/compile/index.js:149`),
which re-bumps `__heap`'s init to the final value while leaving `$__clear`'s baked
constant stale. Measured in `dist/jz.wasm`: `__heap` init = 998032 (true data end), but
`_clear()` resets to 486616 — ~511 KB *below* the data end, into the compiler's own
static constants. Post-`_clear` allocations overwrite them → trap.
**Fix direction:** single source of truth for heap base — make `$__clear` reset to
`(global.get $__heap_start)` and ensure `__heap_start` holds the FINAL heapBase (set it
after all data appends, or re-patch both whenever the data segment grows). Low effort,
unblocks per-compile arena reset (bounded memory + warm-cache reuse).

## UPDATE: optimize:2 BUILD is broken (hangs) — build-lever is NOT free

Built `dist`-equivalent at `optimize:2` (99.5s, 4.8MB, valid module). The resulting
compiler wasm **infinite-loops** compiling mat4 at runtime level 0 (killed at 30s);
the `optimize:false` build compiles the same mat4 in 16.58ms. So jz's own optimizer
**miscompiles the compiler** at -O2 (a self-host optimizer-correctness bug, related to
but distinct from the level-2 runtime `__set_add` trap). Implication: the highest-
leverage *direct* lever (ship an optimized compiler wasm) is BLOCKED until the optimizer
is correct on the compiler's own code. The build-axis and runtime-axis bugs are the same
class: jz's optimizer + GC-forwarding/Set paths aren't yet self-host-correct.

## B1 RESOLVED (reset-point) + warm-reuse scoped out

**Fixed:** `__clear`/`_clear` now rewinds `__heap` to a runtime-captured **post-init
high-water mark** (`__heap_reset`, set at the tail of `__start`), not the static-data
end. Before, `_clear` rewound *into* the compiler's own module-init heap state →
corruption. Now `_clear` preserves module-init state (verified: DSP module with an
init-time buffer survives `_clear`; full suite 2398/2398 green).
Files: `module/core.js` (`__heap_reset` global + `__clear` body), `src/wat/assemble.js`
(seed `__heap_reset` to data-end in the heapBase patch; capture post-init top in the
`needsAlloc` block where `__heap` is known to survive; drop `__heap_reset` when alloc
is pruned).

**Scoped out (full self-host warm-reuse):** compiling repeatedly in ONE instance with
`_clear` between still traps — NOT a reset-point bug, but cross-compile caches that hold
arena pointers and are designed assuming "arena strings are immortal":
`DOLLAR` (`src/ir.js:994`) and `stdlibParseCache` (`src/wat/assemble.js:24`). Resetting
the arena dangles their entries; clearing them per-compile would forfeit the
cross-compile speedup that is their whole purpose. Correct fix = hold cache-referenced
data in a separate non-reset sub-arena (real project). **Until then the bench uses
fresh-instance-per-program** (proven correct, used for all groundtruth numbers).

## SESSION OUTCOME (what landed)

**Shipped:**
- **B1 — `_clear` reset-point fixed** (module/core.js `__heap_reset`, src/wat/assemble.js capture).
  `_clear`/`_reset` now rewinds to the post-init high-water mark, preserving module-init
  heap state. Core suite 2398/2398, test:self 13/13. (Full self-host warm-reuse still
  blocked by cross-compile caches `DOLLAR`/`stdlibParseCache` — documented above.)
- **`optimize:1` self-host build** (scripts/selfhost-build.mjs, was `false`). fusedRewrite
  inlines kernel ptr/eq helpers into the compiler's hot code: ~3% over O0, builds in ~13s,
  passes test:self. JZ_SELFHOST_OPT overrides.
- **Corpus-compile bench** (scripts/bench-selfhost.mjs, `npm run bench:self`). Per-program
  jz.wasm-vs-jz.js with a parity gate (checksums wasm output vs JS output).
- **Regression test** (test/mem.js) pinning the B1 fix: a module-init typed array survives
  `_clear` + repeated alloc cycles (fails 60→4 on the old `__clear`, passes on the fix).

**Tried then REVERTED — T1.9 `__alloc` no-grow fast-path inline:** A/B on an alloc-heavy
kernel was 0.428 vs 0.424 ms — no benefit (V8 already inlines the tiny `$__memgrow`), so
it was dropped rather than add instructions to a hot path for nothing.

**Measured (after the above):** corpus geomean **~1.3× slower** than jz.js (was 1.42×; the
methodology min-of-N tightened it). The representation tax is structural; opt1's ~3% on
the wasm side doesn't flip it.

**B2 — the headline lever (-O2 self-host build) is BLOCKED by an optimizer-correctness bug:**
the compiler compiled at `optimize:2` infinite-loops on its own output. Bisected (build with
`watr:false` for fast 13s builds, test mat4 with a hang guard):
- `optimize:1` (treeshake+sortLocalsByUse+fusedRewrite): WORKS.
- The hang needs BOTH the `watr` module pass AND the Q1 group
  [promoteGlobals, specializeMkptr, specializePtrBase, sortStrPoolByFreq, internStrings,
  hoistConstantPool] — disabling either alone still hangs; disabling any *4 of 6* Q1 passes
  still hangs; all 6 off **and** watr off is the first working point. A fragile multi-pass
  interaction on the compiler's own code, not a single culprit. Fixing it unlocks the real
  win (internStrings ≈ string-tax, watr CSE/inline ≈ NaN-box tax) — the only path to
  faster-than-JS. Repro: `compile(selfGraph, {optimize: <cfg>})` then time `default(mat4)`.

**Self-host fidelity divergence surfaced by the bench parity gate:** at level 0, jz.wasm vs
jz.js output is byte-identical for most corpus programs, **2 bytes** off for fft/synth
(benign encoding), but **json** diverges substantially (16988 vs 17772 bytes). json is the
string/object/Map-heavy case — a pre-existing self-host fidelity bug worth a run-and-compare.

## WATR FIX + −O2 RUNTIME-LOOP LOCALIZATION (session 3)

**Fixed in watr (~/projects/watr) — real bug, the de-fork blocker:**
`trimTrailingZeros` (src/optimize.js, in `packData`) did `bytes.push(...parseDataString(item))`
— spreading a multi-MB `Uint8Array` as call arguments overflows the argument limit
("Maximum call stack size exceeded") on large data segments (the self-host's ~500KB+
static data). Rewrote it to use typed arrays / no spread. watr suite green (optimize.js
186/186 incl. a new large-data regression test; aggregate exit 0). This is exactly the
robustness jz's fork already had and watr lacked — the kind of thing the fork should
push UPSTREAM, not hold privately.

**Conceptual conclusion on the fork:** it's debt, not design. jz's fork adds only 2
NaN-box passes (`devirt`, `guardRefine`) + a size-guard-skip fast-path + deep-IR
robustness over watr's 25 shared passes. Single source of truth (watr exports `optimize`;
jz layers its 2 passes) is strictly better. De-fork is the right direction.

**−O2 runtime-loop — NOT fork-specific, a SHARED optimizer bug:** with watr's optimizer
(overflow fixed) the self-host BUILDS but mat4 still hangs → the bug is in shared pass
logic, present in both. Localized by profiling the hang (names build, --prof, kill):
- **86.5% of ticks in `m17_comment$m5_parse$parse$space$6`** — the parser's comment-skip
  (subscript/feature/comment.js, wrapping `parse.space`).
- **Minimal trigger:** −O2 self-host compiling ANY source containing a comment
  (`'x // hi'` or `'/* c */'`) hangs; comment-free source compiles fine.
- **Ruled out:** the loop constants are correct (`$__fc3`=1.0 increment, `$__fc28`=NaN
  charAt-OOB); loop48 (block-comment) truthiness structure matches O1. Not constant
  corruption, not the obvious EOF-exit logic.
- **Does NOT reproduce in a distilled standalone comment-skip program at −O2** — it needs
  the actual subscript code at the self-host's full module shape/scale + the multi-pass
  interaction (recall: only `watr`-pass-off AND all-6-Q1-off together avoid it).

**Next step (well-scoped now):** pin the exact mis-transform — either pass-bisect on the
self-host build against the minimal `'x // hi'` trigger (faster signal than mat4), or
instrument the compiled `space$6` to find which value diverges O1→O2. Then fix the pass
in watr (single source of truth) and verify −O3 self-host. The de-fork (export watr
optimize, port devirt/guardRefine) follows once the shared bug is fixed.

## RESOLVED — sourceInline bug fixed; -O2/-O3 self-host + level-2 corpus now work

**Root cause (pinned via inverse pass-bisection on the `'x // hi'` trigger + inline trace):**
`inlineHotInternalCalls` (src/compile/plan/inline.js), at a STATEMENT-position candidate
call, spliced only the inlined `prefix` and DISCARDED the callee's return EXPRESSION
("statement position discards the result"). For an expression-bodied arrow whose body is
itself the effect — the parser's `seek = n => idx = n` — the `idx = i` write lived in that
discarded value, so `seek(i)` became a no-op, `idx` never advanced, and comment-skip looped
forever. A general miscompile (any setter-style `v => x = v` inlined at statement position),
not self-host-specific.

**Fix:** emit the value expression as a trailing statement when non-null (a pure value is
dropped later by vacuum/DCE). One small change in inline.js. Regression test in
test/optimizer.js (optimize:2 → 7, not 0).

**Results:**
- `-O2`/`-O3` self-host now BUILD and run correctly (test:self 13/13). Build default raised
  to `-O2` (scripts/selfhost-build.mjs); `-O3` works too but its float/SIMD extras don't
  help the integer/string/pointer compiler — ratio is identical O1/O2/O3.
- **Level-2 self-host now compiles all 22/22 corpus programs** (previously closures/strings
  trapped). The realistic optimized-output workload runs end-to-end.
- Validation: core 2399✓, opt0 2400✓, opt3 2399 (1 pre-existing env-conflict, not ours),
  optimizer 134✓ (incl. new test), test:self 13✓, test:262 ✓ (only tracked xfail).

**The perf verdict is unchanged and now firmly evidenced:** building the compiler optimized
does NOT flip the corpus-compile ratio — wasm is ~1.3× slower at level 0 and ~1.5× at level 2.
The cost is the kernel NaN-box/string/map representation tax, not the compiler's own code, so
the build-axis lever (now unblocked) is not the one that beats V8. Beating V8 needs the
ratio-movers from the original analysis (atom-tag dispatch, schema-object symbol tables,
i32-tag AST ops) — the structural tax, not the optimizer level.

## watr de-fork status
watr's optimizer overflow is FIXED (trimTrailingZeros), so watr can now optimize jz-scale IR.
The −O2 hang was NOT a watr bug (it was jz's sourceInline), so de-fork wasn't required to fix
it — but it remains the right cleanup: export `optimize` from watr, port jz's 2 extra passes
(devirt, guardRefine), drop the fork. Separate, lower-priority follow-up.

## DE-FORK COMPLETE — single optimizer (watr/optimize)

jz dropped its private optimizer fork; the optimizer now lives once, in watr.
- jz's `src/wat/optimize.js` DELETED; `index.js`, `scripts/self.js`, `test/optimizer.js`
  import the default from `watr/optimize`.
- watr's `src/optimize.js` is now jz's (superset) optimizer — adopted wholesale, only
  the `watr/compile` import re-pathed to `./compile.js`; `./optimize` added to watr's
  package exports. `~/projects/watr` is `npm link`ed into jz for now.
- Reconciled watr's suite to the adopted optimizer (all green, 187 optimize tests):
  `inline:true`/`'all'` = general, `inline:'simd'` = SIMD-only (jz now passes 'simd' —
  behavior-identical); `optimize()` accepts a WAT string; i64 fold tests are value-aware
  (optimizer canonicalizes i64 consts to lossless hex); fixed `_i64Canon` signed-hex
  (`-0x1`) and the `trimTrailingZeros` large-data overflow; added a size-contract test
  (default optimize never inflates the encoded binary).
- Validation: jz core 2400 / test:self 13 (IDENTICAL to pre-de-fork — same optimizer
  code); watr full 583 + optimize 187, all 0-fail.
- Committed in watr (de-fork). NOT done by me, for the maintainer: commit the pre-existing
  `.loc` source-map work in `compile.js`/`test/compile.js`; bump+publish watr; then point
  jz's `watr` dep at the published version and drop the npm link.

## SESSION 4 (2026-06-20) — SSO 6-char + specialization triage + perf pivot

**SHIPPED (committed 778862c):** SSO extended 4→6 chars via 7-bit ASCII packing
(char i at payload bit i*7, len at 42-44). ASCII-only → added `__char1byte` (byte<128
SSO, else heap 1-byte) which fixed fromCharCode/charAt/__str_idx for bytes ≥128 — caught
as a self-host miscompile (the f64-data emitter `ir.js:443` String.fromCharCode(u8[i])
masked high bytes to 0x7f → 1.0 emitted as 2^-8 → spread/schema corruption). Centralized
codec (ssoEncode BigInt-free / ssoCharWat / ssoLenWat). Converted ALL producer/consumer
sites incl. host interop.js + src/abi/string.js charCodeAt-decomp.
- **Win:** dist/jz.wasm 41 KB smaller (4,679,160→4,638,406); corpus output −0.4%;
  compile-speed FLAT (structural). A/B: 6-char ~5% faster than 4-char on slice+=== (the
  tokenizer pattern: alloc-free slice + bit-eq compare). 7-char impossible (49>45 payload bits).
- **Validation:** jz.js full 2410/0/1skip; test:self 13/13; test:wasm all 400+ named green
  (proved zero-regression by diffing a clean pre-SSO worktree). New SSO tests in test/strings.js.

**PER-SITE SPECIALIZATION — mapped, then adversarially DISCARDED top picks (no code shipped):**
- Opp1 `__ptr_offset` inline: UNSOUND — callers pass `lookupValType(arr)||VAL.OBJECT`
  (defaulted); inlining skips forwarding → memory corruption if a grown ARRAY hides under
  the OBJECT default.
- Opp2 `__str_eq` hash-prefilter: MOOT+UNSOUND — off-8 hash exists ONLY for interned
  static strings (8-byte hdr); runtime heap strings have 4-byte len-only hdr (no hash), and
  interned strings are already bit-eq short-circuited. The 8.9% was illusory.
- Opp3 `__eq` STRING-vs-unknown fork: sound ONLY for === (== coerces '5'==5). ~1-2%.
- Conclusion: dispatch tails are low-ROI; ratio is structural. User PIVOTED to memory/hash/
  alloc/schema levers (high-roi-levers workflow).

**KNOWN BUG (pre-existing, NOT SSO, flagged):** test:wasm fuzz seed=50 opt=2 — jz.wasm emits
INVALID wasm (`f64.neg` into i32 local) for `p0=-(p0)` in deeply-nested loops; jz.js compiles
it correctly at all opts. Self-host −O2 fidelity bug (same class as the json output DIFF),
present in baseline 4b6088a (de-fork era), narrow trigger, jz.wasm-only. Needs a focused
self-host-fidelity hunt (like the __char1byte one). Does NOT affect the primary jz.js path.

**STILL TRUE:** −O2 self-host build works (sourceInline comment-hang fixed this session →
SELF_OPT='2' in selfhost-build). Headline "ship optimized compiler wasm" lever = landed.

## SESSION 4 cont — normalize O(n²) fix: BLOCKED by self-host monomorphism (reverted)

Implemented the watr normalize O(n²)→O(n) fix (Deque + extracted handleStringOp so folded
instructions process inline instead of the O(n) `nodes.unshift`). Results:
- watr testsuite GREEN (589 pass), jz.js corpus output BYTE-IDENTICAL (fc9e6bc) → correct JS.
- But the REBUILT jz.wasm regressed (many output DIFFs, wasm 315→337ms). Root cause: the Deque
  makes the shared helpers (fieldseq/paramres/typeuse) POLYMORPHIC (called with both plain
  arrays AND Deque objects). V8 (jz.js) handles polymorphism natively; jz.wasm's monomorphic
  dispatch MISCOMPILES the polymorphic .shift()/.at()/.length. (jz DOES support class/this —
  not the cause; the cause is array-vs-object polymorphism in a self-host-compiled hot path.)
- Also: the corpus bench can't even show normalize's win — its functions are SMALL, and O(n²)
  only bites LARGE bodies (the compiler's own funcs). So the gain is unmeasurable on the corpus.
- REVERTED watr (git show HEAD), re-synced node_modules, rebuilt dist/jz.wasm. test:self 13/13,
  watr pristine. A jz-compatible normalize fix would need a non-polymorphic head-index threaded
  through ALL ~98 shift sites (a full encoder rewrite) — not worth it for an unmeasurable corpus gain.

### CONCLUSION OF THE PERF-LEVER CAMPAIGN
Every post-SSO/−O2 lever proved unworkable on execution:
- dispatch specialization (Opp1/2/3): unsound (forwarding-elision memory bug) / moot (hash only
  on already-bit-eq interned strings) / ==-vs-=== only.
- hash-cache: value halved post-SSO + mutation-invalidation traps.
- reachableStdlib cache: helps jz.js more than jz.wasm in the bench (worsens the ratio).
- normalize O(n²): blocked by jz self-host monomorphism + unmeasurable on corpus.
The structural ~1.24× (NaN-box + linear memory + manual hashtable, no GC/JIT) is the floor.
THE REAL WINS — SSO (41KB, ~5% on string code; committed 778862c) and the −O2 self-host build
(comment-hang fixed) — are banked. Further gains need IR-level type-narrowing or a non-moving
allocator (different order of magnitude), not micro-levers.

## SESSION 5 (2026-06-25) — `x === "literal"` spec SHIPPED (corrects the Opp3 verdict)

The campaign above triaged Opp3 (`__eq` STRING-vs-unknown fork) as "==-vs-=== only, ~1-2%" and
shipped NO code. That verdict conflated two different levers: a RUNTIME fork inside `__eq` (what
Opp3 described, low-ROI) vs a COMPILE-TIME literal specialization that removes the `__eq` CALL +
NaN-dance at the emit site (never actually built). The latter ships now and measurably moves the
ratio — the campaign's "every micro-lever is structural floor" conclusion was too strong for THIS
lever.

**Landed (emit.js `emitLooseEq`):** when one operand of `==`/`===`/`!=`/`!==` is statically a
string, inline `i64.eq ? 1 : (__is_str_key(u) ? __str_eq(u,l) : 0)` instead of `call $__eq`.
Sound because the literal is a non-NaN STRING box (bit-match ⇒ same string), and on bit-mismatch
only a genuine string can content-match (`'i'+'f'` is a heap "if" — equal content, different bits —
so the `__str_eq` fallback stays; pure i64.eq is unsound). `__is_str_key` rejects a number whose
bits alias the STRING tag. jz's ==/=== never coerce, so it's sound for both operators.

**Measured:** kernel `$__eq` call sites 6487 → 908 (5579 specialized, the AST-tag dispatch); the
self-host corpus compile is **−2.75%** (one-process interleaved min-of-25 A/B: baseline 427.6ms →
spec 415.8ms), kernel **+137KB**. INLINED, not a helper: a single `__str_eq_lit` helper made the
kernel −53KB but was 2.4% SLOWER (V8 keeps the call at the hot MISS path — where tag dispatch spends
its time; inlining lets the optimizer fold `__is_str_key`/`__str_eq`'s prefix in). So this is the
rare micro-lever that beats the structural-floor narrative — small but real, and on the adversarial
self-host workload.

**Soundness proof (core-path change):** a 4584-case spec-on/spec-off differential at opt {0,2} = 0
behavioral divergence (the spec is provably identical to the old `__eq`); an adversarial workflow
(1580 programs across 6 lenses) found 0 divergence on the core cases (concat-heap 0/100,
type-mismatch 0/111, collection-key 0/195); its other "divergences" were all PRE-EXISTING jz subset
behaviors reproducible with `===` removed (`==` non-coercion of number↔string, `substr(-n)` neg-index,
`(s)=>s+s` param-self-concat). Kernel↔jz.js string-`===` parity fuzz 960/0. Native 2530/0, test:self 14/14.

**Surfaced + ROOT-CAUSED + FIXED (pre-existing kernel-only −O2 bug):** `test:wasm` full-local fuzz
seed=192 emitted invalid wasm from the KERNEL (`local.set $__li0` expected i32, found `f64.nearest`).
Pre-existing + spec-independent (the baseline no-spec kernel emitted byte-identical invalid wasm; jz.js
compiles it valid at every opt level); CI's wasm-target leg scales `JZ_FUZZ_GATE` down so it never
reaches seed=192 — only the full local run surfaced it.

**Root cause:** `resultType` (src/optimize/index.js, the LICM type-of-hoisted-subtree helper) detected
comparison ops — which yield i32 regardless of operand width — with the regex
`/^(eq|ne|lt|gt|le|ge)(_[su])?$/` over the op mantissa. Compiled into the kernel at −O2, that regex
**mis-anchored**: `f64.nearest`'s mantissa `nearest` starts with `ne`, so the embedded matcher accepted
it as a comparison → `resultType` returned i32 → the LICM-hoisted `f64.nearest(p0)` local was declared
i32, and `local.set $__li0 (f64.nearest …)` is an f64-into-i32 type clash. jz.js used V8's native regex
(correct, rejects via the `$` anchor); only jz's OWN wasm regex, as built at −O2 in the full compiler
module, mis-evaluated it — so KERNEL-ONLY. (The same regex compiled standalone via the kernel was
correct; it's the −O2 module-context compilation of the embedded literal that broke — the recurring
self-host −O2 fidelity-bug shape.)

**Fix (committed):** detect comparison mantissas with an explicit `CMP_MANTISSA` Set instead of the
regex — self-host-robust (Set.has / string-eq are used pervasively in the compiler and proven −O2-safe)
AND cheaper in the LICM-hot `resultType`. Kernel now valid at all opts for the trigger; `$__li0`
types f64 identically to jz.js. Validation: native 2530/0, test:self 15/15 (+ a new LICM pin compiling
the nested-loop Math.round shape through the kernel at L2), and the scalar fuzz seeds 1..200 × opt
{0,1,2,3} run THROUGH the kernel = 800 compiles, 0 invalid-wasm, 0 value-mismatch (the fast targeted
equivalent of the 70-min test:wasm fuzz leg). Lesson: prefer Set/string-eq over regex in compiler hot
paths that must survive self-host −O2.

Minimal trigger (narrowed from SESSION-4's vague seed=50):
```js
export let f = (p0) => { let v0 = 0; let i7 = 0;
  while (i7 < 29) { let i8 = 0;
    while (i8 < 23) { v0 = Math.round(p0); i8 = i8 + 1; }   // f64 result into i32-seeded v0
    p0 = 0; i7 = i7 + 1; } return v0; }                     // param reassign in the OUTER loop
```
ALL FOUR needed: (1) two NESTED while loops, (2) `v0 = Math.round(p0)` where v0 is i32-seeded by
`let v0 = 0`, (3) `p0` reassigned in the outer loop, (4) **opt ≥ 2** (opt0/opt1 kernel output is
VALID). Drop any one → valid. **Kernel-only, optimizer-level.**

What CORRECT looks like (jz.js, both opt0 and opt2): `v0` is declared **f64** (widened because
Math.round assigns a float), the loop-invariant `Math.round(p0)` is LICM-hoisted to an f64 temp,
and there is **no `f64.nearest`** anywhere (Math.round ≠ round-half-even). The kernel at opt2
instead keeps `v0` i32 AND introduces `f64.nearest` → the type clash. So the kernel mis-executes a
opt2-only pass — the v0 widening / LICM-of-Math.round interaction — when that pass is itself compiled
to wasm at −O2. Same deep class as the SESSION-3 comment-hang (sourceInline): a −O2 self-host
miscompile of the compiler's OWN code, not a bug in the source (jz.js runs the same source right).
Next-session hunt: rebuild the kernel toggling opt2 passes (the Q1/watr split from SESSION-2) against
this 5-line trigger to find which pass the kernel mis-runs; or diff jz.js vs kernel intermediate
local-type state for v0.

## SESSION 5 cont — valueOf footgun + json self-host DIFF, both ROOT-FIXED

Two long-standing self-host fidelity gaps closed, both real jz.js correctness bugs underneath.

**valueOf footgun (committed 5c6898c).** `let valueOf = 5; return valueOf` compiled to `return 0`
(and `valueOf = …` errored "Assignment to non-variable") — same for toString/hasOwnProperty/
constructor/etc. The compiler keys resolution dictionaries (CONSTANTS, F64_CONSTANTS, REJECT_IDENTS,
GLOBALS, the scope chain via `derive`, hostConsts/namespaces/exports) on the identifier name with
PLAIN `{}` objects. In V8 those inherit Object.prototype, so `'valueOf' in CONSTANTS` is true and the
lookup returns the inherited method → the identifier resolved to a boxed function. jz.js-ONLY (kernel
jz objects are prototype-less — which is why a compiler-internal `valueOf` local once miscompiled into
the kernel). Fix: prototype-less dicts (`Object.assign(Object.create(null), {…})` / `Object.create(null)`),
verified metacircular (kernel builds + runs, corpus byte-identical). +regression test, native 2531/0.

**json self-host DIFF — RESOLVED (the last corpus divergence).** json was the one bench program whose
kernel output diverged from jz.js (the groundtruth's standing "run-and-compare"). ROOT: `[...str]`
(spreading a string into its characters) returned an EMPTY array in jz. The array-spread machinery
decoded string ELEMENTS per-char (via __str_idx) but cached the source LENGTH with `__len` — array
length, which is 0 for a string. The compiler's JSON shape parser builds per-key char checks with
`expectText(k) = [...k].map(…)`; under jz.js that runs on V8 (correct, full keys), but the kernel runs
jz's own broken `[...k]` → it dropped every key NAME, emitting a smaller-but-still-correct positional
parser (hence benign: identical checksum, fewer bytes). Fix (emit.js buildArrayWithSpreads): pick the
spread length by source kind — known string → __str_len; statically-unknown → a runtime
`ptr_type==STRING ? __str_len : __len` dispatch mirroring emitSpreadCopy's element branch (NOT __length:
its `off>=8` guard returns undefined for host/static typed arrays). This fixed the general `[...str]`
bug AND made the kernel's json output **byte-identical** to jz.js at L0 and L2 → **all 22/22 corpus
programs now self-host byte-identical.** +regression test; native 2532/0, test:self 15/15.

**Re-diagnosed 2026-06-25 (was mis-filed as a facts-cache order-dependence — it is NOT).** The earlier
note claimed `(s) => [...s]` was multi-compile-order dependent (a "facts-cache leak"). Verified false:
the failure is *consistent in isolation*, not order-dependent, and the compiled code is provably
correct — `(s)=>[...s].length` → 5, `(s)=>{const a=[...s]; return a[0]}` → "h", `s.charCodeAt(0)` →
104 all pass. The real root is **V8/JSC NaN-canonicalization of BOXED values returned across the
wasm→JS boundary in non-i64-carrier lanes**:
- `() => ['a','b']` compiles to a multi-value `(f64,f64)` return of two SSO-string NaN-boxes. V8
  canonicalizes each NaN f64 lane as it crosses to a JS number, erasing the string payload, so
  `interop.read` sees a bare NaN → `null`. `[1,2,3]` survives only because plain numbers aren't boxed.
- This is exactly the canonicalization the `jz:i64exp` i64-carrier custom section already defends
  against for *single* boxed results (`ie.r`) and boxed params; it just doesn't extend to multi-value
  result lanes (nor to a heap-array whose ELEMENTS are boxed strings, read back fine from memory but
  only when the array pointer itself rides an i64 lane).
**FIXED 2026-06-26 (multi-value case).** `isBoundaryWrapped` now wraps multi-value exports;
`synthesizeBoundaryWrappers` crosses every lane as i64 (capture inner f64 lanes into locals, reinterpret
each); the `jz:i64exp` entry gains an `m` (lane-count) marker; `interop.decode` + the test `adaptI64`
adapter decode the lane tuple. `()=>['a','b']` → `['a','b']`; numeric tuples unchanged. Validated: native
2536/0, fuzz 0-div (45611 inputs), opt0/opt3/WASI 2536/0, 77 adversarial edge cases, self-host 15/15.
Two RELATED issues remain, each a *separate* root cause (NOT this boundary fix):
- **`[...s]` heap-array of slice-strings** still returns null elements — `interop.read`'s STRING case
  doesn't decode SLICE_BIT strings (the chars from spreading a string are slices into the source). A
  contained interop-decode gap, orthogonal to multi-value lanes.
- **bool / dynamic-string-param** edges are general value-representation issues (bools read as numbers in
  any collection incl. heap arrays; an un-inferable string param marshals as NaN) — pre-existing, not
  multi-value-specific.

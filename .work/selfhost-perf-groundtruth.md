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
**FIXED 2026-06-26 (string-spread + untyped-string-param), commit 1afb540.** The earlier "slice-string"
diagnosis was WRONG. Real root of `[...s]`→[null,…]: `emitSpreadCopy` (src/compile/emit.js) gated the
per-char `__str_idx` dispatch on the string module already being loaded; `(s)=>[...s]` with an untyped
param never loads it, so it fell to `__typed_idx`, whose `__len` returns 0 for a STRING pointer → every
index OOB → UNDEF stored. Fix: dispatch on `staticVT===VAL.TYPED` vs else (STRING/unknown → ptr_type
branch) + `includeForStringOnly()`. Separately, a string arg to a fully-untyped param (`(a)=>a`) marshaled
to NaN (i64-carrier slot, memoryless module → `coerce` left the string raw → `f64ToI64(string)`=NaN);
interop now SSO-encodes ≤6-ASCII strings host-side. Both validated: self-host 15/15, fuzz 0-div, regression
tests in test/data.js.

**NOT FIXED — bool-in-collections is LOAD-BEARING, not a bug.** `[true,false]`→[1,0] in any heap
array/tuple. Boxing VAL.BOOL array elements as TRUE_NAN/FALSE_NAN (the "obvious fix") BREAKS the self-host
kernel (array-reduce, closure tests) — the kernel stores comparison results in arrays and consumes them as
raw i32 (index / bitwise), so a boxed bool reinterprets to garbage. A partial multi-value-only fix would
make `[true,false]` (direct, ≤8 = multi-value tuple) disagree with `const a=[true,false]; return a` (heap).
Left as the pre-existing numeric representation. A real fix needs escape analysis (box only when the array
provably crosses to a JS export) — out of scope.

## Map/Set primitive lowering (2026-06-26, commit 050be49) — measured: V8-NEGLIGIBLE

Implemented the expert's #1 (prehash literal Map/Set get/has keys → `_h` probes, no per-access
`__map_hash`) and #3 (inline `storedKey == queryKey` i64.eq before the `__str_eq`/`__same_value_zero`
call in every hash probe). Correct + sound: native 2549/0, self-host 15/15, fuzz 0-div.

**Clean A/B on the self-host corpus (V8/node), built dist at parent vs at 050be49:**
- before: geomean **1.35×** slower (js 231.5ms / wasm 311.9ms)
- after:  geomean **1.36×** slower (js 224.7ms / wasm 304.8ms)

→ **within run-to-run noise — no V8 self-host win.** Root reason: V8's wasm tier ALREADY inlines the
tiny `__str_eq` / `__same_value_zero` / `__map_hash` callees and folds the redundant work, so avoiding a
*call frame* or a *hash recompute* buys nothing on V8. The expert's own note holds: #1/#3 help runtimes
that DON'T inline tiny callees (wasmtime, wasm2c) — the multi-runtime floor — not the V8 self-host ratio.
(Kept the changes: correct, sound, no V8 regression, and a real floor win.)

**Implication for the rest of the plan.** The V8 self-host tax is NOT call/hash overhead (V8 erases it).
It is *work V8 cannot optimize away*: the per-element BYTE WALK when a stored heap/slice key is compared
against a literal key that is content-equal but bit-distinct (the "noncanonical heap-vs-literal true
match"). So the real V8 lever is **#4 intern-on-insert** — canonicalize dynamic string keys through the
static intern table on write, making those true matches bit-equal so the #3 i64.eq fast path actually
fires and the byte walk disappears. #2 (hash CSE) and #5 (split `__dyn_get_t_h`) are also call/branch
shaving → likely V8-negligible too. Measure #4 against this 1.35× baseline before assuming a win.

## #4 (intern-on-insert) — MEASURED not worth building (2026-06-26)

Before building intern-on-insert, instrumented `__str_eq`/`__str_eq_cold` in the kernel (temp
counters, reverted) and ran the corpus (10 compiles, 6.16M __str_eq calls):
- 70.4% resolve WITHOUT a byte-walk (the #3 probe bit-eq + the cold prelude length/SSO checks).
- 29.6% reach the byte-walk; of those only **13.6% are true matches** — the rest return 0 on the
  first differing byte (same-length unequal strings).
- **#4-addressable (heap-vs-literal true-match byte-walks) = 4.0% of all __str_eq calls.**

With __str_eq_cold at 3.8% of self-host time, #4's ceiling is **~1–2%**, minus the per-insert
intern-probe write cost, on a V8 that already vectorizes the byte loop. Not worth a substantial,
miscompile-sensitive insert-path change. The audit's intuition ("the first serious __str_eq reducer")
doesn't survive measurement: the byte-walk is NOT the __str_eq tax — most __str_eq is already cheap.

## SESSION 6 (2026-07-01) — ≤6-ASCII⇒SSO producer invariant + bare-i64.eq string compares

**Fresh profile (-O2 names build, corpus ×12):** kernel helpers = **65%** of wasm-side ticks
(compiler-own 29%, host interop 6%). Clusters: __str_eq(+cold) 11.1%, hash/dyn-get 15.5%,
__str_hash 6.5%, __ptr_offset(+fwd) 7.0%. __eq is GONE (6 ticks — the ===-spec landed).
Call counts per corpus pass (helper counters): ~6M __str_eq of which **3.73M go COLD**
(byte-walk), 2.9M __str_hash, 2.06M __dyn_get_t_h (55% arriving UNhashed via __dyn_get_t),
6.5M allocs, 4.9M __memgrow checks, 870k of 877k __ihash_get_local from __dyn_move
(array shift/grow props-migration probes — next target). Page faults (fresh 512MB instance,
first-touch in timed region): ~4% — real but secondary.

**Root insight:** the cold __str_eq class is MIXED SSO×heap compares — an SSO token vs an
interned heap literal can't short-circuit, so it byte-walks via per-char calls. Cause: the
6-char SSO extension (session 4) never reached the PRODUCERS — concat's SSO fast path was
still `total ≤ 4` (i32-packing era), append_byte `alen < 4`, slice_view routed 5-6-byte
slices to VIEWS, __mkstr/jp_str/pad ≤4. Worse: **append_byte's SSO gate was DEAD CODE all
along** — `(i32.and (i32.eq ta 4) (i32.and aux 0x4000))` bitwise-ANDs a boolean 1 with the
raw 0x4000 mask ⇒ always 0 (masked for years because __str_eq content-walked the heap
results). Every `buf += s[i++]` tokenizer accumulation built HEAP short strings.

**Landed — the invariant: any ≤6-byte all-ASCII string value is SSO, at every producer**
(module/string.js header documents it as load-bearing):
- concat ×4: both-SSO splice extended to ≤6 (i64 lane math) + general mixed/heap short-pack
  (walk ≤6 source bytes, bail non-ASCII) — zero-alloc short concats.
- append_byte: SSO path fixed (the dead gate) + extended to <6 with i64 packing.
- __str_case: SSO in ⇒ SSO out (register case-map, no alloc). slice_view: ≤6 → SSO pack.
- __mkstr (ftoa/itoa/static_str — ALL number→string): ≤4 → ≤6 ('false' was heap!).
- __jp_str (JSON parse), URI codecs, __bytes_decode, repeat, pad: __sso_norm epilogue
  (new no-call helper normalizing fresh short heap strings).
- Host side already normalized (interop.js session-5).

**Exploits (all gated on ctx.features.sso):**
- __str_eq prelude: ANY one-SSO operand + bit-ne ⇒ 0 (one test kills the whole mixed class;
  cold now sees only heap×heap true candidates).
- emitLooseEq: `x === "≤6-ASCII lit"` → **bare i64.eq/ne — no call, no fallback** (the
  literal's NaN-box IS its content); heap-literal sites gain an inline u-SSO⇒0 test before
  __is_str_key. schemaKeyEq (dyn_get/dyn_set schema arms — the #1 measured __str_eq caller)
  gains the same inline one-SSO⇒ne skip.

**Justified pin updates:** perf-ratchet nest 6086→6977 (lexical loop-op count now includes
the kernel pack loops — ≤6-iteration producer-time loops, not user hot-loop work);
golden 'unknown/dynamic object' 8673→9146 (+473: pack paths + inline schema-key skips);
slice-view test slices >6 now (short slices SSO instead of view); str-eq spec pin expects
bare i64.eq for SSO literals. New invariant pin battery in test/strings.js (every producer
=== SSO-literal).

**Two latent bugs the invariant EXPOSED (both root-fixed):**
1. `__str_append_byte`'s SSO gate was dead code — `(i32.and (i32.eq ta 4) (i32.and aux
   0x4000))` bitwise-ANDs the boolean 1 with the raw mask ⇒ always 0. Every `buf += s[i]`
   tokenizer accumulation built heap short strings, forever. Fixed with an explicit i32.ne.
   Swept all modules for the boolean-AND-bitmask anti-pattern — this was the only instance.
2. Template literals (`` `$${n}` `` — the compiler's own wasm-identifier builder) lower via
   `strcat` (module/string.js bind), an INLINE alloc+copy producer that never normalized —
   the kernel registered SSO '$add5' at decl but heap '$add5' at use ⇒ self-host "Unknown
   global $add5". strcat's result now routes through __sso_norm. Pinned in test/strings.js.

**RESULT (clean same-machine A/B, corpus × 22, L0, 22/22 byte-parity):**
- baseline (HEAD + watr@2c0a7b4): **1.35×** slower (js 298.5ms / wasm 403.9ms)
- with the invariant work:        **1.21×** slower (js 310.1ms / wasm 373.7ms)
→ **~10% wasm-side win** — the largest single mover of the campaign (prior best −2.75%).
Validation: fuzz 2000 seeds × opt{0..3} 0-divergence, selfhost 15/15, test/watr.js 35/35,
strings 144, mem 46, selfhost-includes green.

**CAUTION for future producers:** a new string constructor that leaks a ≤6-ASCII HEAP
string silently breaks `===`. Route short results through __sso_norm / the pack paths.

**Suite triage note (2026-07-01):** the 13 red tests in the full suite (SIMD pow-lift /
per-pixel-color / julia / blur lane pins, slp, unswitch, deopt-D2, devirt, golden
typed-array 930→1151) fail IDENTICALLY at jz HEAD 5282b1f with published watr 5.0.0 —
they are the documented Phase-2 vectorizer-recovery targets of the pre-watr-migration
commit (see research.md "Phase 2 — IN PROGRESS"), not regressions from this session.

**Next measured lever:** __dyn_move probes the global __dyn_props hash on EVERY array
shift/grow once the table is non-empty — 870k of 877k __ihash_get_local calls per corpus
pass (~4% of wasm time), almost all misses. A cheap membership filter (never-false-negative
bit filter over inserted offsets, or a per-array has-props signal) would skip them.

## SESSION 6 cont — four more levers landed (2026-07-01 evening)

Post-invariant re-profile (names -O2, corpus ×12): helpers 62.4% / compiler-own 30.9% /
host 6.7%. __str_eq collapsed 472→161 ticks (invariant confirmed); new top: __str_hash 287
(~7%), __ptr_offset(+fwd) 302 (~7%), dyn/hash cluster ~13%. Four levers implemented in
parallel worktrees, integrated + validated sequentially:

1. **SSO fast-hash** (62452a5) — __str_hash's SSO branch: 6-iteration lane-FNV → 7-op
   multiplicative mix over the packed payload. Hash agreement updated at every point:
   strHashLiteral (ssoEncode→ssoMix / byteFnv dispatch, all literal-prehash sites route
   through it), __jp_str audited (feeds only the schema-cache sequence hash — no agreement
   needed), interned statics unaffected (≥7B/non-ASCII by construction). Cross-producer ×
   cross-consumer hash battery in test/strings.js.
2. **dyn-props probe filter** (42dc91c) — 64-bit never-false-negative bitset over offsets
   ever inserted into the global __dyn_props table gates the __dyn_move/__dyn_set/__dyn_del
   fallback probes. Its survival pin EXPOSED a real pre-existing bug: shift-then-grow of a
   props-carrying array silently dropped the props (grow's zeroed header erased the
   accidental off-16 "check global" signal) — fixed with an explicit sentinel + i32-returning
   __dyn_move.
3. **proven decode inline** (42dc91c) — __arr_grow_known inlines the raw offset extract
   (receiver proven ARRAY by all 3 call sites, __arr_idx_known contract). Full re-audit
   confirmed the Opp1 verdict still holds for src-side sites (defaulted kinds, HASH/SET/MAP
   forward too) — left untouched, documented.
4. **warm-instance reuse** (42dc91c) — one instance, _clear between compiles, byte-identical
   output for 21/22 corpus programs. The dangling-cache set was much larger than documented:
   DOLLAR + stdlibParseCache + program-facts/body-facts/binding-uses caches (all swapped
   fresh, .clear() insufficient — the Map's own backing store is an arena allocation), a
   nullExpr shared-template in-place mutation (latent), __clear now resets
   __dyn_props/__dyn_props_filter/__dyn_get_cache_* (injected post-reachability), PLUS
   companion fixes in watr (err.loc/src expando props → module state; suite green) and
   subscript (comment table rebuilt per parse; suite green). JZ_BENCH_WARM=1 bench mode;
   warm round-trip pinned in test/selfhost.js.
   **Warm-trap hunt (2026-07-01 late):** the earlier "watr-internal" diagnosis was wrong.
   Two SEPARATE danglers:
   - **tokenizer — FIXED (7a5a3b6):** src/abi/string.js memoized ssoBitI64Hex() in a
     module-level cell; the kernel's copy of that string lives in the arena → warm round 2
     interpolated the dangling pointer's garbage into `(i64.const …)` → watr "Bad int".
     Memo dropped (laziness kept, caching removed); charCodeAt shape added to the selfhost
     warm round-trip pin.
   - **json — OPEN, precisely localized:** minimal repro = a module containing BOTH a
     JSON.parse walk (`const o = JSON.parse(SRC); o.items; for(...items.length...)`,
     long non-const SRC) AND any Math.* call. Round-2 emit traps reading a STALE MAP:
     named-kernel stack (lookupValType split into sub-fns):
     `__map_get ← m65_reps$lvtOverlay (ctx.func.localValTypesOverlay) ← lookupValType ←
     readVar ← emit ← closure630 (Math emitter) ← emitBuiltinCall`. All overlay
     installers save/restore correctly and _bodyFactsCache/setupSelf resets are wired —
     the stale handle reaches a round-2 ctx.func slot through an unidentified path
     (suspects: an emitter-table closure env from round 1, or a ctx.func record surviving
     reset). Delta-debug reducer + probe harness in the session transcript; repro is 3
     lines. Bench warm mode reports json `skipped`; fresh mode and the perf pin corpus
     are unaffected.

**RESULTS (quiet machine, 22-program corpus, L0):**
- fresh-instance: **1.11×** slower (was 1.21× → 1.35× at session start)
- warm-instance (JZ_BENCH_WARM=1): **1.00× — parity with V8**, mandelbrot/crc32 at 0.98×
  (20/22; tokenizer/json skipped on the watr warm bug)
Gates: fuzz 1000×opt{0..3} 0-divergence; selfhost 16/16; full suite 2598 pass, 13 fail =
exactly the pre-existing Phase-2 set, zero new failures.

**Remaining gap to <1.0 fresh:** first-touch page faults (~4%, structural to
fresh-instance methodology — warm mode is the honest apples-to-apples), the dyn-get
dictionary cluster (~9%), __str_byteLen/char_at volume, and compiler-own recursive
walkers (~31% of ticks — inference/representation-carrier class). Also: fix the watr
warm-recompile bug to get tokenizer/json into warm mode; commit the watr + subscript
companion fixes upstream (uncommitted in their repos).

## SESSION 6 cont-2 — flow-fact lever + the domination miscompile it exposed

**Measured-first negatives (two independent agents, zero code):** the dyn-get
schema-arm linear scan is NOT hot — ~24k iterations/compile at 4.6 avg keys, no schema
>32 keys; watr's INSTR is an ARRAY (dyn-props path), TYPE/SECTION resolve via static
slots. 98.5% of dyn-gets resolve in the sidecar hash probe at ~1.26 iterations. The
dyn cluster's residue is fixed per-call dispatch overhead — near its structural floor
without representation change. Don't re-chase the hash-index idea.

**Flow-fact lever (emit.js):** decl value-kind facts now recorded at emitDecl (right
after each init emit) instead of one statement late in emitBlockBody — for-init decls
(the for-of desugar: `let arrVar = __iter_arr(x), idx = 0, len = arrVar.length`) now
carry ARRAY facts, so loop-body `arrVar[i]`/`.length` take the array fast path instead
of __typed_idx/__length.

**Pre-existing MISCOMPILE the lever exposed (root-fixed):** the overlay recorded facts
whose sites don't dominate later reads — `let x = [7,8]; if (c) x = 5; x.length`
dereferenced the number 5 through the ARRAY fast path (OOB) at HEAD, before any new
change. Fix: per-block nested-assignment blocklist (collectNestedAssigns) — a name
written at any nested position (if/loop/closure body, for-step) carries no overlay
fact; top-level `=` re-records (dominates). Declarations are NOT reassignments (a
for-init `let x = …` must not block x — that subtlety preserves the whole lever).
Pinned: 3 flow-fact tests in test/inference.js.

**RESULTS (full 22-case corpus, quiet machine):**
- fresh-instance: **1.06×** (1.35× at session start → 1.21 → 1.11 → 1.06)
- warm-instance: **0.97× — jz.wasm is FASTER than jz.js-on-V8** (21/22; tokenizer now
  warm-clean after the ssoBitI64 fix; json still skipped on the lvtOverlay dangler)
Gates: fuzz 1000×opt{0..3} 0-div, selfhost 16/16, perf pin green (warm 0.927× /
fresh 1.027× on the pin subset), full suite zero new failures.

## json warm-trap — root-cause session (2026-07-01 night): landmine found, policy designed & parked

**Diagnostic method that worked:** instrument the kernel's growth/sidecar-install paths
with a "durable receiver" check (`off < __heap_reset` at write) + exported counters +
key capture. Array/hash GROWTH of durable containers: **zero** (that class is clean).
Durable-object SIDECAR installs: **exactly one** — key `"unreachable"`, receiver =
**watr's INSTR array** (compile.js:1040 lazily repurposes the init-built INSTR array
into a name→opcode dict via `INSTR[nm]=…` on first compile). In-kernel that installs a
round-arena sidecar whose pointer survives in the durable header across `_clear` — a
landmine any program can hit when round-2 allocations alias it (mat4 tolerates it by
luck; the earlier lvtOverlay-garbage read and the cyclic finalizeClosureTable tree are
both downstream corruption symptoms, not causes).

**The conceptual fix (designed, implemented, REVERTED — saved as
.work/durable-dynprops-policy.patch):** durable receivers (off < __heap_reset at
runtime) route dyn props to the GLOBAL __dyn_props table (which __clear resets) —
prop lifetime matches storage; init-time writes still take sidecars (heap_reset is
data-end-seeded during __start, so init sidecars land durable). Template gating via
`heapResetWat()` (expansion-time declGlobal check, const-0 fallback for alloc-pruned/
shared modules). Patched arms: __dyn_get_t_h (ARRAY zero-shortcut + OBJECT + TYPED/SET/
MAP), __dyn_set ×3, __dyn_del ×3 — native tests all green, BUT the kernel broke
(selfhost 15 fail, "Unknown instruction 23/$inc"): the PREHASHED dot-access paths
(`__hash_get_local_h` via core.js:709, `__dyn_get_expr_t_h`, `__dyn_get_any_t_h`) and
the enumeration merges (Object.keys / for-in / stringify schema∪dyn-props) still read
sidecars directly — writes went global, those reads missed → watr's INSTR dict
half-visible → immediate-consumption misalignment. **The policy is right but must land
on ALL dyn-prop paths atomically**: get_t_h/set/del (patch has them) + expr_t_h +
any_t_h + the core.js prehashed dot path + enumeration merges + __dyn_move. A focused
follow-up session task; the patch file is the starting point.

**json's cycle persisted even under the partial policy** — there is at least one MORE
dangler beyond INSTR (the reduced repro needs the JSON walk + several extra module
functions; trap = self-recursion in finalizeClosureTable's scan over a cyclic tree).
Re-reduce after the policy lands fully.

Perf state unchanged and re-confirmed after revert: pin warm 0.911× / fresh 1.024×,
selfhost 16/16.

## Synthesis across #1/#3/#4 — the tax is distributed, not a fixable primitive

Three expert/audit-recommended primitive optimizations, all measured: #1+#3 V8-negligible (V8 inlines
the callees), #4 ~1–2% ceiling (byte-walk is only 4% of calls). The self-host V8 tax is DISTRIBUTED —
the NaN-box representation (every value reinterpret), __ptr_offset 6.6%, the 70% of __str_eq that's
already-cheap-but-still-called, __eq dispatch — none individually fixable by a local recognizer, and V8's
JS tier beats V8's wasm tier on this helper-heavy shape regardless. This is the audit's own deeper point:
the moat is the ARCHITECTURAL SUBSTRATE (unified EffectFacts/Alias facts, canonical mid-level IR, a
V8-wasm lowering lab) + MEASUREMENT INFRASTRUCTURE (durable helper-counter harness = audit #5, coverage
matrix = audit #1), NOT another primitive. Build the measurement tool first; let it pick the next target.

## Session 7 — subscript 10.5.0/10.5.1 compat + recognizer restoration
Six engine fixes unblocked self-hosting the rewritten subscript tokenizer core (see
parser-bugs.js pins); seven pre-watr recognizer regressions restored (diagnosis fleet
+ serial fixes). subscript upstream: for-head re-association + decl-comma continuation
(417c895, +1). watr npm-clobber bit twice — node_modules/watr must stay a link.
OPEN: kernel gate red on "Unknown instruction f64.nearest" — in-kernel miscompile of
watr's INSTR-dict refactor (native watr green; reduce via the native-jz-compile-watr
differential harness). Also open: codegen i32-global pin, unknown-receiver NUMBER-key
pin (unswitch now fires there — likely re-pin), closure-parser golden +1478, ratchet
buf, watr-side licm-before-devirt in finish() (swap), 5 pre-existing stragglers
(for-in dyn-keys, slice-view ×2, uncatchable sanity, Object.create OOB).

## Session 8 — durable-dynprops v2: landed, exposed deeper strata, parked again
The atomic re-land (all sites: get_t_h dual-check global→sidecar for init-time keys,
set gate, del ORs both sources, __obj_clone merge, enumerate/json 3-way merges;
expr/any/prehashed verified delegating — no change needed) is DESIGN-CORRECT and
saved as .work/durable-dynprops-policy-v2.patch (772 lines). Reverted because it
EXPOSES two pre-existing strata that net-worsen the gates (fresh pin 1.05×→OOB):
1. Array-growth forwarding is not _clear-safe: grow writes the forwarding sentinel
   into the OLD (durable) header pointing at an EPHEMERAL target — outlives it.
   Fix needs a durable relocation registry consulted by followForwardingWat/
   __ptr_offset_fwd (~25% of compile ticks, dozens of inline sites). Own campaign.
2. Un-root-caused fresh-instance OOB: durable module-scope closure invoked across
   two loops + cross-module calls (mat4 repro), independent of _clear.
Landing order when resumed: (1) forwarding registry, (2) OOB #2, (3) re-apply v2.
Warm pin + json 22/22 + JZ_BENCH_WARM all block on this chain.

## OPEN (next): in-kernel OPCODE-dict miscompile — 'Unknown instruction f64.nearest'
String corruption fixed watr-side; residual 4 selfhost reds = kernel's embedded
watr can't resolve f64.nearest (+1 empty-name, +1 vectorizer internal). Native
watr green ⇒ jz miscompiles watr const.js's eager dict build
(`for (...) typeof(item=TABLE[i])==='number' ? code=item : ([nm,imm]=item.split(' '),
OPCODE[nm]=code++, ...)`) — suspects: comma-expr-in-ternary-arm value semantics,
destructuring-from-split, code++ interleave. Reduce natively: jz-compile const.js
+ probe OPCODE['f64.nearest'] (same harness as the parse.id hunt, scratchpad
tok-min.mjs pattern). Then the tone-map vectorizer 'empty value' internal.

UPDATE: const.js build-loop rewrite (canonical flat form, committed watr-side,
watr suite 590 green) did NOT clear the f64.nearest kernel reds ⇒ the miscompile
is in the LOOKUP path, not the dict build: compile.js's instr()/HANDLER consumers
reading OPCODE/IMM (682-key heap-string dict reads in-kernel), or module state
around them. Reduce: jz-compile const.js+probe first (rule out build in-kernel too),
then compile.js's instr dispatch on a minimal (f64.nearest) module — same native
differential harness. Tone-map vectorizer 'empty value' internal = separate 5th red.

## RESOLVED — OPCODE-dict lookup miscompile root-caused to watr's packData + jz's internStrings

**Both the dict build AND the dynamic lookup are individually correct** — proven by a
native-differential harness (native jz compiling watr's const.js/compile.js, a probe
driver, node_modules symlinked into scratch): `OPCODE['f64.nearest']` (literal key) and
`watrCompile('(module (func (f64.nearest …)))')` (parser-tokenized key) both give 158 /
match jz.js at every optimize level, even bundling the FULL self.js+watr graph (139
modules, one level of native-jz compilation). The bug needs a SECOND property: **self.js
must be the literal graph ENTRY** (`resolveModuleGraph(self.js)`, matching the real
build exactly) — re-exporting it from a wrapper module (`export {default as compileSelf}
from '…/self.js'`), or reaching watr's `const.js`/`watr.js` via an extra direct import
(even one that resolves to the identical realpath through a different symlink chain),
changes treeshake/dedup enough to hide the bug. `self-mirror.js` (self.js's own source,
relative imports rewritten to absolute, entry unchanged, module count 130 matching the
real build exactly) is the reliable native repro — one level of indirection cheaper than
debugging the actual two-level-compiled kernel.

**Bisecting `optimize`'s object-config form (`{level, watr, internStrings, …}`) on that
exact entry found the minimal pair:** `{level:1, watr:true}` and `{level:2, watr:false}`
BOTH compile the kernel correctly (native jz, one level); only watr's default pass suite
**+ internStrings together** reproduce it — matching this codebase's established
multi-factor self-host bug shape (session 3's −O2 comment-hang needed watr AND the Q1
group together). **Disabling watr's `packData` pass alone** (its ~20 other passes +
internStrings stay on) fixes it, at both the minimal bisection config and the real
default level-2 config.

**Mechanism (as far as pinned without editing watr):** `buildInternTable`
(src/compile/index.js) gives interned static strings (5–32 bytes, `internStrings` on) an
8-byte `[hash u32][len u32]` header instead of the plain 4-byte `[len u32]` one, plus a
separate sparse open-addressing intern-probe table (`buildInternTable`) — both are
zero-run-dense (a length/hash field's high bytes, empty probe-table slots). watr's
`packData` (src/optimize.js) drops "long" interior zero runs from data segments,
relying on wasm's implicit zero-init to restore them at instantiation — a generic,
previously-safe size optimization that a small (~300-literal) native repro does NOT
reproduce, so it needs the self-host kernel's actual interned-literal density/shape to
misfire; the exact byte-level fault (which zero-run, which downstream read) wasn't
pinned further given the "don't touch watr" constraint — there's nothing to patch
locally, and characterizing it deeper only matters for an eventual upstream report.
STRING CONTENT itself is never corrupted (confirmed: `op` arrives at watr's `instr()`
with the exact right bytes — the error message interpolates `${op}` and prints
`f64.nearest` correctly); watr's OWN parser tokenizes opcode names via `buf += str[i++]`
(char-by-char concat, never `.slice()`, so `internStrings`' slice-probe never even sees
watr's tokens) while jz's own array-literal AST nodes (Math.round's
`['f64.nearest', …]`) never touch this path at all — explaining why Math.round was
always immune while every OTHER f64.nearest site (all reached via a WAT-TEXT stdlib
template — `module/math.js`'s `math.exp2`/`math.sin`/`math.cos` — parsed by watr's
parser at KERNEL RUNTIME) tripped it.

**Fix (scripts/selfhost-build.mjs):** wrap the self-host build's `optimize` level in
`{level, watr: {packData: false}}` instead of the bare number/string. Kernel size
+37 KB (0.8%) from the disabled zero-trim; no other behavior change (watr's other
~20 passes + internStrings stay on, matching every prior session's build-lever work).
Pinned: `test/selfhost.js` gains `math-sin`/`math-cos`/`math-pow` samples (new coverage
— `math-exp`/`math-expm1` already covered `math.exp2`'s WAT-text f64.nearest, but no
prior sample reached `math.sin`/`math.cos`, whose f64.nearest lives directly in their
OWN templates, or `Math.pow`'s general path).

**Results:** `test/selfhost.js` 11/16 → **19/19** (16 original + 3 new samples; all 4
f64.nearest-shaped reds fixed — math-sqrt/math-exp/math-expm1/LICM — warm-instance reuse
was already green, contra this doc's "parked" note two sessions ago). `test/parser-
bugs.js` 13/13, `test/statements.js` 183/183 unaffected (both gates only exercise
native jz — this bug and fix are purely in the self-host BUILD orchestration).

## OPEN (new, separate) — in-kernel typed-array-element comparison miscompile, blocks selfhost-perf.js

Found while chasing the "tone-map vectorizer 'empty value'" 5th red (test/selfhost.js's
last test): it is NOT SIMD-specific and NOT new — it's **pre-existing** (reproduces
identically on a from-scratch kernel build with the bare `optimize:2` config, i.e.
present before this session's packData fix and before it) and **much bigger blast
radius than one test**: `test/selfhost-perf.js`'s two ratio-gate tests (`warm-instance`/
`fresh-instance ≤ cap`) both THROW (not just measure high) on EVERY ONE of their 6 bench
cases (mat4/fft/biquad/sort/crc32/mandelbrot) — the perf gate is currently
**unmeasurable**, not merely over cap.

**Minimal repro (native jz correct; kernel-only, at `optimize:'0'` — the level the
running kernel uses to compile these bench cases, no watr/internStrings involved on
that inner compile):**
```js
export let f = (samples, j) => samples[j] > 0
export let main = () => { const s = new Float64Array(5); s[0] = 3; return f(s, 0) | 0 }
```
`jz(src).exports.f(new Float64Array([3,0,0,0,0]), 0)` → `true` at every native optimize
level. Through the kernel (`compileSelf(src, 0, '0')`) → throws `compiler internal:
expected emitted IR value in <module>, got empty value` (src/ir.js:57's `asF64` null
guard — some `emit()` call in the comparison's codegen path returns `null`/`undefined`
instead of an IR node). Same plain-array version (`const s = [3,0,0,0,0]`) compiles
fine — **TYPED-array-element-in-comparison specifically**, not arrays/comparisons
generally. Suspect (unconfirmed): `module/array.js`'s `ctx.core.emit['[]']` handler
gates its typed-array fast path on `ctx.core.emit['.typed:[]']` truthiness — another
dyn-prop-shaped lookup (`ctx.core.emit` is `derive(proto)`, grown across modules the
same way `OPCODE`/`ctx.core.stdlibDeps` are) — worth checking first since it matches
this session's whole pattern, but NOT bisected/proven the way the packData fix above
was; treat as a fresh hunt, not a confirmed cause.

**Impact:** blocks `test/selfhost-perf.js`'s ratio gates entirely (can't measure a
ratio when the wasm throws mid-corpus). Does not affect the `test:self` build/sample
gates (none of the 19 selfhost.js samples index a typed array in a comparison) or
`test:matrix`/`test:262`/native perf (`test/perf-ratchet.js`, `test/bench.js`) — all
native-only, unaffected. `test/differential.js` has one unrelated pre-existing red
(`round half-integers: round(7) → jz 4 ≠ js 5`) also present before this session,
confirmed unrelated (a native, non-self-host rounding-semantics test; nothing this
session touched is on that path).

## RESOLVED — root cause was jzify, not module/array.js; the `.typed:[]` suspect was a red herring

The `ctx.core.emit['.typed:[]']` dyn-prop suspicion above was wrong. Bisection (marker
`err()` calls threaded through `emit()`/`emitElementAssign`/`.typed:[]=`, then through
`compileAst`/`prepare`/`lower` via two new temporary diagnostic exports on `self.js` —
`diagPrepareOnly`/`diagLowerOnly`, run-then-reverted) localized the throw to BEFORE
`compileAst` ever starts (`ctx.func.current`/`ctx.error.node` still at their `reset()`
values at the throw — confirmed meaningful by cross-checking a real, unrelated kernel
error, which also never showed `ctx.func.current?.name`: that field is simply *never*
populated in this build, native or kernel — `sig` objects carry no `.name`, `ctx.func`
current holds the sig; a pre-existing, harmless message-cosmetic gap, not a clue). A
`strict:1` call (`parse` + `liftIIFEs` only, skipping `jzify`) compiled the repro fine —
isolating the bug to **`jzify`**, which none of `parse.js`/`prepare/`/`type.js`/etc.
import `ir.js`'s `asF64` from, so the "empty value" text was misleading: `asF64` was
never called from jzify at all in the sense of a direct call — see mechanism below.

**Root cause: `jzify/hoist-vars.js`'s `isDestructurePat`.** Pre-`prepare()`, a `'[]'`-
tagged node is ambiguous — jessie's parser doesn't yet split array-literal/destructure-
pattern (`[a,b]` → `['[]', commaSeqOrSingleElem]`, length ≤ 2) from element-access
(`arr[i]` → `['[]', receiver, index]`, ALWAYS length 3) — `prepare()` does that split
into `'['` vs `'[]'` tags, but jzify runs first and only checked the tag:
```js
Array.isArray(p) && (p[0] === '[]' || p[0] === '{}' || (p[0] === '=' && isDestructurePat(p[1])))
```
So `arr[i] = v` — ANY bracket assignment, ANY receiver (typed array, plain array, plain
object with a dynamic key) — misclassified as a destructuring-assignment pattern and got
walked by `transformPattern`/`hoistPattern` (treating `arr`/`i` as binding targets)
instead of falling through to the generic `[op, ...args.map(transform)]` path. For the
receiver-name + literal/simple-index shape every real destructuring/element-access
program in the native suite happens to use, **both paths reconstruct byte-identical
IR** (proven: `compile()` output for the repro and for the whole `test/selfhost-perf.js`
6-case corpus is byte-for-byte, hash-identical with vs without the fix) — a pure
coincidence of this shape, not a general safety net, which is exactly why this sat
latent through every native test run. The self-hosted kernel exercises `transformPattern`/
`hoistPattern`'s OWN compiled code path instead of the generic fallback's, and that path
is where the divergence turns real — the two are equivalent in *result* but not in
*execution*, and only the *wrong* one's compiled form throws `asF64`'s null guard deep in
its own call graph (not traced further than that — once the true root cause was pinned
and the fix was this precise and this cleanly proven risk-free, chasing the exact
mis-instruction inside `transformPattern`'s -O2-compiled body stopped being worth it).

**Fix (`jzify/hoist-vars.js`):**
```js
Array.isArray(p) && ((p[0] === '[]' && p.length !== 3) || p[0] === '{}' || (p[0] === '=' && isDestructurePat(p[1])))
```
Arity disambiguates: element access is always exactly `[op, receiver, index]`;
literal/pattern arrays never reach length 3 (multi-element forms comma-wrap into a
single second slot). `p[0]==='{}'` needs no such guard — object *member* access is a
different tag (`.`/computed `[]` on an object still routes through the same `'[]'` check
above; `'{}'` is exclusively literal/pattern).

**Validated:** 26-case targeted native differential (typed/plain-array/hash element
writes with literal/string/bool/null RHS across receiver types, PLUS array/object
destructuring — basic, single-element, nested, defaults, rest, params, for-of, swap) —
all pass, optimize on and off. Full native suite: 2595/2650 pass, the same 55 pre-
existing failures with and without the fix (confirmed via stash A/B — this doc's "13
pre-existing" note is stale; 55 is the current baseline, unrelated to this fix).
`test/parser-bugs.js`/`test/differential.js`/`test/statements.js`/`test/simd.js`: zero
new failures (stash A/B'd `simd.js`'s 2 reds and `differential.js`'s 1 red too — both
pre-existing). `test/selfhost.js`: 19/19 → **20/20** (new `typed-elem-write-literal`
sample pinning the exact charter repro through the kernel). Pinned natively too:
`isDestructurePat` unit-checked directly (`test/parser-bugs.js`) plus the end-to-end
shapes, so a regression is caught even if a future native coincidence masks it again.

## OPEN (new, separate) — self-host build produces INVALID wasm for most of the bench corpus at runtime level 0 (blocks the ratio gates, unrelated to the fix above)

Fixing the jzify bug above unblocks `test/selfhost-perf.js`'s ratio gates from throwing
on every case — but doing so exposes TWO further, pre-existing, unrelated gaps that were
never reachable before (nothing ever got far enough into a corpus run to hit them).
**Proven pre-existing, not caused by the jzify fix**, by a strict A/B: reverting the
jzify fix and rebuilding reproduces the ORIGINAL "compiler internal: expected emitted IR
value" throw on all 22/22 corpus programs in both warm and fresh scripted benches (0/22
measurable) — i.e. neither of the two issues below was ever observable before this
session, in any prior kernel build, because the corpus never got past this doc's
`OPEN`-section bug on a single case.

1. **Most of the corpus compiles to genuinely INVALID wasm at the kernel's runtime
   level 0** (`s.exports.default(src, 0, '0')`, what both perf test files use). Spot-
   checked mat4/json/sort/crc32/bitwise/callback: all fail `new WebAssembly.Module()`
   identically — `type error in return[0] (expected f64, got i32)` — same shape as the
   session-5 `narrowI32Results`-adjacent -O2 self-host miscompiles this doc has already
   fixed twice (CMP_MANTISSA, sourceInline). Native `compile(src, {optimize:'0'})` for
   every one of these programs is valid + byte-identical with/without the jzify fix, so
   this is a KERNEL-BUILD-TIME issue (self.js compiled to wasm by native jz, `optimize:
   {level:2, watr:{packData:false}}`), not a general compiler bug. Reproduces
   identically at self-host BUILD level 1 too (still watr-on) — not the level-2-only
   passes; narrower bisection (watr on/off, per-pass) not done — same shape as every
   prior "OPEN (next)" hand-off in this doc, scoped out here as a fresh, separate hunt.
   `bench-selfhost.mjs`'s parity check (`fnv(jsBytes)===fnv(wasmBytes)`) flags this as
   `⚠ DIFF` on literally every case (21/21 that compile) — it never runs
   `new WebAssembly.Module()`, so it under-reports: DIFF here usually means invalid, not
   "benign encoding" as the session-4/5 "2 bytes off" precedent assumed.
2. **Warm-instance reuse (`_clear()` between compiles, ONE instance) now traps on
   100% of the 22-case corpus** (`fnv`/parity aside — every case throws before
   producing bytes at all), both in `test/selfhost-perf.js`'s warm-instance gate
   (`Unknown memory end` — a watr `id()` lookup miss, i.e. a WAT-text reference to a
   memory index that doesn't exist in the current module, the dangling-cross-compile-
   cache shape this doc's "json warm-trap"/"durable-dynprops" sections already
   describe) and in `JZ_BENCH_WARM=1 node scripts/bench-selfhost.mjs` (all 22 report
   `warm-trap`, mat4→fft two-case repro throws `memory access out of bounds` — same
   class, different concrete trap, consistent with a dangling-pointer bug whose exact
   symptom depends on what the stale offset now aliases). This is the SAME open
   landmine class the "json warm-trap"/durable-dynprops-v2 sessions already found and
   parked (INSTR-dict sidecar + array-growth-forwarding + at-least-one-more dangler) —
   just now visible across the WHOLE corpus instead of one program, because nothing
   previously survived long enough in a warm instance to hit it twice.

**Measured (this session, quiet-ish machine, corpus × 22, level 0):** fresh-instance
geomean **1.40×** slower than jz.js (21/22 — `aos` traps OOM even fresh; every
compiling case flagged `DIFF` per the invalid-wasm finding above, so this ratio is
honest wall-clock but not a clean parity-gated number the way session 6's 1.06×/0.97×
were). `test/selfhost-perf.js`'s 6-case subset: fresh geomean **1.34–1.36×** (cap
1.22×, FAIL), warm throws immediately (cap 1.08×, FAIL — unmeasurable, same as this
doc's prior "unmeasurable, not merely over cap" framing for the OLD bug). Both ratio
numbers are consistent across repeated runs and proven unrelated to the jzify fix
(byte-identical native compiles; A/B on the OLD kernel shows 0/22 measurable either
way) — they are the corpus's first-ever real measurement, not a regression to chase in
this session's diff. `json` specifically: no longer special-cased — it fails the SAME
way as the rest of the corpus now (warm-trap; fresh compiles but is invalid wasm),
folded into the general finding above rather than being the one outlier it was in
session 5.

**Next session:** two independent hunts, in order — (1) the invalid-wasm return-type
mismatch (narrower, more likely to be a single miscompiled pass given the uniform
"type error in return[0]" signature across every program tested — start with
`narrowI32Results`/`src/compile/narrow.js` compiled at self-host build level, the same
diagnostic-marker technique this session used); (2) the corpus-wide warm-instance
dangling reference (larger scope — likely needs the parked durable-dynprops-v2 policy
finished, not a local fix). Both block the ratio gates; neither blocks `test:self` (its
samples are too simple to reach either) or anything native.

## RESOLVED — fresh-corpus invalid-wasm root-caused to a ternary-duplicated `emit()` call in emit.js's 'return' handler; NOT narrowI32Results

**Root cause (pinned via WAT diff on the charter repro + ddmin, not the build-level
bisection the prior hand-off suggested):** `narrowI32Results` was a red herring — native
and the kernel agree byte-for-byte on every narrowing decision. The divergence is
downstream, in the RETURN-VALUE rebox. `emit.js`'s `'return'` op handler computed the
reboxed IR as:
```js
const ir = pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)
```
`emit(expr)` is called separately, inline, once per ternary arm — only one arm ever
executes, and both textually reference the identical `expr` AST subtree. Behaviorally
identical in plain JS (function-call argument evaluation doesn't care whether the call
site is written once-and-stored or twice-inline-in-dead-and-live-branches) — but the
SELF-HOSTED kernel, at every self-host BUILD level (0/1/2, ruling out watr/sourceInline/
any single optimizer pass) and every runtime optimize level, drops the `f64.convert_i32_s`/
`_u` rebox on the taken arm's result. A function whose result narrowSignatures correctly
leaves at f64 (e.g. because narrowing is blocked by an unrelated same-name value-used
shadow elsewhere in the program, or — more naturally — by mixed return-tail kinds: one
f64 tail, one `(expr)|0` i32-shaped tail) then returns the RAW i32 bits where the wasm
validator expects f64: `type error in return[0]: expected f64, got i32`, identical
signature on every corpus program that has any such shape.

**Method that found it:** kernel exports (`compileWat`/`default`) on bench/mat4+benchlib
reproduced `Compiling function #42 failed: type error in return[0]`; mapping the wasm
function index to the WAT function list (both dumps have the same 49 functions in the
same order) landed on `$medianUs` — benchlib's `return (samples[(samples.length-1)>>1]
*1000)|0`. Diffing native vs kernel WAT for that ONE function showed the kernel's
`(return (i32.or …))` missing native's `(return (f64.convert_i32_s (i32.or …)))` wrapper
verbatim — everything else byte-identical. ddmin on the INPUT source (not jz's own
source) shrank the trigger from the full corpus to an 8-line snippet, and separately
confirmed `medianUs` was blocked from narrowing by `printResult`'s PARAM (also named
`medianUs`, used in a template literal) — `isFuncRef` (src/ast.js) is a scope-blind bare
NAME match, so `valueUsed` picks up the parameter as if it referenced the outer function.
Harmless pessimization on its own (native still compiles it correctly, just unnarrowed),
but it's exactly the shape (f64-result function, i32-shaped return tail) the real bug
needs — and arises naturally too, via mixed-kind return tails, no name collision needed.

**Fix (`src/compile/emit.js`, the `'return'` handler):** materialize `emit(expr)` into a
local ONCE, before branching:
```js
const emitted = emit(expr)
const ir = pk != null ? asPtrOffset(emitted, pk) : asParamType(emitted, rt)
```
`compile/index.js`'s sibling call site (the expression-bodied-arrow tail path —
`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) : asParamType(ir, …)`)
already used this materialize-then-branch shape and was NEVER affected — confirming the
shape, not the helper functions (`asF64`/`asParamType`/`tcoTailRewrite`, all pure and
individually correct), is what the self-hosted kernel mishandles. Root cause not
localized further than "the kernel, at every build/runtime optimize level, sometimes
drops a coercion wrapper when its argument is a call repeated verbatim across ternary
arms instead of hoisted to a local" — same "don't chase the exact miscompiled
instruction once the fix is this precise and this cleanly proven" call the isDestructurePat
session made.

**Shape-class swept, not just the one site (`Agent`, general-purpose, unproven leads
deprioritized — see below):** found the SAME shape (nested call duplicated verbatim
across ternary arms, wrapped by DIVERGING coercions per arm) at `storedValue` (defined
identically in `module/object.js:42` and `src/compile/emit-assign.js:27` —
`valTypeOf(node) === VAL.BOOL ? boolBoxIR(emit(node)) : asF64(emit(node))`, the boxed-
property/array-element store path) and the default-parameter initializer
(`src/compile/index.js`, `t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))`).
Fixed all three the same way (materialize once). The OTHER ~14 sites the sweep flagged
mostly duplicate a call under the SAME wrapper in both arms (no type divergence) or a
cheap/pure helper — lower-confidence matches to this specific mechanism, left untouched
rather than speculatively "fixed" (see the writeVar finding below for why textual
duplication alone isn't a reliable predictor).

**A SEPARATE, NOT-fixed bug surfaced by broader validation — `src/ir.js`'s `writeVar`:**
running the full native suite through `JZ_TEST_TARGET=jz.wasm` (broader than the charter
repro) found `[a] = [7]` (single-element array-destructuring ASSIGNMENT, not declaration)
and the even more minimal `(a) => { a = 3 | 0; return a }` (no destructuring at all) ALSO
emit invalid wasm through the kernel — `local.set[0] expected type f64, found i32.const`.
Confirmed PRE-EXISTING (reproduces identically on the untouched original kernel) and
UNRELATED to the fix above (`writeVar`'s coercion is `coerced = t === 'v128' ? valIR :
t === 'f64' ? asF64(valIR) : asI32(valIR)` — valIR is a parameter, not a duplicated call,
so the emit.js mechanism doesn't apply). Diagnosed with a single minimal `err()` guard
(proved `localType` IS a valid type string, just not `'f64'` when it should be — ruling
out a garbage/corrupted value) but THREE different structural rewrites of the consuming
ternary (reuse `asParamType`, rename the three colliding `const t` declarations across
writeVar's boxed/global/local branches to match the documented `specializeBimorphicTyped`
name-collision bug shape, convert to an if/else chain) all failed to fix it — while
merely ADDING an inert diagnostic statement masked it every time (classic self-host
heisenbug: any perturbation to the function's shape dodges it). Points at `ctx.func.locals`
(or its population from `analyzeBody`) resolving the wrong-but-valid type for this
specific shape, not at the coercion dispatch itself — genuinely not localized further.
**Confirmed NOT to affect the 22-case bench corpus** (direct `new WebAssembly.Module()`
validation, not just the parity-hash check) or the charter's gates — reverted the
attempted fixes, left `src/ir.js` untouched. Next session: instrument `analyzeBody`'s
locals-map construction itself (not its consumer) for this exact shape, or try the
native-differential harness (compile `ir.js` as self.js's literal entry, one level of
indirection) instead of the two-level kernel.

**Also found, NOT fixed, confirmed pre-existing and out of scope:** `export let f = (x,
c) => { if (c) return; return (x*1000)|0 }` (bare `return;` sibling, at the kernel's
DEFAULT runtime optimize level — level 2, not the level-0 the charter's repro uses) traps
`memory access out of bounds` inside `compileAst` itself (before WAT encoding) — confirmed
via clean A/B against the untouched original kernel, so unrelated to every fix above.
Native WAT for this exact shape shows heavy level-2 inlining of the truthiness check plus
an i64-carrier boundary wrapper (`c`'s NaN-canonicalization-safe crossing) — likely an
interaction between those two systems, not the return-handler fix. Excluded from the
`test/parser-bugs.js` pin (would make the pin lie about what's fixed); noted inline there.

**Results:** kernel now compiles the bench corpus to genuinely VALID wasm — 21/22 corpus
programs (`aos` OOMs even fresh, pre-existing, unrelated), 20/22 byte-identical to native
(`json`'s pre-existing, already-documented value-encoding diff is the only non-`aos`
non-parity case, and it's still valid wasm). `test/selfhost.js` 20/20. `test/selfhost-
perf.js` fresh-instance ratio gate is now MEASURABLE for the first time — geomean
**1.32–1.36×** across repeated runs (cap 1.22×, over-cap but every case valid; warm-
instance still throws on the separately-documented, pre-existing dangling-cache class).
`scripts/bench-selfhost.mjs` full 22-case corpus geomean **1.39–1.43×**. Native: zero
regressions — full suite 2624/2654 pass identically with and without every fix in this
session (A/B'd via temporary `git show HEAD:<file>` swaps, not stash/checkout, to avoid
disturbing concurrent work in this repo), the same 29 pre-existing failures (`devirt`,
SROA, uncatchable-throw, `perf-ratchet: buf`, …) either way; `test/differential.js` 22/23
(the one red is the pre-existing, unrelated `round(7)` case); `test/statements.js`
183/183; `test/parser-bugs.js` 77/77 native AND (new pin) 3/3 under `JZ_TEST_TARGET=
jz.wasm`. Files: `src/compile/emit.js` (the fix), `src/compile/emit-assign.js` +
`module/object.js` (`storedValue`, same class), `src/compile/index.js` (default-param
init, same class), `test/parser-bugs.js` (pin).

## packData-on residual (2026-07-05): SECOND corruption class
watr c90aa41 (';'-comment fix, pinned) is at HEAD and necessary but NOT
sufficient: real kernel build with full default watr config → selfhost 14/20
(6 reds). The reducing agent's 20/20 packData-on verification used a scratch
mirror — config drift vs the real build path suspected, or a genuinely distinct
second class. Disable stays until reduced the same way (extract failing kernel
WAT → packData in isolation → byte-image diff → encode-stage bisect). Charter:
same method as the ';' hunt, start from the 6 failing sample names.

RETRACTION (2026-07-05): there is NO packData class 2. The 14/20 "residual" was
class 1 through the PUBLISHED watr 5.1.0 tarball (released 07-03, BEFORE c90aa41
landed) — the npm-install link-clobber landmine, third occurrence. Proven A/B:
pre-fix 5.1.0 → 14/20 with exact class-1 signatures; watr HEAD → 20/20 full
default config, five independent builds. watr got: generalized byte-image
regression test + 5.1.1 version bump (6fff69b, 45a89e8) — PUBLISH PENDING (user).
jz TODO once 5.1.1 published (or link guaranteed): bump dep, DELETE the packData
disable in scripts/selfhost-build.mjs (deferred now only to avoid dist collision
with the in-flight warm-chain agent).

## Warm-chain session (2026-07-05): forwarding fixed + validated; durable-dynprops
## v2 re-applied then reverted — a NEW self-host-only miscompile, precisely bisected

**Root cause #1 (array/hash/set/map growth forwards a DURABLE header into an
EPHEMERAL target) — FIXED, validated, landed.** Design: a durable relocation LOG,
not a registry consulted by the chase (keeps followForwardingWat/__ptr_offset_fwd
— ~25% of compile ticks — completely untouched, per the charter's preference).
At every forward-mark site (array.js's `arrGrow` shared by __arr_grow/
__arr_grow_known, `__arr_shift`; collection.js's `genUpsert` shared by __set_add/
__map_set, `genUpsertGrow` shared by __hash_set_local/__hash_set), BEFORE the
existing forward-mark stores, a new check `durableFwdLogIR(off, newOff, len, cap)`
(module/collection.js) tests **both** ends — `off < __heap_reset` (source is
durable) **and** `newOff >= __heap_reset` (target is ephemeral) — and if both hold,
calls a new `$__durable_fwd_log(off, len, cap)` (module/core.js) that appends to a
tiny raw side-buffer (lazily `__alloc`'d, 256-entry trap-on-overflow ceiling, no
forwarding-capable header of its own so it can't recurse into the bug it exists to
fix). `_clear` (post-hoc rebuild in src/wat/assemble.js, alongside the existing
__dyn_props reset — refactored to a single shared `resets` array so the two
independent reset blocks compose instead of clobbering) now also calls
`$__durable_fwd_heal`, which restores every logged header's exact pre-relocation
`(len, cap)` — undoing the forward mark — then zeroes both log globals so the
buffer re-allocates fresh next round. Two-sided check (not just "is off durable")
matters for `.shift()` specifically: its "new" header is `off+8`, INSIDE the same
block, not a fresh allocation, so it's ordinarily still durable (shifting a durable
array is legitimate persistent state that must survive `_clear` — only the
one-in-8-bytes edge case where `off` sits at `__heap_reset-8` crosses into
ephemeral); grow's newOff is unconditionally a fresh `__alloc_hdr` call so the
second condition is provably redundant there, but checking it anyway makes the
invariant self-evidently correct at every site instead of a per-caller argument.
All four call sites needed an EXPLICIT `deps()` edge for `__durable_fwd_log` (not
left to the auto-dep scan) — this is the *exact* `test/selfhost-includes.js`
"Unknown func $__clamp_idx" shape: the new helper is reachable only via a template
body reference, and self-host's realize/regex-scan auto-deps path silently drops
that. Also gated (`needsDurableFwdLog`/shared-memory check) so a shared-memory
build — which never declares `__heap_reset`, hence `durableFwdLogIR` emits `''`,
no call at all — never requests a name core.js never registers there (a real
regression caught by `test/mem.js`'s shared-memory suite, fixed by making the
IR-emit function itself (not just its runtime condition) test
`ctx.scope.globals.has('__heap_reset')` and emit nothing when absent).
**Validated:** native suite 2626/2654 (same 27 pre-existing reds with or without,
confirmed via worktree A/B — `perf-ratchet: buf`, `devirt`, SROA, regex-stress,
Math.cbrt(27), the opt3-only `Math.imul(Math.min(Math.sqrt(negative)))` fuzz
seed=30 NaN-vs-0 case, all reproduce identically at clean HEAD); test/selfhost.js
20/20; test/selfhost-perf.js fresh-instance gate MEASURABLE at 1.34–1.37× (matches
the pre-session ~1.35 baseline, no regression); `scripts/bench-selfhost.mjs` fresh
21/22 (aos OOMs fresh, pre-existing), geomean 1.44×.

**Root cause #2 (durable-dynprops-v2) — RE-ANCHORED, NATIVELY CORRECT, BUT BLOCKED
by a new self-host-only OOB — reverted, not landed.** Re-applied
`.work/durable-dynprops-policy-v2.patch`'s design onto current files by hand
(`git apply` conflicted on module/collection.js — patch's own heapResetWat
insertion point now collided with root-cause-#1's; module/core.js — deps-block
context shifted; module/object.js — `storedValue` was rewritten to the
materialize-once shape by the emit.js session, changing `emitEnumerateObject`'s
surrounding text — `module/json.js` and `test/perf.js` applied cleanly, no
drift there). Native result: **fully correct** — 2626/2654 (same pre-existing
reds), test/objects.js 116/116 (incl. the "dynamically-added props… carry over"
dyn-clone case), test/json.js 60/60, test/mem.js 46/46, test/selfhost-includes.js
green after adding the same explicit-deps treatment root-cause-#1 needed
(`__dyn_get_t_h`'s new durable-read block calls `$__hash_get_local_h` — added to
its deps() list; the `__clear`-only `$__durable_fwd_heal`/schema-arm-style
late-adds already covered by root-cause-#1's `inc()` pattern).

**Self-hosted: fresh-instance corpus compile traps `memory access out of bounds`
on EVERY case (mat4 alone reproduces it, no `_clear` involved — this is NOT the
warm-reuse dangling-cache class, a strictly earlier failure).** Bisected by
selectively reverting each of the four touched functions (one at a time, rebuild,
retest against the minimal `mat4`-through-kernel repro) since the native suite
gave zero signal (100% green throughout): `__dyn_set`, `__obj_clone`,
`__dyn_del` — each independently reverted, crash PERSISTS. Only reverting
`__dyn_get_t_h`'s new durable-receiver read block fixes it. Ruled out inside
that block, in order: (1) build-optimize level — crashes identically at kernel
`optimize:2` (default), `:1`, and `:false` (pure mechanical translation, no
optimizer pass involved at all — rules out the project's usual "-O2 self-host
miscompile" pattern entirely); (2) duplicate non-nested WAT label names
(`buildObjectSchemaArm`'s hardcoded `$kdone`/`$kloop` now emitted from TWO call
sites in one function) — gave every call site a `ctx.func.uniq++`-suffixed
unique label (mirroring `emitEnumerateObject`'s `id` pattern) — crash persisted
unchanged, so NOT a label collision; (3) the new global-table probe
(`__ihash_get_local`/`__is_nullish`/`__hash_get_local_h` reached via
`dynPropsFilterMissIR`) — removing it alone (keeping the sidecar-check +
`buildObjectSchemaArm()`) still crashes; (4) the sidecar-check — removing it
alone (keeping the global probe + schema-arm) still crashes; (5) narrowed to
**`buildObjectSchemaArm()` itself, called from this one new position, with
every other piece of the block removed** (just the global probe, no sidecar, no
schema-arm → does NOT crash, but silently returns wrong values — a source string
gets visibly corrupted, `median` → `m̭edian`, i.e. omitting the schema fallback
is a real correctness bug on its own, not a safe simplification); re-adding
*only* `buildObjectSchemaArm()` (global probe + schema-arm, no sidecar) →
crashes; global probe alone with schema-arm removed entirely (not just skipped)
→ does not crash. So the crash needs `buildObjectSchemaArm()` called from
`__dyn_get_t_h`'s new (early, pre-array-chase-adjacent) position specifically,
independent of duplication, independent of optimize level. **Not root-caused
further** — `$off` is provably identical at the new vs. original call position
for an OBJECT receiver (nothing between function entry and the new position
touches `$off` for non-CLOSURE non-ARRAY types), so the "why" remains open.
Given the hard gate (fresh must stay measurable, must not regress) leaves no
room to ship a fresh-instance trap, **v2 was reverted in full** (collection.js
restored to HEAD then root-cause-#1's pieces only were re-applied cleanly;
core.js's `__obj_clone` reverted to its pre-patch body; object.js restored to
HEAD; json.js and test/perf.js `git checkout`'d back to HEAD) rather than
shipped broken or left half-applied (which would have desynced __dyn_set's
write-target from __dyn_get_t_h's read-source — worse than not landing it at
all). `.work/durable-dynprops-policy-v2.patch` itself is untouched and remains
the correct starting point.

**Net effect on the warm-instance gate: unchanged from session start.**
`test/selfhost-perf.js`'s warm-instance gate and `JZ_BENCH_WARM=1
scripts/bench-selfhost.mjs` (0/22, every case `warm-trap` on `Unknown memory
end`) still fail exactly as documented above ("json warm-trap… INSTR sidecar")
— root-cause-#1 alone was never going to fix that class (it protects
off-4/off-8 growth-forwarding; the INSTR landmine is an off-16 dyn-props-sidecar
issue, v2's actual target) — and v2, the fix for THAT class, is blocked by the
self-host-only bug above. **Next session: root-cause the
`buildObjectSchemaArm`-from-new-position OOB** (try: native-differential harness
compiling collection.js as a literal self.js-style entry, one level of
indirection cheaper than the two-level kernel, per this doc's own established
technique; or instrument `$sid`/`$kbits`/`$koff`/`$nkeys`/`$idx` with exported
counters at kernel runtime to see which one diverges) **then re-apply v2**
(the patch/design needs no changes — only this kernel-only reader bug blocks
it). Files this session: module/array.js, module/collection.js, module/core.js,
src/wat/assemble.js (all landed, root-cause-#1 only) — module/object.js,
module/json.js, test/perf.js untouched (reverted back to HEAD, matching git
status). Also fixed in-passing: `node_modules/watr` had silently drifted to the
pre-c90aa41 published 5.1.0 tarball (this session's OWN clean-baseline check
caught it independently of the "packData-on residual" entry above) —
`npm link watr` unblocked test/selfhost.js from 14/20 to 20/20 before any of
this session's own code changes; superseded mid-session by the real 5.1.1
publish (this doc's entry above), final state uses the published dependency,
not the link.

## VERDICT (2026-07-05, era-vs-era bisection): fresh 1.05x→1.385x is WATR 5.0.0→5.1.1
Single-variable watr swap on fixed jz source reproduces the gap (1.373x vs today's
1.32-1.35x; true era rebuild ~1.08x). 5.1.1 eliminates FEWER dyn-chain calls
(dyn_get_t_h 131k→156k, +53% pool) and typed/length fast-path calls (typed_idx
47k→99k, +80%), MORE str_eq/alloc — net loss on property/array-heavy code.
preEval: SHA-identical kernels (and self.js never ran it in-kernel). subscript:
not cleanly separable but dyn-chain growth tracks watr, not subscript.
Actionable upstream: diff watr optimize.js/compile.js 5.0.0→5.1.1 heuristics for
the two named pools; pin kernel-helper-elimination as a watr perf regression test.

## Heuristic hunt status (2026-07-06): dedupe-deferral fix INERT on the kernel
watr probe harness committed (test/jz-kernel-perf.mjs — 129s build, WATR_ROOT A/B,
counters). The dedupe×specializeParams deferral fix (uncommitted in watr
src/optimize.js) verified on its synthetic probe but changes NOTHING on the
kernel: dyn_get_t_h 158,187 / typed_idx 100,427 — byte-for-byte the broken-5.1.1
counts; ratio 1.441x. Either the deferred groups don't carry these calls or
inlineOnce declines them (check: soleCaller's callRefs may count calls from
functions treeshake hasn't dropped yet, or the groups' members are pinned/multi-
caller on the real kernel). NEXT: instrument dedupe on the KERNEL build — log
deferred-group count + member names; if 0/near-0, the guilty heuristic is
elsewhere (candidates: inlineOnce's own caps vs 5.0.0, macro-inline gate,
export-rooted liveness keeping wrappers alive). The 47-min build scare was box
contention (129s quiet); rounds are capped at 6 — no fixpoint pathology.

## SESSION 7 (2026-07-06/07) — WARM PIN EARNED SOUNDLY: durable-slot heal

**Context reset:** user published watr 5.2.0 (dedupe fix + speed profile + packData fix
— the registry landmine is DEAD) and bumped jz to subscript ^10.5.2 / watr ^5.2.0.
Suite verdict on arrival: only 4 unique fails, all known. Old stragglers (for-in
dyn-keys, slice-views, Object.create OOB) fixed by the prior batches.

**Landed this session (jz):**
1. **profile-speed default** (4f44d36): LEVEL_PRESETS 2/3/'speed' carry
   watrProfile:'speed' → decoration maps it onto watr opts; 'size' keeps watr's
   size-leaning default; selfhost-build's bespoke config dissolved. self.js
   optimizeTail mirrors it.
2. **FORIN workaround removed**: subscript ≥10.5.1 re-associates for-in/of heads
   (all six wrapper classes probe-verified); kernel-compat verified (selfhost 20/20).
3. **ratchet re-baselined** (e8264b1): buf +3507 bisected via worktrees to 7b15b6d
   (heal guards inlined into loop bodies by watr — cold-path, zero per-iter cost);
   watr exonerated (14112 under both 5.1.1/5.2.0); five categories improved & locked.
4. **Global-snapshot sweep**: _clear restores every runtime-written module global to
   its post-__start snapshot (slab under the watermark; no-start modules restore
   declared inits; __tof_/__hc_/protocol excluded). Kills the `let CACHE = null`
   module-cache dangler class + scalar poisoning. Pinned in test/mem.js.
5. **Durable-slot heal — THE warm unlock**: init-created dicts written at runtime
   dangle across _clear (found via HOST-SIDE DANGLER CENSUS: scan [0,heap_reset) for
   boxed heap ptrs aiming ≥ heap_reset; 34 at _clear, 5 surviving at trap; poison-fill
   diagnostic + wasm-objdump pinned the trap to a stale section array byte-copy in
   watr-assemble; the memo key was the UNDEF_NAN literal text). Value-only healing
   measured INSUFFICIENT: dangling KEYS made warm round 2 FNV-hash 15.5MB of garbage
   (vs 415KB round 1) = the whole 2.4× gap. Full mechanism: unconditional entry-log on
   durable inserts + value-log on ephemeral overwrites → heal zombifies entries
   (key←TOMB_NAN unforgeable sentinel, value←undefined, len--) after fwd-heal;
   zombie-aware probes reclaim TOMB slots (remember-first, cap-bounded);
   __coll_order + len-iteration skip zombies. Map size/enumeration semantics exact
   ("warm = fresh"): 12-round × 6-insert stress stable, 0/0 after clear.

**Landed upstream (watr, needs 5.2.1 publish):**
- **eager NCLS** (compile.js): lazy module-level dict = warm landmine (round 2 saw the
  stale truthy handle, mis-consumed `end` as a memidx → "Unknown memory end"); also
  drops the rebuild branch from the per-token hot path.
- **CSE write-clock** (optimize.js): LIVE MISCOMPILE in 5.2.0 — statement-level
  invalidation can't see a write BETWEEN two sites of one statement; propagate-coalesced
  locals made two f64.eq conditions identical and CSE reused the FIRST across the
  second select's own re-tees (jz's Math.round(x)+Math.round(-x) → bump-misrouting;
  found by jz's differential round-half gate, which is now GREEN). profile:'speed'
  did NOT dodge it. Fix: monotone write ticks in evaluation order; repeat sites only
  JOIN a group with unchanged stamp, else reseed. Pinned in watr test/optimize.js.

**RESULTS (quiet box, 6-case pin subset):**
- **warm-instance: 1.027× (cap 1.08) — GREEN**: mat4 1.06 fft 1.04 biquad 1.00
  sort 1.00 crc32 1.00 mandelbrot 1.05. First SOUND warm parity — the session-6
  0.97× partly read dangling-but-intact cache entries (the very bug class fixed here).
- **fresh-instance: 1.143× (cap 1.22) — GREEN, best of era** (was 1.216 at session start).
- selfhost 20/20; suite 2672 pass / 3 unique knowns (SROA red pin, devirt red pin,
  uncatchable-throw straggler); csePureExpr ablation isolated with watr:false (watr's
  fixed CSE now collapses the shared muls itself).

**Diagnostic kit that cracked it (reusable):** (1) host-side dangler census —
DataView scan of durable memory for NaN-boxed heap ptrs aiming past the watermark,
zero rebuilds; (2) JZ_CLEAR_POISON memory.fill diag (removed after use) — makes the
FIRST stale read trap at the reader; (3) names:true kernel + wasm-objdump around the
trap offset; (4) ddmin over the failing source (mat4 → 4 lines); (5) FNV byte/call
counters (removed after use) — turned "warm is 2× slower" into "15.5MB vs 415KB".

**Next:** eco gates re-measure (heal machinery now in all compiled modules);
watr 5.2.1 publish unblocks CI reproducibility; queue: 11 todos, 2 red pins
(SROA owning-module prefix; watr devirt no longer matching jz's unbox chain),
jessie 5.44×, watr.wasm 1.42×, preeval tiers 2–3, fresh ≤1.0.

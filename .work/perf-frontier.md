# Perf frontier — what's left after the floor was attained (2026-06-12)

Floor status (jz vs min(V8, JSC), all 14 cases, M-series, medians):
9/14 outright floor wins (0.28×–0.99×), 11/14 beat V8. Above floor:
json 1.08× / crc32 1.30× (vs JSC only — both beat V8), watr 1.14×,
jessie 1.74×, jz self-host 1.85×.

## The one structural blocker: shape-IC dispatch
The compiler/parser family's residual is NOT a hotspot — it's the
polymorphic-receiver tax spread over every `node[i]` / `node.prop` on
kind-erased trees (IR nodes are arrays|strings|numbers mixed; no static
kind can fire). JITs solve this with inline caches. Everything cheap was
measured and landed (97b1c54: hash-first probes, loop-free heap helpers,
static-pool interning, SSO slices, schemaKeyEq short-circuit; ~35.5M
__str_eq calls/run profiled down by construction). Five further micro-fixes
measured ZERO on the self-host case — the next real win is a shape-IC:
per-site (tag, schema) → direct-load cache for dyn-get/dyn-set, the wasm
equivalent of a 2-entry polymorphic IC. That closes jessie/jz/watr in one
mechanism.

## Measured-and-deprioritized (was quality-roadmap tail)
- devirt K>2 / closure-array dispatch: callback/tokenizer already beat both
  engines; call_indirect is not the binding constraint anywhere measured.
- param-kind overlay (hard call-site consensus): cannot fire on the
  polymorphic IR params that dominate the residual; minor elsewhere.
- emit-level raw narrow-element move (u8/i16/i32 copy idiom): niche; the
  memop recognizer covers f64/zero/byte-fill; revisit if a workload shows.

## Claim language the data supports
"min(V8, JSC) as the floor — beaten outright on 9 of 14 workloads, V8
beaten on 11 of 14; the three compiler-on-itself workloads trail by
1.1–1.9× with the cause named and tracked (shape-IC dispatch)."


## 2026-06-12 session 2 — intern-bit landed, frontier sharpened

Landed (22fb332): STR_INTERN_BIT canonical strings — bit-ne canonicals answer
≠ in 3 ops, cached FNV header, fusedRewrite literal-eq inline (any-shaped
operand tee'd once). Dispatch-ladder microbench 54→31 ms; **watr flipped to
beating V8** (1.35 vs 1.37 ms). jz self-host 64→~61 ms (±3 noise).

Measured dead-ends (do not retry without new evidence):
- Runtime map-key interning at the hash boundary: REGRESSION on fresh-concat
  keys (the probe must walk bytes to identify a fresh string — same cost as
  the verify it replaces) + an OOB; reverted. The verify-walk is irreducible
  for fresh keys; V8 pays it too (cons-string hash+compare).
- crc32 vs JSC: jz's stream is optimal (2 loads + 4 ALU/byte); jz.wasm runs
  identically on V8 (11.98) and JSC (11.94) wasm — JSC's B3 JS tier (9.2)
  out-schedules both wasm backends on the serial LUT chain. Engine-level,
  reclassified structural in the page ledger. (A ×4 partial unroll could
  shave the ~3 loop-overhead ops/iter ≈ 15% — pass not yet written.)

jz self-host residual (~1.6× vs jz.js): fresh-key byte-walks (jz's own
emit builds `'$'+name`-style keys per use — a SOURCE-level fix: cache
prefixed names per binding) + per-node value-model dispatch (shape-IC for
dyn-get/arr-idx on kind-erased receivers). Both are scoped, neither is a
runtime micro-fix.


## The JIT-baseline guarantee — extra-work inventory (2026-06-12, session 3)

Mission restated: a jz-compiled module must never do work the JIT doesn't.
Per-class status, from the corrected jessie profile (import-offset fixed):

| extra work | share | status |
|---|---|---|
| tag-compare ladders (`op === 'lit'`) | was ~17% | **KILLED** — intern-bit + literal-eq inline (22fb332) |
| `__is_truthy` helper calls | was 3.8% | **KILLED** — tee pre-step inlines every site (22a2ac4) |
| closure-hook dispatch: tramp + call_indirect | ~10% | **OPEN — the next big one.** subscript's `parse.space/step/id` hooks are closure-valued slots written once at init; V8 calls them direct+inlined. Kill: generalize the devirt pass to K-way guarded DIRECT BODY calls for closure slots whose writes are all init-time consts — elides both the indirect call and the arity-adapting trampoline. |
| value-model residual on scan paths (`__typed_idx`/`__ptr_offset`/`__arr_idx_known`) | ~5% | OPEN — tag-guarded inline fast paths for param-stable receivers; shape-IC longer term |
| AST-node alloc volume (`__alloc_hdr`) | ~4% | OPEN(long) — JIT wins via escape analysis; extend jz's `_nonEscaping` to loop-local array literals |
| map fresh-key byte-walks (self-host only) | ~10% of kernel | OPEN — jz-SOURCE fix: stop rebuilding `'$'+name` keys per use (cache per binding); not a runtime feature |

Measured after this session's kills: jessie 2.84 → 2.01 ms (1.52× of JSC,
was 1.75×); jz self-host ratio ~1.83×. The guarantee claim becomes honest
when the closure-devirt + key-caching items land — they cover the two
remaining double-digit classes.


## 2026-06-12 session 3 — the CI-only x64 OOB: root-caused, fix needs design

Symptom: selfhost CI (linux-x64) traps OOB while the kernel compiles
`Math.sqrt(-1)`; byte-identical kernel passes on darwin-arm64 (verified:
same sha256, reproduced in docker --platform linux/amd64, node22).

Mechanism: wasm's one nondeterminism — NaN payload bits. x64 arithmetic
produces SIGN-SET qNaNs (0xFFF8…), arm64 canonical ones (0x7FF8…). A NaN
that escapes canonicalization on a narrowed path becomes, in a kind-erased
slot, a value whose bits the dispatch layer interprets: canonical decodes
as the harmless NaN atom (tag 0), sign-set as tag 14 + offset 0 → header
reads at u32-wrapped negative addresses → OOB. Hosts can inject sign-set
NaNs through typed arrays on ANY platform, so this is a general soundness
hole, not an x64 quirk.

Why the obvious fix is wrong: replacing the `f !== f` box tests with a
strict prefix test (notBoxWat) DOES fix the kernel (verified in docker:
all trap cases compile, kernel simd+fuzz 93/93) — but it breaks the
i64 VALUE CONTRACT: in-kernel BigInts are raw i64 carriers, and negative
ones (0xFFF8… bit range) legitimately alias the NaN space. __eq's bit-eq
arm and __is_truthy were RELYING on NaN-shaped ≠ NAN_BITS meaning
"negative kernel BigInt" (the code comments say so); the prefix-strict
variant made every negative bigint falsy/never-self-equal and broke the
watr i64 suites at all levels. Reverted wholesale.

The DESIGNED fix (next session, pick one):
1. Canonicalize at the narrow→boxed boundary: any f64 leaving the pure-
   numeric domain into a kind-erased slot gets the canon select. Sound,
   costs ~3 ops per possibly-NaN boxing store.
2. Move kernel BigInt carriers out of the NaN-bit space (e.g. flip to an
   offset encoding) so prefix-strict dispatch becomes valid — then the
   notBoxWat fix (already written, in git history at the revert) lands
   as-is and ALSO closes the host-injection hole.
3. Find and canonicalize the specific kernel-internal NaN producer that
   feeds the sqrt-fold path (narrowest; doesn't close the general hole).

Status: CI selfhost stays red on x64 with the cause fully named; every
local leg (native ×4 + kernel arm64) is green. The docker repro recipe:
  rsync tree → /tmp/jz-docker (symlink node_modules), build dist,
  docker run --platform linux/amd64 node:22 → compile 'Math.sqrt(-1)'.

Side find (latent, unfixed): element-const folding ignores writes through
a DIFFERENT typed view of the same buffer (u[0]=…; buf[0] folds to the
init value) — aliasing must kill element facts across views.


### RESOLVED (same session): the x64 OOB — two-line fix at the true origin

The poisoned value was found by an in-kernel probe: a sign-set qNaN NUMBER
sitting in an f64.const node — `makeConst`'s `value !== value` NaN guard
MISSED it because in-kernel `!==` routes through __eq's bit-equality, where
a sign-set qNaN compares EQUAL to itself (the arm that keeps negative
i64-carrier BigInts correct). Detector swapped to `Number.isNaN` (unboxes
to f64, f64.ne — catches every payload) in makeConst (f32+f64 arms) and
getConst, normalizing any folded NaN to the canonical literal. Verified in
docker linux-x64: all trap cases compile; simd+fuzz+watr green. BigInt
semantics untouched; dispatch untouched; native no-op.

LESSON (add to the i64 VALUE CONTRACT notes): in-kernel, `x !== x` is NOT
a NaN test — it is bit-inequality for NaN-shaped carriers. NaN tests in
compiler internals must be Number.isNaN.


## 2026-06-12 session 4 — the parity wall, characterized by exhaustion

Goal: jz.wasm (self-host) ≤ V8/JSC. Current: ~45 ms vs JSC ~26 / V8 ~29
(quiet machine) = 1.6-1.8×. Six further interventions measured FLAT:
generic eq tee-wrap at all 5.5k dynamic sites (+65 kB, reverted),
__str_eq hot/cold split (kept — principled, zero-cost), compact module
prefixes (kept — symbol hygiene + build speed; long names never reached
the runtime hot path), runtime key-interning (reverted earlier), V8
--wasm-inlining-budget=20000 gave +4.5% (engine-side confirmation that
call granularity matters but is not the wall).

CONCLUSION (now evidence, not theory): no single helper holds the gap.
The residual is the DISTRIBUTED per-op value-model tax — every node[i],
.prop, poly call on the compiler's own kind-erased data pays 2-5× a JIT's
shape-IC'd equivalent, spread over hundreds of functions (profile tail:
2.9% walk, 2.6% walkPost, 2.3% ptr_offset, 2.3% arr_idx, 1.7% dyn_get,
then ~1%×dozens). Closing it = the named structural projects:
1. shape-IC dispatch for dyn-get/arr-idx (per-site caches keyed by
   tag/schemaId in the box aux),
2. escape-analyzed stack allocation for loop-local AST nodes,
3. devirt alias rung (baseSpace pattern: global initialized from another
   const slot via dyn-get — needs init-store alias tracking),
4. emit-side prefixed-name caching in jz's own source.
Each is compiler-engineering scale (days, not session hours). The bench
suite meanwhile: 10/14 beat min(V8,JSC) outright; watr at engine parity;
jessie 1.5-1.6×; the self-host case is the honest open frontier and the
page ledger says exactly that.


## Session 4 final — pointer-kind audit + the inline-slice verdict

User question answered: the redundant dispatch construct is NOT a pointer
kind — every kind earns its place except two diet candidates (BUFFER could
fold into TYPED; SET/MAP could be one tag + entry-size-in-aux, mostly a
binary-size win). The construct that costs more than it creates is the
CLOSURE TRAMPOLINE LAYER: the box erases the signature, so even exact-arity
calls pay call_indirect → tramp → body. Fix shape: arity in the box aux +
bodies in the table → exact-arity sites call the body directly; tramp only
for mismatch/defaults/rest. This subsumes most of the closure-dispatch tax
and replaces the old devirt-alias rung as priority #1a.

Seventh + eighth flat measurements (kind-erased x[i] ARRAY-arm inlining,
+260 kB → reverted; ratio noise band 1.71-1.85 across all of them): the
self-host wall is NOT instruction-count at any single class of site. The
remaining 1.6-1.8× is branch/dependency-bound across the whole value model.
Patch-scale emit inlining is exhausted as a strategy — only the four
structural projects move it:
  1a. trampoline elision via arity-in-aux (closure ABI change),
  1b. shape-IC dispatch for dyn-get (per-site schemaId caches),
  2.  escape-analyzed AST-node allocation,
  3.  devirt alias rung,
  4.  emit-side key caching.

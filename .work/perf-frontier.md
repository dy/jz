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

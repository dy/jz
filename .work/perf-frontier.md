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

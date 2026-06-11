# Quality roadmap — consolidated state (2026-06-10, post session 3)

Aspects (the standing gates): **correctness/JS-fidelity #0** (test262, differential
fuzz, determinism — every speed/size trade judged against it) · **speed** (faster than
V8 ≈ C, per-program not on-average) · **size** (≈ handwritten WAT) · **predictability**
(no silent cliffs) · **compile throughput** · **minimality/declarativity of the
compiler** · **pipeline directness** · **diagnostics/debuggability**.

## Gate state (all green, CI-pinned)
- Examples corpus: **geomean 1.70–1.75×, 11/11 beat V8** (Node 22 + 25). CI gate:
  geomean > 1, winners ≥ 0.9 (FLOOR 0.9→1.0 once interference gains margin past 1.01×).
- Floatbeats: geomean ≤ 0.85× pinned (runs ~0.51×); local per-beat backstop 1.05.
- Kernel corpus: jz/V8 ≤ 1.0, jz/C ≤ 1.05 geomean; tokenizer 0.47× V8 (was the one
  AS-loss); watr 1.12–1.30× band (abs 1.08 ms stable; ratio noise is V8-baseline drift).
- Size: jz/AS 0.878×, wasm-opt slack 0.896×; `add` = 41 B exact minimum.
- Ratchet: int 699 / float 600 / mixed 830. Selfhost 11/11. Fuzz continuously zero-divergence.

## 1. Speed
- [x] 1.1 narrowLoopBound (1495ea0) — f64 loop bound → hoisted i32; unlocked SIMD for
  naive kernels. Floatbeats 0.21–0.93×; jukebox todo closed.
- [x] 1.2 string substrate — DONE for the scan class:
  - slice 1 (dfa8161): __jss_length/charCodeAt in LICM whitelist — boundary scan
    loops hoist length, body = one engine-inlined charCodeAt.
  - slice 2 (0a876cb + cde711f tests): **splitCharScan** — iteration-range split at
    `Math.min(N, s.length)`; main loop gets the i32 char carrier (zero f64 compares),
    NaN tail keeps JS semantics exactly (integral/fractional/NaN/negative bounds
    verified). tokenizer 0.10 → 0.06 ms (0.47× V8). Off under 'size' + large-source
    auto-config. Bound proof extends through Math.min (lengthRecv).
  - watr residual: scan loops are NOT its bottleneck (abs time unchanged by split);
    it is hash/concat/closure-bound → see 1.3.
- [ ] **1.3 Closure-capture narrowing** [M] — NEXT SPEED ITEM. Captures always box to
  NaN-boxed f64 cells; `let c = n|0; () => c++` round-trips i32↔f64 per access.
  Gate: capture provably single-narrow-type AND not object/string (watr regression
  risk — watr captures objects/strings; measure watr abs ms before/after).
- [ ] 1.4 int-accumulator general path [L] — deferred (owner YAGNI; peephole covers
  the measured shapes).
- [ ] 1.5 deferred-on-no-workload: extending-add i8/i16 SIMD (trigger: color-space),
  AoS→SoA [L], scalarization cap 32→64, call_indirect devirt (trigger: callback
  workload).
- [x] interference parity (feb3341) — expression-position inlining: flattenable
  pure-arith decl prefixes substitute into the return value (distance/dx/dy/sqrt);
  exported callers take the leaf-safe subset. 1.01×, 11/11 winners.

## 2. Size — DONE (structural floor reached; remaining gap is by-design generality)
- [x] 2.1 guardRefine (d3a564b) — tag reads fold under dominating guards; typed
  probe −19%.
- [x] 2.2 hoistGlobalPtrOffset (dc93d18 + cca52f8 + f7ccefc + 9cfe51c) — stable-pointee
  globals resolve once per function (reachable-writes call graph; loop placement
  beats site count; leaf-into-export inlining; STABLE_PTR_VALS generalization +
  precise promoteGlobals). Fixed rfft/diffusion/game-of-life/attractors/lenia.
  ORDERING LOAD-BEARING: offset-hoist before value-promotion.
- [x] 2.3 resolved — i32-export wrappers already inline (probe: no wrapper exists).
- [x] 2.4 resolved — heap preamble already minimal (probe: no stale pools).
- [ ] README size-table preset note (perception, zero code).

## 3. Minimality / declarativity
- [x] 3.1 valTypeOf → VT dispatch table (bb6e4f9).
- [x] 3.2 emitMethodCall strategies 5–12 → TYPED_STRATEGIES record table (56d3258).
- [~] 3.3 analyzeBody decomposition — slice 1 done (9ff7314: widenLocalTypes
  extracted; body reads walk → widen → narrowUint32). REMAINING: the walk/processDecl
  observation machinery (~350 lines) — package observation maps into a record,
  extract as top-level functions. Pre-req for 4.1.
- [ ] **3.4 emitClosureBody (623 lines)** [L] — unify with emitFunc's structured-IR
  path; the inline WAT-string trampoline synthesis becomes a named builder.
- [x] 3.5 TYPEOF enum (8bce811).
- [ ] **3.6 emit.js split** [S, mechanical] — emit-decl/emit-assign/emit-spread
  modules along the `// === ===` banners.
- [x] 3.7 hygiene tail (6a14b74 + verified-stale items).

## 4. Pipeline
- [ ] **4.1 unified per-function analysis cache** [M] — analyzeBody runs 5–10× per
  body with manual invalidation. Build facts once post-plan, pass explicitly.
  Do WITH 3.3's remaining extraction. (Profile: analyzeFuncs ~11 ms on watr-scale —
  modest; correctness/clarity is the motivation, not ms.)
- [x] 4.2 resolved-differently (5a786e4) — permanent per-pass profiling (plan:*,
  optMod:*, compile buckets); incremental-facts premise disproven (refreshes 7 ms);
  the REAL hotspot (quadratic LICM privacy check) memoized: watr compile 560→393 ms.
- [x] 4.3 structural globals (3ea8056) — declGlobal records; ~45 writers one-lined;
  emission builds IR directly; byte-identical.
- [x] 4.4 boundary contracts (4b918f2 sentinels; 4b5488d prepare seeding doc).
- [x] 4.5 two-layer optimizer contract documented (4b5488d).

## 5. Self-host options (user ask) — landed pending final wasm-leg verification
- scripts/self.js: all three entries (bytes/wat/warnings) share setupSelf/lower and
  take the uniform (source, strict, optJSON) triple — dist/jz.wasm now compiles at
  any optimize level/alias/per-pass object. kernel-target bytes leg forwards
  optJSONFor (was: always optimize:false), so JZ_TEST_TARGET=jz.wasm honors
  JZ_TEST_OPTIMIZE end-to-end.

## Next queue (in order): 1.3 closure captures → 3.6 emit split → 3.3 remainder +
## 4.1 → 3.4 emitClosureBody → README size note.

### 1.3 design (probed 2026-06-10, ready to implement)
Canonical cost confirmed: captured counter `c=(c+1)|0` emits per access
f64.load(cell) → guarded ToInt32 select → f64.convert back → f64.store.
Design: per-boxed-var cell-type narrowing — compute intCertain ∧ plain-number
across the OWNER body AND every capturing closure body (closure bodies list at
program-facts level); when all agree, record ctx.func.cellTypes[cell]='i32' and
emit i32.load/i32.store at every cell access site (env slot stays 8B; generic
ABI only passes cell POINTERS, never reads values — safe). Sites: emitFunc cell
init, emitDecl boxed path, emitLocalGet/assign cell load/store, closure body
cell access. Gate: not object/string-kind (watr risk); measure watr abs ms.

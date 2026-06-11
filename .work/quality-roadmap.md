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
- [x] **1.3 Closure-capture cell narrowing** (landed 4938d7f) — intCertain boxed vars
  (params excluded) keep their CELL in raw i32; readVar/writeVar are the width
  chokepoints, closure.make ships the decision with the capture (bodyFn.cellI32),
  LICM cell admission extended to i32 width. Found+fixed the logical-assign
  handler bypassing writeVar with a direct f64.store. Examples geomean 1.76×;
  watr best-run 1080→1018 µs (modest as designed — its captures are mostly
  objects/strings, out of intCertain scope).
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
- [x] 3.3 analyzeBody decomposition — CLOSED. Slice 1 (9ff7314): widenLocalTypes
  extracted; the body reads walk → widenLocalTypes → narrowUint32. The remaining
  walk/processDecl machinery is a COHESIVE single-concern unit (observation
  collection over shared fact maps) — extracting it would thread ~10 params for
  no clarity gain; the monolith critique was the interleaved passes, now staged.
- [x] **3.4 emitClosureBody** — RESOLVED by remeasurement (2026-06-11): the
  623-line monolith no longer exists — today it is ~250 sectioned lines
  (seed frame → enterFunc → analyze → boxed classification → defaults →
  env unpack → param unpack → rest packing → assemble → restore), each section
  commented and cohesive; extraction would thread an 8-field record through
  linear sections for no clarity gain. The trampoline WAT-string synthesis
  (emit.js ~3062) follows the HOUSE stdlib-text idiom (ctx.core.stdlib is a
  text registry by design) — cosmetic multi-line reformat is the only residue.
- [x] 3.5 TYPEOF enum (8bce811).
- [x] **3.6 emit split** (landed b069a0d) — assignment IR helpers (~370 lines,
  9 functions) → compile/emit-assign.js via the bridge pattern; the kernel
  bundler's cycle rejection forced the RIGHT factoring (isBoundName → ir.js,
  storedValue moved with its consumers, _expect → ctx.func transient).
  emit.js 3501 → ~3130 lines.
- [x] 3.7 hygiene tail (6a14b74 + verified-stale items).

## 4. Pipeline
- [x] **4.1 unified analysis cache** — CLOSED by analysis: the post-plan path
  ALREADY builds facts once (analyzeFuncForEmit → funcFacts) and passes them
  explicitly to emit; the 5–10× re-walks live inside narrow's fixpoint, where
  re-analysis after AST mutation IS the algorithm (WeakMap-memoized per body).
  Nothing left to unify without changing the fixpoint itself.
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

## Self-host L2 divergence (EXPOSED by the options plumbing, 2026-06-10) — NEXT TRIAGE
Running the KERNEL's own optimizer at L2 miscompiles typed-literal shapes that
native L2 handles fine. Repro (kernel = dist/jz.wasm):
  src: let mk = () => new Float64Array([1.5, 2.5, 3.5])
       export let f = (i) => { let a = mk(); let b = a.map(x => x + 10); return b[i] }
  kernel L2: f(0) = 10 (a[0] read as 0); native L2 + kernel O0/O1: 11.5 ✓.
Bisect: vectorizeLaneLocal:false fixes; watr:false fixes; unroll/hoistConstPool
irrelevant. WAT diff (kernel vs native, same source, L2): the kernel DROPS the
`(f64.store base (f64.const 1.5))` literal store, leaves `i32.add(16, 4<<3)`
UNFOLDED (fold pass not folding in-kernel!), and bases element stores off a
different local (+24/+32 vs +0/+8/+16). Theory: a documented kernel-vs-JS
divergence inside the optimizer's own code (suspects: getConst's
parseInt/replaceAll path, BigInt i64 handling, Map/object iteration in fold/
propagate). Affected suite tests at JZ_TEST_OPTIMIZE=2: typed-narrow .map ×3 +
promoteIntArrayLiterals closure-capture. Until fixed, the bytes leg defaults
to the kernel's historical optimize:false; `JZ_TEST_OPTIMIZE=2 npm run
test:wasm` is the triage switch (4 failures to drive to zero).

## Self-host fidelity hunt (2026-06-11) — two real bugs fixed, ratchet established
- [x] **deadStoreElim index-shift miscompile** — LATENT NATIVE BUG, kernel-triggered:
  dead[] entries are pushed at SUPERSEDE time, so same-parent indices aren't
  monotonic; the reverse-order splice executor shifted remaining entries onto
  innocent neighbors (deleted the `1.5` literal store in the kernel repro).
  Fixed identity-based: capture the node at scan time, indexOf at removal.
  Could in principle have corrupted NATIVE output for interleaved-lifetime
  supersedes — fuzz 2500 + full matrix green post-fix.
- [x] **fold dead in-kernel** — the unary/binary dispatcher discriminated on
  Function.length; self-host closures don't carry faithful arity → ZERO folding
  ever ran in-kernel. Node-shape dispatch now (every WAT op is fixed-arity).
- **NEW bug class discovered**: `arr.length = 0` on an IMPORTED binding splits
  aliasing in-kernel (resize rebinds a fresh array onto the importer's binding;
  the exporter keeps the old one). Repro: the _executed debug-trace artifact.
  Triage next: __arr_set_length's persist-binding vs cross-module globals.
- **Kernel-L2 ratchet**: with fold alive, the kernel's own optimizer is now
  ACTUALLY exercised — `JZ_TEST_OPTIMIZE=2 npm run test:wasm` shows the
  remaining in-kernel divergences (~7 in types.js, ~79 suite-wide; the original
  typed-narrow .map four are FIXED). Bytes leg defaults to optimize:false until
  the ratchet hits zero; wat/warnings legs run L2 (and pass — shape-faithful).
- Self-host options (uniform (source, strict, optJSON) triple + setupSelf/lower
  DRY) verified: kernel compiles at any level/alias/per-pass object; L2/L3/'size'
  probes correct on the repro.

## Kernel-L2 ratchet status (2026-06-11, post three fixes)
Landed root-cause fixes: (1) dse index-shift [latent native, 4c03b12],
(2) fold Function.length arity [kernel-only, 4c03b12], (3) `.length=`
auto-box protocol split [NATIVE cross-module corruption, 1836a3b — repro:
importer resize between owner pushes read garbage; pinned in test/imports.js].
Ratchet remaining: `JZ_TEST_OPTIMIZE=2 node test/index.js types optimizer
strings closures array-methods` → 99 failures, distinct roots sampled:
`?.()` null short-circuit, slot-types NUMBER/STRING on .prop AST, arenaRewind
persist-on-return. Each is an in-kernel JS-semantics deviation biting the
compiler's own code — same hunt protocol as the three landed: minimal native
probe of the construct → kernel-vs-native WAT diff → root-cause → pin.
Default (optimize:false) leg green; wat/warnings legs green at L2.

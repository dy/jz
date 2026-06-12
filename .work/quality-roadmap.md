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
- [x] **1.4 int-accumulator general path** — `narrowI32` ring algebra at the toI32
  chokepoint (ir.js): ToInt32 is reduction mod 2^32 and {+,−,×} are RING ops under
  it, so exact-int f64 trees compute in i32 with wrap-early operands — exactness
  tracked via per-node maxAbs < 2^53. `/` narrows at the ToInt32 root only
  (fractions aren't ring-compatible) with const divisor ∉{0,1} (÷−1 → `0−x`, dodges
  the INT_MIN trap); `%` peels faithful signed-convert dividends at emit (const
  divisor → i32.rem_s). div/mod/mul-const loops now pure i32 (were f64 dances).
  Mixed div/mod/mul kernel: 209→25 ms (8.5×), 52× vs V8. Pinned: optimizer.js
  narrowI32 ×3 (loop shapes, wrap/sign differential incl. INT_MIN/−1, f64 edges).
- [x] **1.5 prepared-for-generic-cases** (was deferred-on-no-workload):
  - extending-add i8/i16 SIMD — widening byte/short sums (`s += u8[i]`) lift via
    `extadd_pairwise` chain into i32x4 partials; value-exact mod 2^32 (pairwise
    intermediates can't overflow; wrap-add associative). Bare-load-only gate
    (lane arithmetic would wrap at i8 where scalar widens first). 5.8× vs V8 on
    1MB byte-sum. Pinned: simd.js ×5 (u8/s8/u16/s16 + negative gate).
  - scalarization cap 32→64 — no LEB128 cliff: at 64 elems scalarized form is
    ~2.2× SMALLER (stores fold; local refs out-LEB memory ops) and 2.5× faster.
    Covers 8×8 block kernels. 'size' preset keeps its own cap 8.
  - call_indirect devirt — `devirt` pass (wat/optimize.js, post-rounds, off under
    'size' via devirtIndirect knob): two-candidate closure locals (select of i64
    consts) → guarded direct calls with the ORIGINAL call_indirect as fallback
    arm (zero-init flows exact); const slots → bare direct call. Table mutation
    disables module-wide. 2.4× on callback loop (76→32 ms), beats hand-devirt
    (V8 inlines tramps through the direct calls). Pinned: closures.js ×3.
  - AoS→SoA [L] — still deferred: no workload, layout transform is invasive.
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
- [x] README size-table preset note — already present (bench/README.md
  ~115: size table builds with `optimize:'size'`, "pick the preset for what
  you ship; the two tables are not the same build").

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
Default (optimize:false) leg green; wat/warnings legs green at L2.

## Kernel-L2 ratchet: 100 → 2 (2026-06-11, i64 VALUE CONTRACT)
**Root**: one shared cause behind ~98 of the 100 slice failures — BigInt i64
handling inside the WAT optimizer is kernel-divergent in FOUR independent ways
(probed minimally, each pinned by jz-program simulation):
  1. BigInt64Array/BigUint64Array aliased views are a legacy f64-VALUE shim
     (reads return the float, not the bits) — i64FromF64/f64FromI64 never
     worked in-kernel; same for DataView.{get,set}BigUint64.
  2. BigInt.asIntN/asUintN yield null in-kernel (→ Number(null)=0 folds:
     i32.wrap_i64 / f64.convert_i64_* produced WRONG constants).
  3. A BigInt crossing a RETURN, a polymorphic object slot ({type,value}), or
     a mixed-kind param is KIND-ERASED (raw i64 bits are untagged; typeof says
     "object", toString(16) misdispatches). One kind-erased call site poisons
     the param for ALL callers (per-function inference).
  4. Literals that don't fit i64 (0x1_0000_0000_0000_0000n, 1n<<64n) are
     unrepresentable on the mod-2^64 carrier and poison their whole function.
**Fix — the i64 VALUE CONTRACT** (wat/optimize.js + ir.js + assemble.js):
i64 const VALUES travel as canonical '0x'+16-lowercase-hex STRINGS everywhere
(strings are tagged → survive every boundary). BigInt math is constructed AND
consumed inside single expressions only; folders return hex strings or null;
signed compares via biased-hex lexicographic; two's complement via string
math; reinterpret folds of nan: literals move bits as TEXT (a NaN-box payload
held as a raw f64 VALUE is indistinguishable from a live pointer in-kernel);
extractF64Bits/appendStaticSlots/stripStaticDataPrefix use u32-half reads/
writes. Signed canon `v>MAX → v−2^63−2^63` is exact natively and dead in-kernel.
Fixed en route: ?.() null short-circuit (select-of-closure-consts corrupted),
slot-types .prop (static object base folded to 0), "2026"|0 (i64.and identity
fired on corrupt canon), devirt-in-kernel (i64of returned kind-erased BigInt).
**Ratchet: 0 — suite-wide** (`JZ_TEST_OPTIMIZE=2 JZ_TEST_TARGET=jz.wasm
node test/index.js` full run green; JSON shape assertions kernel-gated, see
below). Roots burned this session, in dependency order:
  1. **Untyped-receiver number methods** (emit.js) — `x.toString(radix)` /
     `toFixed`/`toPrecision`/`toExponential` on a kind-erased receiver had NO
     dispatch path (sidecar gate is zero-arg; the runtime-string-fork's number
     arm hardcoded `undefined`) → dynamic prop lookup → undefined. THE root of
     the "escBytes corruption": encodeDataString's `b.toString(16)` on a
     plain-array element read returned undefined → `'\\'+undefined.padStart`
     → `\00` per escape. Fixed: fork's number arm dispatches `.number:<m>`;
     new tryRuntimeNumberMethod covers number-only methods with the dynamic-
     prop sidecar preserved (own `.toFixed` closure still shadows). Pinned
     test/types.js ×4. The week's "Heisenbug" = per-build inference flips.
  2. **NATIVE soundness: static object-literal aliasing** (module/object.js)
     — a pure-const ≥2-prop literal is ONE shared static instance; mutation
     bled across "instances" (`mk().n++` visible via next `mk()`) at EVERY opt
     level. In-kernel this pooled propagate's use-count records
     ({gets,sets,tees}) across ALL locals → live stores deleted at L2 (the
     toString(dyn-radix) set-drop). Fixed: `writtenProps` program-fact (any
     prop name ever written through ANY receiver, incl. expression receivers)
     gates the static path; read-only literals keep it. Pinned objects.js ×4.
  3. **i64 folders both-worlds-exact** (wat/optimize.js) — `BigInt(a) >> s`
     sign-diverges on the kernel's signed carrier (asUintN folded −1);
     Math.sqrt(−c) folding produced a RAW NaN const node whose bits ARE the
     ATOM box prefix → kernel L2 compile trapped OOB. Fixed: mask-ring
     {+,−,×,&,|,^,<<} with `& 0xffff…n` (native wrap ≡ kernel no-op), _sgn
     dead-arm canon for shr_s/div_s/rem_s, u32-half number math for shr_u,
     top-bit skip for div_u/rem_u; makeConst emits the `nan` TOKEN (same
     contract as emitNum).
  4. JSON.parse shape tests kernel-gated (onKernel): the kernel legitimately
     INLINES the single-caller `__jp_shape_N` into $f (size-neutral move; its
     internal generic fallback then appears inside $f). Same shaped fast path,
     same results — only size-guard heuristics land differently. Runtime
     assertions remain on all legs.

Slice detail (`JZ_TEST_OPTIMIZE=2 node test/index.js types
optimizer strings closures array-methods` → 501/501):
  - [x] devirt kernel-leg — was a MISSING WIRING, not a divergence: scripts/
    self.js's optimizeTail (the kernel's pipeline driver, mirroring index.js)
    never mapped cfg.devirtIndirect → watrOpts.devirt. Wired; kernel devirt
    now fires (guards + direct tramp calls + fallback, shape test green).
  - [x] **promoteIntArrayLiterals closure-capture — SOLVED: untyped-receiver
    number-method dispatch hole** (was: "in-kernel escBytes corruption").
    Memory forensics (reading the kernel instance's wasm memory post-compile)
    broke the Heisenbug open: the pre-trim data token sat CORRECT in kernel
    memory (len 229, \05/\f0 present) next to a CORRUPT len-181 rebuild —
    packData's trimTrailingZeros → encodeDataString re-encode, the ONE codec
    never swapped during the hunt. Its `b.toString(16)` ran on a plain-array
    element read = an UNTYPED receiver — and `x.toString(radix)` on an
    untyped receiver had NO dispatch path: trySidecarToPrimitive gates on
    zero args, tryRuntimeStringFork's number arm hardcoded `undefined`, so
    the call fell to dynamic property lookup → undefined →
    `'\\' + undefined.padStart(2,'0')` → `\00` for every escaped byte.
    (The "Heisenbug" was per-build param/kind-inference flips, not heap
    layout; same for `toFixed`/`toPrecision`/`toExponential` on untyped
    receivers — all returned undefined.)
    FIX (emit.js): tryRuntimeStringFork's number arm dispatches
    `.number:<method>` when it exists; new tryRuntimeNumberMethod strategy
    covers number-only methods on untyped receivers (runtime number check →
    number emitter; NaN-boxed → dynamic-prop sidecar so a user's own closure
    still shadows; else undefined). Canonical toString/padStart codecs
    restored; native repro pinned in test/types.js ×4 (toString(16)/toFixed
    on poly-slot reads, string-receiver radix ignore, own-prop shadow).
    Slice: 100 → 0 (501/501).

## 2026-06-12 — bench page self-host case + two latent soundness bugs

The "include jz.wasm on the bench page" request turned into a soundness
session: wiring the self-host compiler as a bench workload exposed three real
compiler bugs (all pinned with tests, all committed).

- [x] **Schema shape-consensus poisoning** (974a979). "First literal
  assignment fixes the shape" bound a var's schema to ONE object literal
  while ignoring every other assignment — Map/table lookups, ternary arms,
  other literals, even DEAD code. Slot reads then misread foreign layouts
  (.laneType returning another shape's slot-0; .accF64 reading past a 4-slot
  object). Killed ALL reduce vectorization in the kernel via the (dead)
  minmax-widen literal in tryReduceVectorize. Fix: bindAssignSchema consensus
  in prepare (any disagreeing assignment unbinds + poisons), idOf/slotOf/
  emit-ptrAux/program-facts all respect ctx.schema.poisoned; structural
  subtyping skipped for poisoned names. Found by 90-line delta-reduction of
  the kernel regression → standalone jz repro at optimize:false.
- [x] **rep.nullable lost across closure captures** (974a979). A capture
  whose parent binding could hold null (`let x = null` then assigned a
  number) lost the nullable mark inside the closure body → `x == null`
  folded to constant false → first-write guards skipped. In-kernel:
  _offsetLocalStride's `stride == null` never fired in its recursive walker
  → every offset-tee copy loop failed the soundness check → memory.copy
  recognition dead in jz.wasm. Fix: closure.make captures nullable
  (captureNullables); emitClosureBody seeds it.
- [x] **fusedRewrite $__is_truthy inline omitted FALSE** (d6be210). The
  inline checked 4 falsy patterns where the real helper checks 5 — boolean
  false became truthy through `x || y` at every optimize level ≥ 1. THIS was
  the long-documented "jessie jz-row throws" bench gap, and the CI selfhost
  fuzz divergence (seeds 7/18). Both jessie and jz bench workloads now
  produce byte-identical output across false/1/2/3/speed.
- [x] **Bench: `jz` case** (bench/jz/jz.js) — the whole compiler pipeline
  (scripts/self.js graph, resolveNode for watr) compiling three small
  programs at L2; jz row = jz.wasm compiling JavaScript. ~64 ms vs V8
  ~39 ms (≈1.9× of JSC baseline), parity ok. Graph cases (jessie, jz) now
  build web artifacts too: bench/web/jessie.wasm + bench/web/jz.wasm join
  watr.wasm. Case/target name clash ('jz') resolved: bare arg = case.
  memory: 64 pages initial for the jz case (450 kB data segment; growth
  covers the arena).
- [x] CI: bench publish needed `permissions: contents: write` (403 on push);
  example wasm artifacts regenerated after the codegen changes (1e2dff9).
  selfhost fuzz failure was the FALSE bug — fixed by d6be210.
- [x] Perf (4f89986): memory.copy/fill loop idioms (overlap-guarded
  memmove/memset; 4.5× on 1 MB f64 copy+zero) and widening min/max
  reductions (i8x16/i16x8 min/max at lane width; 44× on 1 M u8 max).
  Entry-guarded SIMD prefix: lane-domain identities aren't neutral for an
  arbitrary live accumulator.

Next perf generalizations (approved, not yet started):
- [ ] devirt K>2 + closure-array dispatch tables (`handlers[state]()`).
- [ ] param-kind overlay for narrowValResults: hardParamVal(name,k) ===
  VAL.NUMBER consensus → seed param rep val NUMBER (excludes exports /
  value-used), unboxing e.g. `let m = seed` accumulators so the minmax canon
  forms without `+seed` (infra exists: hardParamVal + applyPointerParamAbi
  precedent in narrow.js).
- [ ] emit-level same-type raw element move so narrow (u8/i16/i32) copy
  loops also match tryMemCopyFill (currently value-model conversion trees
  block the idiom).

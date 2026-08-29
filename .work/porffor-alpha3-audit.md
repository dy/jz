# Porffor alpha 3 competitive audit

**Reference:** Porffor `alpha-3`, commit
[`03b6b54f`](https://github.com/CanadaHonk/porffor/commit/03b6b54fda4bdf242e085d23768a6e31490fa58d),
released 2026-08-27. JZ reference: `4c38662f`, Apple M4 Max, Node 25.9.0,
Homebrew clang 19.1.6. Measurements are same-machine local diagnostics, not a
replacement for the full paired release evidence.

## Direct answer: self-compilation

“Compiles itself in 1.7 s” is Porffor's **self-hosted compiler emitting C**, not
its complete source-to-native build. On this machine:

| operation | input | result | wall | peak RSS |
|---|---:|---:|---:|---:|
| Porffor module bundling (`node selfhosted/build.mjs`) | source graph | 2,102,661 B bundle | 0.38 s | 208 MB |
| Porffor selfhost → C (`porf c --compress-data`) | 2,102,661 B / 105,069 AST nodes | 11,230,057 B C | 1.94–1.95 s (7/7) | 251 MB |
| Porffor selfhost → native (`porf native --compress-data`) | same | 5.9 MB executable | 203.77 s | 1.89 GB |
| JZ hosted build → executable Wasm (`self-compile-build.mjs`) | 6,594,483 B / 411,488 AST nodes / 162 modules | 17,786,782 B Wasm | 344.02 s baseline; 348.42 s profiled | 4.33–4.34 GB peak footprint |
| JZ Wasm-hosted full jz×jz | same 162 modules | **trap, zero output** | 10.465–11.448 s in compile; 12.93–14.21 s process | Wasm memory reached 4 GiB |

The JZ self-host result was:

```json
{"modules":162,"outcome":"trap","error":"unreachable","outputBytes":0,"memoryBytes":4294967296,"heap":-32,"wallMs":11448}
```

JZ currently has **no successful self-compilation time**. It fails after roughly
10.5–11.5 s at the wasm32 ceiling. Even before completion,
its source-normalized self-host rate is about 1.9× slower than Porffor's C-emission
rate and its resident memory per input byte is about 3.3× worse. The hosted
shipping-artifact build is about 1.7× slower and 2.1–2.3× heavier than
Porffor's full native build, depending on RSS vs peak-footprint accounting.

Output stages differ: JZ's Wasm is executable immediately; Porffor's 1.95 s C
still needs a C compiler (about 202 s here). Report both numbers. Either one
alone misstates the comparison. Input scale does not explain the
compiler gap: JZ has 3.14× the source bytes and 3.92× the parsed nodes, not the
roughly 176× hosted wall ratio versus Porffor's C-emission phase. Repeated semantic
walks, all-function emission, stdlib realization, whole-module optimization and
WAT/binary materialization account for the rest and must be measured separately.

## Can JZ compile Porffor?

Minimally, yes. The unmodified full selfhost bundle still remains outside JZ's
finite object and host dialect.

The exact 2,102,661-byte alpha-3 bundle first exposed a false JZ early error on
this valid default parameter:

```js
(types = [...LOOP_TYPES, 'switch', 'switch_typeswitch']) => {}
```

The lexical validator kept the comma marker from the nested array spread and
mistook it for `(...rest,)`. `src/early-errors.js` now clears that marker when a
sibling element follows. `test/parser-bugs.js` pins the Porffor shape, an empty
spread, an ordinary trailing comma, a call-spread trailing comma, and the three
invalid rest forms that must still reject.

The tracked compatibility boundary is now:

```sh
npm run test:porffor-core
```

`scripts/porffor-core-adapter.mjs` requires the clean pinned revision
`03b6b54f`, asks Porffor's own bundler for its no-precompiled-builtins variant,
extracts parse, codegen, and C rendering, and emits an 818,526-byte standard-JS
compiler core. It removes only native CLI, filesystem, uWebSockets, and runtime
entry modules. Every rewrite has an exact shape and count check, so source drift
rejects instead of changing behavior silently.

The adapter uses three opt-in compatibility moves:

1. A constructible local `RegExp` delegates validation to one host import. The
   host returns an error string; the shim throws inside Wasm, preserving
   Porffor's own `try`/`catch` without adding a regex interpreter to JZ.
2. Six fixed-name metadata deletions route through one computed-key helper,
   using JZ's existing dynamic-object path. No default object representation or
   ordinary property access changes.
3. Porffor's descriptor-backed comptime table becomes eager in the
   no-precompiled build. Two internal table censuses explicitly filter those
   entries, preserving the accessors' non-enumeration role. The omitted
   precompiled table cannot invoke the removed setters. The one data descriptor
   for `Object.prototype.__proto__` becomes an own computed property via object
   spread.

The adapter exposed generic JZ bugs, fixed at their shared authorities. Builtin
constructor lowering now respects local and imported shadows, including the
syntax-only Array, SharedArrayBuffer, URLSearchParams, and Promise paths.
Expression-bodied functions build final carrier conversions before freezing
local declarations. Direct-recursive boolean predicates retain boolean
truthiness rather than applying numeric ToInt32 to a boxed atom. Nested reads
through opaque aliases, helpers, and imported results retain external dispatch;
each receiver and getter runs once. At `45987028`, a clean build measured
17,777,844 bytes; the same revision plus the working-tree compiler changes
measured 17,820,098 bytes, a 42,254-byte increase. The hot-loop ratchet stayed
at +0 and every
golden output-size gate passed.

The original verifier reported 50.73–54.54 s total wall at up to 1.14 GB peak
RSS. Its timer also covered 24 compiler-core executions: seven unadapted Node
calls, seven adapted Node calls, and ten Wasm calls. Split timing now shows that
those calls are negligible: one current run spent 53.897 s compiling, 4.6 ms
instantiating, and 55.0 ms verifying, including 53.9 ms across all 24 executions.
The old total therefore approximated JZ compile time, but it still cannot be
divided by Porffor's 1.95 s self-host C-emission time: the inputs and output
stages differ. The verifier compares the unadapted no-precompiled Node core, the
adapted Node core, and the JZ-compiled core. All three emitted identical C
for empty input, arithmetic A and B, redeclaration R, valid RegExp G, and module
input M:

| input | C bytes | SHA-256 |
|---|---:|---|
| empty source | 93,415 | `4189c1fa84714e79c109b61b9984c65158effa2f220e2e08ba7bd5969b9aabb9` |
| `let x = 40 + 2; x` | 93,490 | `3e8ddb7ba1c31520597c4de17f2390a7049afaff087aca5d410afad2beeae594` |
| `let x = 6 * 8; x` | 93,490 | `df42aa8b120018db2eb7482f294131463472d0a776439f0d888d2a9f97df67bf` |
| `var x = 1; var x = 2; x` | 93,513 | `db8914715ed849a6a52425e6c476d472c9066cd097d5e4420a7809014faf54e3` |
| `let value = /a+/` | 93,651 | `a714c3545431ab1c1363eea78b4d46e87b54bf06e49271994370790964ddac1e` |
| module `export default 1` | 93,571 | `154fa1faf6010b0368c89b770a57d6ec4a475f0a08f518e5d90bd55b6f8ad1b8` |

A to A was stable, A to B changed output, and module mode reset before the next
script compile. Invalid `/a{2,1}/` raised SyntaxError in all three tiers. The
same instance then compiled A to its original bytes. The generated adapter is
deterministic, SHA-256
`c2c1bb379ad069e8d64cfca6a5b267ad11fe7b29443bca9f9588a4e6b9f74a6f`.

This is a minimal compiler-core result. The no-precompiled variant does not
carry Porffor's complete standard builtin corpus, and the full CLI still needs
Node services and `Porffor.c`. It is therefore a compatibility proof and a
reproducible lab gate, not benchmark evidence for the full Porffor compiler.
Add a corpus row only after an unmodified, feature-complete core produces a
parity-checkable artifact.

## Where JZ spends the hosted 348 seconds

A diagnostic run passed the existing host-only phase sink to `compile()` and
produced byte-identical `dist/jz.wasm` (`341fdfcf…`):

| phase | wall | share of 348.42 s process wall |
|---|---:|---:|
| `watOptimize` | 119.25 s | 34.2% |
| `snapshotInit` | 100.40 s | 28.8% |
| final `watrCompile` | 82.25 s | 23.6% |
| semantic `compile` total | 42.15 s | 12.1% |
| └ `optimizeModule` | 26.82 s | nested in `compile` |
| └ planning | 4.52 s | nested in `compile` |
| prepare | 0.90 s | 0.3% |
| pull stdlib | 0.68 s | 0.2% |

About 87% is after JZ has already built its semantic module: whole-WAT
optimization, the snapshot probe encode/run/rewrite, and final binary encoding.
That makes the ordering evidence-based: streaming/compact output and reducing the
module handed to watr outrank parser micro-optimization. Precompiled stdlib IR
still matters because allocation volume blocks the Wasm-hosted run.

## What Porffor does differently

### 1. A small, fixed-shape typed/effect IR

Porffor's IR is one structured tree. Every node is exactly six slots:
`[kind, type, effects, a, b, c]`; kinds and types are numeric enums and effects
are a bitmask. See
[`compiler/ir.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/ir.js#L1-L35).

The fixed slots provide constant-time result-type and effect queries. JZ
currently tags WAT arrays with expandos such as `.type`, `.ptrKind`, `.ptrAux`,
`.schemaSid`, then repeatedly re-walks trees for purity/effect/type questions.
The comments in `src/ir.js` already document metadata-loss and aliasing bugs
caused by this shape.

**Transfer:** make the compact HIR real: fixed slots for opcode, result
representation, provenance and effects. Keep WAT as a lowering product, not the
first authoritative semantic IR.

### 2. Optimization while constructing IR

IR constructors fold constants, remove no-op conversions, collapse conversion
chains and fold truthiness/nullish checks immediately. There is deliberately no
post-hoc IR optimizer; the C compiler handles machine-level cleanup. See the
header and constructors in
[`compiler/ir.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/ir.js#L1-L7).

JZ cannot delete its optimizer because Wasm backend quality is the product.
Constructor folding can still keep obvious garbage out of downstream passes.

### 3. Demand-driven function and builtin generation

A Porffor function initially stores AST plus a `generate()` closure. Bodies are
only generated when exported or referenced, followed by a bounded finalizer
fixpoint. Ungenerated functions never become IR. See
[`compiler/codegen.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/codegen.js#L4600-L4810)
and the reachability/finalizer loop near lines 5154–5166.

JZ emits every entry in `ctx.funcs.list` and tree-shakes after emission
(`src/compile/index.js:2619+`). For the self graph that means roughly 2,234
functions can incur analysis/emission/IR allocation before dead code is known.

**Transfer:** build one frozen call/reachability index before emission and skip
only functions proven unreachable. This must consume RepresentationPlan and the
canonical member-call target index; no name-guess fallback.

### 4. Builtins are precompiled, compressed and lazily decoded

Porffor precompiles 1,204 functions from 38 builtin files into typed IR. It
serializes fixed-shape nodes, interns strings, Huffman-encodes token streams and
installs replace-on-first-read accessors so only demanded builtins decode. See
[`compiler/precompile.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/precompile.js#L188-L585).

Measured generation: 0.741 s compiler phases / 1.20 s process, 301 MB peak. The
resulting `builtins_precompiled.js` is 1.19 MB and replaces 688 KB / 18,404 lines
of builtin source during normal compilation.

JZ demand-loads stdlib helpers, but `pullStdlib` still realizes and parses WAT
text templates late. The memory ledger measured about 927 MB of churn in that
stage.

**Transfer:** generate a versioned packed stdlib-IR image at build time, lazily
materialize only demanded helpers, and round-trip it against source in tests.
Do not hand-edit or commit hidden `node_modules` output; the generator and format
must be tracked and deterministic.

### 5. Selfhost modules are linked before compilation

`selfhosted/build.mjs` statically resolves imports, renames top-level bindings,
removes module syntax and emits one 2.1 MB source bundle. See
[`selfhosted/build.mjs`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/selfhosted/build.mjs#L142-L761).

JZ passes 162 source modules plus a 6.71 MB JSON modules map into the Wasm
compiler. That duplicates source and keeps module/session state live.

**Transfer:** add a deterministic, semantics-checked selfhost bundle as a
shipping-build accelerator. It must not replace the separate 162-module jz×jz
acceptance gate; otherwise it hides rather than fixes module-graph scaling.

### 6. Scoped temporary reuse

Porffor allocates typed temporaries from a per-function pool with explicit
`mark()`/`release()` lifetimes and spills only nontrivial duplicated expressions.
See `compiler/codegen.js:84–180`.

**Transfer:** a scoped TempArena in JZ emission can reduce locals, IR nodes and
later local-lifetime work. It must preserve source evaluation order and should
land behind exact IR parity tests first.

### 7. Direct-only ABI specialization

Porffor scans calls to functions that never escape, propagates argument types to
a fixpoint, and gives proven numeric parameters raw `f64` signatures
(`compiler/codegen.js:4980–5037`). It also omits closure-environment parameters
when the caller chain proves none can exist.

JZ already has the stronger RepresentationPlan/FunctionPlan machinery. The
transferable lesson is structural: one canonical call-target/escape index should
feed every ABI consumer. Another emitter-local name resolver would repeat the
member-call wrong-value seam.

### 8. Compiler PGO

Porffor's release compiler profiles itself compiling its own bundle, then builds
with that profile (`selfhost:616–639`, CI workflow `ci.yaml:71–85`).

**Transfer:**

- use JZ's existing helper/callsite counters to specialize and order the
  self-compiler artifact from real full-graph profiles;
- feed equivalent PGO into JZ's native lowering;
- do not introduce self-source hints or benchmark-specific branches.

Wasm lacks C/LLVM's general PGO backend, so transferable wins are call-target
specialization, hot/cold outlining and data/function layout. Wasm cannot express
the branch metadata used by C and LLVM PGO.

### 9. A reclaiming compiler runtime

Porffor's native compiler runs with an actual GC and fixed-address 32-bit arena.
JZ's self-compiler uses a bump arena and must prove region releases manually.
Porffor can therefore build whole output strings and still reclaim transient
objects; JZ reaches 4 GiB before final encoding.

**Transfer:** compiler-only phase/function arenas and streaming output. Do not
add a GC to user artifacts: JZ's no-runtime product contract remains valuable.

## Ranked JZ work

1. **P0: finish compact/streaming output or sound function-region release.**
   Nothing else turns the current trap into a self-compile time.
2. **P0: stop paying two whole-module encodes for init snapshotting.** The
   snapshot probe costs 100.40 s before the final 82.25 s encode. Evaluate a
   compact init interpreter or an earlier proven snapshot form; preserve exact
   final bytes and decline behavior rather than merely disabling the runtime win.
3. **P0: canonical ProgramIndex/call-target authority plus demand-first named
   emission.** Closes the member-callee soundness seam and avoids producing dead IR.
4. **P0: packed lazy stdlib IR.** Target the measured `pullStdlib` parse/churn
   class, not one benchmark.
5. **P1: fixed-shape HIR with inline type/provenance/effect bits.** Migrate
   consumers incrementally; fail closed when facts are absent.
6. **P1: scoped typed temp reuse.** Pin single evaluation and source order.
7. **P1: self-profile specialization and native PGO.** Only after correctness
   and memory are stable.
8. **P2: deterministic single-module selfhost bundle.** Useful shipping fast
   path, never a substitute for the full module gate.

## What not to copy

- Do not rely on clang to optimize JZ Wasm; direct Wasm quality is JZ's claim.
- Do not replace correct-or-reject representation plans with Porffor's more
  optimistic local type inference.
- Do not adopt Porffor's runtime GC in ordinary JZ output.
- Do not flatten benchmark sources or add integer hints to make JZ look faster.
- Do not count a Porffor compile/runtime failure as proof that JZ is faster;
  retain explicit coverage gates.

## Competitive gates

- `porf-native` is now pinned to alpha 3's exact SHA in `bench.yml`.
- Porffor prep-cache stamps include exact git HEAD. Dirty checkouts bypass the
  cache. Shared harness mtimes invalidate rival artifacts when `bench.mjs` or
  `bench/_lib` changes. Target-specific flat inputs prevent Porffor's timer
  variant from replacing the shell-engine variant.
- Claims freshness reads each parity-valid JZ row's `measuredAt` and rejects
  uncommitted compiler inputs. A Porffor-only merge can no longer move
  `meta.commit` to HEAD and disguise carried JZ timings as fresh. Claims,
  headline stats, and the bench page
  exclude wrong-result rows on both sides of every ratio.
- Failure-only targeted runs are now persisted. The previous `if
  (!results.length) continue` silently retained an old failed row whenever the
  sole selected target failed. The current jz×jz lab attempt hit this path.
  `test/bench-porffor.js` now pins failure persistence and sibling preservation.
- The anchored alpha-3 refresh produced 43 accepted-checksum rows, including
  `synth`'s documented FMA result. Against the `4c38662f` JZ-row refresh, JZ won
  all 43: `porf-native/jz` runtime geomean 21.722×, narrowest win 1.865×
  (`synth`). JZ artifacts were smaller on all 43: `porf-native/jz`
  artifact-byte geomean 63.865×, narrowest margin 4.981× (`provenance`). Larger
  ratios favor JZ. Porffor had 14 checksum-divergent rows
  and three failed lab rows (`watr`, `jessie`, `jz`); these are retained as
  failures, never counted as wins.
- The long JZ self-lab compile pushed system swap to 4.20 GB, beyond the
  committed 4 GB validity bound. Anchor rows still passed and the Porffor margin
  is far outside noise, but the mixed snapshot is not release-certified.
  Compiler source advanced after the JZ rows were measured, so freshness is also
  red. Remeasure after reboot and source freeze. No validity threshold was loosened.
- `test/bench.js` requires at least 40 comparable rows, no JZ speed or size
  loss, and Porffor/JZ runtime and artifact-byte geomeans of at least 1.
- Full self-compilation remains red until JZ produces bytes below 4 GiB. Once it
  succeeds, add the same-machine self-compiler wall/RSS comparison as a hard
  release gate; do not grandfather today's trap or relax Porffor's floor.

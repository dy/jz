# Contributing to JZ

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # 2800+ tests
node bench/bench.mjs  # run benchmarks
```

## Code layout

```
jzify/          pre-compile desugar (index.js orchestrator + phase modules)
  names.js      temp-name factory
  bundler.js    esbuild export/interop folds + object-literal idioms
  classes.js    class + object-method `this` lowering, pseudo-classical/prototype folds, statics
  switch.js     switch fall-through lowering
  generators.js function*/yield state machines + iterator-helper loop fusion
  hoist-vars.js var hoisting; arguments.js — arguments/rest lowering
src/
  prepare/      validate, normalize, extract exports/imports (index.js)
  compile/      analyze → infer → plan → narrow → emit; program-facts; driver (index.js)
  optimize/     WASM IR peephole passes + vectorize.js
  wat/          assemble.js, codegen.js (AST → jz source printer), optimize.js
  abi/          NaN-box ABI helpers (string, array, object, number)
  op-policy.js  shared jzify/prepare reject + class-error messages
  # shared leaves — cycle-free, imported across stages:
  ast.js static.js kind.js type.js param-reps.js
  ctx.js bridge.js reps.js ir.js autoload.js resolve.js
  layout-kinds.js  region-arena relocation arms per heap kind (executable registry; prose twin layout-kinds-doc.js)
module/         stdlib
layout.js       NaN-box bit layout + PTR.TYPED elem-aux codec (compiler-free, shared with module/)
interop.js      host↔wasm value marshalling: NaN-box decode/encode at the JS boundary (exports, imports, memory views)
transform.js    jzify as standalone source→source (`jz/transform`; parse → jzify → codegen)
err-codes.js    compile/runtime error-code registry (host decode of trapped error classes)
wasi.js         WASI shim for the standalone/CLI targets
cli.js          command-line driver (`jz` binary): flags → compile opts, file IO, --why-not-simd
```

**Folder policy:** one folder per pipeline *stage*, not per arbitrary concern. `jzify/` lives at repo root (pre-compiler transform, like `layout.js` / `cli.js`). Shared cycle-free leaves stay at `src/` root so `module/` imports stay short.

**Stdlib registration — two dialects, by design:** raw `ctx.core.stdlib[name] = body` / `ctx.core.emit[name] = fn` (or the `bind(name, fn)` sugar) is the DEFAULT for dep-free, arity-irrelevant handlers — the overwhelming majority of the stdlib (~580 sites vs ~35 `reg()` calls; this is real, not legacy-to-migrate). Call `inc('__dep', …)` inline in the handler body for any stdlib kernel it needs. `reg(name, deps, fn)` (→ `emitter()`, `src/ctx.js`) — or `wat(name, body)` for the WAT-kernel half, co-located via `reg(name, { deps, wat, emit })` — is REQUIRED whenever either mechanical property matters:
  - **deps must be auto-included, not hand-called.** `emitter()`'s wrapper runs `inc(...deps)` before every invocation of `fn`; anything that wraps/aliases the handler (`dual`, `.deps` propagation, a second name bound to the same function) inherits the guarantee for free. A raw handler's `inc()` call lives only in its own body — copy or wrap it and the dep silently drops.
  - **logical arity diverges from `fn.length`.** `emitter()`/`call()`/`method()` set `.argc` explicitly, which `emitArity()`'s fallback (`h?.argc ?? h?.length`) needs whenever a handler is built through a rest-param wrapper or otherwise doesn't report its true arity via `Function.length`. Plain raw handlers work fine on the `.length` fallback *only when the two agree* — that's the common case, hence still the default.

  The one hard, mechanical rule for either dialect: **never introduce a raw assignment for a name already `reg()`-registered** — it used to silently overwrite `emitter()`'s wrapper, dropping the auto-inc/argc guarantee with no error. It no longer can: `reg()`/`wat()`/`registerGetter()` (`src/ctx.js` `registerName`) refuse to register a name that's already occupied — by an earlier raw/`bind()` write *or* an earlier `reg()`/`wat()` call, in either order — and throw immediately, naming both the module registering now and the module that got there first. A `reg()`-registered `ctx.core.emit` handler clobbered by a *later* raw assignment (undetectable at the moment `reg()` runs) is caught right after the clobbering module's `init()` returns (`verifyEmitIntegrity`, wired from `src/autoload.js` `includeModule`), by checking that its `emitter()` wrapper tag (`.deps`) is still intact. This does **not** touch the default dialect's own legitimate override chain — a later raw/`bind()` write freely shadowing an *earlier* raw/`bind()` write for the same name (e.g. `date.js`'s Date-specific `.valueOf` over `string.js`'s generic Object-prototype fallback) is the intended generic-then-specific specialization idiom and stays silent, unguarded, by design. Both throw paths are exercised by `test/passes.js`'s stdlib duplicate-registration tests.

**kind vs type:** `kind.js` = value family (STRING, ARRAY, …). `type.js` = WASM numeric type (i32/f64), typed-array ctor detection, integer proofs, loop-unroll helpers (the pure PTR.TYPED aux codec lives in `layout.js`). **AST walks:** use `refsName`/`refsAny`/`some` from `ast.js` — don't hand-roll name scanners.

## Architecture

Pipeline: `source → parse (subscript/jessie) → jzify (default-on; strict skips) → prepare → compile → optimize → watr (WAT→binary)`

All values are f64. Heap types use NaN-boxing (see README). The shared `ctx` object is the single source of compilation state — the docstring in [`src/ctx.js`](src/ctx.js) carries the lifecycle ownership table (which phase owns which subkey, writers, readers); consult it before adding new state.

## Adding a stdlib method

1. Find or create the module file in `module/` (e.g. `module/string.js`)
2. Register the handler — plain `ctx.core.emit['name'] = fn` (`inc()` any deps inline) unless deps must auto-include or arity must be explicit, in which case `reg('name', deps, fn)` / `call` / `method` from `src/bridge.js` (see "Stdlib registration" above). WAT include deps via `deps({ … })`. Emit helpers: `flat`, `body`, `bool`, `idx`, `spread`.
3. If the handler's key is `.name` or `.kind:name` (a `.prop`-dispatched method/property, as opposed to a bare global-call name like `parseInt`), run `node scripts/gen-prop-modules.mjs` and commit the resulting `src/prop-modules.generated.js` diff — it's the derived table `includeForProperty` (`src/autoload.js`) uses to decide which modules a property NAME might auto-load at prepare() time, before value-type inference can say which module it'll actually dispatch to. `test/self-compile-includes.js`'s freshness test fails loudly (naming this command) if you forget.
4. Add tests in `test/`
5. Run `npm test`

## Adding an auto-vectorizer recognizer

The lane vectorizer (`vectorizeLaneLocal` in [`src/optimize/vectorize.js`](src/optimize/vectorize.js))
lifts typed-array loops to WASM-SIMD. Recognizers are tried in order in its dispatch; each consumes the
shared `matchBlockLoop` descriptor and returns a wrapper or `null` — a `null` is fail-safe (the loop
stays scalar), so **never emit code you can't prove equivalent to the scalar loop.**

Discipline (non-negotiable — these run in the default `speed` build that ships to everyone):

- **Bit-exact.** Compile `{optimize:3}` vs `{optimize:3, noSimd:true}`, run N frames, compare output
  buffers byte-for-byte (0 diffs). **Seed RNG** (`randomSeed:K`) for any example using `Math.random` —
  two un-seeded instances diverge and look like a miscompile. Float reductions that reorder across lanes
  are ulp-divergent → gate at `optimize≥2`; per-lane maps/reductions reorder nothing and are exact.
- **Ratchet +0.** `npm run test:ratchet` must stay byte-identical — recognize only the intended shape;
  don't widen the default corpus path.
- **Run `npm run test:self`.** The dev suite runs on V8, but the self-compile build compiles JZ *with JZ*.
  A recognizer can be bit-exact on V8 yet make `dist/jz.wasm` fail validation
  (`i64.reinterpret_f64 expected f64, found i32`) — **the V8 suite will not catch this.**
  - *Cause & fix:* a top-level **self-recursive** helper taking the `ctx` object as a param — JZ's
    signature narrowing can't prove the recursive call passes an i32 pointer, so it leaves that one
    function's `ctx` boxed (`f64`) while every other has `ctx:i32`, and callers emit a bad reinterpret.
    Define ctx-using *recursive* lifters as **nested `function` declarations that capture `ctx`** (take
    only `expr`/`stmt` args), like `scanForLoadsStores`. No `ctx` param ⇒ nothing to mis-narrow. Also:
    don't reassign a parameter (use a local).
  - *Debug:* `compile(<self.js source>, {optimize:false, wat:true})`, map the failing `function #N` to a
    name by counting `(func $…` in order, then dump its param types — the odd `ctx:f64` is the smoking gun.

Coverage is not exhausted but is diminishing-returns vs reach work (see `.work/todo.md`): i32x4 cellular
automata (game-of-life/ising/rule30) and lyapunov's carried-recurrence outer-strip remain feasible;
gather/scatter loops (dla/sand/voronoi) are not — WASM-SIMD has no gather/scatter, so route them to scalar.

## Principles

- **Don't optimize the compiler source itself.** Readability > cleverness in `src/`. The compiler doesn't need to be fast — the output does.
- **Valid JZ = valid JS.** Any JZ program must parse and run as standard JavaScript.
- **WASM conventions, not JS edge-cases (the speed dialect).** The *source* is valid JS, but the *compiled output* targets WASM/native semantics. Where a native language (C, Rust, Zig) may assume something JS can't, JZ's output may take that convention too — **provided the f64 value-precision of real computation is preserved.** Integer wrap at ±2³¹, unchecked typed-array reads, raw UTF-8, NaN bit-patterns and signed-zero follow the machine, not the spec. What JZ will **not** do is trade away a meaningful result's accuracy (no mantissa-trimming, no brutal precision loss). Litmus: *if another native language can presume it here, JZ may too.* Any new speed-mode lowering must stay inside this contract and be added to the [FAQ divergence list](README.md#faq).
- **Minimal surface.** Every feature must justify its weight. If it can be a library, it should be.
- **No runtime.** Compiled WASM has no jz-specific runtime — just WASM + WASI.

## Testing

Tests use [tst](https://github.com/dy/tst). Each file in `test/` is self-contained. Run all:

```sh
npm test
```

Run one file:

```sh
node test/strings.js
```

## Performance & size invariant

JZ makes a load-bearing promise: **on the bench corpus, JZ wasm is at least as
fast and at least as small as the alternatives.** Concretely, enforced by
`test/bench.js` (run by CI on every push/PR — `.github/workflows/bench.yml`):

- **Speed** (`-O` speed-tuned build): JZ median ≤ V8 and AssemblyScript (`asc -O3`)
  on every comparable case, and ≤ them on geomean; ≤ Porffor's native artifact by
  geomean (the `porf-native` lane, asserted from committed evidence — the 2026
  Porffor rewrite emits no wasm, so it left the per-case wasm field). *Timing ratios are
  asserted off-CI only (local `npm run test:bench` on stable hardware — the
  release discipline); on CI they print informational, since a shared 2-core
  runner reads identical builds up to 15× slower. Checksums, sizes and compile
  success stay hard-gated on CI.*
- **Native parity** *(asserted only when `clang` is on PATH — i.e. locally; CI
  runners have no clang, so this pin is printed but not gated there)*: JZ wasm runs
  at `clang -O3` speed — geomean jz/C ≈ 0.86–0.98×
  (JZ *beats* native C on `poly`, `mat4`, `aos`, `tokenizer`, `sort`, ties
  `mandelbrot`). Two cases trail native and are pinned `near`, not as a parity
  claim: `biquad` is wasm-v1 ISA-bound (no scalar `fma` — hand-written WAT ties
  it too) and `json` is string-carrier bound. The geomean ceiling is the
  guarantee; the `near` per-case pins are regression backstops.
- **Size** (`optimize: 'size'` build): JZ wasm ≤ AssemblyScript (`asc -Oz --converge`)
  on every comparable case, and ≤ it on geomean. (Porffor left this axis with its
  wasm target; its native binary sizes read on the bench page's native band.)
- **Codegen slack**: `wasm-opt -Oz` should find little to remove in JZ's own
  output — whatever it shrinks is latent size headroom. Gated with margin today
  (`WASMOPT_SLACK_MIN=0.70` in `test/bench.js` — ~25–30% slack on size builds);
  target is 0.95+, ratcheted down as codegen tightens.
- **Correctness floor**: `test/differential.js` fuzzes jz-compiled wasm against
  the same source run as plain JS — "smallest/fastest" never via a wrong answer.

Run locally (needs `asc` and `wasm-opt` on PATH for the full picture; the
`porf-native` lane picks up a Porffor git checkout via `PORF_BIN`):

```sh
npm run test:bench   # the gate
npm run bench:size       # just the wasm-size table (jz vs AS -Oz, + wasm-opt slack)
npm run bench            # just the speed harness
```

**Ratchet, don't backslide.** `bench.js` carries per-case `win`/`tie`/`near`/`todo`
claims (against each competitor and against native C) and geomean ceilings. When
you make JZ beat a `todo` or close a `near` gap, promote it to `win`/`tie` in the
same PR; when you shrink codegen, tighten the relevant geomean ceiling and the
`wasm-opt` slack budget. A PR may not move any claim backward. If a change trades size for speed (or vice-versa) deliberately — e.g.
the unrolled/vectorized hot kernels — say so in the commit and adjust the
*size* budget, not the speed pin.

### Adding a bench case

1. `mkdir bench/<name>/` and add `bench/<name>/<name>.js` — valid JZ that
   `import`s `{ ... }` from `../_lib/benchlib.js`, exports `main`, and ends with
   `printResult(medianUs(samples), checksum, …)`. Use an existing case as a template.
2. For a fair size/speed comparison, add a self-contained `bench/<name>/<name>.as.ts`
   (AssemblyScript port — env imports `perfNow`/`logLine`, see `bench/bitwise/bitwise.as.ts`).
   Optional: `<name>.c` / `.rs` / `.go` / `.zig` for native baselines, `<name>.wat` for a hand-written reference.
3. Add the case to the `SPEED` and `SIZE` maps in `test/bench.js` (claims
   default to `todo` / `na`), and a `SIZE_BUDGET` backstop.
4. `npm run bench -- --cases=<name>` and `npm run bench:size -- <name>` to see where it lands.

Prefer cases that mirror real JZ target workloads (numeric/DSP/parsing/wasm-utils) —
the corpus *is* the guarantee, so widen it toward the code you actually ship.

## Commits

Small, focused commits. Describe what and why, not how.

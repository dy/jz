# Contributing to JZ

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # core suite
node bench/bench.mjs  # run benchmarks
```

Building, and which files are build output rather than source: AGENTS.md ("Never hand-edit generated artifacts", "Build artifacts & deploy").

For coordinated changes in sibling `jz`, `watr` and `subscript` checkouts,
test their main branches together with
`npm install --no-save --package-lock=false --ignore-scripts ../watr ../subscript`.
This selects the local libraries without changing the published dependency ranges.
The parser allocation regressions require source-span parsing in subscript and
watr's `loc: false` option.
Before release verification, use `npm ci` to replace local links with the locked
registry packages so local tests exercise the same dependencies as CI.

## Code layout

```
jzify/          pre-compile desugar (index.js orchestrator + phase modules)
src/
  prepare/      validate, normalize, extract exports/imports (index.js)
  compile/      analyze → infer → plan → narrow → emit; ProgramIndex; program facts; driver (index.js)
    plan/       source-level sweeps before emission: inlining, loop copies, scope folds (index.js)
    analyze/    per-function facts: body facts, the frame-effects census
    narrow/     signatures and parameter carriers from the call sites
    emit/       the emitters, one file per node family
  summary/      the program summary: one kind per binding, slot and result, a whole-program fixpoint refreshed after source rewrites
  type/         numeric proofs: the interval interpreter, loop bounds, loop versioning, expression types
  kind/         value kinds: the lattice, payload and shape facts
  optimize/     WAT passes; pass-table.js orders them, rules.js holds the local rewrites, vectorize/ the lane lifts
  link/         whole-module passes on the tape: treeshake, custom sections, throw-runtime prune, function order, local names (index.js)
  ir/           tape.js, the IR tape (parallel typed arrays); the WAT-array helpers until emit builds the tape
  wat/          assemble.js and assemble/: sections, the stdlib pull, the module optimizer's walk
  abi/          NaN-box ABI helpers (string, array, object, number)
  std/          the `jz:` runtime modules written in JavaScript (promises, iterators, events)
  op-policy.js  shared jzify/prepare reject + class-error messages
  # shared leaves — cycle-free, imported across stages:
  ast.js static.js kind.js type.js param-reps.js
  ctx.js bridge.js reps.js ir.js autoload.js resolve.js
module/         stdlib
layout.js       NaN-box bit layout + PTR.TYPED elem-aux codec (compiler-free, shared with module/)
layout-kinds.js  region-arena relocation arms per heap kind (executable registry; prose twin layout-kinds-doc.js)
interop.js      host↔wasm value marshalling: NaN-box decode/encode at the JS boundary (exports, imports, memory views)
err-codes.js    compile/runtime error-code registry (host decode of trapped error classes)
wasi.js         WASI shim; linked by interop.js, no public subpath
cli.js          command-line driver (`jz` binary): flags → compile opts, file IO, --why
test/ bench/ scripts/ examples/   suites and gates, the bench corpus and its claims, build and census tools, the gallery
```

**Folder policy:** one folder per pipeline *stage*, not per arbitrary concern. `jzify/` lives at repo root (pre-compiler transform, like `layout.js` / `cli.js`). Shared cycle-free leaves stay at `src/` root so `module/` imports stay short.

### Stdlib registration

**Stdlib registration — two dialects, by design:** raw `ctx.core.stdlib[name] = body` / `ctx.core.emit[name] = fn` (or the `bind(name, fn)` sugar) is the DEFAULT for dep-free, arity-irrelevant handlers — the overwhelming majority of the stdlib (~580 sites vs ~35 `reg()` calls; this is real, not legacy-to-migrate). Call `inc('__dep', …)` inline in the handler body for any stdlib kernel it needs. `reg(name, deps, fn)` (→ `emitter()`, `src/ctx.js`), paired with `wat(name, body)` for any WAT-kernel half, is REQUIRED whenever either mechanical property matters:
  - **deps must be auto-included, not hand-called.** `emitter()`'s wrapper runs `inc(...deps)` before every invocation of `fn`; anything that wraps/aliases the handler (`dual`, `.deps` propagation, a second name bound to the same function) inherits the guarantee for free. A raw handler's `inc()` call lives only in its own body — copy or wrap it and the dep silently drops.
  - **logical arity diverges from `fn.length`.** `emitter()`/`call()`/`method()` set `.argc` explicitly, which `emitArity()`'s fallback (`h?.argc ?? h?.length`) needs whenever a handler is built through a rest-param wrapper or otherwise doesn't report its true arity via `Function.length`. Plain raw handlers work fine on the `.length` fallback *only when the two agree* — that's the common case, hence still the default.

The one hard, mechanical rule for either dialect: **never introduce a second write for a FLAT name already registered** — it used to silently overwrite the earlier handler (dropping `emitter()`'s auto-inc/argc guarantee when the earlier write was a `reg()`) with no error. **Type-qualified keys** (`.date:valueOf`, `.string:padStart`, …) are the one exemption: namespaced by design, one physical owner (the type's own module) per key, so `bind()` leaves them on the old unguarded raw write — cross-module collision there was never the hazard. All throw paths are exercised by `test/passes.js`'s stdlib duplicate-registration tests.

**kind vs type:** `kind.js` = value family (STRING, ARRAY, …). `type.js` = WASM numeric type (i32/f64), typed-array ctor detection, integer proofs, loop-unroll helpers (the pure PTR.TYPED aux codec lives in `layout.js`). **AST walks:** use `refsName`/`refsAny`/`some` from `ast.js` — don't hand-roll name scanners.

## Architecture

Current pipeline: `source → parse (subscript/jessie) → jzify (always on; the test-only `strict` option skips it) → prepare → compile → optimize → link → watr (WAT→binary)`

**One shared optimizer, owned by watr (`~/projects/watr`).** Generic optimizer changes belong there, with tests in both projects. JZ supplies language-specific analysis, representation contracts, and lowering. The existing generic passes in `src/optimize/` are migration work: consolidate them into watr and delete JZ copies, rather than building a competing optimizer. Never patch only `node_modules`.

The tape (`src/ir/tape.js`) transports WAT through link. Settled program summaries own semantic facts; watr owns generic optimization. Reliable builds and stateful audio DSP come first. Further IR or state refactors need a demonstrated defect, bottleneck, or deletion. Each migration slice deletes the authority it replaces.

Values use proven raw lanes or tagged carriers; heap values use NaN-boxing (see README). The legacy `ctx` store still carries compilation state. Consult its lifecycle ownership table in [`src/ctx.js`](src/ctx.js) before changing state; new persistent facts belong in ProgramIndex and frozen summaries, not another ambient store.

Design lives beside the code. A file's header comment states what the file owns, the invariants its readers rely on and the measurements behind its choices: read it before changing the file. The optimizer's order is one table (`src/optimize/pass-table.js`), the local WAT rewrites another (`src/optimize/rules.js`), the product's speed and size claims a third (`bench/claims.mjs`). The design notes this file held before it became a guide are in Git history: `git show ea0795b7d:CONTRIBUTING.md`.

A comment citing a `.work/` path or `PLAN.md` that the tree no longer holds refers to Git
history: the notes retired on 2026-09-08 read as `git show 66e72c46:<path>`, PLAN.md and the
notes retired with it as `git show c41d43f10:<path>`. The owner's product notes stay in
`.work/` (todo, marketing, strategy, ecosystem, audiojs); this file and the README hold the rest.

## Principles

- **Don't contort compiler source for microbenchmarks.** Readability wins in `src/`; optimize compiler time and retained memory only from measured, general evidence. Output speed and size remain the primary product budgets.
- **JZ source is JavaScript source.** Supported programs must parse and run as standard JavaScript. Parser acceptance of an ECMAScript early-error-invalid program is a bug/temporary hole, never a language extension or compatibility promise.
- **A finite speed dialect, not an open-ended escape hatch.** Compiled output follows the semantics explicitly listed under [“What differs from JS?”](README.md#what-differs-from-js): wide bitwise operands, 64-bit BigInt, constant rounding and the other enumerated cases. Outside that list, preserve JavaScript answers, exceptions, evaluation order, and effects or reject. “A native compiler could do it” is not sufficient authority for a new divergence: update the public contract and add cross-tier exact tests before landing one. Never trade away a meaningful result's f64 accuracy (no mantissa trimming or arbitrary precision loss).
- **Minimal surface.** Every feature must justify its weight. If it can be a library, it should be.
- **No external runtime and no GC.** Needed JZ runtime operations are linked into the module; unused operations are omitted.

## Adding a stdlib method

1. Find or create the module file in `module/` (e.g. `module/string.js`)
2. Register the handler — plain `ctx.core.emit['name'] = fn` (`inc()` any deps inline) unless deps must auto-include or arity must be explicit, in which case `reg('name', deps, fn)` / `call` / `method` from `src/bridge.js` (see "Stdlib registration" above). WAT include deps via `deps({ … })`. Emit helpers: `flat`, `body`, `bool`, `idx`, `spread`.
3. If the handler's key is `.name` or `.kind:name` (a `.prop`-dispatched method/property, as opposed to a bare global-call name like `parseInt`), run `node scripts/gen-prop-modules.mjs` and commit the resulting `src/prop-modules.generated.js` diff — it's the derived table `includeForProperty` (`src/autoload.js`) uses to decide which modules a property NAME might auto-load at prepare() time, before value-type inference can say which module it'll actually dispatch to. `test/self-compile-includes.js`'s freshness test fails loudly (naming this command) if you forget.
4. Add tests in `test/`
5. Run `npm test`

## Adding a pass

A WAT pass is an entry of `src/optimize/pass-table.js`: its stage, the steps it follows and why, the facts it takes and makes, the emitter's marks it reads and drops. `test/pass-table.js` fails a step run out of its stated order, and under `JZ_DEBUG_INVARIANTS=1` the suite fails a step that reads a fact its entry does not take (`test/_facts-guard.js`). For the source passes:

- No source-plan pass keeps a private call or effect analyzer; where the shared evidence is silent, the optimization declines.
- A pass that rewrites a body in place calls `invalidateRewrittenBody`: the binding-use census, interval proof and mutation memo are keyed by node identity.
- A pass that copies a node or puts one in its place carries what the parser noted on it (its position, `loc`) through `copyNode` and `noted` (`src/ast.js`), not `slice`: a statement rewritten without them has no source position.

## Adding a rewrite rule

A local rewrite of WAT is a row of `src/optimize/rules.js`, `[name, relation, match, out, when]`; its header defines the holes and the relations. `test/rules.js` assembles both trees of every row and runs them over grids of constants and arguments, compared by the row's relation. A rule that needs a fact from outside the tree, a chain of any length, flow, fresh locals or effects stays code beside the table, states its relation in the same terms, and `test/rules.js` runs its own function on patterns the same way.

## Adding an auto-vectorizer recognizer

Generic recognizer work belongs in watr. The discipline below also applies to the
existing JZ implementation while it migrates.

The lane vectorizer (`vectorizeLaneLocal` in [`src/optimize/vectorize/index.js`](src/optimize/vectorize/index.js)) lifts typed-array loops to WASM-SIMD. Every lowering is asked of the loop; each lift it makes passes the one legality (`legality.js`) and is costed by one measure read off its own code (`cost-model.js` passCost: the weighted ops of a pass of the loop). The cheapest is emitted; of two that cost the same, the smaller, and of two the same size the first asked. A lowering that takes nothing returns `null` — a `null` is fail-safe (the loop stays scalar), so **never emit code you can't prove equivalent to the scalar loop.**

Which loops lift is a table, `test/vector-coverage.json`: which of the alias battery's loops a lift takes, as a table that only grows. A kernel fails on any difference from its listing: a mark lost is a lift lost; a mark gained is a lift to list, `node test/vector-coverage.js --update`, after the review of its legality.

Discipline (non-negotiable — these run in the default `speed` build that ships to everyone):

- **Bit-exact.** Compile `{optimize:3}` vs `{optimize:3, noSimd:true}`, run N frames, compare output buffers byte-for-byte (0 diffs). **Seed RNG** (`randomSeed:K`) for any example using `Math.random` — two un-seeded instances diverge and look like a miscompile. Float reductions that reorder across lanes are ulp-divergent → gate at `optimize≥2`; per-lane maps/reductions reorder nothing and are exact.
- **Ratchet +0.** `npm run test:ratchet` must stay byte-identical — recognize only the intended shape; don't widen the default corpus path.
- **Run `npm run test:self`.** The dev suite runs on V8, but the self-compile build compiles JZ *with JZ*. `test:self` is the correctness round-trip; `npm run test:self:perf` is the warm/fresh self-compile speed gate (a local release step: it needs a quiet machine, so CI never times it). A recognizer can be bit-exact on V8 yet make `dist/jz.wasm` fail validation (`i64.reinterpret_f64 expected f64, found i32`) — **the V8 suite will not catch this.**
  - *Cause & fix:* a top-level **self-recursive** helper taking the `ctx` object as a param — JZ's signature narrowing can't prove the recursive call passes an i32 pointer, so it leaves that one function's `ctx` boxed (`f64`) while every other has `ctx:i32`, and callers emit a bad reinterpret. Define ctx-using *recursive* lifters as **nested `function` declarations that capture `ctx`** (take only `expr`/`stmt` args), like `scanForLoadsStores`. No `ctx` param ⇒ nothing to mis-narrow. Also: don't reassign a parameter (use a local).
  - *Debug:* `compile(<self.js source>, {optimize:false, wat:true})`, map the failing `function #N` to a name by counting `(func $…` in order, then dump its param types — the odd `ctx:f64` is the smoking gun.

## Testing

### Source cleanup

`npm run lint:imports` checks unused imports in the root JavaScript modules,
`src/`, `jzify/`, and `module/`. Run `npm run lint:imports:fix` to remove them.
The ESLint configuration enables only this rule, so it does not reformat code
or remove variables. Keep initialization-only dependencies as bare imports
(`import './register.js'`); the fixer preserves those.

`npm run audit:files` uses Knip to find unreachable source modules. Package
exports and the CLI are discovered from `package.json`; `knip.json` also roots
the standalone scripts, tests, examples, benchmarks, and browser assets that
use compiler internals. Fixtures, generated output, and standalone programs
are outside the source-file deletion scope. When adding a new external loader,
include its entry point before trusting the report.

Review reported files for string-based loading and documented use before
deleting them. After that review, `npm run audit:files -- --fix --fix-type files
--allow-remove-files` removes the reported files. Run the tests below after
cleanup; an unused binding alone does not prove its module has no side effects.

### Test suites

Tests use [tst](https://github.com/dy/tst). Choose the owner of the work you need:

| Command | Work |
| --- | --- |
| `npm test` | Core semantic/structural regressions, split over the idle cores into contiguous runs whose boundaries move with the commit (`JZ_TEST_SEED=<n>`, printed in the header, repeats them); **no bootstrap or generated population sweeps** |
| `JZ_TEST_JOBS=1 npm test` | The same in one process: the state a file leaves behind meets every later file (CI's weekly `one-process` workflow) |
| `npm test -- strings dyn-keys` | Named files, regardless of owner, in one process; keeps completed-test GC and warm compile-state checks |
| `npm test -- --costs` | The core suite on the current leg, each file timed: its CPU seconds, tests and assertions written to the leg's row of `test/native-costs.json`, by which a split run weighs its processes (`--suite=` picks another suite; named files print their times instead) |
| `npm run test:matrix` | Core default/O0/O3/WASI legs, one at a time |
| `npm run test:integration` | Libraries, tools, examples, site/package smoke for the current leg |
| `npm run test:generated` | Fuzz correctness, WAT populations, deterministic codegen ratchet for the current leg |
| `JZ_TEST_SAMPLE=4 npm run test:generated` | Every population at one program in 4, the same ones on every run (a fixed seed, which a sampled test's name prints); unset, the whole, as CI runs them. Under `npm test` the same switch samples the core's dearest sweeps: loop-forms' strips, missing-read, missing-arith |
| `npm run test:extended` | Integration matrix plus native/WASI generated owners |
| `npm run test:bootstrap` | Fresh self compiler: round-trip, O0/O2/O3 parity/oracles, separate checkpoint overlay |
| `npm run test:bootstrap -- --full` | Above, plus the full hosted suite and recursive compilation |
| `npm run test:bootstrap -- --hosted=<i>/<n>` | Slice i of n of the hosted suite alone, on a fresh compiler of its own: CI's matrix, the files packed by their seconds in `test/hosted-costs.json` |
| `npm run test:battery -- fast` | Core matrix with O3 armed (`JZ_DEBUG_INVARIANTS=1`) in place of plain O3: the same bytes, and the checks besides |
| `npm run test:battery` | Above, extended checks with integration's O3 armed too, armed fuzz, fixpoint, then exclusive full bootstrap |
| `npm run test:all` | Core + extended + conformance + benchmark + full bootstrap + self performance |

Before reporting a change, run what AGENTS.md ("Verify before claiming done") lists.

`node test/index.js --suite=all --list` lists every registered file without compiling. `--suite=core|integration|generated|bootstrap` selects an owner; `--suite=all` explicitly requests the old single-process collection (including heavy builds). `test/_suites.js` gives each file exactly one owner; `test/test-infrastructure.js` checks that the union is complete. CI runs the core and integration on all four legs (O3 plain, the path users ship), generated checks on native/WASI, each a job of its own, the core in one process weekly, and bootstrap in its own workflow.

`JZ_TEST_TIMEOUT` bounds an ordinary task in milliseconds (default one hour); bootstrap's round-trip, parity, checkpoint and recursive tasks have four hours each, a hosted file the ordinary hour, and bootstrap always runs alone in the battery. A test that must hold at several optimize levels writes `for (const optimize of levels(false, 2, 3))` (`test/_matrix.js`): each leg runs its own level ('size' and 'fast' go with 2, 'speed' with 3); the default leg also owns O1. `ownedLevels` divides the levels the same way over the JS legs and keeps the whole list on WASI and the hosted compiler, for a check whose answer can depend on the host. A literal list compiles every level on every leg; it is kept only where the assertions need the levels together. Do not split a pass-on/pass-off comparison that needs both results in the same assertion.

Shared helpers live in `test/util.js`: `run` (exports), `wat` (text),
`jzWat` (the text and the instance from one compile, and `fresh()` for an
instance an input), `oracle(src)` (the same program evaluated by Node), `agree`
(jz equals Node for one call; given a `jzWat` build it compiles nothing),
`funcWat` (one function's WAT), and `cases(rows)`, which compiles a
table of `[label, arrowSource, want, ...args]` rows as one module. A compile is
almost all of a test's cost, so a family of one-assertion programs belongs in one
`cases` table, not one compile per assertion, and a source whose text a test reads
and whose module it runs is one `jzWat`. Reuse compiled exports **within a
fixture** for its argument table, not through a global compiler cache (which
would hide state leaks). Keep population compilation inside test callbacks so
`TST_GREP` cannot accidentally run an entire corpus during imports.

A population (programs over a grid or from a seed, each answering what Node
answers) goes through `population()` in `test/_population.js`, which joins its
programs into modules and takes `JZ_TEST_SAMPLE`. A sweep that must keep a module
a program, or runs a loop of its own, takes the same switch through `sample(list,
label)`, its test's name through `sampled(name)`; programs written out by hand,
each a defect pinned, run whole.

To count and time real compiles, including duplicates:

```sh
JZ_HASHES=/tmp/strings.json node --import ./test/_hashes.mjs test/index.js strings
```

The recorder's `meta.calls` and per-key `measurements` complement its outcome
hashes; keys include effective host/optimization defaults. This is opt-in
instrumentation, not a production compilation cache.

Negative-parse acceptance is an exact path set, not a count ceiling: any change must update and explain `test/test262-neg-accepts.json`; residual entries are blockers/inventory, not language extensions.

### Debugging switches

Compiler lifecycle diagnostics live in `src/debug.js`. `JZ_DEBUG_INVARIANTS=1`
enables phase, representation and mutation checks for development. Source builds
use one flag; the browser and self-hosted release builds specialize it before
import analysis, removing the diagnostic code. These checks report compiler bugs,
not source-program warnings. Phase consumers read the owned context fields directly;
wrapping those fields in temporary objects adds no protection.

- `JZ_DEBUG_POISON=1` makes every restore, a frame's, an iteration's and the host's, overwrite what it frees: a pointer kept into freed memory reads all ones instead of what the block held until the next allocation. The suite and the audiojs atoms run under it as a check of the proof: every test of a computed value passes; the tests that pin the emitted shape or its size (the restore of a frame and of a loop, golden sizes, the loop ratchet, the kernel's byte parity) see the fill and differ.
- `JZ_DEBUG_COMPACT=1` takes every chance to compact: a loop walks at the next round that allocates past its last move, and the host walks at every outermost return, so a pointer a walk left stale shows where, compacting rarely, it would hide. `test/compact-stress.js` (the generated suite) runs the files that move memory under it, each in a process of its own; their assertions of answers hold as they are, and what is policy (how often a walk comes, how much memory a call keeps) is skipped under `stressed()` (`test/_matrix.js`). The suite runs a cut of them, its header naming what the cut leaves out; `JZ_STRESS_FULL=1 node test/index.js compact-stress` runs them whole.
- `JZ_DEBUG_ESC=1` makes every site tell the host which one it is, the flag before it and what the site itself lowered the flag to (`env.__esc_note(id, before, target)`, all ones where it lowered nothing: the site runs over a cleared flag, which then takes the lower of the two; the ids listed on stderr with their function, source line and node), to find what keeps a call's memory.
- `why: true` and any `warnings` callback report `shape-lost` with the first cause a layout was lost by; the census is the first thing to read when a library compiles dynamic.
- The internal `inspect` flag (`compile(source, { inspect: true })` through test/util.js) returns `{ wasm, inspect }`; `inspect.runtime` describes final Wasm exports, including reachable helpers. `noAllocation`, `noHostCalls` and `boundedWork` are `true` only when proved; `null` means unknown. `maxInstructions` is a conservative instruction-count upper bound, not a latency estimate.

## Performance & size invariant

The product's speed and size claims are stated in [AGENTS.md](AGENTS.md#performance-claims-the-bar-every-change-is-held-to) and held by two gates:

- `npm run test:claims` (`test/bench-claims.js` over `bench/claims.mjs` and the committed `bench/results.json`): on every case jz leads each claim class, or stays inside the band its `CLAIM_EXCEPTIONS` entry names and measures; `CLAIM_UNMET` names the cases it does not lead yet. Its bytes are the `optimize: 'size'` build against AssemblyScript's `asc -Oz --converge`. `bench.yml`'s reference run refreshes the dataset.
- `npm run test:bench` (`test/bench.js`): the per-case pins against V8 and AssemblyScript (`SPEED`), against `clang -O3` (`NATIVE`) and on bytes (`SIZE`, `SIZE_BUDGET`), and their geomean ceilings. *Live timing ratios are asserted off-CI only (local `npm run test:bench` on stable hardware); on CI they print informational because a shared 2-core runner reads identical builds up to 15× slower. Checksums, sizes, compile success, and the committed-evidence Porffor floor stay hard-gated on CI.*

The self-compile's own time is `npm run test:self:perf`, a local release step (above, under the vectorizer's discipline).

Run locally (needs `asc` and `wasm-opt` on PATH for the full picture; the
`porf-native` lane picks up a Porffor git checkout via `PORF_BIN`):

```sh
npm run test:bench   # the gate
npm run bench:size       # just the wasm-size table (jz vs AS -Oz, + wasm-opt slack)
npm run bench            # just the speed harness
```

**Ratchet, don't backslide.** `bench.js` carries per-case `win`/`tie`/`near`/`todo` claims (against each competitor and against native C) and geomean ceilings. When you make JZ beat a `todo` or close a `near` gap, promote it in the same commit; when you shrink codegen, tighten the geomean ceiling and the `SIZE_BUDGET` entry. A PR may not move any claim backward. If a change trades size for speed (or vice-versa) deliberately — e.g. the unrolled/vectorized hot kernels — say so in the commit and adjust the *size* budget, not the speed pin.

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

5. Until a reference run measures the case, list it in `PENDING_CASES` (`test/bench-claims.js`), or the claims gate fails on the missing evidence.

Prefer cases that mirror real JZ target workloads (numeric/DSP/parsing/wasm-utils) —
the corpus *is* the guarantee, so widen it toward the code you actually ship.

## Public contract and ABI

The public surface is deliberately small (README owns it): the root exports
`jz` (default, with `jz.memory`), `compile` and `instantiate`; the `jz/interop` subpath with
`instantiate` (instantiate.js over the interop.js runtime); the compile options in `index.d.ts`; and the
CLI flags in `jz --help`. Everything else is internal and may change without a
major version: `pool.js` (experimental SPMD worker pool, node only, not
exported), `setCompileTarget` in src/compiler.js (the test harness's compiler
switch) and `compileInProcess` in test/util.js (the in-process compiler for
tests that read analysis state).

The public options are a closed set: `normalizeOptions` (src/options.js) checks every key and value of `compile()`'s and `jz()`'s options before the pipeline runs, throws a `TypeError` naming any other key (with the public key a typo likely meant), and folds the `memory` and `optimize` objects onto the internal flags.

Advisories reach the `warnings` callback, one per site (the source offset when the node kept one, else the message): `heap-return`, `heap-loop`, `deopt-generic`, `deopt-dyn-read`, `deopt-dyn-write`, `deopt-method`, `deopt-prop-read` (how the read lowered and the receiver's candidate shapes), `class-generic` (a class kept as closures and why), `module-kept` (a CommonJS module of an esbuild bundle left a function, and why: jzify/link-cjs.js links the others at compile time), `shape-lost` (the first cause the summary lost an object layout by, with the function and statement), `host-global`, `jsstring-declined`; `simd-why-not` and `rewind-why-not` need `why`. Warnings are delivered after the pipeline returns, so a warning callback may compile again; a compile attempted while the pipeline is active is rejected.

### Semantics contract

Outside the dialect differences the README lists, accepted programs must preserve JavaScript values, exceptions, operand order and effects at every optimization level. Unsupported representations must reject. An unlisted silent wrong value or an accepted invalid-parse case blocks release. Early-error validation runs before lowering in both the JS and Wasm compiler; `test/test262-neg-accepts.json` gates the accepted-invalid ledger; an early error throws SyntaxError. Error classes are stable within a major; message text may change. A value a call throws reaches the host as JavaScript throws it: a value of the program as itself, its Error as the host's Error of its class (`jz:errcls`) with its message, a name it set and its other own properties, an error the runtime raises (err-codes.js, its code private) as the class and message its site models.

### Host memory contract

Strings use UTF-16 code units; UTF-8 belongs at encoding and I/O boundaries.
`memory.Object()` and `memory.write()` enforce compiled field kinds, typed
storage, nested schemas, integer refinements and discriminants used by lowering.
Incompatible replacements throw `TypeError`. Nullable fields admit their value
family and nullish values. Modules sharing memory must agree on existing schema
contracts and bind their schemas at the same ids: a pointer carries the id its
module compiled with, so a module whose schema would bind at another id in the
memory is rejected before it is instantiated: its tables are read from its
custom sections and merged on copies, committed whole once every id, brand
and field contract agrees, and the module's start function and data never
reach a memory that rejects it (one compilation, or the same module again,
shares; the host references of a memory are one table for every module in
it). A class layout carries its brand
(`jz:brand`, `Name#id`), so two classes with one field list are two schemas,
and a host object matching such a layout by keys alone is ambiguous rather
than silently bound. Booleans preserve their identity; exposed BigInt fields are tagged,
including shapes shared by BigInts and numbers. Returned object literals have
independent storage, so mutating one result cannot change a later result.

Plain arrays retained by the host have open element types. Typed arrays retain
their storage policy; fresh arrays can specialize while being constructed.
An indexed store through a host object's array-valued field commits the copied
container back to its captured owner. Reference staging retains that owner with
the receiver temporary; only the actual store performs the write-back, so a
short-circuited logical assignment or a thrown operand does not invoke a setter.
Native containers already share storage and require no write-back.
Allocations round upward to eight-byte alignment without signed address
truncation. Allocation may grow memory and invalidate views: retain handles and
reacquire views through `memory.read()`.

Array/object writes stage replacement values before committing contents and
length. If staging throws, the destination is unchanged; allocations remain
until reset and user getter effects are not rolled back. `memory.reset()`
invalidates handles allocated after the reset base. Owned memory retains
module-initialized state. Imported/shared memory resets the entire arena and
requires re-instantiation before calling the module again. Direct writes and
forged pointers bypass these checks.

### Experimental ABI

Every export the program does not declare is the module's ABI: `memory`,
`_initialize` (the init of a module that reaches the host from it or can throw
to it: `instantiate()` runs it and throws what it throws, as an export's throw;
an embedder calling it gets the transport, the value's bits in
`__jz_last_err_bits`) and the names
under `__jz_`: the allocator (`__jz_alloc`, `__jz_clear`, `__jz_heap`), the
closure table (`__jz_table`, which a `memory.fixed` module keeps to itself: its
proof bounds a closure call by the table's entries), the release and compaction handles, the async
boundary, a class's members, a kernel's kind variants. A program export never
takes `memory` or a `__jz_` name (`compile` rejects it at the export); its own
`_initialize` or `_start` is the WASI entry, after jz's init. `instantiate()`'s
`exports` holds the program's exports alone; the ABI stays on `instance.exports`.

A prebuilt module loads with the interop of the jz that built it; nothing marks or
checks the pairing. A box crosses as its i64 bits only: no f64 NaN-box carrier,
no `__ext_prop`/`__ext_call`.

The raw ABI is not frozen across versions: NaN-box layouts, the `__jz_` exports, `jz:hostabi`, `jz:i64exp`, `jz:schema`, `jz:fields`, `jz:errcls`, `jz:brand`, `jz:class`, `jz:values` and its getters, schema IDs, `jz:symbols` and `jz:symbol-slots` with the identity layout they decode, and the field contracts are all current-toolchain policy, regression-tested in `test/abi.js` but not cross-release-stable. Use `jz/interop`'s `instantiate()` or pin the exact compiler version when implementing a raw host. BigInt arguments require compiler-emitted slot evidence when the slot is used; unsupported slots throw `TypeError`. Kernel byte identity is not promised across releases. The runtime's other exports (`memory`, `wrap`, `coerce`, bit conversions, pointer/tag accessors, NaN constants, `toModule`, `codecOf`) serve index.js and the tests; `jz/interop` does not expose them.

### Known limitations

- DataView indexed own properties are unsupported; indexed writes reject.
  Unextended views have no `.length` or indexed elements.
- Used rest-parameter BigInt elements lack boundary evidence and reject.
- Array patterns share lazy pulls, undefined-only defaults and IteratorClose on
  early completion or binding errors. Native Map/Set views are snapshots.
  Indexed values cannot override their iterator.
- `ArrayBuffer.prototype.transfer`/`transferToFixedLength` and growable
  `SharedArrayBuffer` are unsupported. A resizable buffer reaches the host as a
  copy (resizable to the same maximum), and one the host passes in arrives as
  a fixed copy. A typed array out of bounds of its resizable buffer converts to
  an empty string (`String(view)`, `view.toString()`) where JavaScript throws a
  TypeError.
- Async generator functions work; async generator methods reject.

## Commits

Small, focused commits. Describe what and why, not how.

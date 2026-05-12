# Contributing to jz

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # 1466+ tests
node bench/bench.mjs  # run benchmarks
```

## Code layout

```
src/           compiler core (parse → prepare → compile → emit → optimize)
module/        stdlib modules (math, array, string, object, …)
test/          test files (tst framework)
bench/         benchmark corpus (one dir per case: .js + optional .as.ts/.c/.rs/…)
scripts/       bench harnesses (bench-size = wasm size, bench-compile = compile time)
```

## Architecture

Pipeline: `source → parse (subscript/jessie) → jzify (opt-in) → prepare → compile → optimize → watr (WAT→binary)`

All values are f64. Heap types use NaN-boxing (see README). Shared `ctx` object — see [`src/ctx.js`](src/ctx.js) for the lifecycle ownership table (which phase owns which subkey, writers, readers).

## State management

The global `ctx` object (defined in `src/ctx.js`) is the single source of compilation state. Each namespace (`ctx.core`, `ctx.module`, `ctx.func`, `ctx.types`, etc.) has a declared lifecycle phase and clear ownership. The docstring at the top of `src/ctx.js` contains the full ownership table — consult it before adding new state to understand which phase should own it.

## Adding a stdlib method

1. Find or create the module file in `module/` (e.g. `module/string.js`)
2. Register the handler on `ctx.core.emit` — see existing patterns in any module
3. Add tests in `test/`
4. Run `npm test`

## Principles

- **Don't optimize the compiler source itself.** Readability > cleverness in `src/`. The compiler doesn't need to be fast — the output does.
- **Valid jz = valid JS.** Any jz program must parse and run as standard JavaScript.
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

jz makes a load-bearing promise: **on the bench corpus, jz wasm is at least as
fast and at least as small as the alternatives.** Concretely, enforced by
`test/bench-pin.js` (run by CI on every push/PR — `.github/workflows/bench.yml`):

- **Speed** (`-O` speed-tuned build): jz median ≤ V8, AssemblyScript (`asc -O3`)
  and Porffor on every comparable case, and ≤ them on geomean.
- **Size** (`optimize: 'size'` build): jz wasm ≤ AssemblyScript (`asc -Oz --converge`)
  and ≤ Porffor on every comparable case, and ≤ them on geomean.
- **No codegen slack**: `wasm-opt -Oz` must not be able to meaningfully shrink
  jz's own output — anything it removes is a jz size bug.
- **Correctness floor**: `test/differential.js` fuzzes jz-compiled wasm against
  the same source run as plain JS — "smallest/fastest" never via a wrong answer.

Run locally (needs `asc`, `porf`, `wasm-opt` on PATH for the full picture):

```sh
npm run test:bench-pin   # the gate
npm run bench:size       # just the wasm-size table (jz vs AS -Oz vs porf, + wasm-opt slack)
npm run bench            # just the speed harness
```

**Ratchet, don't backslide.** `bench-pin.js` carries per-case `win`/`tie`/`todo`
claims and geomean ceilings. When you make jz beat a `todo`, promote it to
`win`/`tie` in the same PR; when you shrink codegen, tighten the relevant
geomean ceiling and the `wasm-opt` slack budget. A PR may not move any claim
backward. If a change trades size for speed (or vice-versa) deliberately — e.g.
the unrolled/vectorized hot kernels — say so in the commit and adjust the
*size* budget, not the speed pin.

### Adding a bench case

1. `mkdir bench/<name>/` and add `bench/<name>/<name>.js` — valid jz that
   `import`s `{ ... }` from `../_lib/benchlib.js`, exports `main`, and ends with
   `printResult(medianUs(samples), checksum, …)`. Use an existing case as a template.
2. For a fair size/speed comparison, add a self-contained `bench/<name>/<name>.as.ts`
   (AssemblyScript port — env imports `perfNow`/`logLine`, see `bench/bitwise/bitwise.as.ts`).
   Optional: `<name>.c` / `.rs` / `.go` / `.zig` for native baselines, `<name>.wat` for a hand-written reference.
3. Add the case to the `SPEED` and `SIZE` maps in `test/bench-pin.js` (claims
   default to `todo` / `na`), and a `SIZE_BUDGET` backstop.
4. `npm run bench -- --cases=<name>` and `npm run bench:size -- <name>` to see where it lands.

Prefer cases that mirror real jz target workloads (numeric/DSP/parsing/wasm-utils) —
the corpus *is* the guarantee, so widen it toward the code you actually ship.

## Commits

Small, focused commits. Describe what and why, not how.

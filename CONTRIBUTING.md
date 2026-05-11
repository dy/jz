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
bench/         benchmarks (9 cases, 15+ targets)
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

## Commits

Small, focused commits. Describe what and why, not how.

# AGENTS.md

Operational guide for AI agents working in this repo. Architecture, code layout, and
conventions live in [CONTRIBUTING.md](CONTRIBUTING.md) — read it first. This file is
only the things that bite automated edits.

## Verify before claiming done

- `npm test` — core suite (in-process compiler). Run it before reporting any change.
- `npm run test:matrix` — the full opt0/opt2/opt3/wasi matrix CI runs (legs are
  serial locally; CI parallelizes them).
- `npm run test:self` — self-host gate: builds `dist/jz.wasm` and round-trips real
  programs through the wasm-hosted compiler. Codegen changes can break the bootstrap.
- `npm run test:262` / `test:262:builtins` — conformance subset.

A test that **passes standalone but fails in the full suite** is almost always a
**compile-state leak** — global mutable state that isn't reset between `compile()`
calls (see [src/ctx.js](src/ctx.js)). Reproduce cold (`node -e "import…compile(src)"`)
vs warm (after other compiles) before assuming a logic bug.

## Never hand-edit generated artifacts

These are compiler/build output — edit the source, then regenerate:

| Artifact | Regenerate with | Source |
|---|---|---|
| `examples/**/*.wasm` | `npm run build:examples` | the example's `*.js` |
| `examples/thumbs/*.webp` | `node examples/gen-thumb.mjs <name>` | the example |
| `dist/jz.js`, `dist/interop.js` | `npm run build` | `index.js` / `interop.js` + `src/` |
| `bench/bench.svg`, `bench/results.json` | `npm run bench` | the bench corpus |

Codegen changes ripple into **example `.wasm` bytes**. CI gates this:
`git diff --exit-code -- examples/` after `build:examples` (jukebox beats excluded —
non-reproducible across Node versions). So rebuild examples and commit the new bytes
**with** the source change, or the gate fails.

## dist/ policy (don't "simplify" the .gitignore)

`.gitignore` deliberately whitelists `dist/jz.js` + `dist/interop.js` and ignores
the rest. Those two are committed because the **repl/playground import them from the
repo** (GitHub Pages serves the repo: [repl/index.html](repl/index.html),
[examples/playground/index.html](examples/playground/index.html)) and npm ships them.
`dist/jz.wasm` (4.5 MB self-host artifact) is gitignored — nothing serves it. The
`bench` workflow rebuilds and commits `dist/jz.{js,interop.js}` on push to `main`.

## Git

- Stage specific files by name. Never `git add -A` / `git add .`.
- Don't `push`/`pull` unless asked. Don't run repo-wide `checkout`/`reset`/`stash`/`clean`.
- Commit source and its regenerated artifacts together (see the drift gate above).

## Semantics check

Valid jz is valid JS — run the same source under Node and diff results to catch
miscompiles, minding the [documented divergences](README.md#faq) (f64 numbers, UTF-8
strings, no GC, etc.). `--wat` (or `compile(src, { wat: true })`) shows emitted WAT;
grep `v128` to confirm vectorization, `__dyn_get`/`__ext_call` for dynamic fallbacks.

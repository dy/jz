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

These build outputs are **gitignored, not committed** (see below). You never commit
`.wasm`/`dist` — just make sure they still *build*: CI runs `build:examples` as a
smoke test and `test:self` for the bundle. Edit source, not output.

## Build artifacts & deploy (no artifacts in git)

`dist/` and example `.wasm` are **gitignored build output**:

- **Local dev** — `npm install` runs `prepare`, which builds `dist/` (the repl needs
  only that). For examples, run `npm run build:examples` once. The repl/examples
  import these by relative path, so they must exist *on disk* — they do after a build,
  they're just untracked. A fresh clone needs a build before they run locally; nothing
  is served "from master."
- **Deploy** — `pages.yml` builds `dist/` + example wasm and uploads them alongside
  the tracked files as the Pages artifact. Pages Source = **GitHub Actions** (not a
  branch); URL unchanged (https://dy.github.io/jz/).
- **npm** — `prepare` builds `dist/` before pack, so the published tarball ships
  `dist/jz.js` + `dist/interop.js` (in `package.json` "files"). `dist/jz.wasm` is the
  self-host artifact — never served, never published.

`bench/results.json` + `bench/web/*.wasm` *are* committed (the `bench` workflow
produces them; the bench page reads them from the tracked files).

## Git

- Stage specific files by name. Never `git add -A` / `git add .`.
- Don't `push`/`pull` unless asked. Don't run repo-wide `checkout`/`reset`/`stash`/`clean`.
- Build artifacts (`dist/`, example `.wasm`) are gitignored — never commit them; CI
  and `prepare` build them. Commit source only.

## Semantics check

Valid jz is valid JS — run the same source under Node and diff results to catch
miscompiles, minding the [documented divergences](README.md#faq) (f64 numbers, UTF-8
strings, no GC, etc.). `--wat` (or `compile(src, { wat: true })`) shows emitted WAT;
grep `v128` to confirm vectorization, `__dyn_get`/`__ext_call` for dynamic fallbacks.

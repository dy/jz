# AGENTS.md

Operational guide for AI agents working in this repo. Architecture, code layout, and
conventions live in [CONTRIBUTING.md](docs/CONTRIBUTING.md) — read it first. This file is
only the things that bite automated edits.

## Performance claims (the bar every change is held to)

These are the product's promises. They are CI-gated (`test/bench.js`), not aspirations:

1. **Fastest wasm.** On every bench case, jz's wasm is the fastest among wasm producers —
   ahead of `clang→wasm`, `rustc→wasm`, `tinygo→wasm`, AssemblyScript, Porffor. Native
   `clang -O3` is the only thing allowed to be faster (and we aim within its parity band).
   A case where another *wasm* target wins is a bug to fix, tracked as `todo` in the gate
   until jz takes the lead — never silently accepted.
2. **Faster than any JIT.** jz beats V8 (Node), and any other JIT (JSC, SpiderMonkey) on
   the same source.

What this implies for HOW we optimize:

- **General techniques, never per-bench tweaks.** The other wasm producers win where they
  win because they have *general* passes (loop autovectorization, SLP, alias-based load
  CSE). To match them, each jz optimization must eradicate a whole CLASS of cases — phrase
  the fix as "any program shaped like X," prove it on a minimal kernel, and pin that kernel
  (not the bench). If a fix only helps one named bench, it's the wrong fix.
- **The compiler reasons; the source gives no hints.** jz must infer integer-ness, ranges,
  shapes and aliasing on its own. Do NOT make a kernel faster by editing its source (adding
  `|0`, splitting arrays, hoisting by hand). If a var needs a `|0` to narrow, the inference
  is too weak — fix the inference. Bench sources are fixed inputs, identical across targets.

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
| `assets/sprae.js` | `npm run build` | the `sprae` package (web asset for the landing, not compiler dist) |
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

`bench/results.json` (+ the geomean `bench/bench.svg`) *is* committed — measured
data the `bench` workflow refreshes. `bench/web/*.wasm` is **not**: like `dist/`
and the example wasm, it's build output that `pages.yml` rebuilds from source at
deploy (`node bench/bench.mjs --emit-web`) and serves from the Pages artifact.

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

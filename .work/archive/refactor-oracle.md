# Refactor oracle

`scripts/refactor-oracle.mjs` — the enabling tool for the pipeline-minimality
campaign (retiring hand-rolled AST walkers, consolidating `analyzeBody`
traversals, splitting outlier files/functions). It proves a refactor changed
**no compiled output**: same source in, byte-identical wasm out, across the
whole corpus the repo already owns, at every optimize level.

## What it proves

For every specimen in the corpus (bench cases, examples, `test/kernel-parity.js`'s
CORPUS, watr's own entry) at O0/O2/O3/size: `sha256(compile(src, {optimize}))`
is unchanged between two trees. If `check` reports clean, the refactor is a
pure internal restructuring as far as the compiler's OUTPUT is concerned —
every emitter decision, every optimizer fold, every mangled name, byte for
byte. A compile that used to fail and still fails with the same error class
also counts as "unchanged" (error hashes are compared too); a failure that
starts or stops happening is reported as a difference.

## What it cannot prove

- **Runtime behavior of host-nondeterministic paths.** `Math.random` without
  a fixed seed, host timers, WASI clock/env imports — these can be
  byte-identical at the wasm level and still observably differ when RUN.
  This oracle never instantiates or executes anything; it is a static
  compile-output proof only.
- **Correctness of either side.** Byte-identity certifies "didn't change,"
  not "was right." A refactor that reproduces an existing bug exactly is
  reported clean — that's by design (this is not a correctness oracle; see
  `test/kernel-oracle.js` / `test/kernel-parity.js` for that job).
- **Corpus drift.** If a refactor branch also edits `bench/`, `examples/`,
  or `test/kernel-parity.js`'s CORPUS, the two sides may not even be
  comparing the same specimens. `check` diffs by spec name, so an
  added/removed specimen shows up as a "before/after (missing)" difference
  rather than silently vanishing — but a specimen whose SOURCE changed on
  purpose will legitimately show a byte diff that has nothing to do with
  the compiler internals under test. Read the diff before treating it as a
  regression.
- **The self-host compile** (`bench/jz/jz.js`'s whole-compiler-through-itself
  graph) is excluded by default — see the script header for the timing that
  justifies this (68s at O0, 246s at O3, alone). `--full` opts it back in for
  a deliberate deep run; the default corpus (everything else) is the one
  meant to run on every refactor slice.

## The rule

A pipeline-minimality slice merges only with `check --ref main` clean, **or**
with every difference it reports listed and justified in the PR/commit
message — which specimen, which level, what changed, why it's expected
(e.g. "narrowed a dead branch in X; case Y's O3 output shrank by Z bytes,
semantics unchanged — see `diff` output").

## Usage

```
node scripts/refactor-oracle.mjs snapshot .work/oracle-baseline.json
node scripts/refactor-oracle.mjs check .work/oracle-baseline.json
node scripts/refactor-oracle.mjs check --ref main
node scripts/refactor-oracle.mjs diff .work/oracle-baseline.json bench:mandelbrot O3
```

Full option/command reference lives in the script's own header — that is
the canonical doc (this file is the campaign-level "why", not a duplicate
usage reference).

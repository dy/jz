# Phase 9b: a held-out lane, measured once on first contact

Part of `.work/architecture.md` (phase 9: "Claims: a held-out lane measured once on
first contact; a lane at exact JS semantics; relaxations opt-in", done when "README
states only what the lanes show"). 9a built the exact lane, the one option for the float
relaxations, the lane flags as one table and the docs' figures written from the dataset.
This step is the lane the corpus cannot give: programs jz was never tuned on, measured
the first time the compiler meets them, failures counted. Read the phase 9 scout's map
(`SCRATCH/scout-9/map.md`, section 3: why, the public sets, how `bench.mjs` takes a
case, what a first-contact record must hold) and the integration's notes on 9a.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## Why

Every case of the corpus was written to expose a gap or tuned class by class after it
was added. The scout's split of the reference run: against the best wasm rival the
third-party cases stand at 0.97 of the rival's time (behind on 9 of 22) where the rest
stand at 0.67; against V8 0.58 where the rest stand at 0.39. A reader who brings a
program of their own meets the first kind. The README's averages are of the second.

## The outcome

1. **The set is named before it is run and never read here.** A manifest in the repo
   (`bench/heldout/manifest.json` or as you name it): for each set its upstream
   repository, the commit, the licence as its own files state it, every program of the
   set (all of them: a program expected to fail is listed and counted, not left out),
   and how a program is run (its entry, its iteration arguments, how its result is
   checked). Take Are-we-fast-yet (smarr/are-we-fast-yet, MIT: 14 programs with a
   `verifyResult` each, written to compare languages) and one set of plain numeric
   programs with printed results (the Computer Language Benchmarks Game's JavaScript
   programs that need no stdin: nbody, spectral-norm, fannkuch-redux, mandelbrot;
   BSD-3). Pin commits by `gh api repos/<owner>/<repo>/commits/<branch> --jq .sha` and
   list files by the contents API (names and blob ids: metadata, a few KB). **Fetch no
   program to this machine and read none**: the owner is on a metered link, a download
   of external code was refused once in this session, and a driver written after
   reading a program's body is the tuning this lane exists to rule out. The driver is
   written from each set's documented interface (AWFY: `harness.js`, `benchmark.js`'s
   `Benchmark` with `benchmark()`, `verifyResult()`, `innerBenchmarkLoop()`; a program
   exports `newInstance`), and shaken out as below.
2. **A workflow that runs it, by hand only** (`workflow_dispatch`): fetches the pinned
   files (their sha256 recorded at first fetch and required after), generates each
   program's driver by script (`scripts/decode-cases.mjs` is the precedent: bundled by
   esbuild, nothing rewritten), and has two modes. `dry`: V8 alone runs every driver,
   jz is not built: this is where the harness is debugged, and it may run as often as
   needed, because no result of jz's is seen. `contact`: jz at `'speed'` and at the
   exact build beside V8, Deno, Bun, JSC and Porffor, each program's oracle V8's own
   result of the unmodified source (the `SOURCE_ORACLE` pattern of `bench.mjs`; the
   whole result compared, not a sample), in paired rounds as the claim lanes are.
3. **The record, append-only, written by the workflow alone** (`bench/heldout.json`):
   per program the set, commit, sha256, the compiler's commit, the run's id, date,
   machine and tool versions; a row for jz and for every lane, failures as rows (does
   not compile with the message's first line, traps, wrong result, timeout). An entry
   carries the hash of the one before it. A program measured again later is stored
   beside its first contact, marked as tuned, and never replaces it. A program leaves
   the held-out set the commit after its row is stored: say in the manifest's header
   that the lane needs new programs for each release that quotes it.
4. **The gate** (`test/bench-claims.js`, beside 9a's tests): the record's chain holds;
   each first-contact entry's compiler commit has no change to compiler source between
   it and the commit that added the program to the manifest (computed from git, not
   claimed); a figure a doc quotes for the lane is the record's, over every program of
   the set with the failures in the denominator (`scripts/bench-readme.mjs --check`
   knows how figures are marked). With no record yet, the gate says the lane is
   unmeasured and passes. What no test can hold, say in the manifest: that no one read
   or ran a program before it was registered is a rule the owner keeps.
5. **No prose of the owner's is written or reworded.** The figure is available to the
   docs script; where README or AGENTS.md should say it is the owner's decision, listed
   in your report as a proposal with the sentence's line.
6. **The stale facts of `bench/README.md` that are not prose claims are corrected from
   the dataset by the docs script**: the rivals' versions (Porffor alpha 19 where the
   dataset has 23, Bend 2.0.39 where it has 2.0.40), the count of pending cases (13,
   the text says 3), the gate's file (the text names `test/bench.js`; the release gate
   is `test/bench-claims.js`). The sentences the evidence contradicts (9a's list, in the
   integration's notes) stay as they are: they go to the owner.

## Testing it without the set

A fixture of your own in the set's shape (two or three small programs written by you to
the documented interface, one that fails to compile under jz on purpose, one whose
result is wrong on purpose under a stand-in lane) drives the generator, the runner, the
record and the gate locally. The real `dry` and `contact` runs are the integrator's,
after the landing: say exactly what to run (`gh workflow run … -f mode=dry`) and what a
first failure of each kind looks like in the log.

## The rules

- Nothing here changes what jz emits: bench bytes by hash at `size` and `speed` equal
  your base's (`SCRATCH/benchhash.mjs`, `bhcmp.mjs`; base rows `SCRATCH/bh-int.jsonl`).
- Yours: `bench/**`, `scripts/` files you add and `scripts/bench-readme.mjs`,
  `test/bench-claims.js`, `test/site.js`'s workflow pins, `.github/workflows/**`. Not
  yours: everything under `src/` and `module/` (two writers are in the optimizer).
- The existing claims, bands and exceptions are not widened, removed or renamed.
- Network: metadata calls to the GitHub API only. No `npm install`.

## Verify

`npm test -- bench-claims bench-shards site` and the files you touch as you build; once
at the end `npm test`, `npm run lint:imports && npm run audit:files`, `npm run
test:types`. Two other writers and a battery share the machine: `JZ_TEST_JOBS=4`.

## Working rules

Your worktree, `node_modules` symlinked; scratch under `SCRATCH/p9b/`; commits by class
with their tests, files staged by name, messages in the repo's voice with no agent or
tool named, no co-author line and no em-dash; never push, never a repo-wide git command
(`checkout`, `stash`, `reset`, `clean`, `switch`, `restore .`); a permission refusal is
an answer: say what was refused and go on.

## Report

Your model id first. What is not done or not verified, first. Then: the commits; the
manifest (sets, commits, programs, how each is run and checked); the workflow's two
modes and the commands for the integrator; the record's shape and the gate's tests,
each with the fixture case that fails it; the docs figures; the proposals for the
owner's text.

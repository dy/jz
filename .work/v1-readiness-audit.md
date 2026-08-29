# v1 readiness audit — 2026-08-28

Pinned at `a15ec98c` (2026-08-28T22:42:44-04:00, tip of the current merge queue —
`d7c7e67f` "kind-split.md: record the main-merge + final battery results" merged
in). Worktree: detached checkout, read-only against `/Users/div/projects/jz`;
`node_modules` symlinked from the main worktree (watr 5.9.3, subscript 10.7.1 —
match `package.json`'s `^5.9.3`/`^10.7.1`, so no `npm install` was run or needed).

**The bar** (owner, verbatim): produced size must ALWAYS be smaller than
AssemblyScript (×1 gate, per case); speed ALWAYS faster than every other WASM
toolchain (per case); jz must compile itself well. This document finds every
gap between that bar and what the repo currently enforces and achieves, with
evidence. Nothing here was fixed — audit only, per instructions.

All measurements below are from this session, on this machine (darwin/arm64,
Apple M4 Max, Node v25.9.0, 14 cores/36 GiB), run **once each** as instructed.
The machine was shared with other agents' batteries throughout (`load1` peaked
at 30+; a concurrent process at a sibling scratchpad was independently running
`JZ_TEST_TARGET=jz.wasm node test/index.js` while this audit ran) — no timing
number in this report should be read as a clean benchmark; every number that
matters here is a pass/fail, a byte count, or a count of test cases, not a
wall-clock ratio measured under contention.

---

## 1. CI truth table

Eight workflows. Every step that could run locally and wasn't excluded by the
task instructions (`bench/bench.mjs`, any multi-toolchain speed benchmark,
`test/bench-c.js`) was run once.

### `test.yml`

| job | step | command | ran? | result |
|---|---|---|---|---|
| `test` (default) | `npm test` | `node test/index.js` | **RAN** — full `TESTS` list minus `bench-c` (94/95 files; `bench-c.js` builds a native binary under AddressSanitizer, whose own header comment documents ASan runtimes that "busy-loop without ever reaching main" on some hosts — excluded per task instruction, not run) | **PASS** — see full tally below |
| `test` (opt0) | `npm run test:opt0` | `JZ_TEST_OPTIMIZE=0 node test/index.js` | not run | Same 95-file suite at a different optimize tier — identical code path to the default leg, ~10 more minutes for a second full pass. Not independently re-run this session; last-known-green from `.work/handoff-2026-08-22.md`'s 2026-08-26 entry: `matrix default/O0/O3 3660/3659/0/1`. No fresh confirmation at `a15ec98c`. |
| `test` (opt3) | `npm run test:opt3` | `JZ_TEST_OPTIMIZE=3 node test/index.js` | not run | Same caveat as opt0. |
| `test` (wasi) | `npm run test:wasi` | `JZ_TEST_HOST=wasi node test/index.js` | not run | Same caveat as opt0. |
| `test` (default) | `npm run build:examples` | — | not run | Smoke-only (examples still compile); low audit value, redundant with the `npm run build` success below. |
| `test` (default) | `npm run test:types` | `tsc test/public-types.ts --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM --skipLibCheck false` | **RAN** | **PASS** — zero diagnostics, exit 0. |
| `fuzz` | — | `JZ_DEBUG_INVARIANTS=1 npm run test:fuzz` (`test/fuzz.js --count=5000`) | not run | The in-suite `fuzz` test (200 seeds) is already covered by the default `node test/index.js` run above (`TESTS` includes `'fuzz'`); the CI-only 5000-seed extension is the same differential oracle at higher volume. Not independently re-run — diminishing marginal evidence for the time cost. |
| `claims` | — | `node test/bench-claims.js` | **RAN** | **FAIL** — exit 1, 9/19 test groups red (53 assertions: 9 pass, 9 fail, 1 skip). Full detail in §2 and §5. This is the job that turns the owner's per-case bar into an actual CI gate, and it is red at HEAD. |

**test.yml verdict: CI is red today**, driven entirely by the `claims` job. `test`
(default) and `test:types` are clean.

### `bench.yml`

| job | step | ran? | what it checks / result |
|---|---|---|---|
| `bench` | toolchain installs (zig, deno, bun, jsc, numpy, GNU time, wasmtime, tinygo, rust wasm target, `asc`+binaryen, Porffor pinned clone) | not run | Infra only. |
| `bench` | `npm run test:bench` (`node test/bench.js`) | **excluded per task instructions** | Runs the full 60-case corpus across every installed toolchain. Hard-gated on CI: checksums, parity, wasm sizes, compile success (per rival — `test/bench.js:590-611`). Timing ratios are **informational only on CI** (`okTiming`, `test/bench.js:146-148`, because "a shared 2-core runner reads identical builds up to 15× slower"). Evaluated instead from committed evidence — see §2. |
| `bench` | native-lane smoke (`jz-w2c`/`jz-w2c2`, wasm2c/w2c2 install + 3-case checksum verify) | not run | Same exclusion (invokes `bench.mjs`); toolchain-install heavy, secondary regression net for the native-lowering lane, not central to the v1 bar. |
| `bench` | `publish bench snapshot` (push-to-main only) | N/A | Not applicable outside a push-to-main; observed as a side fact: `bench/results-ci.json` (the CI/EPYC secondary dataset this step writes) is dated **2026-07-25**, commit `d2a0589`, Porffor **pre-alpha 1** — over a month and one full Porffor generation stale relative to `bench/results.json`'s 2026-08-27/`4c38662f`/alpha-3. This dataset is informational-only per `bench/README.md` and gates nothing, but it shows the publish leg hasn't produced a fresh secondary reading in a long time. |

**bench.yml verdict**: cannot be fully evaluated live (by design, per task scope);
the part that matters for the owner's bar (per-case leadership) is reconstructed
in §2 from the exact same committed evidence this job would read.

### `self-compile.yml`

| step | command | ran? | result |
|---|---|---|---|
| `build dist/jz.wasm` | `npm run build` | **RAN**, wrapped in `/usr/bin/time -l` | **PASS**, exit 0. **314.29 s real** (345.79 s user, 2.54 s sys), **4,212,146,176 B (4.212 GiB) maximum resident set size**. `dist/jz.wasm` = **17,481.3 kB**. `dist/jz.js` 2,261.7 kB, `dist/interop.js` 30.1 kB, `assets/sprae.js` 19.0 kB. wat-strip parity: 3/3 probes byte-identical. |
| `self-compile round-trip` | `npm run test:self` | not run | `test/self-compile.js`'s own `ensureSelf()` (`test/self-compile.js:26-34`) reuses `dist/jz.wasm` if present — after the build above this would be a fast round-trip, not a rebuild — but was not independently run this session; not needed to establish the section-3 facts, which come from the build above plus the cited 162-module self-host probe. |
| `full suite via dist/jz.wasm` | `JZ_FUZZ_GATE=0.15 npm run test:wasm` | not run | This re-runs virtually the entire `TESTS` list (minus `KERNEL_EXCLUDE`, `test/index.js:142-163`) with every `compile()` call routed through the wasm-hosted kernel instead of the native compiler — the heaviest non-excluded step in any workflow. A concurrent process from another agent on this same machine was already running exactly this command (`JZ_TEST_TARGET=jz.wasm node test/index.js`, observed live in `ps aux`) for the duration of this audit. Not duplicated. Evaluated instead from `kernel-parity`/`kernel-oracle` (run natively as part of the default suite above) plus the dated figures in `.work/handoff-2026-08-22.md` (e.g. "Full test:wasm: 2892/2890/0/2", 2026-08-22 baseline) — cited as history, not confirmed fresh at `a15ec98c`. |

**self-compile.yml verdict**: the one step that matters most for "compiles
itself well" — the actual build — **passes** and reproduces the campaign's own
cited profile almost exactly (§3). The full in-kernel suite gate was not
independently re-verified this session.

### `test262.yml`

| job | command | ran? | result |
|---|---|---|---|
| `test262-language` | `npm run test:262` | **RAN** (cloned the pinned corpus `b363f29d` fresh — network reachable) | **PASS** — `Pass: 2976, Fail: 0, Xfail: 21, Neg-reject: 3908, Neg-accept: 137`. Exit 0. Matches `test/test262-baseline.json` (`language: 2976`, `negAcceptExact: 137`) and `STABILITY.md:27` exactly — no drift. |
| `test262-builtins` | `npm run test:262:builtins` | **RAN** | **PASS** — `Pass: 858, Fail: 0, Xfail: 70`. Exit 0. Matches the baseline's `builtins: 858` exactly. |

**test262.yml verdict: green, confirmed fresh at `a15ec98c`.** Both floors hold
with zero drift from the committed lock. (Note for §4: the baseline's own
`_comment` records that `language` dropped 3003→2976 on 2026-08-27 when a
silent-wrong-value fallback was closed — most of the "3003" figures scattered
through `.work/handoff-2026-08-22.md` and `.work/v1-architecture-campaign.md`
predate that fix and are stale; 2976 is the current, live-confirmed floor.)

### `watr.yml`

Not run. Clones a second repo (`dy/watr`, recursive submodules), `npm link`s it
bidirectionally against HEAD jz, builds `watr.wasm` with HEAD jz, then runs
watr's own suite against it. Its own header comment scopes it as "a downstream
integration signal, not a unit gate" and "kept as its own workflow (slow)".
Out of proportion to the marginal v1-gap evidence it would add over the
already-extensive native/kernel correctness evidence gathered elsewhere in this
audit; evaluated from the workflow definition only.

### `bench-probe.yml`

Not a gate — `workflow_dispatch`-only, its own comment says "not a gate, writes
nothing." No action needed.

### `release.yml`

Fires only on a published GitHub release (`build dist/jz.wasm` + `gh release
upload`). Mechanically identical to the `npm run build` step already verified
PASS above; `gh release upload` not exercised (nothing to attach to, and cutting
a release is out of scope for a read-only audit).

### `pages.yml`

Its gate step is `npm test` (subsumed by the default-suite run above, which
includes `web-smoke` from `TESTS`). The remaining steps build+deploy the
GitHub Pages site — infrastructure, not a correctness or performance gate; not
run (no Pages target locally).

### Default suite tally (`node test/index.js`, 94/95 files)

```
# total 3858 (28503 assertions)
# pass 3857
# skip 1
EXIT=0
```

**Clean pass, zero failures**, ~11 minutes wall (contended machine, see header).
The one skip is an explicitly-marked `test.todo` (🚧), not a silent gap:
"spread: rest-param spread through export-only unknown callee." This is the
strongest single piece of evidence in this audit *for* v1 readiness — the core
correctness suite, run fresh at `a15ec98c`, is fully green.

---

## 2. Per-case WASM leadership table

**Evidence freshness, by the gate's own rule.** `bench/results.json` meta:
`commit: "4c38662f"`, `date: "2026-08-27 17:09 UTC"`, `partial: true`. Per
`test/bench-claims.js:145-183` (`claims: reference evidence is fresh…`), the
gate itself says **STALE**: 57 JZ rows predate **221** compiler-source commits
(touching `SOURCE_SCOPE` — `src`, `module`, `jzify`, `index.js`, `interop.js`,
`layout.js`, `package.json`, `package-lock.json`, `test/bench-claims.js:93`)
that have landed between `4c38662f` and `a15ec98c`. This is not my judgment —
it is the project's own freshness test, run live, saying its own reference
dataset is out of date.

**Live re-run of the gate** (`node test/bench-claims.js`, evidence-only — no
live benchmarking, exactly as instructed):

```
# total 19 (53 assertions)
# pass 9
# fail 9
# skip 1
```

Failing groups:
1. **Freshness** — STALE (221 commits, above).
2. **VALIDITY** — committed evidence's `machineState.swapUsedMB=4199.75` exceeds
   the 4096 MB sane bound (`test/bench-claims.js:212-222`) — the M4 reference
   run that produced `bench/results.json` was itself under swap pressure.
3. **Memory evidence stale** — `.work/memcheck-results.csv` is 573
   compiler-source commits behind.
4. **Strict wasm-rival leadership** — unproven on **22/60** cases.
5. **No-red-cases (1.05× band) wasm rival** — **13/60** cases exceed even the
   loose band (genuine losses, not jitter): `base64` 1.145×(tinygo), `crc32`
   1.076×(c-wasm), `delayline` 1.124×(rust-wasm), `fft` 1.095×(rust-wasm),
   `glyfparse` 1.169×(c-wasm), `lorenz` 1.096×(as), `radixsort` 1.054×(zig-wasm),
   `sdf` 1.293×(c-wasm), `shapes` 1.431×(as), `slices` 1.067×(c-wasm), `sort`
   1.209×(zig-wasm), `trace` 1.562×(c-wasm), `vm` 1.052×(rust-wasm).
6. **Strict V8-family leadership** — unproven on 7/60 cases.
7. **No-red V8-family** — **3 real losses to raw V8/deno beyond the band**:
   `jessie` 1.641×(v8), `resample` 1.073×(v8), `watr` 1.291×(v8).
8. **Strict bun/jsc leadership** — unproven on 9/60 cases.
9. **No-red bun/jsc** — 7 cases exceed band: `jessie` 2.043×(bun), `lorenz`
   1.063×(jsc), `resample` 1.087×(jsc), `sdf` 1.146×(jsc), `sort` 1.056×(jsc),
   `synth` 1.156×(bun), `watr` 1.148×(bun).

Passing groups worth naming: the **Porffor floor is fully green** — 43/43
comparable rows, JZ leads every one on speed and size, geomeans 21.722×/63.865×
in JZ's favor (`test/bench-claims.js:312-328`) — but per its own header comment
this snapshot is explicitly **not release-certified** (freshness + VALIDITY
above apply to it too). The **size geomean vs AS** also passes: 1.042× ≤ the
1.05× par band (`test/bench-claims.js:394-406`) — but read the fine print in
§5: only **25/49 (51%)** cases are actually smaller than AS; the gate passes
because it is scoped to geomean, not because most cases win.

### Full per-case table (60 cases in `bench/results.json`, non-lab + lab)

`jz bytes` / `AS bytes` are the **speed-preset** build's bytes (`optimize:
'speed'`, what `bench.mjs`'s size column records for the speed run); best-rival
is the fastest of `{c-wasm, rust-wasm, go-wasm, tinygo, zig-wasm, as}` with a
matching checksum.

| case | jz B | AS B | jz/AS | jz ms | best wasm rival | ratio | verdict |
|---|---:|---:|---:|---:|---|---:|---|
| alpha | 1113 | 1271 | 0.876 | 0.167 | zig-wasm 0.878 | 0.190 | strict |
| aos | 1972 | 1957 | 1.008 | 0.684 | as 1.371 | 0.499 | strict |
| base64 | 1701 | 1924 | 0.884 | 3.618 | tinygo 3.161 | 1.145 | **RED** |
| bezfit | 3624 | 3017 | 1.201 | 0.831 | rust-wasm 0.839 | 0.990 | strict |
| biquad | 1858 | 1830 | 1.015 | 4.735 | zig-wasm 4.640 | 1.020 | band |
| bitwise | 1100 | 1319 | 0.834 | 0.951 | zig-wasm 5.690 | 0.167 | strict |
| blur | 1538 | 1724 | 0.892 | 0.889 | tinygo 3.310 | 0.269 | strict |
| bytebeat | 995 | 1164 | 0.855 | 1.563 | c-wasm 2.812 | 0.556 | strict |
| callback | 1669 | 1814 | 0.920 | 0.351 | zig-wasm 0.388 | 0.905 | strict |
| colorconv | 2459 | — | — | 32.574 | — | — | no wasm rival |
| colorlch | 2969 | — | — | 62.648 | — | — | no wasm rival |
| conv2d | 1535 | 1696 | 0.905 | 1.317 | rust-wasm 2.510 | 0.525 | strict |
| crc32 | 1124 | 1359 | 0.827 | 8.797 | c-wasm 8.174 | 1.076 | **RED** |
| delayline | 1656 | 1470 | 1.127 | 0.679 | rust-wasm 0.604 | 1.124 | **RED** |
| deltae | 3650 | — | — | 44.371 | — | — | no wasm rival |
| dict | 1330 | 1467 | 0.907 | 1.957 | as 2.344 | 0.835 | strict |
| dispatch | 1813 | 1614 | 1.123 | 1.845 | zig-wasm 11.000 | 0.168 | strict |
| dotprod | 1069 | 1177 | 0.908 | 0.152 | tinygo 1.988 | 0.076 | strict |
| fft | 2384 | 1758 | 1.356 | 1.057 | rust-wasm 0.965 | 1.095 | **RED** |
| fftplan | 30763 | — | — | 1.854 | — | — | no wasm rival |
| glyfparse | 3082 | 2408 | 1.280 | 3.370 | c-wasm 2.883 | 1.169 | **RED** |
| hash | 1151 | 1367 | 0.842 | 3.830 | as 3.790 | 1.011 | band |
| hashjoin | 1495 | 1561 | 0.958 | 6.014 | as 7.368 | 0.816 | strict |
| heat | 1445 | 1364 | 1.059 | 2.210 | as 8.158 | 0.271 | strict |
| immutable | 1851 | 1481 | 1.250 | 0.156 | c-wasm 0.308 | 0.506 | strict |
| jessie | 80770 | — | — | 2.110 | — | — | no wasm rival (V8 loss, see below) |
| json | 8117 | — | — | 0.133 | c-wasm 0.250 | 0.532 | strict |
| levenshtein | 1358 | 1564 | 0.868 | 1.775 | as 1.918 | 0.925 | strict |
| lorenz | 1543 | 1571 | 0.982 | 14.168 | as 12.931 | 1.096 | **RED** |
| lz | 2126 | 1910 | 1.113 | 11.516 | zig-wasm 11.002 | 1.047 | band |
| mandelbrot | 1121 | 1301 | 0.862 | 4.833 | as 8.426 | 0.574 | strict |
| mat4 | 1522 | 1456 | 1.045 | 0.775 | rust-wasm 1.178 | 0.658 | strict |
| matmul | 1384 | 1285 | 1.077 | 1.883 | as 8.399 | 0.224 | strict |
| nbody | 2205 | 2174 | 1.014 | 9.186 | as 12.874 | 0.714 | strict |
| noise | 2168 | 1868 | 1.161 | 1.303 | rust-wasm 1.466 | 0.889 | strict |
| nqueens | 1167 | 1410 | 0.828 | 2.807 | c-wasm 2.780 | 1.010 | band |
| particle | 1609 | 1549 | 1.039 | 6.980 | c-wasm 31.842 | 0.219 | strict |
| poly | 1096 | 1291 | 0.849 | 0.139 | as 0.831 | 0.167 | strict |
| provenance | 30172 | — | — | 1.406 | — | — | no wasm rival |
| qoi | 2796 | 3012 | 0.928 | 8.509 | rust-wasm 8.599 | 0.990 | strict |
| radixsort | 1424 | 1557 | 0.915 | 2.395 | zig-wasm 2.273 | 1.054 | **RED** |
| raytrace | 2242 | 2007 | 1.117 | 1.107 | rust-wasm 1.062 | 1.042 | band |
| resample | 1933 | 1463 | 1.321 | 1.367 | c-wasm 1.433 | 0.954 | strict (wasm); V8/JSC loss below |
| sdf | 2737 | 2209 | 1.239 | 6.688 | c-wasm 5.171 | 1.293 | **RED** |
| shapes | 3023 | 1695 | 1.783 | 1.550 | as 1.083 | 1.431 | **RED** |
| sieve | 1090 | 1261 | 0.864 | 5.184 | rust-wasm 5.183 | 1.000 | band |
| slices | 2146 | 1657 | 1.295 | 2.948 | c-wasm 2.762 | 1.067 | **RED** |
| sort | 1667 | 1889 | 0.882 | 6.271 | zig-wasm 5.187 | 1.209 | **RED** |
| spmv | 1935 | 1897 | 1.020 | 2.399 | as 2.389 | 1.004 | band |
| strbuild | 1911 | 2480 | 0.771 | 0.383 | zig-wasm 0.416 | 0.921 | strict |
| synth | 1895 | 1797 | 1.055 | 2.558 | as 2.471 | 1.035 | band (V8/bun loss below) |
| tokenizer | 2094 | 1551 | 1.350 | 0.046 | as 0.062 | 0.742 | strict |
| trace | 1908 | 2013 | 0.948 | 1.023 | c-wasm 0.655 | 1.562 | **RED** |
| vm | 1531 | 1694 | 0.904 | 6.374 | rust-wasm 6.058 | 1.052 | **RED** |
| watr | 290999 | — | — | 1.117 | — | — | no wasm rival (V8/bun/jsc loss below) |
| wav | 1655 | 1751 | 0.945 | 5.754 | rust-wasm 5.749 | 1.001 | band |
| wordcount | 16372 | 3480 | **4.705** | 0.742 | c-wasm 0.780 | 0.951 | strict (speed); size far red |

**Geomeans** (computed live from `bench/results.json`, cross-checked against
`test/bench-claims.js`'s own numbers — they agree):

- **Size, jz/AS**: N=49 comparable cases, **geomean 1.042×**, **25/49 (51%) strictly smaller**.
- **Speed, jz/best-wasm-rival**: N=50 comparable cases, **geomean 0.688×**, **28/50 (56%) strictly faster**, 37/50 within the 1.05× band, **13/50 (26%) genuinely red** (listed above).

**Fresh reproduction of the size numbers** (`node scripts/bench-size.mjs --json`,
run live at `a15ec98c` — cheap, deterministic, no external network): **geomean
1.0418×, 25/49 smaller** — numerically indistinguishable from the stale
committed figure. The staleness flagged above does not appear to be hiding a
different size verdict; the per-case reality (about half the corpus is larger
than AS) holds under a fresh measurement too. Largest fresh misses: `wordcount`
4.705×, `shapes` 1.783×, `tokenizer` 1.350×, `fft` 1.356×, `resample` 1.321×,
`slices` 1.295×, `immutable` 1.250×, `sdf` 1.239×, `glyfparse` 1.280×, `bezfit`
1.201×.

### Which gate enforces the owner's two literal bars?

**"Smaller than AS, ×1, per case" — no gate enforces this.** Three
progressively weaker layers exist, and none of them is the owner's bar:

1. `bench/README.md`'s own text: "JZ holds a par-or-smaller **geomean** band
   (≤1.05×)" (`bench/README.md:208-211`) — already geomean, not per-case.
2. `CONTRIBUTING.md:149-151` ("Performance & size invariant"): "JZ wasm ≤
   AssemblyScript... on every comparable case, **and** on geomean" — this
   *documents* a per-case promise, but uses **≤** (ties allowed), not the
   owner's strict **<**.
3. The actual enforced code doesn't even reach layer 2's promise:
   `test/bench.js`'s `SIZE` object (`test/bench.js:190-261`) marks most cases
   `'todo'` — **printed, never asserted** (`test/bench.js:706-723` only asserts
   cases with a `SIZE_TOL` entry, i.e. `'win'`/`'tie'`). Of the SIZE table's
   ~30 curated cases, 16 are `todo`: `slices, trace, bezfit, sdf, resample,
   delayline, glyfparse, mat4, biquad, tokenizer, fft, synth, blur, lz, qoi,
   hashjoin`. The only universally-applied, always-hard-gated (even on CI —
   `test/bench-claims.js` has no `okTiming` carve-out) size check across the
   *whole* corpus is the **geomean ≤ 1.05×** (`test/bench.js:728-730`,
   `test/bench-claims.js:394-406`, the latter's own name for itself: "par-or-
   smaller... **not strict-smaller**"). **This is the textbook washed-out
   requirement the owner is describing**: it was never even documented as
   strict, and the actually-enforced version is weaker still than what is
   documented.

**"Faster than every wasm rival, ×1 (strict), per case" — a real gate exists,
and it is currently red.** `test/bench-claims.js:355-372` (`strictTest`/
`bandTest`) is the honest version: hard-gated unconditionally (no CI
carve-out), requires ratio < 1.0 for every case against `CLAIM_RIVALS`. Run
live today, it fails on 22/60 (unproven-strict) and 13/60 (red-beyond-band).
The **weaker sibling** in `test/bench.js:548-613` ("Assertions: jz is the
fastest WASM, per case") covers the same full corpus but is wrapped in
`okTiming` (`test/bench.js:146-148`), so **on CI it never fails the build** —
it only prints. So: the strict per-case bar the owner wants is *specified*
faithfully in one file (`bench-claims.js`) and *softened to informational* in
the file that actually runs on every push (`bench.js`, inside the excluded-
from-this-audit `bench.yml`). The `claims` job in `test.yml` is what makes the
strict version bite on CI — and it is red today (§1).

**"jz must compile itself well"** — see §3; no gate of any kind currently
requires the literal claim (jz recursively compiling itself) to succeed.

---

## 3. Self-compilation

**Hosted native build — measured live, once, this session:**

```
npm run build
  wrote dist/jz.js       2261.7 kB
  wat-strip parity: 3 probes byte-identical
  wrote dist/interop.js  30.1 kB
  wrote assets/sprae.js  19.0 kB
  wrote dist/jz.wasm     17481.3 kB
314.29 real   345.79 user   2.54 sys
4,212,146,176  maximum resident set size   (4.212 GiB)
exit 0
```

Cross-check against `.work/porffor-alpha3-audit.md:19` (2026-08-27, JZ ref
`4c38662f`, 221 commits behind this run): **344.02 s baseline / 348.42 s
profiled, 4.33–4.34 GB peak**. My independent rerun today is faster (314 s) and
slightly lighter (4.21 GiB) — same order of magnitude, no regression, the
profile is stable across 221 intervening commits.

**Kernel size** over the campaign (all same lineage, `dist/jz.wasm`):
16,963.2 kB (final certification, older) → 17,258.9 kB (Slice 5) → 17,732.2 kB
(Slice 6, region-disabled) → **17,481.3 kB (today, `a15ec98c`)**. Not
monotonic — it has moved in both directions across correctness-driven work in
the 17.0–17.7 MB band, consistent with "correct-or-reject" landings adding
union-materialization bytes (e.g. the `watr` SIZE_BUDGET comment in
`test/bench.js:296-304` documents +25.8 kB from exactly this class of fix).

**The recursive goal — jz compiling itself, in-wasm (NOT run, per instructions;
cited from `.work/porffor-alpha3-audit.md:20-26`, 2026-08-27, JZ ref
`4c38662f`):**

```json
{"modules":162,"outcome":"trap","error":"unreachable","outputBytes":0,"memoryBytes":4294967296,"heap":-32,"wallMs":11448}
```

Traps at exactly the wasm32 4 GiB address-space ceiling, ~10.5–11.4 s in, every
time it has been measured across the campaign (the negative heap byte offset
moves slightly — -80, -32, -24, -16 — across different `.work/` entries as
work landed, but the wall is always the same 2^32-byte ceiling). **JZ has no
successful self-compilation time, ever, at any point in the cited history.**
`STABILITY.md:99-107` — the section literally titled "Remaining v1 release
gate," the *only* item under that heading — states this plainly: "V1 requires
this run to produce bytes below that ceiling." `CONTRIBUTING.md:158-163` adds
a second clause the codebase hasn't even started measuring against: once the
trap closes, JZ must *also* "match or beat the pinned Porffor self-host on
same-machine wall time and peak memory" — i.e., closing the trap is only half
of the project's own stated bar for this item.

**Same-machine comparison to Porffor's self-host** (non-recursive, since
Porffor's target isn't wasm — `.work/porffor-alpha3-audit.md:9-33`): Porffor
selfhost→C: 1.94–1.95 s / 251 MB peak. Porffor selfhost→**native** (full C
compile too): 203.77 s / 1.89 GB peak. **JZ's one-level hosted build (not even
the recursive claim) is already ~1.5–1.7× slower and ~2.2–2.3× heavier than
Porffor's complete native self-build**, and JZ has no recursive result to
compare at all. The audit document attributes ~87% of JZ's 348 s to work
*after* the semantic module is already built — `watOptimize` 119.25 s (34.2%),
`snapshotInit` 100.40 s (28.8%), final `watrCompile` 82.25 s (23.6%) — and
ranks eight concrete architectural gaps (compact/fixed-shape IR, demand-driven
codegen, precompiled/lazily-decoded stdlib, linked selfhost modules, scoped
temp reuse, direct-ABI specialization, compiler PGO, a reclaiming compiler
runtime) against Porffor's actual implementation, with exact source citations.

**Kernel correctness** (native-vs-kernel checks, run as part of the default
suite in §1 — `kernel-parity` proves byte-identical WAT between the native and
kernel-hosted pipelines on a fixed corpus at O0/O2/O3; `kernel-oracle` adds
three-way execution parity — host JS vs native-compiled vs kernel-compiled —
against a JS oracle, with an explicit `PENDING-FIX` tier for currently-known
native/kernel-vs-JS-oracle divergences, per `test/kernel-oracle.js`'s own
header). Historical citation (2026-08-26, `.work/handoff-2026-08-22.md`):
kernel-parity 33/33 byte-identical rows, kernel-oracle 14/14 (605 assertions).
This session's own default-suite run exercises both files natively; see §1's
tally for the live pass/fail count.

**Verdict: "compiles itself well" is not met, and — separately — it is not
gated at all.** `self-compile.yml` requires `npm run build` to succeed (it
does) and `npm run test:self`/`npm run test:wasm` to pass (the kernel
compiling *other, smaller* programs correctly) — a materially weaker claim
than "jz compiles itself." No CI job anywhere runs the 162-module recursive
jz×jz probe; it exists only as a hand-run diagnostic tracked in `.work/`
documents. So the literal bar has no enforcement surface at all today, on top
of currently failing every time it has been attempted.

---

## 4. Correctness contract vs reality

**The contract** (`STABILITY.md:19-22`): outside the enumerated dialect
differences, "an accepted program must preserve JavaScript's answers...
Where the compiler cannot do so, it must reject rather than silently choose a
representation or value. Any unlisted silent wrong value is release-blocking."

**`KNOWN-WRONG` pins** (`grep -rn "KNOWN-WRONG" test/ src/ module/`): 10 hits,
9 in `test/data.js` + `test/inference.js`, 1 in a `src/ir/bigint.js` comment.
Reading each in context: the large majority are *historical* — "was
KNOWN-WRONG," "FIXED (was KNOWN-WRONG...)," "used to be KNOWN-WRONG" — kept as
regression-pin commentary after the bug closed. **Exactly one family is
currently open**, and it is a live, passing test:

> `test/data.js:2452` — `test('bigint: shape #9 sibling — index-resolved
> `.`-member callee (KNOWN-WRONG, separate residual)', ...)` — asserts
> `is(typeof e.f(), 'number', ...)` (`test/data.js:2504`) for a source whose
> real-JS answer is a BigInt (`n >>= 7n; return n`, reached through
> `obj.leb(n)`). The test's own comment (`test/data.js:2481-2482`): "Fixing
> this needs the closure-materialization subsystem to ALSO prove a
> value-used named function's own param boxed-by-construction across a
> property-dispatched call — out of this fix's scope; **pinned KNOWN-WRONG,
> not silently accepted**."

This is a green CI test *encoding* a silent wrong value (`number` instead of
`BigInt`) that is not in README's "What differs from JS?" enumeration —
i.e., by `STABILITY.md`'s own text this is currently release-blocking, and it
is currently shipping (in the sense that the suite is green with it in place).

**`KNOWN-FAIL` pins**: 7 files, same pattern — mostly historical
("was KNOWN-FAIL," "FIXED... was KNOWN-FAIL"). One live exception, narrower
and more defensible: `test/dyn-keys.js:1622` — a BigInt-through-Map "strict-mode
(opt-in) collection diagnostic" the test's own comment scopes as "out of
scope," not silently wrong in ordinary code paths.

**Good-faith update on the 2026-08-26 seven-gate scorecard**
(`.work/handoff-2026-08-22.md:463-495`) — Gate 1 (Soundness, RED) named two
concrete accepted-wrong families "hiding as test262 xfails": 17 Boolean
join/throw-carrier bugs and 12 promoted-rest bugs. Checked live against
`a15ec98c`: **both are now fixed**, via `fix/wrong-values-2` (2026-08-27, the
same commit line that also dropped test262 language pass count 3003→2976,
below). Evidence: `test/booleans.js:181` — "throw/catch preserve boolean
identity (audit-#12, **was WRONG**)"; live test262 xfail list (this session's
own run, §1) — the coalesce `BOOL∪NUMBER` cases now read "correctly REJECTS
(**was silently wrong pre-audit-#12**... confirmed live, all 5 files reject
cleanly)"; `test/array-methods.js:1814` and `test/destruct.js:147` ("audit-#12
Family A") — rest-pattern `Array.isArray` promotion now returns the correct
`true`. Both families moved from silent-wrong to either correct-reject or
correct-value. (Not independently re-verified: the same scorecard's
"member-call provenance = Shape #8... canonical call-target index" item —
its current completion status wasn't directly checked either way; the shape
#9 finding above is adjacent but not the same item, and I'm not asserting
Shape #8 is closed.)

**`STABILITY.md`'s own "Known limitations at v1"** (`STABILITY.md:108-114`) —
two items, both scoped as correct-reject rather than silent-wrong, i.e.
compliant with the contract by design rather than violations of it: (1)
"Ambiguous `boolean∪number` locals whose stored identity would escape reject
at compile time" — this is precisely the mechanism that closed the
Boolean-join family above; (2) "Rest-parameter BigInt elements have no
reachable evidence today and reject per the marshalling policy." Both are
disclosed, both reject rather than lie — the opposite pattern from the
`test/data.js:2452` finding above, and worth naming as the contract working as
intended in two places while failing in a third.

**test262 ledgers** (confirmed live, §1): language 2976/0/21xfail,
3908 neg-reject / **137 neg-accept**; builtins 858/0/70xfail. Zero drift from
`test/test262-baseline.json`. The 137 neg-accepts are exact-set-gated in
`test/test262-neg-accepts.json` (any add/remove/family-move requires review)
and are explicitly named in `STABILITY.md:27-30` as "a v1 release gate, never
a supported extension" — currently **137 open**, unchanged at HEAD, with the
only forward plan being an aspirational one-line note in
`.work/v1-architecture-campaign.md:217-219` ("reject the exact 137
parser-context residuals" — not yet done).

**README/bench claims vs. their own gate**: README's "Is it fast?" section
states "JZ leads V8 and AssemblyScript by geometric mean... the release gate
is stricter than an average: JZ must be the fastest WASM on every case" —
nominally backed by `test/bench.js` + `test/bench-claims.js`. The live run in
§2 shows `test/bench-claims.js` **failing** at HEAD (9/19 groups). The claim
is not currently backed by a passing gate, even though the gate that would
back it exists and ran honestly.

**`prepublishOnly` is currently broken**: `package.json`'s `prepublishOnly`
script is `npm test && npm run test:types && npm run test:self && npm run
test:claims` — the last step is exactly the failing `test/bench-claims.js`
run above. **`npm publish` cannot succeed from `a15ec98c` today.**

---

## 5. Gap table

Ranked by v1-blocking severity. "NONE" in the gate column means: even if
today's numbers happened to satisfy the requirement, nothing would catch a
regression — that counts as *not met*, per the audit's own instructions.

| # | Requirement | Enforcing gate | Current status | What closes it |
|---|---|---|---|---|
| 1 | Full recursive jz×jz self-compile below wasm32's 4 GiB | **NONE** — no CI job runs the 162-module probe at all; `.work/`-tracked hand diagnostic only | **NOT MET** — traps at exactly 2^32 bytes on every measurement in the campaign's history (cited, not re-run) | Engine work: streaming/compact encoder or region-scoped release (both named, neither landed — `.work/v1-architecture-campaign.md`'s Slice 6 + `.work/porffor-alpha3-audit.md`'s ranked P0 list) |
| 2 | Once self-compile succeeds, match/beat Porffor's self-host wall+RSS | **NONE** (documented only in `CONTRIBUTING.md:158-163`) | **NOT MET / NOT MEASURABLE** — can't start until #1 closes; today's *one-level* hosted build is already ~1.5–1.7× slower, ~2.2–2.3× heavier than Porffor's full native self-build | Blocked on #1, then engine work per the 8 ranked gaps in `.work/porffor-alpha3-audit.md` |
| 3 | Strictly faster than every wasm rival, per case (owner's literal bar) | `test/bench-claims.js:355-372` (hard-gated, no CI softening) — the *only* place this is enforced as written | **NOT MET** — 22/60 unproven strict, **13/60 genuinely red** beyond even the 1.05× tolerance band (`base64, crc32, delayline, fft, glyfparse, lorenz, radixsort, sdf, shapes, slices, sort, trace, vm`); plus 3 real losses to raw V8 (`jessie, resample, watr`) | Engine work on the 13 (+3 V8) red cases — most are already self-diagnosed with a named root cause in `test/bench.js`'s `WASM_TODO` map — then an evidence refresh after a source freeze |
| 4 | Strictly smaller than AS, per case (owner's literal bar) | **NONE** — `test/bench.js`'s per-case `SIZE` table asserts only a `win`/`tie` subset (16/~30 curated cases are `'todo'`, unasserted); the only universal, always-hard-gated check is **geomean ≤ 1.05×** (`test/bench.js:728-730`, `test/bench-claims.js:394-406`, self-described as "par-or-smaller... not strict-smaller") | **NOT MET** — 24/49 (49%) cases larger than AS today, fresh-confirmed two ways (committed evidence + live `scripts/bench-size.mjs --json` rerun, both ≈1.04× geomean / ~51% smaller) | Gate work (write the missing per-case assertions) *and* engine work (real gaps, not just missing gates — `wordcount` 4.7×, `shapes` 1.78×, several transcendental/gather kernels >1.2×) |
| 5 | Correct-or-reject, no unlisted silent wrong value (`STABILITY.md:19-22`) | `STABILITY.md`'s text is the policy; no automated scanner enforces "no open `KNOWN-WRONG` pin" — a human/agent must grep | **NOT MET** — one live, green test (`test/data.js:2452-2506`) explicitly pins a silently-wrong `typeof` result, by its own comment's admission | Engine work: extend the closure-materialization subsystem to cover value-used property-dispatched callees (the pin's own next-step) |
| 6 | 137 exact accepted-invalid test262 negative parses (`STABILITY.md:27-30`, "a v1 release gate") | `test/test262-neg-accepts.json` exact-set-gates the *current* 137 (any drift fails CI) but does not require shrinking it | **NOT MET** — 137 open, unchanged at HEAD; only an aspirational one-liner exists as a plan | Engine work, per parser-context family (module-goal/export context, class-element token boundaries, destructuring cover grammar, ASI/line-terminator context, async-generator/parameter context, legacy-escape context — 6 named families in the ledger) |
| 7 | Evidence backing the performance claim is fresh + valid | `test/bench-claims.js` (hard-gated) | **NOT MET** — 221 compiler commits stale, swap-pressure invalid (4199.75 MB > 4096 MB bound), memory evidence 573 commits stale | Cheap in isolation (re-run the bench harness) but explicitly blocked behind "freeze source first" per the project's own stated order (`.work/handoff-2026-08-22.md`'s 2026-08-27 addendum) plus a quiet (non-swapping) machine |
| 8 | `npm publish` succeeds (`prepublishOnly`) | `package.json`'s `prepublishOnly` chain, ending in `test:claims` | **NOT MET** — exit 1 today, transitively from #3/#4/#7 | Same as #3/#4/#7 |
| 9 | CI actually blocks a regression to the per-case speed/size bars on every push | `bench.yml`'s `test:bench` step — but its ratio assertions are `okTiming`-softened to informational-only on CI (`test/bench.js:146-148`) | **STRUCTURALLY PARTIAL** — the only unconditional enforcement is the separate `claims` job (#3/#4), which depends on someone/something periodically refreshing `bench/results.json` (see #7) | Gate work: none required if the `claims` job is treated as the real gate and kept fresh — but that dependency is implicit, not enforced by CI itself (nothing fails when evidence goes stale except the next `claims` run happening to notice, as it did here) |
| 10 | test262 language/builtins floors hold | `test262.yml` (hard-gated, no softening) | **MET** — confirmed live this session, zero drift (2976/0/21, 858/0/70) | Already closed; keep it this way |

**Overall, on the owner's own three-part bar: none of the three parts is met,
and two of the three (size-per-case, self-compile-recursive) have no CI
enforcement surface at all today — only geomeans and hand-run diagnostics.
The third (speed-per-case) has a correctly-written, unconditionally-hard-gated
test, and that test is honestly red.** This matches the owner's framing
exactly: CI is red (`claims` job, `test.yml`), and it is red for the right
reason — the gate is not a rubber stamp.

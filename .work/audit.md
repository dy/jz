# audit.md: v1 readiness + core simplification

Two audits merged: **v1 release readiness** (§1-4: CI truth table, per-case
WASM leadership, self-compilation economics, correctness contract) and
**core simplification** (§5-9: measured shape, expert panel, overdone list,
simplification plan, optimization gaps), plus **§10**, the Porffor alpha 3
competitive audit's adapter contract and ranked transferable optimizations
(its raw measurements live in `evidence.md`). §11 is one unified gap table.

Every number below was measured in the cited run or cited from a dated
source with its date stated; every architectural claim is a file:line
citation. Nothing in this document was fixed as part of writing it. The
measured sections retain their pinned snapshots.

**Branch-base reconciliation (`dd92662e`)**: Sections 1-4 were measured at
`a15ec98c`; sections 5-9 were measured at `a45ce6ca`. Later commits in this
branch base changed several status conclusions without invalidating those
measurements. Commit `105bdc18` added strict per-case size gates;
`18690313` reduced the general devirtualized-closure guard class; four live
wrong-value pins now remain in `test/data.js`; and the nine-commit narrow
split reduced `src/compile/narrow.js` to a 30-line barrel. On the
consolidation checkout, `npm test` is 3,864 total / 3,863 pass / 1 skip /
0 fail (28,541 assertions). The branch-base test262 lock is 2,976 language
pass / 21 xfail, 3,908 negative reject / 137 accept, and 858 builtins pass /
70 xfail. Performance evidence, recursive
self-compilation, and the 137 parser paths remain red. This reconciliation
governs any "current", "today", or "HEAD" wording in the pinned audit
below. Section 11 reports branch-base status.

---

## 1. CI truth table

Pinned at `a15ec98c` (2026-08-28T22:42:44-04:00, tip of the merge queue at
that time). Worktree: detached checkout, read-only against
`/Users/div/projects/jz`; `node_modules` symlinked from the main worktree
(watr 5.9.3, subscript 10.7.1: matching `package.json`'s
`^5.9.3`/`^10.7.1`). All measurements below are from that session, on
darwin/arm64, Apple M4 Max, Node v25.9.0, 14 cores/36 GiB, run once each.
The machine was shared with other agents' batteries throughout (`load1`
peaked at 30+): no timing number in this section should be read as a
clean benchmark; every number that matters here is a pass/fail, a byte
count, or a count of test cases, not a wall-clock ratio measured under
contention.

Eight workflows. Every step that could run locally and wasn't excluded by
the audit's own scope (`bench/bench.mjs`, any multi-toolchain speed
benchmark, `test/bench-c.js`) was run once.

### `test.yml`

| job | step | command | ran? | result |
|---|---|---|---|---|
| `test` (default) | `npm test` | `node test/index.js` | **RAN**: full `TESTS` list minus `bench-c` (94/95 files; `bench-c.js` builds a native binary under AddressSanitizer, whose own header comment documents ASan runtimes that "busy-loop without ever reaching main" on some hosts: excluded per audit scope, not run) | **PASS**: see full tally below |
| `test` (opt0) | `npm run test:opt0` | `JZ_TEST_OPTIMIZE=0 node test/index.js` | not run | Same 95-file suite at a different optimize tier: identical code path to the default leg, ~10 more minutes for a second full pass. Not independently re-run this session; last-known-green from `plan.md`'s current-state matrix. |
| `test` (opt3) | `npm run test:opt3` | `JZ_TEST_OPTIMIZE=3 node test/index.js` | not run | Same caveat as opt0. |
| `test` (wasi) | `npm run test:wasi` | `JZ_TEST_HOST=wasi node test/index.js` | not run | Same caveat as opt0. |
| `test` (default) | `npm run build:examples` |: | not run | Smoke-only (examples still compile); low audit value, redundant with the `npm run build` success below. |
| `test` (default) | `npm run test:types` | `tsc test/public-types.ts --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM --skipLibCheck false` | **RAN** | **PASS**: zero diagnostics, exit 0. |
| `fuzz` |: | `JZ_DEBUG_INVARIANTS=1 npm run test:fuzz` (`test/fuzz.js --count=5000`) | not run | The in-suite `fuzz` test (200 seeds) is already covered by the default `node test/index.js` run above (`TESTS` includes `'fuzz'`); the CI-only 5000-seed extension is the same differential oracle at higher volume. Not independently re-run: diminishing marginal evidence for the time cost. |
| `claims` |: | `node test/bench-claims.js` | **RAN** | **FAIL**: exit 1, 9/19 test groups red (53 assertions: 9 pass, 9 fail, 1 skip). Full detail in §2 and §11. This is the job that turns the owner's per-case bar into an actual CI gate, and it is red at HEAD. |

**test.yml verdict: CI is red today**, driven entirely by the `claims` job.
`test` (default) and `test:types` are clean.

### `bench.yml`

| job | step | ran? | what it checks / result |
|---|---|---|---|
| `bench` | toolchain installs (zig, deno, bun, jsc, numpy, GNU time, wasmtime, tinygo, rust wasm target, `asc`+binaryen, Porffor pinned clone) | not run | Infra only. |
| `bench` | `npm run test:bench` (`node test/bench.js`) | **excluded per audit scope** | Runs the full 60-case corpus across every installed toolchain. Hard-gated on CI: checksums, parity, wasm sizes, compile success (per rival: `test/bench.js:590-611`). Timing ratios are **informational only on CI** (`okTiming`, `test/bench.js:146-148`, because "a shared 2-core runner reads identical builds up to 15× slower"). Evaluated instead from committed evidence: see §2. |
| `bench` | native-lane smoke (`jz-w2c`/`jz-w2c2`, wasm2c/w2c2 install + 3-case checksum verify) | not run | Same exclusion (invokes `bench.mjs`); toolchain-install heavy, secondary regression net for the native-lowering lane, not central to the v1 bar. |
| `bench` | `publish bench snapshot` (push-to-main only) | N/A | Not applicable outside a push-to-main; observed as a side fact: `bench/results-ci.json` (the CI/EPYC secondary dataset this step writes) is dated **2026-07-25**, commit `d2a0589`, Porffor **pre-alpha 1**: over a month and one full Porffor generation stale relative to `bench/results.json`'s 2026-08-27/`4c38662f`/alpha-3. This dataset is informational-only per `bench/README.md` and gates nothing, but it shows the publish leg hasn't produced a fresh secondary reading in a long time. |

**bench.yml verdict**: cannot be fully evaluated live (by design, per audit
scope); the part that matters for the owner's bar (per-case leadership) is
reconstructed in §2 from the exact same committed evidence this job would
read.

### `self-compile.yml`

| step | command | ran? | result |
|---|---|---|---|
| `build dist/jz.wasm` | `npm run build` | **RAN**, wrapped in `/usr/bin/time -l` | **PASS**, exit 0. **314.29 s real** (345.79 s user, 2.54 s sys), **4,212,146,176 B (4.212 GiB) maximum resident set size**. `dist/jz.wasm` = **17,481.3 kB**. `dist/jz.js` 2,261.7 kB, `dist/interop.js` 30.1 kB, `assets/sprae.js` 19.0 kB. wat-strip parity: 3/3 probes byte-identical. |
| `self-compile round-trip` | `npm run test:self` | not run | `test/self-compile.js`'s own `ensureSelf()` (`test/self-compile.js:26-34`) reuses `dist/jz.wasm` if present: after the build above this would be a fast round-trip, not a rebuild: but was not independently run this session; not needed to establish the §3 facts, which come from the build above plus the cited 162-module self-host probe. |
| `full suite via dist/jz.wasm` | `JZ_FUZZ_GATE=0.15 npm run test:wasm` | not run | This re-runs virtually the entire `TESTS` list (minus `KERNEL_EXCLUDE`, `test/index.js:142-163`) with every `compile()` call routed through the wasm-hosted kernel instead of the native compiler: the heaviest non-excluded step in any workflow. A concurrent process from another agent on this same machine was already running exactly this command for the duration of this audit. Not duplicated. Evaluated instead from `kernel-parity`/`kernel-oracle` (run natively as part of the default suite above) plus the dated figures in `plan.md`'s current-state matrix: cited as history, not confirmed fresh at `a15ec98c`. |

**self-compile.yml verdict**: the one step that matters most for "compiles
itself well": the actual build: **passes** and reproduces the campaign's
own cited profile almost exactly (§3). The full in-kernel suite gate was
not independently re-verified this session.

### `test262.yml`

| job | command | ran? | result |
|---|---|---|---|
| `test262-language` | `npm run test:262` | **RAN** (cloned the pinned corpus `b363f29d` fresh: network reachable) | **PASS**: `Pass: 2976, Fail: 0, Xfail: 21, Neg-reject: 3908, Neg-accept: 137`. Exit 0. Matches `test/test262-baseline.json` (`language: 2976`, `negAcceptExact: 137`) and `STABILITY.md:27` exactly: no drift. |
| `test262-builtins` | `npm run test:262:builtins` | **RAN** | **PASS**: `Pass: 858, Fail: 0, Xfail: 70`. Exit 0. Matches the baseline's `builtins: 858` exactly. |

**test262.yml verdict: green, confirmed fresh at `a15ec98c`.** Both floors
hold with zero drift from the committed lock. (Note for §4: the baseline's
own `_comment` records that `language` dropped 3003→2976 on 2026-08-27 when
a silent-wrong-value fallback was closed: most of the "3003" figures
scattered through the archived session logs predate that fix and are
stale; 2976 is the current, live-confirmed floor.)

### `watr.yml`

Not run. Clones a second repo (`dy/watr`, recursive submodules), `npm
link`s it bidirectionally against HEAD jz, builds `watr.wasm` with HEAD jz,
then runs watr's own suite against it. Its own header comment scopes it as
"a downstream integration signal, not a unit gate" and "kept as its own
workflow (slow)". Out of proportion to the marginal v1-gap evidence it
would add over the already-extensive native/kernel correctness evidence
gathered elsewhere in this audit; evaluated from the workflow definition
only.

### `bench-probe.yml`

Not a gate: `workflow_dispatch`-only, its own comment says "not a gate,
writes nothing." No action needed.

### `release.yml`

Fires only on a published GitHub release (`build dist/jz.wasm` + `gh
release upload`). Mechanically identical to the `npm run build` step
already verified PASS above; `gh release upload` not exercised (nothing to
attach to, and cutting a release is out of scope for a read-only audit).

### `pages.yml`

Its gate step is `npm test` (subsumed by the default-suite run above,
which includes `web-smoke` from `TESTS`). The remaining steps build+deploy
the GitHub Pages site: infrastructure, not a correctness or performance
gate; not run (no Pages target locally).

### Default suite tally (`node test/index.js`, 94/95 files)

```
# total 3858 (28503 assertions)
# pass 3857
# skip 1
EXIT=0
```

**Clean pass, zero failures**, ~11 minutes wall (contended machine, see
header). The one skip is an explicitly-marked `test.todo` (🚧), not a
silent gap: "spread: rest-param spread through export-only unknown
callee." This is the strongest single piece of evidence in this audit
*for* v1 readiness: the core correctness suite, run fresh at `a15ec98c`,
is fully green.

---

## 2. Per-case WASM leadership table

**Evidence freshness, by the gate's own rule.** `bench/results.json` meta:
`commit: "4c38662f"`, `date: "2026-08-27 17:09 UTC"`, `partial: true`. Per
`test/bench-claims.js:145-183` (`claims: reference evidence is fresh…`),
the gate itself says **STALE**: 57 JZ rows predate **221** compiler-source
commits (touching `SOURCE_SCOPE`: `src`, `module`, `jzify`, `index.js`,
`interop.js`, `layout.js`, `package.json`, `package-lock.json`,
`test/bench-claims.js:93`) that have landed between `4c38662f` and
`a15ec98c`. This is not a judgment call: it is the project's own
freshness test, run live, saying its own reference dataset is out of date.

**Live re-run of the gate** (`node test/bench-claims.js`, evidence-only -
no live benchmarking):

```
# total 19 (53 assertions)
# pass 9
# fail 9
# skip 1
```

Failing groups:
1. **Freshness**: STALE (221 commits, above).
2. **VALIDITY**: committed evidence's `machineState.swapUsedMB=4199.75`
   exceeds the 4096 MB sane bound (`test/bench-claims.js:212-222`): the
   M4 reference run that produced `bench/results.json` was itself under
   swap pressure.
3. **Memory evidence stale**: `memcheck-results.csv` is 573
   compiler-source commits behind.
4. **Strict wasm-rival leadership**: unproven on **22/60** cases.
5. **No-red-cases (1.05× band) wasm rival**: **13/60** cases exceed even
   the loose band (genuine losses, not jitter): `base64` 1.145×(tinygo),
   `crc32` 1.076×(c-wasm), `delayline` 1.124×(rust-wasm), `fft` 1.095×
   (rust-wasm), `glyfparse` 1.169×(c-wasm), `lorenz` 1.096×(as),
   `radixsort` 1.054×(zig-wasm), `sdf` 1.293×(c-wasm), `shapes` 1.431×
   (as), `slices` 1.067×(c-wasm), `sort` 1.209×(zig-wasm), `trace` 1.562×
   (c-wasm), `vm` 1.052×(rust-wasm).
6. **Strict V8-family leadership**: unproven on 7/60 cases.
7. **No-red V8-family**: **3 real losses to raw V8/deno beyond the
   band**: `jessie` 1.641×(v8), `resample` 1.073×(v8), `watr` 1.291×(v8).
8. **Strict bun/jsc leadership**: unproven on 9/60 cases.
9. **No-red bun/jsc**: 7 cases exceed band: `jessie` 2.043×(bun), `lorenz`
   1.063×(jsc), `resample` 1.087×(jsc), `sdf` 1.146×(jsc), `sort` 1.056×
   (jsc), `synth` 1.156×(bun), `watr` 1.148×(bun).

Passing groups worth naming: the **Porffor floor is fully green**: 43/43
comparable rows, JZ leads every one on speed and size, geomeans
21.722×/63.865× in JZ's favor (`test/bench-claims.js:312-328`; full
numbers in evidence.md): but per its own header comment this snapshot is
explicitly **not release-certified** (freshness + VALIDITY above apply to
it too). The **size geomean vs AS** also passes: 1.042× ≤ the 1.05× par
band (`test/bench-claims.js:394-406`): but read the fine print below:
only **25/49 (51%)** cases are actually smaller than AS; the gate passes
because it is scoped to geomean, not because most cases win.

### Full per-case table (60 cases in `bench/results.json`, non-lab + lab)

`jz bytes` / `AS bytes` are the **speed-preset** build's bytes (`optimize:
'speed'`, what `bench.mjs`'s size column records for the speed run);
best-rival is the fastest of `{c-wasm, rust-wasm, go-wasm, tinygo,
zig-wasm, as}` with a matching checksum.

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
| colorconv | 2459 |: |: | 32.574 |: |: | no wasm rival |
| colorlch | 2969 |: |: | 62.648 |: |: | no wasm rival |
| conv2d | 1535 | 1696 | 0.905 | 1.317 | rust-wasm 2.510 | 0.525 | strict |
| crc32 | 1124 | 1359 | 0.827 | 8.797 | c-wasm 8.174 | 1.076 | **RED** |
| delayline | 1656 | 1470 | 1.127 | 0.679 | rust-wasm 0.604 | 1.124 | **RED** |
| deltae | 3650 |: |: | 44.371 |: |: | no wasm rival |
| dict | 1330 | 1467 | 0.907 | 1.957 | as 2.344 | 0.835 | strict |
| dispatch | 1813 | 1614 | 1.123 | 1.845 | zig-wasm 11.000 | 0.168 | strict |
| dotprod | 1069 | 1177 | 0.908 | 0.152 | tinygo 1.988 | 0.076 | strict |
| fft | 2384 | 1758 | 1.356 | 1.057 | rust-wasm 0.965 | 1.095 | **RED** |
| fftplan | 30763 |: |: | 1.854 |: |: | no wasm rival |
| glyfparse | 3082 | 2408 | 1.280 | 3.370 | c-wasm 2.883 | 1.169 | **RED** |
| hash | 1151 | 1367 | 0.842 | 3.830 | as 3.790 | 1.011 | band |
| hashjoin | 1495 | 1561 | 0.958 | 6.014 | as 7.368 | 0.816 | strict |
| heat | 1445 | 1364 | 1.059 | 2.210 | as 8.158 | 0.271 | strict |
| immutable | 1851 | 1481 | 1.250 | 0.156 | c-wasm 0.308 | 0.506 | strict |
| jessie | 80770 |: |: | 2.110 |: |: | no wasm rival (V8 loss, see below) |
| json | 8117 |: |: | 0.133 | c-wasm 0.250 | 0.532 | strict |
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
| provenance | 30172 |: |: | 1.406 |: |: | no wasm rival |
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
| watr | 290999 |: |: | 1.117 |: |: | no wasm rival (V8/bun/jsc loss below) |
| wav | 1655 | 1751 | 0.945 | 5.754 | rust-wasm 5.749 | 1.001 | band |
| wordcount | 16372 | 3480 | **4.705** | 0.742 | c-wasm 0.780 | 0.951 | strict (speed); size far red |

**Geomeans** (computed live from `bench/results.json`, cross-checked
against `test/bench-claims.js`'s own numbers: they agree):

- **Size, jz/AS**: N=49 comparable cases, **geomean 1.042×**, **25/49
  (51%) strictly smaller**.
- **Speed, jz/best-wasm-rival**: N=50 comparable cases, **geomean
  0.688×**, **28/50 (56%) strictly faster**, 37/50 within the 1.05× band,
  **13/50 (26%) genuinely red** (listed above).

**Fresh reproduction of the size numbers** (`node scripts/bench-size.mjs
--json`, run live at `a15ec98c`: cheap, deterministic, no external
network): **geomean 1.0418×, 25/49 smaller**: numerically
indistinguishable from the stale committed figure. The staleness flagged
above does not appear to be hiding a different size verdict; the per-case
reality (about half the corpus is larger than AS) holds under a fresh
measurement too. Largest fresh misses: `wordcount` 4.705×, `shapes`
1.783×, `tokenizer` 1.350×, `fft` 1.356×, `resample` 1.321×, `slices`
1.295×, `immutable` 1.250×, `sdf` 1.239×, `glyfparse` 1.280×, `bezfit`
1.201×.

### Which gate enforced the owner's two literal bars at `a15ec98c`?

**At the audit snapshot, no gate enforced "smaller than AS, ×1, per
case".** Three progressively weaker layers existed, and none matched the
owner's bar:

1. `bench/README.md`'s own text: "JZ holds a par-or-smaller **geomean**
   band (≤1.05×)" (`bench/README.md:208-211`): already geomean, not
   per-case.
2. `CONTRIBUTING.md:149-151` ("Performance & size invariant"): "JZ wasm ≤
   AssemblyScript... on every comparable case, **and** on geomean": this
   *documents* a per-case promise, but uses **≤** (ties allowed), not the
   owner's strict **<**.
3. The actual enforced code doesn't even reach layer 2's promise:
   `test/bench.js`'s `SIZE` object (`test/bench.js:190-261`) marks most
   cases `'todo'`: **printed, never asserted** (`test/bench.js:706-723`
   only asserts cases with a `SIZE_TOL` entry, i.e. `'win'`/`'tie'`). Of
   the SIZE table's ~30 curated cases, 16 are `todo`: `slices, trace,
   bezfit, sdf, resample, delayline, glyfparse, mat4, biquad, tokenizer,
   fft, synth, blur, lz, qoi, hashjoin`. The only universally-applied,
   always-hard-gated (even on CI: `test/bench-claims.js` has no
   `okTiming` carve-out) size check across the *whole* corpus is the
   **geomean ≤ 1.05×** (`test/bench.js:728-730`,
   `test/bench-claims.js:394-406`, the latter's own name for itself:
   "par-or-smaller... **not strict-smaller**"). At `a15ec98c`, the
   enforced requirement was weaker than the documented one.

**Branch-base update**: `105bdc18` replaced this gap with hard
`jz bytes < AssemblyScript bytes` assertions in both `test/bench.js` and
`test/bench-claims.js`, over every comparable case. The requirement is now
enforced and remains red on 24/49 rows from the gate's landing baseline.

**"Faster than every wasm rival, ×1 (strict), per case": a real gate
exists, and it is currently red.** `test/bench-claims.js:355-372`
(`strictTest`/`bandTest`) is the honest version: hard-gated
unconditionally (no CI carve-out), requires ratio < 1.0 for every case
against `CLAIM_RIVALS`. Run live today, it fails on 22/60
(unproven-strict) and 13/60 (red-beyond-band). The **weaker sibling** in
`test/bench.js:548-613` ("Assertions: jz is the fastest WASM, per case")
covers the same full corpus but is wrapped in `okTiming`
(`test/bench.js:146-148`), so **on CI it never fails the build**: it only
prints. So: the strict per-case bar the owner wants is *specified*
faithfully in one file (`bench-claims.js`) and *softened to informational*
in the file that actually runs on every push (`bench.js`, inside the
excluded-from-this-audit `bench.yml`). The `claims` job in `test.yml` is
what makes the strict version bite on CI: and it is red today (§1).

**"jz must compile itself well"**: see §3; no gate of any kind currently
requires the literal claim (jz recursively compiling itself) to succeed.

---

## 3. Self-compilation economics

**Hosted native build: measured live, once, at `a15ec98c`:**

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

Cross-check against evidence.md's Porffor alpha 3 entry (2026-08-27, JZ
ref `4c38662f`, 221 commits behind this run): **344.02 s baseline /
348.42 s profiled, 4.33–4.34 GB peak**. The independent `a15ec98c` rerun
above is faster (314 s) and slightly lighter (4.21 GiB): same order of
magnitude, no regression, the profile is stable across 221 intervening
commits.

**Kernel size** over the campaign (all same lineage, `dist/jz.wasm`):
16,963.2 kB (final certification, older) → 17,258.9 kB (v1-architecture
Slice 5) → 17,732.2 kB (Slice 6, region-disabled) → **17,481.3 kB
(`a15ec98c`)**. Not monotonic: it has moved in both directions across
correctness-driven work in the 17.0–17.7 MB band, consistent with
"correct-or-reject" landings adding union-materialization bytes (e.g. the
`watr` `SIZE_BUDGET` comment in `test/bench.js:296-304` documents +25.8 kB
from exactly this class of fix).

**The recursive goal: jz compiling itself, in-wasm (not run in this
audit; cited from evidence.md's Porffor alpha 3 entry, 2026-08-27, JZ ref
`4c38662f`):**

```json
{"modules":162,"outcome":"trap","error":"unreachable","outputBytes":0,"memoryBytes":4294967296,"heap":-32,"wallMs":11448}
```

Traps at exactly the wasm32 4 GiB address-space ceiling, ~10.5–11.4 s in,
every time it has been measured across the campaign (the negative heap
byte offset moves slightly: -80, -32, -24, -16: across different
sessions as work landed, but the wall is always the same 2^32-byte
ceiling). **JZ has no successful self-compilation time, ever, at any
point in the cited history.** `STABILITY.md:99-107`: the section
literally titled "Remaining v1 release gate," the *only* item under that
heading: states this plainly: "V1 requires this run to produce bytes
below that ceiling." `CONTRIBUTING.md:158-163` adds a second clause the
codebase hasn't even started measuring against: once the trap closes, JZ
must *also* "match or beat the pinned Porffor self-host on same-machine
wall time and peak memory": i.e., closing the trap is only half of the
project's own stated bar for this item.

**Same-machine comparison to Porffor's self-host** (non-recursive, since
Porffor's target isn't wasm): Porffor selfhost→C: 1.94–1.95 s / 251 MB
peak. Porffor selfhost→**native** (full C compile too): 203.77 s / 1.89 GB
peak. **JZ's one-level hosted build (not even the recursive claim) is
already ~1.5–1.7× slower and ~2.2–2.3× heavier than Porffor's complete
native self-build**, and JZ has no recursive result to compare at all.
Input-normalized, JZ has 3.14× the source bytes and 3.92× the parsed
nodes versus Porffor's selfhost bundle: **not** the ~176× hosted-wall
ratio against Porffor's C-emission phase; most of the gap is not input
size. §10 attributes ~87% of JZ's 348 s to work *after* the semantic
module is already built (`watOptimize` 34.2%, `snapshotInit` 28.8%, final
encode 23.6%) and ranks eight concrete architectural gaps against
Porffor's actual implementation, with exact source citations.

**Corroboration at a completely different scale** (§5.6/§5.7 below, this
session's own instrumented profile of a single 10,234-node specimen -
`bench/watr/watr.js`: rather than the full 162-module self-compile): the
same qualitative shape holds. jz's own source is a **minority of
self-time** (24.4% vs. `watr`'s 70.1%) even on a specimen 1/40th the size
of Porffor's own selfhost bundle, and peak RSS per AST node
(43.3 KB/node at O3) is **~18× worse** than Porffor's own self-hosted
bundle's per-node peak (2.39 KB/node during C-emission). This is not a
controlled A/B (different compilers, different source graphs, different
target languages) but both are Node/V8-hosted compiler processes on the
same architecture family, and the direction agrees with the full-scale
self-compile numbers above: the cost profile is the pipeline's
steady-state shape, not an artifact that only appears at 162-module
scale.

**Kernel correctness** (native-vs-kernel checks, run as part of the
default suite in §1: `kernel-parity` proves byte-identical WAT between
the native and kernel-hosted pipelines on a fixed corpus at O0/O2/O3;
`kernel-oracle` adds three-way execution parity: host JS vs
native-compiled vs kernel-compiled: against a JS oracle, with an explicit
`PENDING-FIX` tier for currently-known native/kernel-vs-JS-oracle
divergences, per `test/kernel-oracle.js`'s own header). Historical
citation: plan.md's current-state matrix records kernel-parity 33/33
byte-identical rows, kernel-oracle 14/14 (605 assertions). This session's
own default-suite run exercises both files natively; see §1's tally for
the live pass/fail count.

**Verdict: "compiles itself well" is not met, and: separately: it is
not gated at all.** `self-compile.yml` requires `npm run build` to succeed
(it does) and `npm run test:self`/`npm run test:wasm` to pass (the kernel
compiling *other, smaller* programs correctly): a materially weaker
claim than "jz compiles itself." No CI job anywhere runs the 162-module
recursive jz×jz probe; it exists only as a hand-run diagnostic. So the
literal bar has no enforcement surface at all today, on top of currently
failing every time it has been attempted. Strategy options and the
decision rule live in plan.md's "4 GiB self-compile" section; the ranked
engineering work to close the gap is §10 below.

---

## 4. Correctness contract vs reality

**The contract** (`STABILITY.md:19-22`): outside the enumerated dialect
differences, "an accepted program must preserve JavaScript's answers...
Where the compiler cannot do so, it must reject rather than silently
choose a representation or value. Any unlisted silent wrong value is
release-blocking."

**`KNOWN-WRONG` pins at the branch base**: most grep hits are historical
regression commentary, but four live `test/data.js` tests intentionally
assert a wrong value:

1. `test/data.js:2452-2504`: Shape #9 index-resolved member callee returns
   a Number where JavaScript returns a BigInt.
2. `test/data.js:2811-2864`: a box-forcing Number/BigInt union is misread
   through a BigInt64Array store; its attempted fix was reverted after a
   broader self-host regression.
3. `test/data.js:4348-4387`: an object-literal property holding an inline
   closure never reaches closure-forwarding materialization.
4. `test/data.js:4391-4429`: nested `a.b.c(...)` dispatch does not resolve
   the callee one level beyond the canonical member shape.

All four are green tests encoding silent wrong values outside README's
documented dialect. `STABILITY.md` therefore makes them release blockers.
`ledger-correctness.md` keeps the symptom, root cause or pin, and gate for
each family. The first existed at the `a15ec98c` audit snapshot; the other
three landed later as explicit pins rather than invented completions.

**`KNOWN-FAIL` pins**: 7 files, same pattern: mostly historical ("was
KNOWN-FAIL," "FIXED... was KNOWN-FAIL"). One live exception, narrower and
more defensible: `test/dyn-keys.js:1622`: a BigInt-through-Map
"strict-mode (opt-in) collection diagnostic" the test's own comment scopes
as "out of scope," not silently wrong in ordinary code paths.

**Good-faith update on the 2026-08-26 seven-gate scorecard** (`plan.md`):
Gate 1 (Soundness, RED) named two concrete accepted-wrong families "hiding
as test262 xfails": 17 Boolean join/throw-carrier bugs and 12
promoted-rest bugs. Checked live against `a15ec98c`: **both are now
fixed**, via `fix/wrong-values-2` (2026-08-27, the same commit line that
also dropped test262 language pass count 3003→2976, above). Evidence:
`test/booleans.js:181`: "throw/catch preserve boolean identity
(audit-#12, **was WRONG**)"; live test262 xfail list (this session's own
run, §1): the coalesce `BOOL∪NUMBER` cases now read "correctly REJECTS
(**was silently wrong pre-audit-#12**... confirmed live, all 5 files
reject cleanly)"; `test/array-methods.js:1814` and `test/destruct.js:147`
("audit-#12 Family A"): rest-pattern `Array.isArray` promotion now
returns the correct `true`. Both families moved from silent-wrong to
either correct-reject or correct-value.

The canonical call-target index also landed before `dd92662e`. Its two
Shape #8 sibling limits are the inline-closure and nested-member pins above;
landing the index did not close those broader shapes.

**`STABILITY.md`'s own "Known limitations at v1"** (`STABILITY.md:108-114`):
two items, both scoped as correct-reject rather than silent-wrong, i.e.
compliant with the contract by design rather than violations of it: (1)
"Ambiguous `boolean∪number` locals whose stored identity would escape
reject at compile time": this is precisely the mechanism that closed the
Boolean-join family above; (2) "Rest-parameter BigInt elements have no
reachable evidence today and reject per the marshalling policy." Both are
disclosed, both reject rather than lie: the opposite pattern from the
`test/data.js:2452` finding above, and worth naming as the contract
working as intended in two places while failing in a third.

**test262 ledgers** (confirmed live, §1): language 2976/0/21xfail, 3908
neg-reject / **137 neg-accept**; builtins 858/0/70xfail. Zero drift from
`test/test262-baseline.json`. The 137 neg-accepts are exact-set-gated in
`test/test262-neg-accepts.json` (any add/remove/family-move requires
review) and are explicitly named in `STABILITY.md:27-30` as "a v1 release
gate, never a supported extension": currently **137 open**, unchanged at
HEAD, tracked in plan.md's remaining queue.

**README/bench claims vs. their own gate**: README's "Is it fast?" section
states "JZ leads V8 and AssemblyScript by geometric mean... the release
gate is stricter than an average: JZ must be the fastest WASM on every
case": nominally backed by `test/bench.js` + `test/bench-claims.js`. The
live run in §2 shows `test/bench-claims.js` **failing** at HEAD (9/19
groups). The claim is not currently backed by a passing gate, even though
the gate that would back it exists and ran honestly.

**`prepublishOnly` is currently broken**: `package.json`'s
`prepublishOnly` script is `npm test && npm run test:types && npm run
test:self && npm run test:claims`: the last step is exactly the failing
`test/bench-claims.js` run above. **`npm publish` cannot succeed from
`a15ec98c` today.**

---

## 5. Measured shape of the compiler

Panel and methodology for §5-9: V8/TurboFan-style engineer,
LLVM/Binaryen-style engineer, AssemblyScript author, Porffor author.
Scope: is jz's core overdone, does it self-host well, does it beat other
Wasm generically (not per-bench). Every claim is either a file:line
citation or a measurement taken in this run; opinions are labeled as such.

Worktree detached at `a45ce6ca`, Node v25.9.0, Apple M4 Max, watr 5.9.3,
measured 2026-08-28. Instrumentation added to `src/ast.js`'s `walkAst`
(call/visit counters) and three throwaway driver scripts under
`scripts/_audit-*.mjs`: all uncommitted, none of this ships. The
benchmark specimen is `bench/watr/watr.js` resolved through
`src/resolve.js`'s `resolveModuleGraph` (the same resolution
`bench/bench.mjs` uses for the `watr` case: jz compiling watr's own WAT
encoder, 10,234 AST nodes across the resolved module graph).
`test/bench-c.js` and the multi-toolchain speed bench were **not** run
(other agents on this machine). `scripts/self-compile-build.mjs` (the ~6
min / ~4 GB kernel build) was **not** re-run: at measurement time `uptime`
showed load average 33.24 and `sysctl vm.swapusage` showed 10.9/12 GB swap
already in use from other work on this shared machine: not a safe moment
for a 4 GB, 6-minute job (self-compile economics are covered in §3 above).

### 5.1 Lines per stage

```
jzify/ (pre-compile desugar)                    3,667
src/prepare/                                    5,860
src/compile/ (analyze+plan+narrow+emit+…)      36,940
  src/compile/*.js flat files                  23,515
  src/compile/analyze/ + analyze.js/-scans.js    4,761
  src/compile/program-facts/ + barrel            2,576
  src/compile/plan/                              4,994
  src/compile/representation-plan/ + barrel      2,716
  narrow.js (single file)                        4,027
  emit.js + emit-assign.js                       9,163
  call-target-index.js + dict-kind-index.js        948
  infer.js + flow-types.js + flow-state.js       1,132
  index.js (session driver)                      3,503
src/optimize/ (jz's own per-function IR passes) 14,934
src/wat/ (assemble + codegen)                    2,107
src/ir.js (46, barrel) + src/ir/ (11 files)      2,655 (2,701 incl. barrel)
src/kind.js (27, barrel) + src/kind/ (4 files)   1,767 (1,794 incl. barrel)
src/type.js (71, barrel) + src/type/ (8 files)   2,647 (2,718 incl. barrel)
module/ (stdlib written in the dialect)         29,274
---------------------------------------------------------
src + jzify + module total                    108,446 lines, 213 files
```
(`find src jzify module -name '*.js' | xargs wc -l`, this worktree.)
`test/` alone is 63,876 lines: more test than compiler by more than half.

### 5.2 Files over 3,000 lines: shrinking, verified in-flight

```
8,167  src/compile/emit.js
4,452  src/prepare/index.js
4,027  src/compile/narrow.js
3,535  module/core.js
3,503  src/compile/index.js
```
The 2026-08-26 handoff (2 days earlier) counted **10** files over 3k
(`emit.js 8154, prepare/index.js 4465, narrow.js 3945, core.js 3532,
compile/index.js 3504`: the whole list). Two days later there are **5**.
The other five were split into barrels, verified by reading the barrels,
not inferred from a commit count:

- `src/kind.js`: 27 lines, pure re-export, cites `ledger-refactor.md`
  "kind-split"
- `src/type.js`: 71 lines (mostly a load-bearing doc comment, see §6c),
  cites `ledger-refactor.md` "type-split"
- `src/compile/program-facts.js`: 86 lines, cites `ledger-refactor.md`
  "program-facts-split"
- `src/compile/representation-plan.js`: 62 lines, cites
  `ledger-refactor.md` "representation-plan-split"
- `src/compile/analyze.js`: 55 lines, cites `ledger-refactor.md`
  "analyze-traversals"

Two more outlier **functions** the handoff named are also independently
verified fixed, not just moved:
- `emitInstanceof` (`src/compile/emit.js:5713`): the handoff cited ~2.1k
  lines; it is now a 5-line dispatcher over three named helpers
  (`emitTagInstanceof` 14 lines, `emitTypedInstanceof` 36 lines,
  `emitErrorInstanceof` 61 lines: 116 lines total, verified by reading
  them).
- `genUpsertStrictPrehashed` (`module/collection/upsert.js:931`): the
  handoff cited ~2.5k lines; it is now 66 lines (a single WAT-template
  string builder).

**Branch-base correction from the landed narrow split**: the original
line-span method conflated two adjacent declarations.
`inferTypedValueRanges` is 181 lines; `narrowSignatures`, immediately after
it in the old file, is the 1,085-line outlier. The split keeps the former
nested because its three phases have no reuse and moves the latter intact
to `src/compile/narrow/index.js` because about 20 closures share one
mutable `sharedSiteState` for a measured self-host performance reason.
`src/compile/narrow.js` is now a 30-line barrel. Four files, not five,
remain over 3,000 lines at `dd92662e`: emit, prepare, core, and the compile
driver.

**Read:** the minimality campaign is real, not aspirational: verified by
reading the current files against the two-day-old baseline, not by
trusting either doc's prose.

### 5.3 Whole-program passes and fixpoint loops, execution order

Four independent driver layers, none aware of the others as a single
engine:

**A. `src/compile/plan/index.js` (445 lines): 38 distinct named passes,
6 region-reclaim rounds, one lazy dirty-bit cache.** Grep-counted
(`(t|sweep)\('name'`, deduplicated): 38 unique pass names invoked from one
function (`plan(ast, profiler, regionHooks)`), wrapped in a hand-rolled
mark/exit "round" mechanism (`round(() => {...})`, 6 call sites) whose
entire job is region-arena memory reclamation for the self-hosted kernel
(comments document per-round retained-memory deltas: "+900MB before
narrowSignatures even starts", "+198 MB", "+~395 MB combined", "+60 MB",
"+22 MB": real accounting, not decoration). A `facts()` getter with a
`_dirty` flag re-derives `collectProgramFacts(ast)` lazily after any
AST-mutating pass reports a change (`sweep(name, pass)`), so the actual
re-collection count is input-dependent, not fixed. In order:
`inferModuleLetTypes` → `inferModuleGlobalValTypes` →
`unboxConstTypedGlobals` → `inferModuleIntGlobals` →
`collectProgramFacts` (first collection) → `classifyHashDictGlobals` →
`flattenFuncNamespaces` → `devirtGlobalCalls` →
`bindNestedRowLengths`/`unrollRowLenPadLoops` (×2 each) →
`inlineHotInternalCalls` → `inlineLocalLambdas` →
`specializeFixedRestCalls` → (if optimizing)
`splitCharScanLoops`/`scalarizeFunctionArrayLiterals`/
`scalarizeFunctionObjectLiterals`/`promoteIntArrayLiterals`/
`scalarizeFunctionTypedArrays` → `buildCallTargetIndex` →
`synthesizeComputedDispatchCallSites` → `releaseLiftedValueUsed` →
`buildDictKindIndex` → `materializeAutoBoxSchemas` → `resolveClosureWidth`
→ [fast exit for simple programs, `canSkipWholeProgramNarrowing`] →
`narrowSignatures` (own internal fixpoint, see B) → `narrowBoolResults` →
round 2: `inferModuleGlobalValTypes` again (name suffixed `2`) /
`analyzeParamDistinctness` / `observeProgramSlots` **rebuilt fresh** /
`analyzeParamNeverGrown` / `scanInplaceStores` / `specializeBimorphicTyped`
→ round 3: `specializeValKindDichotomy` / `speculateTypedParams` /
`refineDynKeys` / `refineFieldProvenance` / `inferModuleLetTypes` **again**
→ round 4: `analyzeSchemaSlotIntCertain` **rebuilt fresh** (second time
this program run) → round 5: `invalidateAllBodyFacts` /
`strictBoundaryTypeCheck` / `adviseProgram` →
`solveRepresentationBoundaries`.

**B. `narrowSignatures` (`src/compile/narrow.js:1798-2991`): phases D
through J, its own 5-call internal worklist fixpoint.**
`runFixpointConverged` (`narrow.js:2371-2412`) is called 5 times (lines
2414, 2473, 2492, 2680, 2715), each time rebuilding a fresh
`sitesByCaller` `Map` from the whole `callSites` array and running a
worklist with a bounded guard (`callSites.length * 64`); exhaustion is a
**hard compiler-bug `err()`**, not a silent fallback (narrow.js:2397): a
real correct-or-reject instance, see §6c. Phases (grep-verified comment
labels): D (call-site propagation), E/E2/E3 (numeric/VAL-kind/pointer
result narrowing), F (cross-call typed-array ctor propagation), G (TYPED
pointer-ABI narrowing), H (post-F/G re-fixpoint), I/I1/I2 (re-narrow after
G), J (jsstring boundary, standalone at narrow.js:2991, runs even when the
rest is skipped).

**C. `src/optimize/driver.js` (`optimizeFunc`, 187 lines): 24 named
per-function passes, fixed order, non-fixpoint, run once per function
during emit.** Not a whole-program pass: sequenced once per function
body, no convergence loop (`hoistInvariantLoop` is called at 4 distinct
points in the fixed sequence, not as a "run until stable" fixpoint). The
file's own comment is explicit about the boundary: "jz's optimizer runs
exactly once, before watr" (driver.js:44-45).

**D. `watr/optimize.js` (external dependency,
`node_modules/watr/src/optimize.js`, 8,677 lines, one file): the only
whole-module fixpoint that runs to actual convergence.** `index.js:23-25`:
"watOptimize... the SOLE, FINAL optimizer: CSE, DCE, const fold, inline,
coalesce. Runs ONCE, as a fixpoint. No jz pass touches WAT after it." jz
does not own this code; it is a pinned `^5.9.3` dependency
(`package.json`).

Outside the driver proper: `src/compile/analyze/` (6 modules, 4,761
lines) runs its passes **per function during `compile()`**, separately
from both A and C (`analyze.js`'s own header: "Ordering: all passes run
per function during compile(). plan.js owns the cross-function dynKey
scan"), and `analyzeSchemaSlotIntCertain`'s own internal
integer-certainty sweep is a *third*, independent bounded fixpoint (≤64
rounds, `ledger-refactor.md` "program-facts-split" §5) distinct from both
narrow.js's worklist (B) and `type/int-certain.js`'s separate local-body
lattice (§5.4).

**Read:** four uncoordinated driver layers (A/B/C/D) plus a fifth
per-function analysis layer outside all of them. None is wrong in
isolation: each has a documented reason (region reclaim for A, monotone
worklist soundness for B, fixed lowering order for C, "don't compete with
watr" for D): but there is no single scheduler; "how many times does
this program get walked" is not answerable by reading any one file. §5.5
measures the result.

### 5.4 Type/kind/representation inference systems: 12 distinct answerers

| # | System | File | Question it answers | Recomputed / overlaps |
|---|---|---|---|---|
| 1 | `valTypeOf`/`valTypeOfWithLocals` | `src/kind/val-type-of.js` | VAL kind (STRING/ARRAY/OBJECT/HASH/BIGINT/…) from AST shape | base layer #7/#8 override; #9/#12 are whole-program siblings for slot/dict shapes it declines |
| 2 | dict/Map value-kind census | `src/kind/dict-census.js` | Kind of values stored in a dict/Map, whole-program | overlaps #9 (`observeProgramSlots`): different data source (kind.js's own 3-prior-revert INVARIANT comment on why they stay separate, cited by dict-kind-index.js:27-29) |
| 3 | JSON shape propagation | `src/kind/shape.js` | Object-literal shape flow (`shapeOf`) | feeds #1 |
| 4 | `exprType` | `src/type/expr-type.js` | WASM i32 vs f64 for a local/param | **duplicate decision point**: see below |
| 5 | integer-certainty lattice (local) | `src/type/int-certain.js` | Is this binding provably an integer, per function body | separate fixpoint from #10 (whole-program slot version) |
| 6 | interval abstract interpreter | `src/type/interval-proof.js` | Provable index/charCodeAt bounds | consumed by #4, #5 |
| 7 | flow refinement | `src/compile/flow-types.js` | `typeof`/`instanceof`/`Array.isArray` guard narrowing per branch | **priority override** on #1: `lookupValType` checks `ctx.func.refinements` before valTypeOf (flow-types.js:14) |
| 8 | per-binding evidence ladder | `src/compile/infer.js` | Function PARAMETER shape from an 8-tier evidence ladder | 2 of 8 tiers are **retired**, in-file (see §6c): a documented unsoundness walk-back, not a design |
| 9 | whole-program slot-kind census | `src/compile/program-facts/slot-kind-census.js` (`observeProgramSlots`) | Per-schema-slot kind, whole program | rebuilt from scratch **twice** per compile (plan/index.js: early gate + round 2 `{fresh:true}`) |
| 10 | whole-program slot-int census | `src/compile/program-facts/slot-int-census.js` (`analyzeSchemaSlotIntCertain`) | Per-slot integer certainty, whole program | separate fixpoint from #5; also rebuilt twice (early gate + round 4) |
| 11 | BigInt representation plan | `src/compile/representation-plan/` (6 files, sole authority per ADR-0001) | raw i64 vs boxed, every edge | the one system explicitly unified from a worse dual-system (§7 item 8) |
| 12 | dict-kind index | `src/compile/dict-kind-index.js` | Per-key kind for an array-literal used as a string-keyed dict | narrower sibling of #2/#9, added because widening either was reverted 3× for unsoundness (own header, dict-kind-index.js:27) |
|: | call-target index | `src/compile/call-target-index.js` | Which function a `.`-member call reaches | not a value-kind system, but a **prerequisite** #1's `VT['()']` reads (`ctx.types.callTargets.resolveMember`) |
|: | function-signature narrowing | `src/compile/narrow.js` phases D-J | Per-call-site-census specialized param/result reps | a later, more precise LAYER on top of #1/#9: both stay live simultaneously (`ledger-refactor.md` "program-facts-split" §7.2: "no reader was found reading either fact before its relevant producer settled": sound only by pass-ordering discipline) |

**The one clean, citable duplicate-decision-point (not just an
"overlap"):** `src/type.js`'s own barrel header (lines 11-39) documents
that **two independent implementations** decide i32-vs-f64 and must be
kept in hand sync: "emit.js DECIDES... exprType here MIRRORS... They
cannot share one function... but they MUST share these rules: edit one
side only with the other open beside it." The soundness direction is
one-way and stated explicitly: "exprType's i32 verdict must be a SUBSET
of emit's... If type says i32 but emit yields f64 [i.e. exprType is too
permissive], the value is trunc_sat-narrowed back → silent miscompile."
This is a real, working, documented safety rule (fails toward f64, not
toward corruption): but it is a manually-maintained invariant across two
files, not a computed-once fact read twice, which is exactly the class of
duplication this audit was checking for.

**Read:** 12 systems answering overlapping "what is this value" questions
is not one dataflow lattice with 12 views into it: several are
independent walks with independent caching, independently reverted for
unsoundness in the past (kind.js's dict census, per its own in-file
INVARIANT comment), and one pair (#4 above) is a hand-synchronized
duplicate by the file's own admission.

### 5.5 `walkAst` instrumented: calls, visits, per source node

`walkAst` (`src/ast.js:121`, the ONE canonical generic array-tree walker -
`enter`/`boundary`/`exit` callbacks, no visited-set) instrumented with
call and visit counters (uncommitted). Driven by
`scripts/_audit-walkast.mjs`: resolves `bench/watr/watr.js`'s module graph
exactly like `bench.mjs` does, counts AST nodes in the resolved source
once (10,234 nodes, via a throwaway walk before the timed compile), resets
counters, then calls `compile()`.

| optimize level | wall | walkAst() calls | array-node visits | visits / source node | calls / source node |
|---|---:|---:|---:|---:|---:|
| `false` (O0) | 0.64 s | 12,942 | 2,932,839 | 287 | 1.26 |
| `1` (min) | 0.72 s | 16,708 | 3,285,923 | 321 | 1.63 |
| `2` (default) | 4.09 s | 156,311 | 10,746,104 | 1,050 | 15.27 |
| `3` (speed) | 5.78 s | 270,828 | 15,270,342 | 1,492 | 26.46 |
| `'size'` | 3.93 s | 56,601 | 7,342,473 | 717 | 5.53 |

The O1→O2 step (where the optimizer gate `optimizing()` turns on) is where
the machine gets heavy: 5.7× the wall time, 9.4× the walkAst call count,
3.3× the visits. **Every source AST node is touched, on average, ~1,492
times somewhere in the pipeline by the time an O3 compile finishes** (this
counts `walkAst` only: every hand-rolled recursive walker that bypasses
it, e.g. `program-facts/walk-facts.js`'s `walkFacts`, documented as unable
to use `walkAst` because it special-cases bare-string leaves, adds more,
uncounted here). 281 call sites across 80 files invoke `walkAst` today; a
rough proxy grep for a locally-defined recursive `visit`/`walk`/`scan`
helper (not a precise count) hits 49 more files, order-of-magnitude
consistent with the pipeline-minimality campaign's own "181 hand walkers"
figure in `ledger-refactor.md` (different methodology, not reconciled
here).

**Top call sites by visit volume** (traced separately, `--trace` mode,
top of 30): the volume is dominated by jz's *own* `src/optimize/`: not
by semantic analysis:

```
1,147,325 visits    3,733 calls  processLoop            src/optimize/licm.js:787
  998,820 visits      830 calls  buildRefcount          src/ir/control.js:30
  831,042 visits      664 calls  hoistInvariantLoop      src/optimize/licm.js:681
  806,577 visits  146,180 calls  hasHardOp               src/optimize/licm.js:204
  640,014 visits      594 calls  nextLocalId             src/ir/control.js:52
  603,379 visits    4,382 calls  containsV128            src/optimize/ir-scan.js:14
  551,270 visits      957 calls  collectGlobalRefs       src/optimize/treeshake.js:110
  498,818 visits    6,362 calls  localRefTallies         src/optimize/locals.js:23
  444,879 visits      758 calls  collectReachableGlobalWrites  src/optimize/globals.js:76
  423,699 visits      404 calls  devirtConstFnArrayCalls src/optimize/devirt.js:536
  378,253 visits   23,841 calls  loopInvariance          src/optimize/licm.js:311
  235,511 visits    9,359 calls  hoistInvariantLoop      src/optimize/licm.js:627 (2nd call site)
```
LICM alone (`src/optimize/licm.js`'s five entries above) accounts for
**~3.40M of 15.27M O3 visits (≈22%)**. `hasHardOp` is called **146,180
times** for 806,577 visits: a small predicate re-walked on overlapping
subtrees far more than it is used for anything new; `loopInvariance` is
called 23,841 times. Neither result is cached across calls within one
`optimizeFunc` invocation (§7 item 4). Two near-identical pairs also show
up as literal double traversal of the same tree inside one pass:
`specializeMkptr` (`src/optimize/specialize-mkptr.js:104` and `:214`) -
210,992 and 210,960 visits, a scan-then-rewrite two-pass structure; the
same shape appears in `static-data.js`'s `scan` (lines 46 and 139,
270,114 visits each) and `devirt.js`'s `devirtSchemaReads` (lines 50 and
227, 266,756 visits each).

### 5.6 CPU profile, O3, watr specimen: where the *time* actually goes

`node --cpu-prof` around the same compile (6,390 ms profiled span, 8,172
samples), self-time attributed via `samples[]`+`timeDeltas[]` (the
`hitCount`-only method under-counted by ~40% on this Node build -
cross-checked). A second, independent measurement via the
`node:inspector` `Session` API scoped tightly around just the `compile()`
call (22,929 ms profiled: 100 µs sampling adds real overhead, ~4×
dilation, so its *absolute* numbers aren't used, only its *proportions* as
a cross-check) reproduces the same split within 1-4 points on every
bucket.

```
stage bucket (by file path)              --cpu-prof (6.39s)   inspector cross-check
watr-optimize.js (whole-module fixpoint)   38.8%                38.7%
watr-util.js (shared walk, opt+encode)     16.2%                16.9%
watr-compile.js (binary encode)            14.8%                10.5%
semantic-compile (jz analyze/plan/narrow)  12.3%                13.5%
jz-ir-optimize (src/optimize/)             11.2%                 9.5%
node-internal (GC, ESM loader, etc.)        4.7%                 9.9%
wat-assemble (src/wat/)                     0.9%                 0.5%

  jz OWN source total:   24.4%   (24.0% in the un-normalized first pass)
  watr package total:    70.1%
```

**jz's own source code is a minority of self-time: the external `watr`
dependency (its whole-module optimizer, shared walk utilities, and binary
encoder) is ~70% of wall-clock, even on a small 10,234-node specimen, not
just at self-compile scale.** Top single functions by self-time:

```
  523.2 ms  8.2%  instr        node_modules/watr/src/compile.js:1127  (binary encode)
  436.6 ms  6.8%  walkN        node_modules/watr/src/util.js:133      (shared walker)
  307.4 ms  4.8%  walkPostN    node_modules/watr/src/util.js:171
  289.4 ms  4.5%  visit        src/ast.js:137                         (jz's own walkAst)
  230.9 ms  3.6%  walk         node_modules/watr/src/util.js:112
  138.9 ms  2.2%  hashFunc     node_modules/watr/src/optimize.js:7311
  119.0 ms  1.9%  rec          node_modules/watr/src/optimize.js:3142
  116.2 ms  1.8%  substGets    node_modules/watr/src/optimize.js:3118
  112.5 ms  1.8%  localidx     node_modules/watr/src/compile.js:1061
   96.1 ms  1.5%  writesOf     node_modules/watr/src/optimize.js:2497
```

This independently corroborates: at a completely different input scale
- what §10 measures for the full 344 s self-build ("About 87% is after JZ
has already built its semantic module"): **the architecture spends more
of its own time outside jz's source than inside it, at any size, not just
at self-compile scale.** The two measurements (§5.5's visit *volume*,
dominated by jz's own `src/optimize/`, vs this section's *wall time*,
dominated by `watr`) are complementary, not contradictory: jz's own
passes generate enormous re-walk volume cheaply; `watr`'s whole-module
fixpoint does comparatively few passes but each is expensive (real CSE
fact tables, hashing, a real multi-round fixpoint over the *entire*
module including all pulled-in stdlib, not just the touched function).

### 5.7 Peak RSS

`/usr/bin/time -l`, same watr specimen:

| | wall | max RSS | peak footprint |
|---|---:|---:|---:|
| bare `import('./index.js')`, no compile | 0.13 s | 93 MB | 59 MB |
| O0 compile | 1.34 s | 362 MB | 349 MB |
| O3 compile | 12.17 s* | 464 MB | 459 MB |

(*`/usr/bin/time` wraps the whole node-counting-prepass + compile driver,
so this wall figure is not the compile-only 5.78 s from §5.5: RSS is
unaffected by that.) ~93 MB is fixed cost of loading a 108K-line compiler
into V8 before compiling anything; O0 adds ~270 MB compiling a
10,234-node program; O3 adds another ~100 MB for the optimizer stages.
Per-node cost at O3: **464 MB / 10,234 nodes ≈ 43.3 KB/node.** Porffor's
own self-hosted bundle (105,069 AST nodes) peaks at 251 MB during
C-emission (evidence.md's Porffor entry): **≈2.39 KB/node, ~18× less per
node.** The two numbers are not a controlled A/B (different compilers
compiling different source graphs, in different target languages), but
both are Node/V8-hosted compiler processes, so the per-node memory shape
is at least directionally comparable, and it lands in the same direction
§3's self-compile-scale numbers already show: i.e. this is not purely an
artifact of self-compile's 162-module scale; the ratio is visible on a
specimen 10× smaller than Porffor's own bundle.

---

## 6. Expert panel review

### (a) IR design: S-expression arrays as the only IR

jz has no typed SSA-ish intermediate representation. The IR *is* the WAT
S-expression tree: nested JS arrays of strings and numbers
(`['i32.add', ['local.get', '$x'], ['i32.const', 1]]`), the same array
shape from `emit.js`'s first emission through `src/optimize/`'s
per-function passes through the final handoff to `watr`. `src/ir.js` is a
46-line barrel over `src/ir/` (11 files, 2,655 lines: `classify.js`,
`coerce.js`, `control.js`, `tag.js`, `sentinels.js`, `pointers.js`,
`numeric.js`, `arrays.js`, `bigint.js`, `locals.js`, `vars.js`): helpers
*around* the array shape (classification, coercion, tagging), not an
alternative to it. Facts about a node (result type, purity, effects,
pointer kind) are carried as **expando properties bolted onto the
array**: `.type`, `.ptrKind`, `.ptrAux`, `.schemaSid`: named directly in
§10's own audit of this same codebase, which already flagged
"metadata-loss and aliasing bugs caused by this shape" as visible in
`src/ir.js`'s own comments.

A value passes through at least four representations before it's bytes:
source AST (subscript/jessie parse tree) → jzify-desugared AST (same
array shape, different ops) → WAT-shaped array with expandos (jz's own
emit + optimize) → the *same* WAT-shaped array, now optimized by an
*external* package that also treats it as an untyped array of strings
(`node_modules/watr/src/optimize.js`) → binary. Optimization is therefore
done twice, by two different programs, on two different pieces of code,
both operating on the same weakly-typed textual/array representation -
never on a representation designed for the query an optimization pass
actually needs ("is this pure", "what's its result type", "does this
alias that"). §5.5 measured the consequence directly: `hasHardOp` (a
purity-ish predicate) is invoked 146,180 times on one 10K-node compile,
`loopInvariance` 23,841 times, neither cached across calls in the same
`optimizeFunc` invocation, because there is no O(1) place to store or
look up "is this subtree invariant": answering it means walking it
again. §5.6 measured the vendor half of the same cost: ~38.8% of total
self-time is `watr/optimize.js`'s own from-scratch CSE/purity/effect
rediscovery on a tree jz already knew the answers for and threw away at
emission.

This is the single highest-impact structural finding in this audit.
Porffor's own architecture (a fixed six-slot `[kind, type, effects, a, b,
c]` node, O(1) queries, no post-hoc optimizer because the constructors
fold as they build: §10 §1-2) is the right comparison class, already
ranked P1 by §10's own ranking ("make the compact HIR real... Keep WAT as
a lowering product, not the first authoritative semantic IR"). This audit
concurs and elevates it: see §8(iii).

### (b) Analysis architecture: accreted layers, not one lattice

§5.3/§5.4 already showed the shape: four uncoordinated driver layers
(plan's 38-pass round-bounded driver, narrow's 5-call worklist fixpoint,
the per-function optimizer sequence, and the external whole-module
fixpoint), plus 12 overlapping type/kind/representation systems.
`ledger-refactor.md` "program-facts-split" §7 ("Freeze audit") is the
clearest first-party evidence of what this costs: `programFacts`: the
object nearly every pass above reads and writes: is, in the authors' own
words, "a shared mutable bag the next edit can silently misuse," whose
`paramReps`/`callSites`/`callTargets` fields are written by **producers
in at least three different pipeline stages** (plan, narrow.js, and a
fourth, post-`plan()` EMIT-phase writer, `specializeUnionCursorParams`,
called from `src/compile/index.js:2556`: outside `plan()` entirely). The
freeze audit's own conclusion: soundness today rests on **"pass-ordering
discipline, not... construction"**: i.e. the architecture is correct
because every existing call site happens to run in the right order, not
because the type system or a container contract makes the wrong order
inexpressible.

The remediation the team already shipped is itself evidence of the
underlying problem's shape: since neither `Proxy` nor
`Object.seal`/`preventExtensions` exist in the self-hostable subset, and
`Object.freeze` is an **identity no-op** under self-host
(`module/object.js:294-299`, "jz objects have no per-property
[protection]"), the only available enforcement is a **read-only view
wrapper** (`{ get: k => paramReps.get(k) }`, swapped in for three plan
rounds and swapped back to the real mutable `Map` before `plan()`
returns) plus a **debug-only** (`JZ_DEBUG_INVARIANTS=1`) `Object.keys`
allowlist scan. This is a real, working mitigation for a real,
correctly-diagnosed problem: but it is a runtime convention bolted onto
a language that cannot express "this object is closed," standing in for
a static guarantee a typed IR (or even a closed record shape enforced by
construction, e.g. always rebuilding a frozen plain object instead of
mutating one in place) would give for free. The
`analyzeSchemaSlotIntCertain`/`observeProgramSlots` census pair being
rebuilt **from scratch twice** in one compile (§5.4, #9/#10: once in the
early gate, once "fresh" post-narrowing) is the same pattern at smaller
scale: it's cheaper to re-derive a whole-program census than to
reconcile its incremental update with everything that ran since the
first version was published, because there is no incremental dataflow
engine to ask.

### (c) Inference soundness: real correct-or-reject, not centralized

STABILITY.md is unambiguous and, per this audit's reading of the actual
mechanisms, largely honored: "Where the compiler cannot [preserve JS
semantics], it must reject rather than silently choose a representation
or value. Any unlisted silent wrong value is release-blocking." This
shows up as working code, not just policy: `runFixpointConverged`'s
guard-exhaustion path (`narrow.js:2397`) is a hard `err()`, not a
degrade-to-approximate; the call-target index and dict-kind index headers
both describe "never guessed... poisons... back to unresolved" designs
(`call-target-index.js:30-36`, `dict-kind-index.js:27-32`); `src/type.js`'s
duplicate-decider (§5.4) fails *toward* the safe side (f64) by an
explicit, load-bearing one-way rule.

But there is **no single arbiter**: "reject" is implemented
independently, dozens of times, once per analysis module, each with its
own bail/poison/decline vocabulary. `src/compile/infer.js`'s own doc
comment is the most candid first-party evidence available: its 8-tier
"evidence ladder" records, in the source itself, that tiers 2 and 3
(operator-use and member-access induction: "`s.charCodeAt(...)` used to
induce STRING") are **`[retired]`**, walked back on branches
`fix/string-method-guess` and `fix/param-mutation-propagation` after they
were found unsound in production ("a plain OBJECT/HASH can own a
same-named closure property, so usage alone never proves it"): both
families now tracked in `ledger-correctness.md`. That is the honest
answer to "where was guessing retired": iteratively, one evidence source
at a time, discovered by bug, not by one architectural sweep that made
guessing structurally impossible elsewhere. `kind.js`'s in-file INVARIANT
comment on `dictValueTypes`/`dictValueKindOf` recording **three prior
reverts for unsoundness** (cited verbatim by `dict-kind-index.js:27-29`)
is the same pattern a second time. The soundness *doctrine* is uniform
and real; the soundness *mechanism* is one bespoke predicate per module,
not one typed lattice with one join operator and one bottom value.

### (d) Stdlib-in-dialect and dispatch tiers

The stdlib (`module/`, 29,274 lines) is written in jz's own dialect and
self-hosts through the same pipeline as user code: a real, working "eat
your own dog food" design, and CONTRIBUTING.md documents its registration
surface honestly: **~580 raw `ctx.core.emit[name] = fn` /
`ctx.core.stdlib[name] = body` sites** (the default, for dep-free,
arity-agreeing handlers) versus **~35 `reg()`/`wat()` calls** (required
whenever deps must auto-include or arity is non-obvious): "this is real,
not legacy-to-migrate," per the doc, and the file backs that framing:
`src/ctx.js`'s `registerName` throws immediately, naming both modules, on
any second write to an already-registered FLAT name, closing a real
historical bug class ("it corrupted `.valueOf()` on every unresolved-type
receiver for as long as it shipped": CONTRIBUTING.md's own account). A
raw-write clobber of a guarded `reg()` handler still can't be caught
synchronously (no Proxy: same limitation as §6b), so a post-hoc
`verifyEmitIntegrity` sweep runs after every module's `init()` returns to
catch it retroactively. Two dialects by design, with one now-enforced
invariant and one after-the-fact backstop for the one case that can't be
enforced live: a reasonable trade given the language's own constraints,
not an oversight.

Method-call dispatch, measured directly (`src/compile/emit.js:4671`
`emitMethodCall`, `LEADING_STRATEGIES` 4029 + `TYPED_STRATEGIES` 4648):
**14 named strategies, first-match-wins, in a fixed order**: 5
context-free (`tryFlatObjectMethod`, `tryConcatBufCharCodeAt`,
`tryCharCodeAtFast`, `trySpliceInsert`, `tryFnPropCall`) then 9 keyed off
the receiver's statically-resolved value kind (`tryBoxedDelegate`,
`trySidecarToPrimitive`, `tryStaticDispatch`, `tryRuntimePtrTypeFork`,
`tryRuntimeNumberMethod`, `trySchemaClosureCall`, `tryGenericEmitter`,
`tryDynamicPropCall`, `externalMethodFallback`: the last one total). Most
of these resolve entirely at **compile time**: the compiler picks the one
strategy that applies and emits code for only that path: this is not 14
runtime branches. The generic-dispatch *cost in emitted code* shows up
only when the receiver's kind genuinely can't be proven: compiling
`export const f = (x) => x.slice(1, 2)` (a deliberately unresolvable
receiver) emits a NaN-box tag runtime fork (`tryRuntimePtrTypeFork`,
emit.js:4200-4270) that must ship **both** `__str_slice` and
`__typed_slice_rt` kernels: every kind the value could dynamically be,
not one shared generic path: plus the allocator. Measured: 11 functions,
and (thanks to tree-shaking + `watOptimize`) a 1,990-byte final binary -
the per-call-site *dispatch-fork* cost is real but the *total* stays
small because it's tree-shaken and shared once compiled, not duplicated
per call site with a distinct receiver in the same function. The
dispatch tier count is a genuine complexity cost to a reader of `emit.js`
(14 strategies to hold in your head to know what a given `.method()` call
becomes); the runtime cost it produces in real programs is smaller than
the tier count suggests, because most receivers *are* proven.

### (e) Codegen quality vs. state of the art

What jz has that's genuinely general, verified by reading, not by the
README's own marketing: `src/optimize/arena-rewind.js`: module-level
escape analysis is a real whole-program fixed-point over a call graph
("propagating 'arena-safe callee' status via fixed-point iteration," not
a per-bench recognizer), classifying every function as
arena-safe/rewindable generically. That is a legitimate general
technique, in the same family as what Binaryen's `heap2local` does for GC
structs, scoped to jz's own bump-arena model.

What's recognizer-based, not general: the vectorizer
(`src/optimize/vectorize/`, **24 files, 8,613 lines**: almost as large
as watr's *entire* external optimizer, 8,677 lines) is a named-pattern
dispatcher (`aos.js`, `blur-channel.js`, `butterfly.js`, `dot-slp.js`,
`idioms.js`, `map.js`, `memcpy.js`, `outer-strip.js`,
`per-pixel-color.js`, `ramp.js`, `reduce.js`, `stencil.js`,
`strength-reduce.js`, `tone-map.js`, …) tried in order
(`CONTRIBUTING.md`'s own "Adding an auto-vectorizer recognizer" section
confirms this is the intended extension model: a new idiom is a new file
and a new dispatch entry, not a generalization of an existing one).
README's own optimization list documents the boundary explicitly:
"Loop-carried dependencies remain scalar": a real, self-admitted gap
versus a general dependence/reassociation-based auto-vectorizer.
`CONTRIBUTING.md`'s own coverage note lists concrete open items in the
same vein: i32x4 cellular automata (game-of-life/ising/rule30) as
"feasible," and gather/scatter loops (dla/sand/voronoi) as infeasible
**on this ISA** (WASM-SIMD has no gather/scatter: correctly attributed
to the target, not the compiler).

Inlining is three narrow, named heuristics (`inlineHotInternalCalls`,
`inlineLocalLambdas`, `specializeFixedRestCalls`, all in
`src/compile/plan/inline.js`): no general cost-modeled whole-program
inliner. There is no SSA form anywhere in the pipeline, so no GVN/PRE
beyond what `watr`'s external CSE happens to find on the WAT-array shape.

Binaryen comparison, measured locally (`wasm-opt --version` → 128
installed at `/opt/homebrew/bin/wasm-opt`, not recalled from memory):
`wasm-opt --help` lists **271** flags, the large majority genuine
IR-level passes: `heap2local` (GC scalar replacement / escape analysis,
general), `gufa` ("Grand Unified Flow Analysis," whole-program
flow-sensitive type refinement), `dfo` (SSA-based DataFlow optimization),
`directize` (devirtualize indirect calls generally), `code-folding`,
`inlining-optimizing` (budget-driven whole-program inlining),
`dae`/`dae-optimizing` (dead-argument elimination). jz relies on `watr`'s
external, closed, 8,677-line `optimize.js` for CSE/DCE/const-fold/inline/
coalesce as its *only* whole-module fixpoint (§5.3 driver D): a single
file with an unknown (un-audited by this session; out of scope, it's not
jz's code) internal pass list, almost certainly smaller and less general
than Binaryen's, and jz has **no visibility or control** over what that
file does or doesn't do, only what it hands it. Nothing in the pipeline
plays Binaryen's `wasm-opt -O` role *for jz's own emitted IR before* the
handoff to `watr`: jz's own `optimizeFunc` (§5.3 driver C) is explicitly
non-fixpoint, one fixed pass per function, by design (driver.js:44-45).

### (f) Self-hosting economics

Covered with full measurements in §3 and §5.6/§5.7 above. Verdict: the
100×-class gap against Porffor is real, mostly not input-size, and ~87%
of it sits *after* semantic compilation finishes (whole-WAT optimize + a
snapshot probe + final encode). §5.6's own profile shows the identical
shape at 1/40th the scale: the self-build's economics are the
steady-state pipeline shape multiplied by 162 modules, not a
scale-emergent pathology. The Wasm-hosted jz×jz recursive self-compile
has never produced output (traps at 4 GiB): the single largest
unresolved item in this codebase by any measure (release-blocking per
STABILITY.md, not a style preference).

### (g) Codebase size relative to what it does

108,446 lines (§5.1) to compile a deliberately *finite* JS subset to Wasm
- compare AssemblyScript (a much larger surface: full TypeScript-flavored
syntax, its own standard library, a Binaryen-backed backend it doesn't
have to write) and Porffor (currently ~2.1 MB selfhost bundle, closer to
jz's order of magnitude, also self-hosting a JS-subset-to-native
compiler). jz's own README frames the tradeoff correctly for *language*
surface: "A finite speed dialect, not an open-ended escape hatch": but
the **inference and representation-planning machinery** (§5.4's 12
systems, `narrow.js`'s 4,027 lines, `emit.js`'s 8,167) is what a *sound,
no-annotation* type/representation inferencer over untyped JS costs, and
that premise (infer, don't annotate) is the single largest cost driver in
the LOC total, not the language surface itself. The file-size trend
(§5.2: 10→5 files over 3k lines in two days) is real evidence the team is
actively cutting this, not merely aware of it.

### (h) Testing/gating culture: strengths and blind spots

**Strengths, verified by reading the mechanism, not the claim:**
`scripts/refactor-oracle.mjs` proves byte-identical compiled output
across the whole corpus at every optimize level between two trees: a
real, structural "this refactor changed nothing observable" proof, not a
test suite that merely didn't fail. It is explicit about its own boundary
(`ledger-refactor.md` "refactor-oracle"): excludes the self-host compile
*by default* purely for cost (68 s at O0, 246 s at O3, opt-in via
`--full`): a deliberate, documented, sized tradeoff, not a silent gap.
STABILITY.md's correct-or-reject contract is CI-gated (test262: exactly
3,908 applicable negative-parse rejects / 137 accepts, "an exact path
set, not a count ceiling": regressions AND *improvements* both require
updating the pinned ledger, closing the easy failure mode of a ratchet
that only tightens on paper). `test/bench.js`'s claims ratchet
(`win`/`tie`/`near`/`todo`, "a PR may not move any claim backward") is a
real anti-backslide mechanism.

**Blind spots, self-documented by the team, not discovered here:**
`ledger-refactor.md`'s "refactor-oracle" section states its own limits
plainly: "cannot prove... runtime behavior of host-nondeterministic
paths" and, more importantly, "cannot prove correctness of either
side... a refactor that reproduces an existing bug exactly is reported
clean." Byte-identity is a *non-regression* proof, not a correctness
oracle: `kernel-oracle`/`kernel-parity` exist precisely because
byte-identity alone is insufficient, but that means the safety net has
two different meshes stacked, not one uniformly fine one. The 2026-08-26
audit (plan.md) records a real instance of the mesh gap doing damage: "P0
kernel-target regression: recursive OBJECT-schema fails self-hosted only
(test:wasm 2913/1)... batteries MUST include the FULL kernel-target suite
from now on (the gap that let this land)": i.e. a real wrong-value bug
shipped past the existing gates *because* the self-hosted-only battery
wasn't part of the default gate at the time, and the fix was procedural
("must include," going forward) more than structural. As of the same
audit snapshot, one open `KNOWN-WRONG` pin remained. By `dd92662e`, later
porting work had pinned three additional families, bringing the live total
to four. They are listed in §4 and `ledger-correctness.md`; none is treated
as complete.

---

## 7. The overdone list

Each item: what it costs today (measured or cited), what would replace
it, what breaks if it's simply deleted. Two items below are explicitly
**not** overdone on inspection: included because they look like obvious
targets and are not; pattern-matching "big subsystem = cut it" is wrong
here twice.

**1. Two independent i32/f64 deciders (`emit.js` vs
`src/type/expr-type.js`).** *Cost:* not lines (both are needed
regardless): the cost is a standing synchronization obligation,
documented by the file itself as something a human must maintain by
discipline ("edit one side only with the other open beside it,"
`src/type.js:16-39`) rather than something the compiler enforces. This is
exactly the shape of bug the "recomputed elsewhere" question in this
audit was checking for, and jz's own authors already found and fixed one
instance of the class it produces: the "opaque dispatch recovery" entry
in `archive/handoff-2026-08-22.md` ("Numeric use called `__length_num →
__length → __to_num`, repeating dispatch on ARRAY hot paths... the mere
existence of an unrelated durable rep hid higher-priority flow facts") is
a lookup-priority bug in the same family: not this exact duplicate, but
proof the two-deciders-for-one-fact pattern in this codebase has produced
real, shipped, measured regressions (recovered ~3 percentage points of
warm perf) before. *What would replace it:* one decision function
`emit.js` calls to both decide-and-emit and to answer "what will you
decide" before emission: i.e. collapse "decide" and "predict" into one
call with two call sites, not two implementations. The blocker the file
itself names is real: `emit` reads IR values (`isLit`/`maskBound`) that
don't exist before emission, `exprType` reads AST
(`staticValue`/`intExprRange`) needed *before* local types can be sized.
*What breaks if merged carelessly:* the ordering constraint is real, not
laziness: locals must be typed before their home function is emitted,
so a merge needs either a two-phase decider (predict now, confirm during
emit, assert agreement in debug builds: cheaper than what exists today,
which asserts nothing, it just documents the invariant in prose) or
restructuring emission to defer local typing. Scope for §8.

**2. `plan()`'s 38-pass, 6-round monolith with a hand-rolled dirty-bit
cache (`src/compile/plan/index.js`, 445 lines).** *Cost:* 445 lines of
pure orchestration (not counting the ~30 pass implementations it calls),
a bespoke `facts()`/`_dirty`/`sweep()` re-derivation cache that every new
whole-program fact must be manually wired into to know when to
invalidate, and (per §5.3) a whole-program re-collection whose actual
frequency is input-dependent and only knowable by tracing, not by reading
the driver. *What would replace it:* a real incremental/worklist
dataflow engine parameterized by named lattices + transfer functions, so
"does fact X need to be recomputed after pass Y ran" is answered by
declared dependencies, not by each pass author remembering to call
`sweep()` correctly. *What breaks if removed naively:* the
`round()`/`exitRound()` region-arena reclaim boundaries are **not**
ceremony: the inline comments document real, measured retained-memory
deltas per round (+900 MB, +198 MB, +395 MB, +60 MB, +22 MB) that matter
*only* because the self-hosted kernel has no garbage collector
(`CONTRIBUTING.md`: "No runtime... compiled WASM has no jz-specific
runtime": a load-bearing product principle the team has explicitly
chosen, not an oversight). Any replacement driver needs the *same*
reclaim hooks; this is "overdone" only relative to a hypothetical GC'd
self-host runtime the project has already, correctly, declined to build.
Simplify the scheduling logic, keep the reclaim discipline.

**3. The narrow outlier was misidentified in the audit snapshot.** The
landed split's declaration-aware scan found `inferTypedValueRanges` is 181
lines, while `narrowSignatures` is 1,085 lines. The former stays nested:
its three phases run once in fixed order and hoisting them adds interfaces
without reuse. The latter remains the real outlier, but about 20 nested
closures deliberately share one mutable `sharedSiteState`; the source
records that fresh per-site objects were the largest attributed HASH
sidecar source in self-hosted narrowing. *What would replace it:* first
audit whether a parameter-threaded decomposition preserves that reuse and
the warm-instance cap. *What breaks if split mechanically:* self-host
compile time and memory can regress even if output remains byte-identical.
This is an audit target, not a pure extraction.

**4. Uncached hot predicates inside one optimizer pass (`hasHardOp`,
`loopInvariance`, `src/optimize/licm.js`).** *Cost:* measured directly
(§5.5): 146,180 calls / 806,577 visits and 23,841 calls / 378,253
visits respectively, in one 10,234-node O3 compile, none of it cached
across calls within the same `optimizeFunc` invocation on the same
function body. LICM's five hot entries together are ~22% of all O3
`walkAst` visit volume. *What would replace it:* a `WeakMap<node, bool>`
(or an expando flag, matching the existing `.type`/`.ptrKind` convention
on IR nodes, §6a) scoped to one `optimizeFunc` call, invalidated per
function (bodies aren't mutated concurrently within one call). *What
breaks if removed:* nothing semantic: this is pure redundant work, the
safest class of finding in this audit (§8(i), same-day).

**5. Duplicate scan-then-rewrite double traversals inside single
passes** (`specializeMkptr` at `src/optimize/specialize-mkptr.js:104`/
`:214`, `static-data.js`'s `scan` at lines 46/139, `devirt.js`'s
`devirtSchemaReads` at lines 50/227). *Cost:* measured (§5.5): each pair
visits the *same* tree twice for ~210-270K visits per pair, per compile.
*What would replace it:* `walkAst` already supports this in one call -
`enter` for the scan (collect candidates), `exit` for the rewrite
(post-order, sees rewritten children first, exactly the ordering these
passes already want). This may be a same-file, same-pass mechanical
change per site, not a redesign. *What breaks:* needs per-site
verification that the scan phase doesn't depend on having *finished*
scanning the whole tree before any rewrite starts (a real possible reason
for the two-pass split: not yet verified per site, flagged for the
implementing agent, not assumed safe here).

**6. Relying on `watr/optimize.js` (external, 8,677 lines, unaudited by
jz) as the *only* whole-module fixpoint.** *Cost:* §5.6 measured ~38.8%
of total self-time inside this one external file, plus ~16.2% in its
shared walk utilities: a majority of wall-clock time in code jz does not
own, cannot restructure, and (per `index.js`'s own architecture comment)
has deliberately chosen not to duplicate ("jz's optimizer runs exactly
once, before watr... watr is the sole optimizer that runs after"). This
is not obviously wrong: §10's own "what not to copy" list is explicit
that direct Wasm quality (not "trust a downstream tool") is jz's actual
claim, and that discipline is *why* jz's own SIMD/LICM/escape passes
exist instead of hoping `watr` finds those opportunities. But the
practical effect today is **two optimizer budgets paid on every
compile**: jz's own 24-pass non-fixpoint sequence (§5.3 driver C), then
watr's from-scratch whole-module fixpoint that re-derives CSE/purity
facts jz already had and discarded at emission. *What would replace it:*
not "remove watr" (§8(iii) explains why that's the wrong first move) but
reducing how much rediscovery watr has to do: feed it a module where
jz's own passes have already reached local fixpoint and folded what's
cheaply foldable, so the external pass's work shrinks proportionally to
what jz's own passes actually close out. *What breaks if watr were simply
dropped:* everything: it is the only pass in the pipeline that runs to
convergence; without it the compiler ships whatever jz's single
fixed-order per-function pass happened to leave behind, and per
index.js's own comment this is by design not accidental, so dropping it
is not a simplification, it is a regression.

**7. The SIMD vectorizer's recognizer sprawl (`src/optimize/vectorize/`,
24 files, 8,613 lines).** *Cost:* nearly as large as watr's entire
external optimizer (8,677 lines) spent on named, order-tried pattern
recognizers (`aos.js`, `blur-channel.js`, `butterfly.js`, `dot-slp.js`,
`outer-strip.js`, `per-pixel-color.js`, `ramp.js`, `stencil.js`,
`tone-map.js`, …) rather than one general dependence-based
auto-vectorizer. Every new loop shape not already matched by an existing
recognizer needs a *new file* (`CONTRIBUTING.md`'s own extension guide
confirms this is the intended workflow, not an accident). README already
documents the resulting gap honestly ("Loop-carried dependencies remain
scalar"). *What would replace it:* this is the one item in this list
where "replace with something more general" is a multi-month research
project (a real polyhedral/dependence-and-reassociation-based loop
vectorizer), not a refactor: see §9 for the ranked bench-impact case,
and §8(iii) for why this is re-architecture-class, not a slice. *What
breaks if merely deleted:* every already-shipping bench win attributed to
a specific named recognizer (stencil, outer-strip, tone-map are all named
directly in the CLI flags and README options table as stable,
user-visible knobs): this is not dead code, it is a real, working,
product-facing capability; the "overdone" claim here is about the
*pattern* (one file per idiom, unbounded growth) not about any individual
file being wasteful.

**8. NOT overdone, on inspection: the BigInt representation
subsystem** (ProgramIndex boundaries plus `src/compile/representation-plan/`
body facts, disjoint per ADR-0001). This *looks* like a
dedicated subsystem for one narrow value kind and would be an easy target
by pattern-matching alone. It is not: the "one representation authority -
complete" entry in `archive/handoff-2026-08-22.md` records that this
subsystem is what **replaced** a *worse*, dual-implementation predecessor
(a hand-built sentinel ABI plus a separate `bigintBoxed` field, deleted
end-to-end across "the final census result sentinel ABI (`jz:i64exp.s`,
layout tables, interop decoder and hand-built wrapper)... bare, unary and
joint results all use the generic tagged decode": net **−755 lines**
across that completion, `dist/jz.wasm` shrank 17,115.3→17,082.8 kB). What
exists today is the simplification of a previously-worse system, already
measured and landed. It is a good template for what §8's slices should
look like (single authority, `KEEP/BOX/UNBOX/HOST_BOX/REJECT` per edge,
one decision, no shadow state): not a simplification target itself.

**9. NOT overdone, on inspection: the outlier "giant functions" the
handoff flagged.** `emitInstanceof` and `genUpsertStrictPrehashed` were
both independently re-verified in this session (§5.2) as already reduced
from ~2.1k/~2.5k lines to 116/66 lines respectively. Listing them here
would have been citing a two-day-stale number as current. Recorded so
the next reader doesn't re-discover and re-report an already-closed item.

---

## 8. The simplification plan

### (i) Start today, land within a day: mechanical, low-risk, refactor-oracle-gated

| Slice | Scope | Files | LOC Δ | Expected effect | Gate | Effort | Deps |
|---|---|---|---|---|---|---|---|
| **1. Memoize `hasHardOp`/`loopInvariance`** | Cache the predicate per node within one `optimizeFunc` call (§7.4) | `src/optimize/licm.js` | +15/-0 | Cuts a slice of the measured ~3.40M LICM-family visits (≈22% of O3's 15.27M); expect measurable O3 wall-time drop on `watr`-class specimens, no RSS regression (cache is function-scoped, freed per function) | `refactor-oracle.mjs check` byte-identical (pure perf, zero behavior change) + before/after wall time on `bench/watr` | 2-4 agent-hours | none |
| **2. Collapse `specializeMkptr`'s two-pass scan+rewrite** | One `walkAst(enter, exit)` call instead of two separate walks (§7.5) | `src/optimize/specialize-mkptr.js:104,214` | -10/-0 | -~211K visits/compile (~1.4% of O3 total) | refactor-oracle byte-identical | 2-3 agent-hours | verify scan doesn't need whole-tree-complete state before any rewrite starts (check before assuming safe) |
| **3. Same collapse for `static-data.js`'s duplicate `scan`** (lines 46/139) | `src/wat/assemble/static-data.js` | -10/-0 | -~270K visits/compile | refactor-oracle | 2-3 agent-hours | same caveat as #2 |
| **4. Same collapse for `devirt.js`'s `devirtSchemaReads`** (lines 50/227) | `src/optimize/devirt.js` | -10/-0 | -~267K visits/compile | refactor-oracle | 2-3 agent-hours | same caveat as #2 |

Slices 1-4 together remove on the order of 750K-1M redundant `walkAst`
visits per O3 compile of a watr-sized specimen (~5-7% of the measured
15.27M) for under two agent-days total, at effectively zero risk (pure
caching / traversal-shape changes, no decision logic touched,
oracle-provable).

### (ii) Multi-day, incremental, behind fuller gates

| Slice | Scope | Files | LOC Δ | Expected effect | Gate | Effort | Deps |
|---|---|---|---|---|---|---|---|
| **6. Unify the i32/f64 dual-decider** (§7.1): first land a debug-only assert that `exprType`'s verdict and `emit`'s actual choice agree (cheap, catches drift immediately), then work toward one shared decision path | `src/type/expr-type.js`, `src/compile/emit.js` (`mulFitsI32`/`addFitsI32` area), `src/ir.js` | net negative once merged, but the intermediate assert step is +~20 | Closes the standing sync-bug class the file's own comment documents as a real risk (§7.1 cites a prior shipped regression in the same family) | **Full battery + kernel-parity + kernel-oracle + refactor-oracle** (not byte-identical alone: this is semantics-adjacent, not pure perf) | 1-2 agent-days for the assert step; the full merge is a second, separately-gated slice after the assert has run clean for a while | none blocking, but treat as high-care given the file's own explicit warning |
| **7. Always-on `programFacts` shape/freeze check** (§6b): promote the existing `JZ_DEBUG_INVARIANTS`-gated allowlist scan to a cheap always-on check (or prove it's cheap enough to always run); this is the team's own handoff gate-5 finding, re-affirmed here, not new | `src/compile/program-facts/freeze.js`, `src/compile/plan/index.js` | +~10 | Closes (rather than just documents) the "shared mutable bag" soundness risk `ledger-refactor.md`'s "program-facts-split" §7 names as a real, if not-yet-triggered, hazard | Full battery; must show negligible perf delta (it's a hot path) or gate it behind `optimizing()` off-path only | 0.5-1 agent-day | none |
| **8. Precompiled, compressed, lazily-decoded stdlib IR** (Porffor pattern #4 below, existing team ranking: P0): targets the `pullStdlib` churn measured at ~927 MB during self-compile | `module/*`, `src/wat/assemble/stdlib-pull.js`, new build-time generator (precedent: `scripts/gen-prop-modules.mjs` + `src/prop-modules.generated.js` + its freshness test `test/self-compile-includes.js`: the exact "generated table + freshness gate" pattern this needs) | new generator (~300-600 est.), stdlib pull path simplifies | Reduces self-compile memory churn; effect on everyday small compiles likely small (stdlib pull is already demand-gated per-symbol, this compresses *what's decoded*, not *whether*) | refactor-oracle + a new freshness test in the `self-compile-includes.js` family (source vs generated table must never silently drift) | Multi-day: new serialization format + round-trip tests + the generator itself | Should land *after* slice 9's HIR work reaches its "fact schema" milestone if both are in flight: the packed format wants to target the same fact shape, not be designed twice |
| **9. Demand-first function generation / one frozen reachability index before emission** (Porffor pattern #3, existing team ranking: P0): jz currently emits every entry in `ctx.funcs.list` then tree-shakes after (`src/compile/index.js:2619+`); build the reachability index first and skip emission of provably-unreachable functions | `src/compile/index.js` (emit driver core), `call-target-index.js` | net negative (removes emit-then-discard work) | Fewer functions pay analysis/IR-allocation cost before being discarded; self-compile-scale effect likely larger than everyday-compile effect (self graph ≈2,234 functions) | Full battery + kernel-parity + kernel-oracle + self-compile timing before/after | Multi-day, touches the emit driver's core sequencing | **Must** consume `RepresentationPlan` + the canonical `call-target-index.js`: explicitly no name-guess fallback (this is the existing team audit's own condition, repeated here because it's the right constraint, not because it's new) |

### (iii) Re-architecture: say so plainly, with a migration path

**10. Compact typed HIR, replacing WAT-array-with-expandos as the first
semantic IR** (§6a, Porffor pattern #1). This is the single
highest-impact item in the whole audit and it is **not** a slice: it
touches essentially every file under `src/compile/`, `src/optimize/`,
`src/wat/` (>60K lines combined). Effort: multi-month, many-agent-week
campaign. Say so plainly: do not schedule this as if it were slice-sized.
Migration path, phased so the compiler stays shippable throughout:
  1. Define the fixed-shape node (opcode, result representation,
     provenance, effects as dense fields) as an **additional** layer
     alongside the existing WAT array, not a replacement: every node
     still carries its WAT-array form.
  2. Build a differential fact-checker (dev-only): for a chosen fact
     (start with purity/effects: the highest-measured redundant-recompute
     cost, §5.5's `hasHardOp`/`loopInvariance`), compute it both the old
     ad-hoc way and read it off the new HIR field, assert equality on the
     whole corpus. This tool is itself a real deliverable and should land
     *before* any consumer migrates: it is what makes every subsequent
     step provable rather than hopeful.
  3. Migrate one fact family at a time to read from the HIR field instead
     of re-walking, starting with the family §5.5 shows costs the most
     (LICM's purity/invariance checks). Each migration is its own
     refactor-oracle-gated slice.
  4. Only once every consumer of a given expando (`.type`, `.ptrKind`,
     `.ptrAux`, `.schemaSid`) has moved to the HIR field does that expando
     get retired. WAT stays the lowering target, produced from the HIR at
     the very end: matching Porffor's own framing exactly ("Keep WAT as
     a lowering product, not the first authoritative semantic IR").
  Gate for the *whole* campaign, not just its slices: the differential
  fact-checker from step 2 must show zero disagreements across the full
  corpus for a sustained period before any expando is deleted, in
  addition to refactor-oracle/kernel-parity/kernel-oracle at every step.

**11. Reduce what's handed to `watr`, as an experiment before any
commitment to owning convergence** (§7.6). Do **not** start by trying to
replace or absorb `watr/optimize.js`: jz's own architecture doc is
explicit that this split is deliberate (index.js:23-25). Instead: as a
measurement, make jz's own `optimizeFunc` sequence loop to a real
per-function fixpoint (run the 24-pass sequence repeatedly until no pass
reports a change, bounded) and measure whether `watOptimize`'s share of
wall time (§5.6: currently 38.8%) drops proportionally on the same
corpus. If it does, that's real evidence for gradually absorbing more
convergence responsibility into jz's own (typed, once the HIR from #10
exists) optimizer over time. If it doesn't, the "two budgets" framing is
less actionable than §7.6 suggests and effort should redirect to #10/#8
instead. Effort for the experiment alone: 2-3 agent-days; the full
re-architecture this might justify is multi-month, same caveat as #10.

**12. General dependence-based loop vectorizer** (§7.7, §9).
Re-architecture class, not a slice: building a real
dependence/reassociation-based vectorizer is a multi-month research
effort, and it would likely *grow* `src/optimize/vectorize/` before
enabling any deletion (the general framework has to prove it subsumes
specific recognizers bit-exact, per `CONTRIBUTING.md`'s own existing
discipline, before those recognizer files can retire). Migration path:
build the general framework alongside the existing 24 recognizer files;
prove bit-exact subsumption of 2-3 recognizers first (start with the
simplest, e.g. `map.js`); retire subsumed files one at a time, each its
own gated slice. See §9 for why this ranks where it does on expected
bench impact specifically (loop-carried-dependency cases are a
self-documented, currently-scalar gap).

### Porffor patterns: judged individually, not as a package

| # | Pattern | Verdict | Reasoning |
|---|---|---|---|
| 1 | Fixed six-slot typed/effect IR | **Adopt** | This audit's own §6a/§5.5 evidence (uncached `hasHardOp`/`loopInvariance`, expando-property IR) independently arrives at the same conclusion §10's own ranking already gives P1. Concur; place it first in §8(iii). |
| 2 | Optimize-while-constructing, no post-hoc optimizer | **Adapt, not adopt whole** | jz cannot drop its optimizer: direct Wasm quality is the stated product claim (§10's own "what not to copy" list agrees). The *transferable* half: fold obvious garbage (dead conversions, constant chains) at IR-construction time, before any pass has to rediscover it: is cheap and compatible with keeping a real optimizer; adopt that half only. |
| 3 | Demand-driven function/builtin generation | **Adopt** | Concur with existing P0 ranking; independently motivated here by this session's own measurement that jz emits every `ctx.funcs.list` entry before tree-shaking (§8(ii) slice 9). |
| 4 | Precompiled/compressed/lazily-decoded builtins | **Adopt** | Concur with existing P0 ranking; targets a previously-measured real cost (`pullStdlib` churn). Scoped as §8(ii) slice 8, sequenced after the HIR's fact schema stabilizes so the packed format isn't designed twice. |
| 5 | Static selfhost linking (one bundled source pre-compile) | **Adapt** | Real shipping-build accelerator, but the existing team framing is exactly right that it must never replace the 162-module jz×jz acceptance gate: that gate is what's currently proving (or failing to prove, at 4 GiB) the thing that actually matters. Adopt as a *fast path*, never as a substitute measurement. |
| 6 | Scoped typed-temp reuse | **Adopt** | Straightforward, low-risk, standard compiler technique (mark/release lifetimes on a per-function temp pool); the existing team condition (preserve source evaluation order, land behind exact IR-parity tests) is the right gate. |
| 7 | Direct-only ABI specialization via escape-proof call scan | **Reject wholesale copy: jz's existing mechanism is already more precise** | `RepresentationPlan`/`FunctionPlan` (§5.4 table, systems #4/#11 and narrow.js phases D-J) already do call-site-census-driven param specialization with a sounder provenance story than Porffor's simpler escape scan. The transferable lesson (one canonical call-target/escape authority feeding every consumer, no per-emitter name-guessing) is *already* the direction jz is moving (`call-target-index.js`, built to close exactly the "Shape #8" member-callee gap): continue that direction, don't import Porffor's simpler mechanism as a regression. |
| 8 | Compiler PGO (self-profile, build with that profile) | **Adopt, narrowly** | Low-risk, high-specificity: profile the self-compiler compiling its own bundle, use that profile only to order/specialize the self-compiler artifact. Reject explicitly: any source-level hint, any benchmark-specific branch: this would violate the project's own "general techniques, never per-bench tweaks" rule (`AGENTS.md`). Wasm has no branch-metadata PGO surface like native LLVM, so the transferable win is call-target specialization and hot/cold layout, not classic PGO. |
| 9 | A reclaiming compiler runtime (real GC) for the self-hosted compiler | **Adapt: already correctly scoped by the team, concur** | Full GC in user-facing jz output is a rejected idea for good reason ("No runtime" is a load-bearing product principle, `CONTRIBUTING.md`). But the self-hosted *compiler* is itself jz output and currently uses a bump arena that must prove releases manually (§5.3's region-reclaim rounds). The existing team framing: compiler-only phase/function arenas plus streaming output, not a GC: is the right adaptation; this audit's §8(iii)-11 experiment is a concrete next step in that direction. |

---

## 9. Generic-optimization gaps ranked by expected bench impact

Per `AGENTS.md`'s own constitution, every item below is a **class of
program shape**, never a specific bench case, and every fix is an
**engine** capability: nothing here is a suggestion to touch a bench or
example source file. Current measured standing (context, not from this
session): per plan.md's current-state section, JZ already leads
Porffor-native on 43/43 comparable rows by both runtime and artifact-byte
geomean, and `AGENTS.md` states JZ is the fastest Wasm producer on every
currently-covered bench case. The items below are gaps in **general
capability**, most of which the current fixed corpus does not yet expose
as a loss: that is exactly why they are worth closing pre-emptively
rather than only when a specific case fails, per the project's own "a
case where another wasm target wins is a bug to fix... never silently
accepted" standard: a hole the corpus hasn't found yet is the cheapest
time to close it.

**1. Codegen slack vs. `wasm-opt -Oz`: highest confidence, already
measured and gated by the team itself.** `CONTRIBUTING.md`'s own
performance invariant: "`wasm-opt -Oz` should find little to remove in
JZ's own output: whatever it shrinks is latent size headroom... Gated
with margin today (`WASMOPT_SLACK_MIN=0.70`... ~25-30% slack on size
builds); target is 0.95+, ratcheted down as codegen tightens." This is
the single most directly quantified generic-optimization gap in the
codebase: on `optimize: 'size'` builds, an external, general Wasm
optimizer can still find on the order of a quarter of the bytes jz's own
pipeline (its own passes + `watr`) leaves behind. **Engine-level fix:**
this is precisely the `watr/optimize.js` question from §6e/§7.6 -
whatever generic pass classes `wasm-opt -Oz` applies that neither jz's
own `src/optimize/` nor `watr`'s fixpoint yet reaches (candidates: more
aggressive global/constant propagation across function boundaries,
duplicate-code folding of near-identical blocks, tighter local
coalescing) is exactly the content of that 25-30%. This gate already
exists and already measures the right thing; closing it is "make the
ratchet move," not a new measurement.

**2. Loop-carried recurrence vectorization: self-documented,
whole-class, still open.** README: "Loop-carried dependencies remain
scalar": stated as a current, real boundary of the vectorizer (§6e,
§7.7), not a hypothetical. `CONTRIBUTING.md`'s own coverage note names
the concrete open items precisely: **i32x4 cellular automata**
(game-of-life/ising/rule30: flagged "feasible") and **lyapunov's
carried-recurrence outer-strip**: both named by the team as open,
neither claimed done. (`biquad` is explicitly **out of scope for this
list**: `CONTRIBUTING.md` attributes its gap to wasm-v1 lacking a scalar
`fma`, "hand-written WAT ties it too," i.e. an ISA limit, not an engine
gap; listing it here would violate this section's own "engine-level
fixes only" rule.) **Engine-level fix:** a general reduction-reassociation
pass: recognize a carried scalar accumulator whose update is
associative/commutative (sum, xor-mix, min/max) and split it into N
independent lane accumulators combined at the end, which is the general
form the existing named recognizers (`dot-slp.js`, `reduce.js`) already
special-case for specific shapes. Generalizing the *reassociation* step
(not each specific idiom around it) is the highest-impact single
addition to `src/optimize/vectorize/` short of the full re-architecture
in §8(iii)-12. **Expected impact:** any program with a hot
carried-accumulator loop: checksums, mixing/hash functions, running
statistics, cellular automata, small IIR-style recurrences where the ISA
doesn't block it: a whole class, per the project's own doctrine for what
counts as a real fix.

**3. General, budget-driven inlining: medium confidence, latent risk
more than a proven current loss.** Three narrow named heuristics
(`inlineHotInternalCalls`, `inlineLocalLambdas`, `specializeFixedRestCalls`,
§6e) versus Binaryen's cost-modeled whole-program inliner
(`inlining-optimizing`, one of the 271 measured `wasm-opt` flags, §6e).
The current bench corpus does not expose this as a loss (`tokenizer`: a
call-heavy shape: is already a `win` per `test/bench.js`'s claims
table), which is exactly why this ranks below items 1-2: no measured
evidence of present harm, only an architectural gap that a call-heavy
program shaped differently from the current corpus could expose.
**Engine-level fix:** a general small-function inliner gated by a
size/call-count budget (inline when the callee is below a size threshold
AND the call site is proven hot or the calling convention overhead
dominates), not a fourth named heuristic for a fourth specific shape.

**4. SSA-level global value numbering / partial redundancy elimination
beyond `watr`'s array-level CSE: lowest confidence, flagged for
investigation, not asserted as a loss.** There is no SSA form anywhere in
jz's pipeline (§6a); whatever cross-block redundancy elimination happens
is whatever `watr/optimize.js`'s CSE finds on the WAT-array shape, and
this audit did not (and, per its brief, should not) reach into
`node_modules` to characterize that file's own algorithm depth.
**Recommendation before ranking this further:** add one targeted bench
case with genuine cross-basic-block redundant subexpressions (not
currently in the corpus, by inspection of `bench/`'s case list) and
measure whether jz trails a GVN/PRE-capable target on it: this is a
"find the case, then fix the class" item, not yet a "fix the class"
item, and inventing a ratio here would be an opinion dressed as a
measurement, which this audit's own rules forbid.

---

## 10. Porffor alpha 3: adapter contract and ranked transferable optimizations

**Reference:** Porffor `alpha-3`, commit
[`03b6b54f`](https://github.com/CanadaHonk/porffor/commit/03b6b54fda4bdf242e085d23768a6e31490fa58d),
released 2026-08-27. JZ reference: `4c38662f`, Apple M4 Max, Node 25.9.0,
Homebrew clang 19.1.6. Raw same-machine measurements (the self-compile
table, the phase-breakdown table, the C-byte/SHA-256 compatibility table,
and the competitive-gate results) live in `evidence.md`'s Porffor alpha 3
entry; this section is the analysis and the ranked work that entry
supports.

### Can JZ compile Porffor?

Minimally, yes. The unmodified full selfhost bundle still remains outside
JZ's finite object and host dialect.

The exact 2,102,661-byte alpha-3 bundle first exposed a false JZ early
error on this valid default parameter:

```js
(types = [...LOOP_TYPES, 'switch', 'switch_typeswitch']) => {}
```

The lexical validator kept the comma marker from the nested array spread
and mistook it for `(...rest,)`. `src/early-errors.js` now clears that
marker when a sibling element follows. `test/parser-bugs.js` pins the
Porffor shape, an empty spread, an ordinary trailing comma, a call-spread
trailing comma, and the three invalid rest forms that must still reject.

The tracked compatibility boundary is now:

```sh
npm run test:porffor-core
```

`scripts/porffor-core-adapter.mjs` requires the clean pinned revision
`03b6b54f`, asks Porffor's own bundler for its no-precompiled-builtins
variant, extracts parse, codegen, and C rendering, and emits an
818,526-byte standard-JS compiler core. It removes only native CLI,
filesystem, uWebSockets, and runtime entry modules. Every rewrite has an
exact shape and count check, so source drift rejects instead of changing
behavior silently.

**The adapter uses three opt-in compatibility moves:**

1. A constructible local `RegExp` delegates validation to one host
   import. The host returns an error string; the shim throws inside Wasm,
   preserving Porffor's own `try`/`catch` without adding a regex
   interpreter to JZ.
2. Six fixed-name metadata deletions route through one computed-key
   helper, using JZ's existing dynamic-object path. No default object
   representation or ordinary property access changes.
3. Porffor's descriptor-backed comptime table becomes eager in the
   no-precompiled build. Two internal table censuses explicitly filter
   those entries, preserving the accessors' non-enumeration role. The
   omitted precompiled table cannot invoke the removed setters. The one
   data descriptor for `Object.prototype.__proto__` becomes an own
   computed property via object spread.

The adapter exposed generic JZ bugs, fixed at their shared authorities.
Builtin constructor lowering now respects local and imported shadows,
including the syntax-only Array, SharedArrayBuffer, URLSearchParams, and
Promise paths. Expression-bodied functions build final carrier
conversions before freezing local declarations. Direct-recursive boolean
predicates retain boolean truthiness rather than applying numeric ToInt32
to a boxed atom. Nested reads through opaque aliases, helpers, and
imported results retain external dispatch; each receiver and getter runs
once. At `45987028`, a clean build measured 17,777,844 bytes; the same
revision plus the working-tree compiler changes measured 17,820,098
bytes, a 42,254-byte increase. The hot-loop ratchet stayed at +0 and
every golden output-size gate passed.

This is a minimal compiler-core result. The no-precompiled variant does
not carry Porffor's complete standard builtin corpus, and the full CLI
still needs Node services and `Porffor.c`. It is therefore a
compatibility proof and a reproducible lab gate, not benchmark evidence
for the full Porffor compiler. Add a corpus row only after an unmodified,
feature-complete core produces a parity-checkable artifact. (Verification
timings, the C-byte/SHA-256 identity table across unadapted/adapted/JZ,
and the adapter's own determinism hash are in evidence.md.)

### What Porffor does differently

**1. A small, fixed-shape typed/effect IR.** Porffor's IR is one
structured tree. Every node is exactly six slots: `[kind, type, effects,
a, b, c]`; kinds and types are numeric enums and effects are a bitmask.
See [`compiler/ir.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/ir.js#L1-L35).
The fixed slots provide constant-time result-type and effect queries. JZ
currently tags WAT arrays with expandos such as `.type`, `.ptrKind`,
`.ptrAux`, `.schemaSid`, then repeatedly re-walks trees for
purity/effect/type questions (§5.5, §6a). **Transfer:** make the compact
HIR real: fixed slots for opcode, result representation, provenance and
effects. Keep WAT as a lowering product, not the first authoritative
semantic IR.

**2. Optimization while constructing IR.** IR constructors fold
constants, remove no-op conversions, collapse conversion chains and fold
truthiness/nullish checks immediately. There is deliberately no post-hoc
IR optimizer; the C compiler handles machine-level cleanup. See the
header and constructors in [`compiler/ir.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/ir.js#L1-L7).
JZ cannot delete its optimizer because Wasm backend quality is the
product. Constructor folding can still keep obvious garbage out of
downstream passes.

**3. Demand-driven function and builtin generation.** A Porffor function
initially stores AST plus a `generate()` closure. Bodies are only
generated when exported or referenced, followed by a bounded finalizer
fixpoint. Ungenerated functions never become IR. See
[`compiler/codegen.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/codegen.js#L4600-L4810)
and the reachability/finalizer loop near lines 5154–5166. JZ emits every
entry in `ctx.funcs.list` and tree-shakes after emission
(`src/compile/index.js:2619+`). For the self graph that means roughly
2,234 functions can incur analysis/emission/IR allocation before dead
code is known. **Transfer:** build one frozen call/reachability index
before emission and skip only functions proven unreachable. This must
consume RepresentationPlan and the canonical member-call target index; no
name-guess fallback.

**4. Builtins are precompiled, compressed and lazily decoded.** Porffor
precompiles 1,204 functions from 38 builtin files into typed IR. It
serializes fixed-shape nodes, interns strings, Huffman-encodes token
streams and installs replace-on-first-read accessors so only demanded
builtins decode. See [`compiler/precompile.js`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/compiler/precompile.js#L188-L585).
Measured generation: 0.741 s compiler phases / 1.20 s process, 301 MB
peak. The resulting `builtins_precompiled.js` is 1.19 MB and replaces
688 KB / 18,404 lines of builtin source during normal compilation. JZ
demand-loads stdlib helpers, but `pullStdlib` still realizes and parses
WAT text templates late. The memory ledger measured about 927 MB of churn
in that stage. **Transfer:** generate a versioned packed stdlib-IR image
at build time, lazily materialize only demanded helpers, and round-trip
it against source in tests. Do not hand-edit or commit hidden
`node_modules` output; the generator and format must be tracked and
deterministic.

**5. Selfhost modules are linked before compilation.**
`selfhosted/build.mjs` statically resolves imports, renames top-level
bindings, removes module syntax and emits one 2.1 MB source bundle. See
[`selfhosted/build.mjs`](https://github.com/CanadaHonk/porffor/blob/03b6b54fda4bdf242e085d23768a6e31490fa58d/selfhosted/build.mjs#L142-L761).
JZ passes 162 source modules plus a 6.71 MB JSON modules map into the
Wasm compiler. That duplicates source and keeps module/session state
live. **Transfer:** add a deterministic, semantics-checked selfhost
bundle as a shipping-build accelerator. It must not replace the separate
162-module jz×jz acceptance gate; otherwise it hides rather than fixes
module-graph scaling.

**6. Scoped temporary reuse.** Porffor allocates typed temporaries from a
per-function pool with explicit `mark()`/`release()` lifetimes and spills
only nontrivial duplicated expressions. See `compiler/codegen.js:84–180`.
**Transfer:** a scoped TempArena in JZ emission can reduce locals, IR
nodes and later local-lifetime work. It must preserve source evaluation
order and should land behind exact IR parity tests first.

**7. Direct-only ABI specialization.** Porffor scans calls to functions
that never escape, propagates argument types to a fixpoint, and gives
proven numeric parameters raw `f64` signatures (`compiler/codegen.js:
4980–5037`). It also omits closure-environment parameters when the
caller chain proves none can exist. JZ already has the stronger
RepresentationPlan/FunctionPlan machinery. The transferable lesson is
structural: one canonical call-target/escape index should feed every ABI
consumer. Another emitter-local name resolver would repeat the
member-call wrong-value seam.

**8. Compiler PGO.** Porffor's release compiler profiles itself compiling
its own bundle, then builds with that profile (`selfhost:616–639`, CI
workflow `ci.yaml:71–85`). **Transfer:** use JZ's existing helper/callsite
counters to specialize and order the self-compiler artifact from real
full-graph profiles; feed equivalent PGO into JZ's native lowering; do
not introduce self-source hints or benchmark-specific branches. Wasm
lacks C/LLVM's general PGO backend, so transferable wins are call-target
specialization, hot/cold outlining and data/function layout. Wasm cannot
express the branch metadata used by C and LLVM PGO.

**9. A reclaiming compiler runtime.** Porffor's native compiler runs with
an actual GC and fixed-address 32-bit arena. JZ's self-compiler uses a
bump arena and must prove region releases manually. Porffor can
therefore build whole output strings and still reclaim transient objects;
JZ reaches 4 GiB before final encoding. **Transfer:** compiler-only
phase/function arenas and streaming output. Do not add a GC to user
artifacts: JZ's no-runtime product contract remains valuable.

### Ranked JZ work

1. **P0: finish compact/streaming output or sound function-region
   release.** Nothing else turns the current trap into a self-compile
   time.
2. **P0: stop paying two whole-module encodes for init snapshotting.**
   The snapshot probe costs 100.40 s before the final 82.25 s encode
   (evidence.md). Evaluate a compact init interpreter or an earlier
   proven snapshot form; preserve exact final bytes and decline behavior
   rather than merely disabling the runtime win.
3. **P0: canonical ProgramIndex/call-target authority plus demand-first
   named emission.** Closes the member-callee soundness seam and avoids
   producing dead IR.
4. **P0: packed lazy stdlib IR.** Target the measured `pullStdlib`
   parse/churn class, not one benchmark.
5. **P1: fixed-shape HIR with inline type/provenance/effect bits.**
   Migrate consumers incrementally; fail closed when facts are absent.
6. **P1: scoped typed temp reuse.** Pin single evaluation and source
   order.
7. **P1: self-profile specialization and native PGO.** Only after
   correctness and memory are stable.
8. **P2: deterministic single-module selfhost bundle.** Useful shipping
   fast path, never a substitute for the full module gate.

### What not to copy

- Do not rely on clang to optimize JZ Wasm; direct Wasm quality is JZ's
  claim.
- Do not replace correct-or-reject representation plans with Porffor's
  more optimistic local type inference.
- Do not adopt Porffor's runtime GC in ordinary JZ output.
- Do not flatten benchmark sources or add integer hints to make JZ look
  faster.
- Do not count a Porffor compile/runtime failure as proof that JZ is
  faster; retain explicit coverage gates.

---

## 11. Gap table

Ranked by v1-blocking severity. "NONE" in the gate column means: even if
today's numbers happened to satisfy the requirement, nothing would catch
a regression: that counts as *not met*.

| # | Requirement | Enforcing gate | Current status | What closes it |
|---|---|---|---|---|
| 1 | Full recursive jz×jz self-compile below wasm32's 4 GiB | **NONE**: no CI job runs the 162-module probe at all; hand-run diagnostic only | **NOT MET**: traps at exactly 2^32 bytes on every measurement in the campaign's history (cited, not re-run) | Engine work: streaming/compact encoder or region-scoped release (both named in plan.md's "4 GiB self-compile" section, neither landed: §10's ranked P0 list #1/#2 has the detail) |
| 2 | Once self-compile succeeds, match/beat Porffor's self-host wall+RSS | **NONE** (documented only in `CONTRIBUTING.md:158-163`) | **NOT MET / NOT MEASURABLE**: can't start until #1 closes; today's *one-level* hosted build is already ~1.5–1.7× slower, ~2.2–2.3× heavier than Porffor's full native self-build | Blocked on #1, then engine work per the 8 ranked gaps in §10 |
| 3 | Strictly faster than every wasm rival, per case (owner's literal bar) | `test/bench-claims.js:355-372` (hard-gated, no CI softening): the *only* place this is enforced as written | **NOT MET**: 22/60 unproven strict, **13/60 genuinely red** beyond even the 1.05× tolerance band (`base64, crc32, delayline, fft, glyfparse, lorenz, radixsort, sdf, shapes, slices, sort, trace, vm`); plus 3 real losses to raw V8 (`jessie, resample, watr`) | Engine work on the 13 (+3 V8) red cases: most are already self-diagnosed with a named root cause in `test/bench.js`'s `WASM_TODO` map; then refresh evidence after a source freeze |
| 4 | Strictly smaller than AS, per case (owner's literal bar) | `test/bench.js:711-730` and `test/bench-claims.js:398-417`, added by `105bdc18`; both assert strict `<` on every comparable row | **NOT MET**: 24/49 cases were larger at gate landing; `18690313` reduced `dispatch` by 55 bytes without closing that row | Engine work by shape class; `ledger-performance.md` keeps the measured attribution and ranked queue |
| 5 | Correct-or-reject, no unlisted silent wrong value (`STABILITY.md:19-22`) | Policy plus ordinary tests; no automated scanner rejects an open `KNOWN-WRONG` marker | **NOT MET**: four live green tests intentionally pin wrong values, listed in §4 | Fix or reject the Shape #9 member edge, BigInt64Array union store, inline-closure property, and nested-member dispatch; see `ledger-correctness.md` |
| 6 | 137 exact accepted-invalid test262 negative parses (`STABILITY.md:27-30`, "a v1 release gate") | `test/test262-neg-accepts.json` exact-set-gates the *current* 137 (any drift fails CI) but does not require shrinking it | **NOT MET**: 137 open, unchanged at HEAD; tracked in plan.md's remaining queue | Engine work, per parser-context family (module-goal/export context, class-element token boundaries, destructuring cover grammar, ASI/line-terminator context, async-generator/parameter context, legacy-escape context: 6 named families in the ledger) |
| 7 | Evidence backing the performance claim is fresh + valid | `test/bench-claims.js` (hard-gated) | **NOT MET**: 221 compiler commits stale, swap-pressure invalid (4199.75 MB > 4096 MB bound), memory evidence 573 commits stale | Cheap in isolation (re-run the bench harness) but explicitly blocked behind "freeze source first" per plan.md's remaining queue, plus a quiet (non-swapping) machine |
| 8 | `npm publish` succeeds (`prepublishOnly`) | `package.json`'s `prepublishOnly` chain, ending in `test:claims` | **NOT MET**: exit 1 today, transitively from #3/#4/#7 | Same as #3/#4/#7 |
| 9 | CI actually blocks a regression to the per-case speed/size bars on every push | `bench.yml`'s `test:bench` step: but its ratio assertions are `okTiming`-softened to informational-only on CI (`test/bench.js:146-148`) | **STRUCTURALLY PARTIAL**: the only unconditional enforcement is the separate `claims` job (#3/#4), which depends on someone/something periodically refreshing `bench/results.json` (see #7) | Gate work: none required if the `claims` job is treated as the real gate and kept fresh: but that dependency is implicit, not enforced by CI itself (nothing fails when evidence goes stale except the next `claims` run happening to notice, as it did here) |
| 10 | test262 language/builtins floors hold | `test262.yml` (hard-gated, no softening) | **MET**: confirmed live this session, zero drift (2976/0/21, 858/0/70) | Already closed; keep it this way |

**Overall, none of the owner's three release bars is met at `dd92662e`.
Strict speed and size gates now exist and are honestly red. Recursive
self-compilation still has no CI enforcement surface and still traps at
4 GiB.** The `claims` job is red rather than a rubber stamp.
`§7`/`§8` give the engineering path for rows 1-4; `ledger-correctness.md`
and `ledger-performance.md` track the fix-by-fix progress against rows
3/5/6.

---

## Summary for the record

Every number above was measured in the cited run or cited from a dated
source with its date stated; every architectural claim is a file:line
citation, most from the codebase's own doc comments, not this audit's
inference. Two candidate "overdone" items (§7.8, §7.9) were checked and
found to be already-fixed or already-correctly-scoped rather than
confirmed as waste: reported as such rather than padded into the
overdone list to hit a length. The `core-simplification-audit` session's
instrumentation (`src/ast.js` counters, `scripts/_audit-*.mjs`) was left
uncommitted in its own worktree for the next agent to rerun or extend; it
does not ship.

# Fast refresh — jz-only re-measure with anchor validation

Problem: a full refresh re-measures ~60 cases x ~20 lanes (hours). Rival numbers
do not change when only jz changes; what makes mixed-vintage evidence dishonest
is unverified machine-state drift between the jz rows and the stored rival rows.
Fix the verification, not the re-measurement.

Existing infra (bench/bench.mjs, read 2026-08-05):
- `--targets=` / `--cases=` selection (line ~856)
- prep cache: rival toolchain builds mtime-stamped per (target,case), jz never
  cached (line ~241) — rival REBUILDS are already skipped when sources idle
- `--paired[=N]` ABBA release-verdict protocol (line ~843)
- `--json[=path]` — REWRITES the whole file (the hazard that bit two agents;
  hand-patch merge is the current workaround)

## Piece 1 — `--merge` (composes with `--json`)
When results.json already exists at the target path, update ONLY the measured
(case,target) rows; preserve every other row byte-for-byte. Per-row provenance:
each written row gains `measuredAt: <short-sha>` (the current HEAD); meta keeps
`commit` = HEAD plus `partial: true` when any surviving row's measuredAt differs
from meta.commit. The claims FRESH axis reads meta.commit as today; a follow-up
tightening in test/bench-claims.js may require anchors (below) whenever partial.

## Piece 2 — `--verify-anchors[=N]` (default 3)
After the selected measurement, re-measure N ANCHOR rows from the STORED
evidence — deterministic choice: the (case,target) pairs with the lowest
historical variance among rival lanes that are best-rival for some claims case
(seed set: c-wasm x mat4, c-wasm x fft, as x synth; keep the list in the file,
not computed). Compare fresh vs stored medianUs: within ANCHOR_TOL (1.10) →
anchors PASS, stored rival evidence certified still-valid at today's machine
state; verdict written to meta.anchors {pairs, ratios, pass}. Any anchor FAIL →
exit nonzero with the drift report: the honest signal that a full recontest is
due (engine/OS/machine changed). Claims gate may then require
meta.anchors.pass when meta.partial.

## Piece 3 (phase 2, optional) — adaptive sampling
Case harness runs fixed sample counts. Adaptive: keep sampling until the
median's spread over the last K samples < 1% or a 10s/case ceiling hits,
whichever first. Touches bench/_lib/benchlib.js printResult contract
(samples already reported) — bounded but wider blast radius; only worth it
if the jz-only path still feels slow after Pieces 1-2.

## The fast-refresh workflow (post-implementation)
    node bench/bench.mjs --targets=jz,jz-w2c --json=<scratch> --merge --verify-anchors
~60 cases x 2 jz lanes x ~2-5s + 3 anchor re-measures ≈ 10-15 min, no rival
rebuilds, honest provenance. Full recontest reserved for anchor drift or
deliberate re-anchoring (the 2026-08-05 full refresh is the anchor baseline).

## Gates for the implementing agent
- --merge: byte-preservation pin (unmeasured rows identical pre/post), meta
  provenance pin; the previous hand-patch flows replaced by --merge in docs.
- --merge + meta.invocations: meta's per-target sub-structures merge the same
  way case rows merge (overlay this run's targets onto PREV's full dict) — a
  narrow --targets= must not collapse the invocations dict down to just the
  measured targets. Found 2026-08-05 (flagged twice before the fix landed);
  pinned in test/bench-merge.js.
- --verify-anchors: pass and fail paths both exercised (fail path via an
  artificially perturbed stored value in a scratch copy).
- No behavior change to full runs without the new flags (byte-identical
  results.json for a full --json run modulo meta additions).
- bench-claims.js tightening (partial => anchors required) with its own pins.

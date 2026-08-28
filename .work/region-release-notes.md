# feat/region-release — dvnested soundness attempt + measured 4 GiB-close prototypes (2026-08-27)

Base: aff67069. Companion branch: watr `feat/streaming-code-section` @ 84c14c5
(/Users/div/projects/watr, worktree at .../scratchpad/watr-stream).

## Prerequisite (dvnested region-live O2/O3 soundness) — NOT closed

Built a region-enabled kernel (REGION_HOOKS_ACTIVE=true, current aff67069 source,
`node scripts/self-compile-build.mjs`, 265s, 15,720,308 bytes). `node test/kernel-oracle.js`
against it: 12/14 tests fail, INCLUDING `sum` (the simplest AGREE-tier program) at O0/O2/O3 —
broader than documented (self.js's own comment says only dvnested-mechanism at O2/O3 remains
broken). Sanity check: the SAME unmodified test file passes 14/14 (605 assertions) against a
known-good dormant build — isolates the regression to REGION_HOOKS_ACTIVE specifically, not a
harness bug.

Failure signature: `decodeThrown` (interop.js:888) decodes the thrown value to an 8-field
object matching `src/optimize/vectorize.js`'s BodyModel/`bl` shape (`writes, referenced,
hasGlobalSet, hasImpureCall, addrTable, offsetTees, siteAccess, aliasClass`) instead of the
expected Error `{message,name}` shape, with `writes` holding what looks like a caught error's
`.message` string. Consistent with `__schema_tbl` misresolution under region relocation — the
object's schema id resolves to the wrong table entry. Same bug CLASS as the dyn-props layer-1/
2/3 fixes already in module/core.js's `__region_exit` (all explicitly attributed to "kernel-
oracle dvnested-mechanism O2/O3 regression"), evidently not fully closed by those.

Both kernel-parity.js and kernel-oracle.js fail on their own respective FIRST corpus entry
(`sum`) — most likely ONE bug firing on the first region-heavy compile regardless of program
content, not many independent per-row bugs (kernel-oracle's AGREE-tier loop throws on the first
failure, aborting before later rows — e.g. dvnested-mechanism — are ever reached, so "12/14
fail" does not mean 12 distinct causes). `sum` is a smaller, cleaner repro than
dvnested-mechanism for whoever continues this.

**Not fixed**: root-causing a schema-table corruption this deep (Cheney-copy machinery,
module/core.js's ~1000 lines of hand-written WAT, layout-kinds.js's per-kind arms) needs many
more empirical iterations (~5 min per full self-compile rebuild) than fit in this session.
`REGION_HOOKS_ACTIVE` reverted to `false` (unchanged from aff67069) — no region-arena source
change is kept from this attempt.

**Structural finding, independent of the bug above**: region hooks (`front()`/`emitIR()` in
scripts/self.js) are never wired into the final `watrCompile(...)` encode call — confirmed by
reading self.js's own `compileSelf`. So even a fully-sound region arena (strategy A) would not
by itself close the wall: the final module boundary (WAT-IR tree + watr's code-byte arrays
coexisting) is untouched by strategy A as currently designed. This is corroborated empirically
below: a DORMANT (non-region) build with the streaming encoder wired in shows NO peak-memory
change at all, because the dormant build already exhausts memory during front/plan/emit —
before ever reaching the encode step the streaming prototype optimizes. Strategy A and B are
complementary, not alternatives; closing the wall needs region-style reclaim for the
front/plan/emit phases (or a native HIR memory win there) AND a streaming/packed encode step.

## Baseline measurement (confirmed, matches documented history exactly)

Dormant build (aff67069, `node scripts/self-compile-build.mjs`, 320s, 17,867,935 bytes).
`goal-probe.mjs` (feeds dist/jz.wasm the SAME {code,modules} graph that built it, via
`default(code,strict,optJSON,modulesJSON,host)`, reports `exports.memory.buffer.byteLength` at
trap/completion — monotonic growth, so final size IS peak):

```
baseline (dormant, aff67069): TRAP "unreachable", peakBytes 4294967296 (exactly 65536 pages,
  the wasm32 ceiling), elapsedMs 10974, 162 modules
```

## Strategy A (release-behind-the-cursor / region arena) — NOT MEASURABLE

Blocked entirely by the open soundness bug above: a region-live kernel fails before reaching
anything comparable to the goal probe (it cannot even compile the trivial "sum" program without
tripping the schema-corruption trap). No peak-bytes number exists for strategy A.

## Strategy B (streaming typed encoder) — MEASURED, prototype landed on watr, does not alone close the wall

Implementation: opt-in `streamCode:true` on watr's `compile()`/`assemble()` (feat/streaming-
code-section @ 84c14c5, watr repo). Writes each function's locals+instructions directly into
one growable, packed Uint8Array-backed buffer instead of the default path's per-function
`item` array + `inner` merge + `codeSection` merge (3 extra plain-JS-array copies of the code
section — 8 bytes/element under jz's own self-hosted ARRAY representation regardless of value,
vs 1 byte/element for a real packed buffer). Length-prefixed records (per-function body-size,
section overall size) use reserve + backpatch via `uleb5`'s existing fixed-width 5-byte LEB128
(spec-legal non-minimal padding). Two real bugs found and fixed during implementation: (1) a
Proxy-based buffer wrapper doesn't survive being bundled into jz's own self-hosted compiler —
jz's subset rejects `Proxy` (confirmed by an actual failed self-compile, not assumed) — rewritten
as a plain object of explicit methods, no `class`/`Proxy`; (2) `push` needs
`Array.prototype.push`'s variadic multi-argument form (several existing call sites push several
literal bytes in one call) — a single-arg version silently dropped every byte past the first.

Validation: watr's own full suite 604 pass / 0 fail / 22 skip (pre-existing todo/unsupported-
proposal rows) — default (non-streaming) path is byte-for-byte unaffected. Hand-written smoke
test instantiates and executes correctly with `streamCode:true` (module is valid, a few bytes
larger per function from the padded size prefixes — not byte-identical to default, semantically
identical). Wired into a real jz self-compile (scripts/self.js's watrCompile call,
`{streamCode:true}`, via an absolute-path import of the watr-stream worktree — throwaway
measurement rig, not a real dependency, see the commit on this branch) — kernel built
successfully (18,394,714 bytes, 356.6s, 165 modules — +3 modules / negligible source-text
growth from the direct-file-import graph-resolution shape, not a correctness issue).

`goal-probe.mjs` against the streaming-encoder kernel:

```
streaming encoder (strategy B): TRAP "unreachable", peakBytes 4294967296 (exactly 65536
  pages), elapsedMs 10864, 165 modules
```

**Peak bytes and elapsed time are indistinguishable from the dormant baseline** (4294967296
both, 10974ms vs 10864ms). The streaming encoder is real, tested, and does eliminate the
multi-copy code-section amplification it targets — but a DORMANT self-compile never reaches
the phase it optimizes: without any reclaim mechanism at all (regions off), compiler-internal
garbage from front/plan/emit alone already exhausts wasm32 before the final encode step ever
starts. This matches the structural finding above precisely.

## Recommendation

Neither prototype alone crosses under 4 GiB, and neither could be fully validated in
isolation (A blocked by an unresolved, broader-than-documented soundness bug; B validated but
structurally unable to help a dormant build). The two are complementary: closing the wall
needs BOTH a working reclaim mechanism for front/plan/emit (region arena, once its soundness
bug is actually closed — likely needs another schema-table root-completeness audit in the same
family as the dyn-props fixes) AND the streaming/packed encode step B already provides, working
together in one region-and-streaming build. Recommend: (1) root-cause the region soundness bug
starting from the `sum`-at-O0 repro (smaller than dvnested-mechanism), pinning schema-table
identity across region relocation as the next specific suspect; (2) once sound, re-measure a
build with BOTH region hooks active AND the streaming encoder wired in — that combination, not
either alone, is the one actually predicted to reach (or get meaningfully closer to) the final
encode phase with headroom.

## Commands used (reproducible)

- Region-live repro: flip `export const REGION_HOOKS_ACTIVE = true` in scripts/self.js,
  `node scripts/self-compile-build.mjs`, then `node test/kernel-oracle.js` /
  `node test/kernel-parity.js` from the worktree root.
- Baseline/prototype peak-memory measurement: `node <scratch>/goal-probe.mjs <dist/jz.wasm path>
  [label]` (script lives outside this repo, in the session scratchpad — reproduce by feeding
  `resolveSelfCompileBuild()`'s own `{code, modules}` graph back into the built kernel's
  `default(code,strict,optJSON,modulesJSON,host)` export and reading
  `exports.memory.buffer.byteLength` after trap/completion).

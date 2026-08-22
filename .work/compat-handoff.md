# Compat-diet handoff: HASH dict-mode + BigInt retirement

> **§BigInt SUPERSEDED** 2026-08-21 by `.work/adr-0001-bigint-representation.md`: the
> retirement end-state (raw-i64-only, unprovable flows = compile errors by default) is
> rejected — self-host is load-bearing mixed BigInt (the dc6139d9 wall below), so tagged
> dynamic BigInt is core, with raw i64 as plan-proven specialization and strict mode
> opt-in only. The inventory below remains valid as the **deletion-phase target list**
> (legacy fallback authorities die; the tagged mechanism itself does not). The HASH
> dict-mode workstream is unaffected and still live.

2026-08-19. Context: compat features split two ways — desugar-to-core (jzify: generators,
async, classes, switch, var, arguments — architecturally free, zero core dispatch arms)
vs leak-into-core (BigInt mixing semantics, dynamic HASH fallback). Ratified direction:
compat layer is syntax sugar only; the core never grows dynamic machinery for it.
This doc hands the two remaining workstreams to the executing agent. Everything below
is evidence-verified against this tree (file:line cited); re-verify lines after rebases.

## Already landed (do not redo)

**subscript repo** (`/Users/div/projects/subscript`, uncommitted, UNPUBLISHED):
- `feature/number.js`: `n`-suffix consumption removed from `num()` and the 0x/0b/0o
  prefix branch. BigInt no longer parses in ANY dialect by default (`123n` → parse error).
- `feature/bigint.js` (new): opt-in parse half — wraps digit/period lookups (same pattern
  as `feature/unit.js`), consumes pending `n`, emits spec-shaped token node
  `['n', '123']` / `['n', '0xFF']` (spec.md:237,314 finally matches impl), errs on
  `1.5n`/`1e3n`. `eval/bigint.js` (new): eval half, `operator('n', d => …BigInt(d))`.
- Tests: bigint block moved out of `test/feature/async-class.js` into
  `test/feature/bigint.js` (asserts default-jessie rejects + opt-in works + eval);
  registered in `test/test.js`. 361 pass. Min bundles rebuilt (`npm run build`).
- NOT published to npm. jz still pins `subscript@^10.7.0` (published, bigint built in).

**jz repo** (uncommitted):
- `src/parse.js` digitWrapper is now dual-mode: handles suffix already-consumed
  (subscript ≤10.7 builtin bigint) AND suffix-pending (new subscript, bigint opt-in
  feature jz deliberately does NOT import — the wrapper IS jz's bigint surface,
  structural source-text detection, no BigInt values in AST). Full suite green against
  BOTH subscripts (3526 pass / 6 skip vs local; verification vs published re-run after).
- ES2025 Set algebra REMOVED end to end: `module/collection.js` (3 walkers
  `__set_add_all`/`__set_filter`/`__set_all`, their deps-table rows, `=== ES2025 Set
  algebra emitters ===` block: isMapRT/strideRT/isMapI32/setBin/buildSet/addAll/
  filterInto/allMatch + 7 `.set:*` emit entries), `src/autoload.js` PROP_MODULES rows,
  `src/kind-traits.js` result-kind clauses, `test/data.js` two test blocks,
  `test/test262-builtins.js` 7 tracked entries, README stdlib box row.
- WeakMap/WeakSet fold MOVED prepare → jzify (`jzify/index.js` canonSymbols renames
  `new Weak{Map,Set}` → `new {Map,Set}`, both AST shapes; `src/prepare/index.js` 'new'
  handler now rejects unconditionally — reachable only when jzify is skipped, i.e.
  strict). README's "jz default (jzify)" tier already listed WeakMap/WeakSet; code now
  matches the README. Self-compile is safe by construction: self-hosted sources use
  `new WeakMap()` (src/kind.js:634 note) and old prepare ALSO rejected under strict,
  so the kernel was provably compiling non-strict already.
- Pins added: removed `.union()` rejects in default mode with the standard
  unknown-method message, no host fallthrough (test/errors.js 'unknown method on
  KNOWN receiver'); bare `new WeakSet` no-parens shape (test/feature-gating.js);
  subscript hex-E (`0xEn`) and `.5n`-reject edges (subscript test/feature/bigint.js).

## Workstream 1: BigInt retirement (the big one)

### What BigInt actually is here
- Runtime semantics: wrapping i64, NOT arbitrary precision (README:182). `src/bignum.js`
  (315 ln) is compile-time-only (parser literal truncation + pre-eval rational folding),
  never emitted; it STAYS (self-compile-safe limb math).
- Raw i64 lane (proven-BIGINT flows → `i64.*` ops) is CHEAP: flat table rows
  (kind-traits), plain kind-propagation arms. It STAYS — it is jz's ONLY i64 surface
  (no independent i64 annotation exists; index.d.ts has zero bigint/i64 mentions), and
  the good-for list needs 64-bit ints (wyhash/splitmix64/xoshiro256/FNV-64).
- The WEIGHT is the unproven-flow stack (all of this is deletion target):
  - boxed carrier PTR.BIGINT: `src/ir.js:420-770` (boxBigInt/unboxBigInt/
    maybeUnboxBigInt/isProvenBoxedBigint/…); boxing UNCONDITIONAL since 2026-08-19
    (CARRIER_BOX/JZ_CARRIER_BOX flag deleted).
  - joint dynamic-domain dispatch: `src/compile/emit.js:4655-4783` (bigIntDomain/
    bigIntDomainsCanMix/bigIntJointDispatch), wired into EVERY `+ - * / %` emission
    (emit.js:5649,5749,5789,5833,5863,6352) — called unconditionally, NOT gated by
    ctx.features.bigint: a compile-time tax on every binary op of every program.
  - kind-erasing-sink fixpoints: `src/compile/analyze.js:671-857` (markBigintSink/
    markBigintCapture/BIGINT_COLLECTION_METHODS), `src/compile/narrow.js:2670`
    (bigintBoxedVerdict) + coerceArg propagation (emit.js:1470-1560).
  - legacy sentinel-export lane: `src/compile/index.js` `_resultBigintSentinel` +
    synthesizeBoundaryWrappers — an OLDER discrimination mechanism still coexisting
    with the box.
  - `src/reps.js:84-92` ValueRep.bigintBoxed — a bigint-only field on the otherwise
    kind-generic struct (REP_FIELDS allowlist reps.js:288, ~4 consumer sites).
  - whole files: `src/compile/erasure-diag.js` (195 ln), `src/compile/
    bigint-boxed-stats.js` (27 ln) — env-gated debug instruments, delete as blocks.
  - `src/compile/representation-plan.js` (1365 ln): its ONLY current semantic content
    is the bigint raw/boxed decision (header :6-17: BIGINT_REP_* bits,
    solveBigintProvenance :207-445, REP_EDGE_* actions). Slices 4a-4f (2026-08-18/19)
    consolidated per-site boxing decisions into this plan — one seam now, but a seam
    whose payload is exactly the thing being retired.
- Output-byte cost when unused is already zero (ctx.features.bigint prescan,
  prepare/index.js:1159-1170; module/core.js:222-257, module/number.js:1547-1597
  interpolate arms only when true; feature-reach-census: 0/130 corpus programs reach
  any bigint path, wasm delta exactly 0 bytes). The cost is compiler complexity
  (~1,440-1,460 bigint-only lines per the retirement design's own audited inventory;
  ~2,500 lines mention bigint) + the unconditional per-op compile-time tax above.

### History — read before executing (walls already hit)
- `.work/bigint-retirement-design.md` (2026-08-13, 9f851ff0): full 6-slice plan, Table A
  clean-deletion inventory (~1,380 ln source+tests), §8 totals (~1,440-1,460 ln,
  4 schema-fact fields, ~9 emit dispatch arms). END STATE: raw i64 only; unprovable
  Number/BigInt flows = COMPILE ERRORS (this is `JZ_BIGINT_STRICT=1` semantics, which
  already exists as opt-in).
- Slice 0 partial: 38f1259a (self-host kernel-source rewrite, 11→5 unprovable boxed
  sites). Slice 1: fc28a3da (box → diagnostic default) REVERTED same day by 8b7277ab
  (main-stabilization: box stays default, strict via env). Independent attempt
  dc6139d9 (FeaturePlan slice 4, post-carrier gate retirement): "wall hit, fully
  reverted" — root cause .work/todo.md:10044-10097: retiring the legacy
  magnitude-heuristic half broke watr's self-compiled BigInt-parsing code (watr parses
  `i64.const` operands → needs real 64-bit parsing → a LOAD-BEARING self-host
  dependency, not hypothetical).
- Still accreting: eaf61242 (2026-08-19) added the JSON.stringify PTR.BIGINT throw arm.
  Every new box-conformance arm raises deletion cost. FREEZE new box arms now.

### Execution order (each step lands alone, byte-identity-gated on the census corpus)
0. DECISION GATE: stop growing the box (no new conformance arms); pause
   representation-plan slice 5+ until this retirement decision is final — the plan's
   current payload is solely the artifact being deleted. If retirement is ratified,
   rep-plan either gets gutted back to its generic scaffolding or generalized to a
   real multi-kind lattice LATER; do not deepen it first.
1. Publish subscript with opt-in bigint (or `file:` link during dev); bump jz dep.
   jz's dual-mode parse.js makes the bump a no-op TODAY (verified green both ways).
   Do NOT import subscript/feature/bigint in jz — jz's digitWrapper is the surface.
2. Finish slice 0: rewrite the 5 remaining unprovable self-host boxed sites
   (inventory in bigint-retirement-design.md §5; JZ_DBG_BIGINT_STATS=1 counts them).
   Gate: test:self green, boxed-site count 0 for the dist/jz.wasm self-compile.
   THE WALL IS WATR: fix watr-source provability FIRST as its own slice (the
   dc6139d9 post-mortem, todo.md:10044+, has the exact break shape), only then touch
   jz's discrimination lanes.
3. Flip default: unprovable Number/BigInt flow → compile error (JZ_BIGINT_STRICT
   semantics become default; keep env escape one release). This is fc28a3da redone
   after slice 0 actually completes — it reverted last time BECAUSE 0 wasn't done.
4. Delete, in dependency order (consumers before facts): emit.js joint-dispatch arms →
   analyze/narrow sink fixpoints → ir.js box block + layout PTR.BIGINT tag →
   sentinel-export lane (compile/index.js) → reps.js bigintBoxed field + REP_FIELDS →
   rep-plan bigint payload → erasure-diag.js, bigint-boxed-stats.js, test/pointers.js
   "BigInt carrier boxing" block (~220 ln) whole. Expect ~1,450 lines net removal.
5. End state checks: `5n + 5n` still compiles to raw i64; `cond ? 5n : "x"` is a
   compile error with a jz-quality message; ctx.features.bigint prescan still gates
   the $__is_truthy/$__to_num/$__eq module arms (those STAY — they're behind the
   feature flag and cost 0 bytes when unused); test matrix + test:self + 262 suites
   green (262 excludes BigInt wholesale already — test/test262.js:433, no baseline
   movement expected).

## Workstream 2: HASH dict-mode — evidence says KEEP in compat; the real cut is elsewhere

Census (.work/feature-reach-census.md, 130 real programs, -O3, verdict table):
- HASH/__dyn_get/__dyn_set: 5/130 — bench/fftplan, bench/jessie, bench/provenance,
  bench/watr, realinput/jzify_entry. __ext_call: 2/130 (watr, jzify_entry).
- Decomposition of the 5:
  - jessie, watr, jzify_entry = parsers/assemblers/compilers: keyword/operator/charcode
    tables — GENUINE dict users. This is (a) the README's "Parsers, codecs" good-for
    row and (b) THE SELF-HOST GRAPH. Cutting dict from default mode kills jz compiling
    its own parser stack. Non-negotiable keep.
  - fftplan, provenance = NOT dict users — inference-gap specimens, planted
    deliberately (bench/provenance/provenance.js header): typed arrays reaching a hot
    kernel through Map-cache/object-field/memo edges lose their kind because
    typed-array inference is RHS-syntactic (`new.<Ctor>`, src/type.js) → element
    access falls to the dynamic path, measured 2-10× deopt. "Fix the inference, not
    the input — this specimen is fixed."
- Already-existing gate: `strict: true` rejects the ENTIRE dynamic tail at 10 sites
  (front.js:80 skips jzify; prepare/index.js:1269 void, :1273 loose eq, :3444 for-in,
  WeakMap site; module/array.js:940 dyn read; emit-assign.js:86 dyn write;
  emit.js:4018,4067 unknown-receiver; narrow.js:3136 boundary shapes).
- Already-zero cost when unused: syntax-gated module inclusion (autoload) +
  reachability treeshake (optimize/index.js:4602) + test/feature-gating.js CI proof
  (pure-scalar program emits zero __ext_*/__hash_* imports; README:408 "heap-free
  numeric program emits no memory, allocator, or startup function").

Therefore "cut HASH" decomposes into three separate moves — do (a) and (b), skip (c):
(a) KEEP dict-mode available in default/compat mode (it already IS the compat-gated
    design: default = works, strict = rejects, unused = 0 bytes). Nothing to build.
(b) CUT the ACCIDENTAL dict-mode entries by fixing typed-array provenance inference
    (returned-array, object-field, Map-cached, module-memo edges — the four
    provenance.js lanes). This is the perf-relevant cut: it converts the plan-cache
    idiom (the most common real-world FFT/DSP API shape) from 2-10× deopt to fast
    path, and it upgrades fftplan+provenance from dict-reach to zero-dict. Gate on
    the two specimens' bench numbers converging to their caller-built baselines.
(c) DO NOT remove dict machinery from the core or flip default→strict: it breaks
    self-host + the parsers use case + "pasted JS just works". If sizing it someday,
    measure first: the machinery is emit-side fallback proving, not a runtime tax on
    programs that never enter it.

## Verification protocol (both workstreams, every slice)
- `npm test` (matrix if touching emit/narrow: test:opt0/opt1/opt3, test:wasi),
  `npm run test:self`, `npm run test:262`, `npm run test:262:builtins`.
- Byte-identity on the census corpus for slices claimed as no-ops (the repo's
  established gate — see rep-plan slice 4f's "total no-op by construction,
  byte-identity gated").
- Perf ratchet (`npm run test:ratchet`) after emit-path changes; bench/fftplan +
  bench/provenance are the named gates for workstream 2(b).
- AGENTS.md performance claims are CI-gated — do not regress fastest-wasm claims.

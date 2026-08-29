# core.js split (pipeline-minimality slice)

`module/core.js` (3,535 lines) — NaN-boxing encode/decode, the bump allocator,
durable-heap `_clear()`-survival logging, region-arena round-scoped
compaction, memory-based length/cap headers, binary16 conversion, the
`.prop`/`.length`/dyn-get dispatch core, schema-slot devirtualization, and
Error-object construction. "Foundation for all heap types. Every module
depends on this" (the file's own header doc) — auto-included by array/
object/string and effectively every other stdlib module.

## Shape (read before the plan below — matches `.work/stdlib-math.md`'s file, not ir.js/kind.js's)

Like `math.js`, core.js is **one closure**: `export default (ctx) => {`
opens at line 32 and does not close until line 3535, EOF. There is no
top-level pre-closure helper except `const NAN_BITS = nanPrefixHex()` (line
30). Every function/const identified below is declared INSIDE that closure,
at var­ious depths (some further nested inside `if (ctx.memory.shared) {…}
else {…}`).

Because of this shape, a generic comment/string-stripped identifier-
co-occurrence graph across "top-level declarations" is low-value here (as
`.work/stdlib-math.md` found for the same reason) — there are only ~2 dozen
closure-scoped `function`/`const` helpers among 3,535 lines, the rest is
`ctx.core.stdlib['name'] = ` / `ctx.core.emit['name'] = ` WAT-template
registrations. The methodology actually used, matching `stdlib-math.md`'s
own precedent for this exact file shape: for every candidate family, grep
every one of its private JS names across the **whole file** to confirm zero
use outside the candidate range (fan-in = 0 beyond self), then confirm the
candidate range's own free variables (constants/imports it reads) either
come from top-of-file imports (portable) or from nothing else in the file
(true leaf). WAT-level `$name` cross-references (other modules' `inc('name')`
/ `deps()` entries, or raw `call $name` text) never block a move — those
resolve by string at stdlib-pull time regardless of which `.js` file
executed the `ctx.core.stdlib[name] = …` assignment.

Every closure-scoped JS helper name in this file (all ~24 of them, e.g.
`emitPropAccess`, `emitSchemaSlotRead`, `schemaGuardOk`, `literalAst`) is
**private to core.js** — nothing outside this file can reference them (this
is a single default-export closure, not an ES module with named exports),
so fan-out for JS-level names is contained to core.js by construction; only
the `ctx.core.stdlib`/`ctx.core.emit` STRING keys have repo-wide reach.

## Top-level inventory

62 `ctx.core.stdlib['name']` registrations, ~30 `ctx.core.emit['name']`
registrations (the rest of `ctx.core.emit` assignments are the 4 low-level
pointer/region-intrinsic one-liners + `.`/`?.`/`?.[]`/`?.()`/`typeof` +
7 Error-class ctors via a loop), ~24 private closure-scoped `function`/`const`
helpers, one `deps({...})` call (34-156, stays verbatim — flat name→name[]
data, matches every precedent: "doesn't force anything to stay together"),
one delegate call `initSchema(ctx)` (3307, into the already-split-out
`module/schema.js`).

Section markers (author's own `// ===` comments, grep -n '^  // ==='):
296 NaN-boxing encode/decode · 465 Bump allocator · 1823 Memory-based
length/cap helpers · 1848 binary16 ↔ f64 · 2163 Shared dispatch helpers ·
2922 Property dispatch (.length, .prop) · 3306 Schema helpers (delegate only).
Not every section header bounds a real seam (matches `stdlib-math.md`'s own
finding) — e.g. `__u8_clamp`/`__len`/`__cap`/`__str_len`/`__set_len`/
`__alloc_hdr`/`__alloc_hdr_n`/`__obj_clone` sit after the "binary16" header
with no header of their own, but are NOT part of that family (zero shared
state, foundational memory-layout helpers used file-wide instead).

## Family map (real seams, by grep-verified zero fan-out beyond self)

| family | new file | lines (orig) | content |
|---|---|---:|---|
| binary16 | `module/core/f16.js` | 1848-1908 (61) | `__f16_to_f64`, `__f64_to_f16` — Float16 ↔ f64 bit conversion. Already delimited by the file's own header. Grep-verified: neither name appears anywhere else in core.js (repo-wide: only `module/typedarray.js` references them, exclusively via `inc('__f16_to_f64'\|'__f64_to_f16')`/`deps()`/raw `call $__f16_to_f64` WAT text — a runtime name dependency, not a JS import, unaffected by which file registers them). Zero `ctx.*` branching inside either body. |
| error-object | `module/core/error-object.js` | 3340-3534 (195) | `isClosedObjLiteralNoStringMethod`, `isClosedObjNoStringMethod`, `hasKnownObjPrimitiveHook`, `unsupportedErrorMessage`, `errorMessageIR`, `buildErrorObject`, and the `for (const cls of ERR_CLASS_NAMES) ctx.core.emit[cls] = …` registration loop. Grep-verified: each of the 6 private helpers has exactly ONE call site, and every one of those call sites is inside this same range — a fully self-contained leaf, zero coupling to any other closure-scoped helper in the file (only reads top-of-file imports + the `ctx` singleton). |
| durable-log | `module/core/durable-log.js` | 684-957 (274) | `__durable_fwd_log`/`__durable_fwd_heal`, `__durable_arr_snap`/`__durable_arr_heal`, `__is_eph_bits`, `__durable_slot_log`/`__durable_slot_relog`/`__durable_slot_cancel`/`__durable_slot_heal` — the `_clear()`-survival heal-on-clear logging family (own-memory only; nested inside `if (ctx.memory.shared) {…} else { … }`'s `else` arm, contiguous). Grep-verified: zero `__region_*` references inside this range (only a doc-comment analogy at line 14-of-range, prose, not a call); zero use of `lane`. |
| region-arena | `module/core/region-arena.js` | 959-1710 (752) | `__region_memo_get`/`__region_memo_set`, `__region_mark`, `__region_exit_force`, `__region_exit`, `__region_relocate_props`, `__region_relocate_cell`, `__region_copy_rec` — round-scoped Cheney-copy compaction (own-memory only, same `else` arm, immediately after durable-log, contiguous through the arm's close). Grep-verified: zero `__durable_*` calls inside this range; needs `lane` (self-computed via `collectionLaneBytes()`, a pure `() => ctx.transform.compactCollections ? 0 : LANE` — cheap to call a second time rather than thread through a parameter, matching the file's own top-of-closure `const lane = collectionLaneBytes()` pattern). |

**Declined as a 5th declGlobal-only fragment**: the 5 `declGlobal` calls for
`__scratch_base`/`__scratch_heap`/`__scratch_end`/`__memo_cap_hint`/
`__region_force` (lines 647-651) are region-arena's OWN globals (grep-
verified: used nowhere before 647 or between 651-1080) but sit textually
**before** `__alloc`'s owned-memory body (657) — i.e. not contiguous with
the rest of region-arena. Moving them into region-arena.js and calling a
"declare globals" entry point at line 647's position, separately from
`registerRegionArena()` at line 959's, would work, but risks nothing over
just leaving 5 one-line `declGlobal` calls in the core.js trunk at their
exact original position (zero behavior difference either way — WAT globals
don't care which `.js` file declared them, only relative call ORDER across
different names, which staying put trivially preserves). Left in trunk —
the lower-risk, equally-correct choice; noted here so a future reader does
not mistake it for an oversight.

**Declined as its own family**: `__typed_idx`/`__typed_idx_tagged` (319-399,
~90 lines, `arr[i]` element-read dispatch) — self-contained in the sense
that no other core.js JS helper calls them, but they sit inside the
"NaN-boxing encode/decode" section alongside `__mkptr`/`__ptr_offset`/
`__ptr_type`/`__is_object` with no header of their own separating them, and
share the same "every module depends on this" foundational role the file's
own doc comment claims for the whole section. No author-drawn boundary,
matching `stdlib-math.md`'s own reason for declining trig/exp/pow-core as
separate files ("no author-drawn sub-boundary… moving would be relabeling
the interconnected bulk under an invented name").

## The trunk (stays — foundational, file-wide, or too interconnected to cut)

- **158-682, 1710-682 gaps, 1823-1846**: NaN-boxing primitives (`__eq`,
  `__is_nullish`, `__is_truthy`, `__ptr_type`, `__ptr_offset`, `__ptr_aux`,
  `__typed_idx*`, `__rem`, `__is_object`, dyn-get/set stubs) + bump allocator
  basics (`__memgrow`, `__memgrow_exact`, shared/owned `__alloc`/`__clear`) +
  memory-layout headers (`__typed_shift`, `__typed_data`, `__u8_clamp`,
  `__len`, `__cap`, `__str_len`, `__set_len`, `__alloc_hdr`, `__alloc_hdr_n`,
  `__obj_clone`) + `__coll_order`/`__hash_keys_ro` (1713-1821, doc comment:
  "Lives in core (not collection) because object and json iterate HASH
  tables without pulling the collection module" — cross-module foundational,
  not region/durable-specific despite sitting textually adjacent to both).
  Every one of these is either called by dozens of sites across this file
  and/or other modules via WAT name, or is the file's own literal "Every
  module depends on this" foundation. Matches every precedent's own
  "general primitives used file-wide… stays" verdict (collection.js's
  probe-family helpers, array.js's core, math.js's `f`/`fn`/`canon` layer).
- **2163-3305 ("Shared dispatch helpers" + "Property dispatch")**: `.`/`?.`/
  `?.[]`/`?.()`/`typeof` emitters, `emitPropAccess`, `emitSchemaSlotRead`,
  `emitSchemaSlotGuarded`, `schemaGuardOk`, `emitDynGetExprTyped`,
  `emitDynGetAnyTyped`, `emitTypeTag`, `withReceiverTag`, `literalAst`/
  `literalSlot`/`literalSid`, `emitLengthAccess`, `buildLengthHelper`, etc.
  Read in full — deeply, mutually interconnected (e.g. `emitPropAccess`
  calls `emitSchemaSlotGuarded` calls `schemaGuardOk`/`cloneIR`;
  `emitDynGetAnyTyped`/`emitDynGetExprTyped` share `withReceiverTag`/
  `emitTypeTag`; `?.`/`?.[]`/`?.()` all route back through `emitPropAccess`/
  `evalOnce`/`optionalGuard`). No low-fan-in seam anywhere in this ~1,143
  line block — the same verdict as string.js's "Method emitters" bulk and
  array.js's map/filter/reduce core.
- **34-156 `deps({...})`**: flat dependency-graph data, stays per every
  precedent (location-independent, would force nothing useful to move with
  it).
- **3306-3338**: `initSchema(ctx)` delegate call + 7 one-line low-level
  pointer/region-intrinsic `ctx.core.emit[...]` wrappers (`__mkptr`,
  `__ptr_type`, `__ptr_aux`, `__ptr_offset`, `__box_bigint`, `__unbox_bigint`,
  `__region_mark`/`__region_exit`/`__region_exit_force`) — each is a 1-line
  `inc(name); typed(['call', '$name', …])` wrapper referencing WAT names as
  plain strings, needing nothing from the families whose STDLIB BODIES
  happen to move (region-arena). Stays exactly where it is; zero edit.

## Dependency order (trivial — 4 independent leaves)

None of the 4 families call each other, none call back into core.js's own
trunk helpers (each reads only top-of-file imports + the `ctx` singleton +,
for region-arena, a self-computed `lane`), and core.js's trunk never calls
INTO any of them at the JS level (only via WAT `$name`, immune to file
location). So there is no real dependency DAG to order — this is 4 parallel
leaves, not a chain. `resolveModuleGraph('bench/jz/jz.js', {resolveNode:
true})` confirms no cycle is even possible: core.js → 4 new files, no new
file imports from `../core.js` or from each other.

Commit order chosen for ascending risk (not forced by dependencies):
f16 → error-object → durable-log → region-arena.

## Import-liveness audit (per new file, grep-verified against the exact
extracted line range, distinguishing real code from comment-prose false
positives — several single-letter/common-word imports, e.g. `T`, `wat`,
`spread`, collided with WAT-text local names (`$T`) or English prose
("a spread makes the key set open") inside comments; verified by checking
for a real call-shape (`name(`) inside the range, not just a word-boundary
regex hit)

- `f16.js`: `ctx` (registration target only, no branching), `nanPrefixHex`
  (layout.js — the f16→f64 NaN case).
- `error-object.js`: `ctx`, `err`, `inc`, `emit`, `typed`, `asF64`, `temp`,
  `tempI32`, `isUndef`, `truthyIR`, `toStrI64`, `mkPtrIR` (ir.js/ctx.js/
  bridge.js), `valTypeOf` (kind.js), `VAL` (reps.js), `PTR` (ctx.js), `ERR`,
  `ERR_CLASS_NAMES` (err-codes.js).
- `durable-log.js`: `ctx`, `declGlobal`, `PTR`, `LAYOUT` (ctx.js),
  `UNDEF_NAN`, `TOMB_NAN` (ir.js), `nanPrefixHex`, `nanPrefixMaskHex`,
  `ssoBitI64Hex` (layout.js).
- `region-arena.js`: `ctx`, `declGlobal`, `PTR` (ctx.js), `MAP_ENTRY`,
  `INIT_CAP`, `collectionLaneBytes` (collection.js), `regionCopyRecBody`
  (layout-kinds.js).

core.js imports dropped as dead **after** the 4 moves (each name's only
real-code use falls entirely inside a moved range): `mkPtrIR`, `truthyIR`,
`toStrI64`, `isUndef` (ir.js), `ERR`, `ERR_CLASS_NAMES` (err-codes.js),
`nanPrefixMaskHex`, `ssoBitI64Hex` (layout.js), `INIT_CAP` (collection.js),
`regionCopyRecBody` (layout-kinds.js). `nanPrefixHex`/`PTR`/`LAYOUT`/
`UNDEF_NAN`/`TOMB_NAN`/`declGlobal`/`MAP_ENTRY`/`ERR`(→dropped, see above)/
`err`/`inc`/`emit`/`typed`/`asF64`/`temp`/`tempI32`/`valTypeOf`/`VAL` all
have a SECOND, independent real use in the surviving trunk (verified per-name
against the trunk range) and stay imported in core.js too.

Pre-existing dead imports (not caused by this split — confirmed present at
baseline `c520a39a`, matching `.work/dead-exports-sweep.md`'s held-file
finding for this exact file, same line numbers): `updateRep` (reps.js,
line 20), `STR_INTERN_BIT` (layout.js, line 23), `SET_ENTRY` (collection.js,
line 26) — zero uses anywhere in core.js, before or after this split. Removed
in the final import-only cleanup `6e2d09dc`; its immediate-parent oracle was
CLEAN 560/560 and rebuilding produced the exact same kernel hash.

## Gate per commit

Leaf-first pure moves, one commit per family. After every move: cycle check
(`resolveModuleGraph('bench/jz/jz.js', {resolveNode:true})`), `node
scripts/refactor-oracle.mjs check --ref <immediate-parent>` (560/560),
`npm run build`, `node test/kernel-parity.js`, `node test/kernel-oracle.js`,
minimal-output/autoload/eager-stdlib checks, and a JZ-hosted leg. Commit only
when all correctness checks are clean. Extracted bodies were diffed
byte-identical (modulo mechanical leading-whitespace de-indent; region-arena
also re-derives the pure `lane` value) against the immediately preceding
committed `core.js` before each file was wired in.

## Status — landed

Base: `c520a39a`. All four planned families were accepted; no attempted
family was rejected or reverted.

| commit | family | moved body | result |
|---|---|---:|---|
| `005f3216` | binary16 → `core/f16.js` | 61 lines | CLEAN 560/560; cycle graph 280 modules; kernel parity 33/33; self-compile includes 6/6; eager parity 55/55 |
| `5868a446` | Error objects → `core/error-object.js` | 195 lines | immediate-parent oracle CLEAN 560/560; graph 281; build clean; native Error/minimal/autoload battery 804 assertions; kernel oracle 605/605; JZ-hosted Error battery 324 assertions |
| `4b15ef7d` | durable heap log → `core/durable-log.js` | 274 lines | immediate-parent oracle CLEAN 560/560; graph 282; build clean; native targeted battery 1,686 assertions; kernel parity/oracle 33/605; self-host 206 assertions including warm `_clear()` reuse |
| `51ef4a31` | region arena → `core/region-arena.js` | 752 lines | immediate-parent oracle CLEAN 560/560; graph 283; build clean; native targeted battery 1,786 assertions (including region relocation); kernel parity/oracle 33/605; self-host 206 assertions; JZ-hosted layout/region battery 100 assertions |
| `6e2d09dc` | dead-import cleanup | 3 names | immediate-parent oracle CLEAN 560/560; build and kernel SHA byte-identical to pre-cleanup; minimal/autoload/eager battery 355 assertions |

The f16 move's recorded oracle used `c520a39a`; its immediate parent
`d9de7ed6` changes only this ledger, so the compiler tree compared is
identical. Final cumulative oracle against `c520a39a`: CLEAN 560/560.

### Final shape

| file | lines | role |
|---|---:|---|
| `module/core.js` | 2,261 | foundational primitives, allocator, collection-order helpers, dispatch/property/schema wiring |
| `module/core/f16.js` | 76 | binary16 conversion registrations |
| `module/core/error-object.js` | 217 | Error-class emit registrations and message conversion |
| `module/core/durable-log.js` | 300 | own-memory `_clear()` durable heal registrations |
| `module/core/region-arena.js` | 782 | own-memory round-compaction registrations |
| **total** | **3,636** | baseline was 3,535; +101 lines are module docs/imports/wrappers |

`core.js` itself fell from 3,535 to 2,261 lines: **−1,274 lines
(−36.0%)**. Registration/declaration order is unchanged: the own-memory arm
still runs `__alloc`/`__clear`, then durable-log, then region-arena, then
closes before `__coll_order`; the five region scratch globals remain in
their original pre-`__alloc` position.

Final battery:

- Native full suite excluding prohibited `bench-c`: 3,862 pass, 1 skip,
  0 fail; 28,540 assertions across 94 files.
- JZ-hosted full suite: 3,039 pass, 1 skip, 0 fail; 14,676 assertions.
- `test/self-compile.js`: 21/21 tests, 206 assertions, including warm and
  no-clear reuse; `kernel-parity`: 33/33; `kernel-oracle`: 605/605.
- Minimal-output/autoload/self-include/eager checks passed throughout;
  final focused run: 108 tests, 355 assertions.
- `scripts/bench-size.mjs --json`: all 60 rows byte-identical to a fresh
  archived `c520a39a` run.
- `npm run build`: clean after every family. Fresh baseline/final kernels:
  17,908,577 → 17,904,847 bytes (−3,730). The self-host bundle gains four
  registration functions (function section +4 bytes) while its code/data
  sections shrink 1,333/2,400 bytes; target-program Wasm remains exactly
  identical under the oracle.

The local stopwatch-only `self-compile-perf` gate ran under severe concurrent
load (observed averages 22–66, with 8–10-core test262 plus several builds).
Its three deterministic structural pins passed. Timing was visibly unusable:
a fresh archived `c520a39a` baseline failed the same warm and fresh caps;
the final tree's fresh rerun later passed at 0.807× while its warm samples
still swung 1.099–1.274×. A direct order-alternated final/baseline comparison
of the production warm mode measured 1.001× geomean (six pinned cases), i.e.
no measurable split regression. The noisy standalone warm-cap failure is
reported, not treated as a product result.

### Remaining map

No further pure-move seam was found. The retained trunk is the dependency
map, NaN-box/allocator/header/collection-order foundation, and the mutually
connected dispatch/property/schema block described above. Deliberately
retained: the five region globals at their order-sensitive pre-allocator
site and `__typed_idx`/`__typed_idx_tagged` inside the author-drawn NaN-box
section. No outlier decomposition or walker rewrite was justified; doing
one would invent a semantic refactor rather than finish this navigation
slice.

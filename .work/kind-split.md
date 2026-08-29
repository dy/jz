# kind.js split map (pipeline-minimality slice)

`src/kind.js` (1,692 lines) — expression value-KIND inference (STRING, ARRAY,
BIGINT, …) + JSON shape propagation. Read in full before any move. This doc
is the step-1 deliverable; §4 is the plan actually executed.

## 1. Families (by content, not by superficial name)

| family | lines | what it answers |
|---|---:|---|
| literal lattice | 22-98, 186-190 | `literalTruthiness`/`literalValue`/`literalBool` (private, mutually recursive trio, zero ctx dependency) + `nullishArm` (exported join predicate: "is this arm a nullish literal") |
| VT dispatch table + `valTypeOf`/`valTypeOfWithLocals` | 100-273, 814-1425 | the `VT = Object.create(null)` per-op table (literal ops, `?:`/`&&`/`||`/`??` joins, `[]`/`.`/numeric/`()` resolution incl. bare-name AND `.`-member call-target resolution via `ctx.types.callTargets.resolveMember`), `hasAmbiguousBoolMerge`, the two exported entry points |
| dict/map value-kind census | 274-812 | whole-program "every value ever written through `d[k]=v`/`m.set(k,v)`" union-tracking (`dictValueKindOf`/`mapValueKindOf`/`censusKindsOf`/`censusShapedNode`/`censusMaybeUndefinedKind`/`censusBigintResultShape`/the 3 body-trace functions) — deliberately NOT wired into the VT table's general dispatch (see §3) |
| JSON shape propagation | 1427-1626 | `shapeOf`/`jsonConstString`/shape-tree builders/unifiers, `spreadSchema`/`spreadMergeResolves` (object-spread schema mirror of module/object.js) |
| object-literal shape constructor | 1654-1692 (`shapeOfObjectLiteralAst`) | builds a shape tree from a `{}` AST node at decl time; textually adjacent to the shape family but the ONE function in it that calls the general `valTypeOf` (scalar-literal-property leaf case) |

## 2. Exported surface × consumers (grepped across src/, module/, jzify/, test/)

| export | consumers outside kind.js |
|---|---|
| `typedCtorElemValType` (passthrough from kind-traits.js) | **zero** — every real importer (`narrow.js`) already imports it directly from `./kind-traits.js`, not through kind.js's barrel |
| `nullishArm` | ir.js, compile/emit.js, compile/program-facts/slot-kind-census.js, compile/representation-plan/{body-data,provenance}.js |
| `hasAmbiguousBoolMerge` | bridge.js, src/type/expr-type.js, compile/index.js, compile/narrow.js, compile/emit.js, module/core.js, module/string.js |
| `dictValueKindOf`, `mapValueKindOf`, `censusKindsOf` | **zero real importers** — named only in doc comments (reps.js, ctx.js, session.js) and test-file prose; internally live (called by `censusMaybeUndefinedKind`) but externally dormant, matching `censusKindsOf`'s own doc ("ZERO consumers as of product-lattice Slice 1") |
| `censusShapedNode` | ir.js, prepare/index.js |
| `censusMaybeUndefinedKind` | ir.js, compile/emit.js, compile/representation-plan/body-data.js, compile/analyze/val-types.js |
| `BIGINT_JOINT_BINARY_OPS` | compile/emit.js, compile/representation-plan/{materialize,body-data}.js |
| `censusBigintResultShape` | compile/index.js |
| `nameMayBeUndefinedInBody` | test/types.js (direct unit tests); named in session.js/reps.js doc comments |
| `exprMayBeUndefinedIn` | compile/flow-types.js, compile/narrow.js |
| `exprMapGetShapedIn` | src/type/expr-type.js |
| `censusMaybeUndefined` | ir.js, module/number.js, module/console.js, module/string.js |
| `namePresentValInBody` | named only in doc comments (session.js, reps.js) — no direct external call site |
| `exprPresentValIn` | compile/narrow.js, src/type/expr-type.js |
| `valTypeOf` | ubiquitous — ~30 files across src/compile/*, module/*, src/type/*, bridge.js |
| `valTypeOfWithLocals` | compile/flow-types.js, compile/narrow.js, compile/infer.js |
| `jsonConstString` | **zero external importers** (module/json.js has an unrelated same-named private `jsonConstString(ctx, expr)`, different arity, not this one); used internally by `jsonShapeStrings` |
| `shapeOf` | compile/emit-assign.js, compile/emit.js, module/object.js, module/core.js, compile/analyze/val-types.js |
| `shapeOfObjectLiteralAst` | compile/infer.js |

`kind.js` is not part of the npm public surface (`package.json` `exports` only
lists index.js/wasi.js/interop.js/transform.js), so an unused re-export is
ordinary internal dead code, not an API-compat question.

## 3. The three-times-reverted logic (DO NOT TOUCH)

Every `dictValueKindOf`/`mapValueKindOf` doc comment in the census family
repeats one invariant: their census claim must **never** be promoted into
`VT['[]']`/`VT['.']`/`VT['()']`'s general dispatch — an absent dict/Map key
reads real `undefined` at runtime regardless of the observed write-kind
union, and an aliased write (`const a = d; a[k]=v`) is invisible to a census
keyed on `d`'s own name. `censusKindsOf`'s doc cites "three prior attempts to
promote this exact axis globally were reverted as unsound." This logic
(the gating predicates, the `nameEscapes` alias gate, the opt-in-only
projection shape) is moved **verbatim** into `dict-census.js` — no gate, no
condition, no call site touched.

## 4. Module plan (executed)

Cycle baseline (`resolveModuleGraph(bench/jz/jz.js, {resolveNode:true})`,
249 modules): **0 cycles** today. `kind.js` imports nothing from `ir.js`/
`type.js`; `ir.js` and `src/type/expr-type.js` import FROM `kind.js` only;
`kind-traits.js` imports nothing from `kind.js`.

CORRECTION (found empirically while landing `dict-census.js`, not by
analysis): the task's cycle warning names ir.js/type.js/kind-traits.js as
examples, but the REAL constraint is stricter and file-agnostic — jz's own
`src/prepare/index.js` (the module-graph walker that runs when jz compiles
ITSELF into `dist/jz.wasm`) throws a hard error on ANY import cycle
anywhere in the graph it's given, full stop, regardless of whether the
cycle would be safe under native Node ESM's live-binding semantics (it
isn't just being cautious about the three named files — a `dict-census.js`
↔ `kind.js` cycle one level deeper in the new split tripped it too, even
though every binding on both sides was a hoisted `function` declaration
referenced only inside other function bodies — provably TDZ-safe under
native execution, and confirmed loading fine via plain `node -e "import(…)"`
— yet still rejected). Every new `src/kind/*.js` module must be a DAG with
the rest of the split, no exceptions, verified by actually building
`dist/jz.wasm` (not just `resolveModuleGraph` + a native load test) after
each move — see §4's `dict-census.js` entry for the one place this forced
an edit beyond a pure move.

| new file | content | imports from other new kind/ files |
|---|---|---|
| `src/kind/lattice.js` | `literalTruthiness`/`literalValue`/`literalBool` (private), `nullishArm` (exported) | none |
| `src/kind/dict-census.js` | the full census family, byte-for-byte, **minus one substitution** (`mapValueKindSet`'s `valTypeOf(name)` → `lookupValType(name)`) — see below | none |
| `src/kind/shape.js` | JSON shape family MINUS `shapeOfObjectLiteralAst` | none |
| `src/kind/val-type-of.js` | VT table, `hasAmbiguousBoolMerge`, `valTypeOf`, `valTypeOfWithLocals`, **+ `shapeOfObjectLiteralAst`** (relocated — see below) | `literalTruthiness`/`nullishArm` (lattice.js), `censusMaybeUndefinedKind` (dict-census.js), `shapeOf`/`jsonConstString`/`spreadMergeResolves` (shape.js) |
| `src/kind.js` | barrel only — re-exports every current name from its new home, plus the pre-existing `typedCtorElemValType` passthrough from `kind-traits.js` | — |

Two placement calls, both grep-verified before deciding, neither a logic
edit:

- **`shapeOfObjectLiteralAst` moves out of the JSON-shape family into
  `val-type-of.js`.** Textually it sits at the end of the shape block
  (1654-1692), but it is the ONE function in that block that calls the
  general `valTypeOf` (its scalar-literal-property-leaf branch, line 1677).
  Every other shape-family function (`shapeOf`, `jsonConstString`,
  `shapeOfJsonValue`, the unifiers, `spreadSchema`/`spreadMergeResolves`)
  has zero `valTypeOf` dependency (grep-verified: no `valTypeOf(` hit
  outside 1654-1692 within the shape range). Keeping it with the shape
  family would force a `shape.js` ↔ `val-type-of.js` cycle for the sake of
  one function; moving it the other way needs zero import at all in either
  direction (`val-type-of.js` already has `valTypeOf` and imports `shapeOf`
  from `shape.js` for `VT['.']`, which `shapeOfObjectLiteralAst` also
  calls). Net: `shape.js` → zero dependency on any other new kind/ file;
  `val-type-of.js` → `shape.js` one-directional.
- **`dict-census.js`'s one `valTypeOf(name)` call site (`mapValueKindSet`)
  is substituted to `lookupValType(name)` — REQUIRED, not a style choice.**
  First attempt kept it verbatim (a real, deliberate "do not touch that
  logic" bias — §3 — reasoning that Node's live-binding ESM semantics make
  a `dict-census.js` ↔ `val-type-of.js` cycle race-free: every
  cross-referenced binding on both sides is a hoisted `function`
  declaration, never a `const` arrow, referenced only from inside other
  function bodies, never at module top-level evaluation). That reasoning is
  correct for NATIVE Node execution (confirmed: `node -e "import('./src/
  kind.js')"` loads fine with the cycle in place) but WRONG for this
  codebase's actual constraint: kind.js is on the self-hosted compiler
  surface, and jz's own module-graph walker (`src/prepare/index.js`,
  invoked when jz compiles itself into `dist/jz.wasm`) hard-rejects ANY
  import cycle, unconditionally — `node scripts/build-dist.mjs`-equivalent
  failed with `Error: Circular import: …/prepare/index.js -> …/
  program-facts/walk-facts.js -> …/slot-kind-census.js -> kind.js ->
  kind/dict-census.js -> kind.js — break the cycle by moving the shared
  code into a third module both sides import`. jz's own bundler does not
  get the native-ESM live-binding luxury (it linearizes module init order
  for the compiled output), so §3's "do not touch that logic" has to yield
  to a harder correctness requirement: the substitution is proven
  behavior-identical (`valTypeOf`'s own string branch IS `return
  lookupValType(expr)`, and `mapValueKindSet` already guards `name` to a
  string one line above the call), touches zero soundness/promotion logic
  (the census-vs-VT-dispatch invariants §3 protects), and is the only way
  to make `dict-census.js` buildable at all as a separate module. Verified:
  self-host build succeeds after the substitution (`dist/jz.wasm` built
  clean), oracle clean, kernel-parity clean.

## 5. Status

All 5 commits landed on `refactor/kind-split` (base 45987028):

| commit | sha | change |
|---|---|---|
| 1 | dcd6d1f7 | `kind/lattice.js` extracted |
| 2 | 23deeaf6 | `kind/dict-census.js` extracted (+ the required `lookupValType` substitution) |
| 3 | d7cf9c7c | `kind/shape.js` extracted |
| 4 | aac31710 | `kind/val-type-of.js` extracted; `kind.js` becomes a pure barrel |
| 5 | (next)  | dead-code deletion: `export { typedCtorElemValType } from './kind-traits.js'` — zero consumers via the barrel path (verified: every real importer, `narrow.js`, already imports it directly from `kind-traits.js`; val-type-of.js's own internal use also imports it directly, not through the barrel) |

Final module map:

| file | lines |
|---|---:|
| `src/kind.js` (barrel) | 27 |
| `src/kind/lattice.js` | 98 |
| `src/kind/dict-census.js` | 569 |
| `src/kind/shape.js` | 221 |
| `src/kind/val-type-of.js` | 879 |
| **total** | **1,794** (was 1,692 — net +102 from 5 module-doc headers/import blocks instead of 1; same logic, same behavior) |

Gate results, every commit: refactor oracle `check --ref 45987028` CLEAN
(560/560); kernel rebuilt fresh (`dist/jz.wasm`, confirms each intermediate
state is a buildable DAG under jz's own self-host module graph — this is
the check that actually matters, not `resolveModuleGraph` alone, see §4's
correction); `test/kernel-parity.js` 3/3 (33/33 byte-identical WAT O2/O3).

Cycle-checker (`resolveModuleGraph(bench/jz/jz.js, {resolveNode:true})`,
custom DFS): confirms zero cycles in the final tree — `dict-census.js`'s
`lookupValType` substitution eliminated the one cycle that would otherwise
exist (`val-type-of.js` → `dict-census.js` for `censusMaybeUndefinedKind`,
`dict-census.js` → `val-type-of.js` for `valTypeOf`); `shape.js` never had
one (the `shapeOfObjectLiteralAst` relocation avoided it by construction).
ir.js/type.js/kind-traits.js relationships unchanged (kind.js's submodules
import from kind-traits.js only, never the reverse; ir.js and
src/type/expr-type.js import FROM kind.js's barrel only).

## 6. Merge with main + final battery

Mid-slice, main advanced (33aafd82 → 9da6a37c: the assemble.js outlier
split landing + the repo owner's own tree: compiler scope/dispatch/parser
fixes, the Porffor adapter, bench-evidence fail-closed). None of those
commits touch `src/kind.js` or `src/kind/*.js`. `git merge 9da6a37c`
(merge commit `a18f0027`) applied clean — no conflicts, nothing to
re-apply by hand.

Full battery on the merged tree (`a18f0027`):
- `node scripts/refactor-oracle.mjs check --ref 9da6a37c` — CLEAN, 560/560.
- `node test/index.js` (TESTS minus `bench-c`, 92 names) — 3802/3803 pass,
  1 pre-existing skip, 0 fail (28,301 assertions).
- Kernel rebuilt fresh on the merged tree (`dist/jz.wasm`, same compile
  call `scripts/build-dist.mjs` itself uses via `resolveSelfCompileBuild`).
- `JZ_TEST_TARGET=jz.wasm node test/index.js` (plain invocation) —
  3000/3001 pass, 1 skip, 0 fail (14,509 assertions).
- `test/kernel-parity.js` — 3/3 (33/33 byte-identical WAT O2/O3).
- `test/kernel-oracle.js` — 14/14 (605 assertions).
- `test/data.js` standalone — 171/171 (935 assertions).
- `scripts/bench-size.mjs --json` — exit 0, no anomalies across all 60
  bench cases (jz/jz+wasmopt/AssemblyScript columns).

**Kernel bytes, investigated in detail**: 17,817,535 → 17,817,536 (+1
byte; baseline built fresh from a detached `9da6a37c` worktree using the
identical build path, confirmed run-to-run DETERMINISTIC — rebuilding the
unmodified baseline twice produced byte-identical hashes). The diff is
NOT random: `cmp`/section-walking isolated it entirely to the `jz:schema`
custom section content (same total length both sides, 330 differing bytes
inside it — property-list registrations, e.g. an `enter` entry and a
cluster of numeric-placeholder salted-dedup ids, appear at shifted
positions) — every other section (types, imports, functions, code
LENGTH, etc.) is byte-identical. Root cause: `jz:schema`'s ids are
assignment-order-dependent ("entry index === schema id" per
compile/index.js's own writer comment), and the self-host bundle's
module-discovery order (`resolveModuleGraph`, DFS over imports) does not
preserve a single file's internal top-to-bottom order once that file's
functions are spread across several new modules — so the SET of
registered shapes is unchanged, only when-first-encountered shifts for
entries downstream of kind.js's split point. This is the same class of
effect `.work/pipeline-minimality.md`'s own battery reports already show
as normal slice-to-slice drift (kernel size fluctuating a few KB across
otherwise behavior-preserving slices), not something specific to a
mistake here. Confirmed inert, not just plausible: the full
kernel-target suite (14,509 assertions, including every schema/object/
Error-class-decoding test in the corpus) and kernel-oracle (605
assertions targeting exactly this class of BigInt/shape mismatch) both
passed 100% against the rebuilt kernel.

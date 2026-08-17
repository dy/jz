# RepresentationPlan v2 — edge-normalized BigInt provenance

Status: **design, not code** (2026-08-17). Grounded in current main
`2e4072df` and an exact resurrection of the rejected five-commit experiment:

- `cfef7c71` — add frozen BigInt representation provenance
- `55b20a1e` — close storage-backed subnormal provenance
- `3f45fbeb` — discover FeaturePlan across bundled module graph
- `d0d24341` — freeze representation plans for closure bodies
- `94e83fa8` — keep representation projections plan-local

The old branch is evidence, not a base to reapply.

## 0. Decision

Build RepresentationPlan v2, but **do not revive `__to_num_raw` as a fallback
for unknown/TOP values**. A raw-BigInt-or-Number carrier is physically
ambiguous. Analysis cannot make that runtime union distinguishable by labeling
it TOP; it must normalize the edge (box BigInt), split the function by
representation, or reject the unsupported flow.

The plan therefore owns **edge representation**, not merely the source
expression's likely bits.

## 1. Exact postmortem of v1

The old branch reproduced the FeaturePlan import-order fix, but its self-hosted
kernel compiled:

```js
export let f = () => -5e-324
```

as `(f64.const -1)`. Positive `5e-324` remained correct. Native compilation
was correct; the wasm-hosted compiler was wrong.

This was not a generic optimizer failure. The kernel's own compiler graph had
20 `typeof … === 'bigint'` sites for which v1 reported **raw possible + boxed
possible**. They include `kind.js`'s `literalTruthiness`, `literalValue`, and
`valTypeOf` helpers—the exact functions that process AST leaf values. Once
whole-graph discovery correctly set `ctx.features.bigint=true`, their retained
magnitude arm interpreted a real negative subnormal Number as a raw BigInt;
unary negation then produced `-1`.

Two v1 rules caused this:

1. **Source fact was mistaken for edge fact.** Param lattice `bigintReps`
   joined the caller argument's source representation. It did not apply the
   call edge's `bigintBoxed` transform. `repFromValueRep` even consulted
   `bigintReps` before `bigintBoxed`.
2. **TOP still guessed from magnitude.** `rawBigintPossible(TOP)` selected
   `__to_num_raw` and `TYPEOF.bigint` kept the subnormal heuristic. TOP is
   uncertainty, not a runtime discriminator.

A diagnostic attempt to mark every `typeof` parameter `bigintBoxed` caused a
memory-OOB failure: some recursive/indirect edges still delivered raw values
while the callee unboxed them. That falsifies a body-only patch. Boxing demand
must cover **every incoming edge**, including direct, recursive, closure, and
host boundaries, before a consumer may trust the tagged representation.

## 2. Two facts, never one conflated flag

For every binding/result/edge, the plan carries:

```js
SemanticKinds = { possibleKinds, kindsCoverage }
BigIntRep = { bits, repCoverage }
// bits: 0 NONE, 1 RAW_I64, 2 BOXED_PTR, 3 RAW_OR_BOXED
```

These answer different questions:

- `possibleKinds`: can this value semantically be BigInt, Number, undefined…?
- `BigIntRep`: if it is BigInt, how is that BigInt represented here?

A third fact is a backward demand:

```js
BigIntDemand = 'raw-ok' | 'tag-required'
```

`tag-required` means this consumer must distinguish BigInt from another
runtime kind (typeof, generic ToNumber/ToNumeric, identity/hash, mixed
arithmetic, kind-erasing storage, dynamic return/boundary).

### Projection rules

- Definite BigInt + RAW only → raw i64 operations are legal.
- Definite BigInt + BOXED only → unbox by `PTR.BIGINT` tag.
- BigInt-or-Number + BOXED only → runtime tag dispatch is legal.
- No BigInt with closed coverage → no BigInt arm.
- Open coverage or RAW-or-BOXED may not exclude either representation.
- **BigInt-or-Number with RAW possible at `tag-required` is illegal plan
  output.** Normalize/specialize/reject; never magnitude-guess.

This is the central v2 invariant.

## 3. The plan is edge-normalized

Each call/storage/boundary edge records both sides:

```js
EdgePlan = {
  source: BigIntRep,
  demand: BigIntDemand,
  action: 'keep-raw' | 'keep-boxed' | 'box' | 'unbox' | 'variant' | 'reject',
  target: BigIntRep,
}
```

The invariant is checked mechanically:

```text
apply(action, source) == target
and target satisfies demand
```

`bigintBoxed` becomes an input/provenance alias during migration, then is
replaced by these explicit edge actions. A source RAW fact never silently
survives a `box` edge into the callee's entry fact—the v1 mistake becomes
unrepresentable.

## 4. Solver

Run after semantic call-site/kind facts settle and before FunctionPlan
publication.

### 4.1 Forward representation seed

- BigInt literal / `BigInt()` / BigInt arithmetic → RAW.
- `PTR.BIGINT` storage read → BOXED.
- BigInt typed-array element read → RAW.
- ordinary ARRAY/OBJECT/HASH/MAP/SET/closure cell read → BOXED for the BigInt
  member, because write-side `carrierF64` owns those stores.
- Number/Bool/String/etc with closed kind coverage → NONE.
- uncovered external/indirect source → open RAW_OR_BOXED until its boundary is
  normalized.

### 4.2 Backward demand

Seed `tag-required` from:

- `typeof x === 'bigint'` / generic typeof,
- generic `Number`, unary `+`, ToNumeric and mixed binary dispatch,
- equality/SameValueZero/hash over dynamic values,
- kind-erasing storage and closure capture,
- dynamic function returns and JS exports,
- destructured/uncovered params.

Propagate demand backward through aliases, joins, params/results, closure
captures, and module globals to the nearest legal normalization edge.

### 4.3 Edge action

- RAW-only source + raw-ok target → keep raw.
- BOXED-only source → keep boxed (or unbox for a definite-BigInt raw-only
  arithmetic variant).
- RAW source entering tag-required target → box.
- Mixed callers where boxing every call would tax a raw arithmetic core →
  materialize two representation variants:
  - `$f$raw`: definite-BigInt/raw-only ABI
  - `$f$tagged`: dynamic f64 carrier; every BigInt edge boxed
- Unknown edge that cannot be normalized or specialized → compile-time
  diagnostic, not heuristic fallback.

Use the existing `materializeVariant` authority. Representation variants are a
general context-specialization class, not named benchmark tweaks.

### 4.4 Fixpoint

Alternate:

1. forward source/result representations,
2. backward demands,
3. edge actions / variant selection,
4. forward target representations.

Finite lattice: 4 representation bitsets × 2 coverage states × 2 demands.
Stop on a change signal, not a fixed round count. Recursive SCCs converge to a
normalized tagged variant or reject; they do not remain TOP and proceed to
emission.

## 5. Boundary rules

### Direct internal calls

Call emitter consumes `EdgePlan.action`; callee entry reads the plan's target
representation. No re-derivation from AST bits.

### Closure/call_indirect ABI

The generic closure ABI is a tag-required boundary. Any BigInt packed into an
unknown closure argument/result is boxed. A closure proven raw-only and
direct-called may retain a raw specialized path; otherwise the uniform ABI is
tagged.

### JS exports/imports

The host adapter knows actual JS `typeof arg`. Extend boundary metadata with a
BigInt-boxed parameter bitset for dynamic/tagged params; interop allocates a
`PTR.BIGINT` cell for a JS BigInt before calling wasm. Number subnormals remain
plain f64. Exported raw-only BigInt functions keep the current i64 ABI.

This closes the otherwise-unrepresentable exported `Number | raw BigInt`
union without a magnitude test.

### Storage

Ordinary heap storage stays tagged. BigInt typed arrays stay raw. These are
representation facts, not semantic-kind guesses.

## 6. Consumer contract

After v2 settles:

- `$__to_num` is tag-safe only: self-equal f64 is always Number; `PTR.BIGINT`
  dereferences and converts.
- Definite RAW BigInt → Number conversion is emitted inline (or through a
  raw-only helper whose parameter type is *definite BigInt*, never TOP).
- `TYPEOF.bigint` uses static true for definite raw BigInt and a tag check for
  tagged dynamic values.
- `bigIntJointDispatch` uses static domain or `PTR.BIGINT` tag; no subnormal
  magnitude branch.
- equality/hash/truthiness/interop use the same plan/tag distinction.

There is no `ctx.features.bigint` correctness reader. FeaturePlan may later
retain a size-only BigInt feature if a template genuinely needs it, but helper
semantics never depend on module discovery order.

## 7. Immutability and ownership

RepresentationPlan follows current FunctionPlan architecture, not v1's
`Object.freeze({ bindings: Map })`:

- opaque handle under `ctx.plans.representations`,
- canonical primitive/bitset data in a session-owned private map,
- pure scalar projections only,
- persistent function plans detached; linear closure/`__start` plans sealed
  and transferred with their prepared ActiveFunction,
- no mutable Map/Set exposed to emission.

`typedElem`/`typedLen` and FlowState already live on ActiveFunction; no ambient
parallel carrier store is introduced.

## 8. Migration slices

1. **Shadow plan, no codegen.** Compute semantic/rep/demand/edge facts; assert
   lattice convergence and edge equations under debug. Pin old-v1 regressions:
   negative/positive subnormal, watr memory64 limits, storage BigInt, raw
   arithmetic, recursive and closure boundaries. Output byte-identical.
2. **Direct-call normalization.** Consume edge actions for params/results;
   introduce representation variants only where mixed callers require them.
   Keep all old runtime heuristics as fallback but assert they are unreachable
   at covered sites.
3. **Closure + host boundaries.** Tagged generic closure ABI and interop boxed-
   BigInt param metadata. No TOP/raw dynamic boundary remains.
4. **Consumer switch.** Migrate typeof, ToNumber, joint arithmetic,
   equality/SameValueZero/hash/truthiness one family at a time. Each family gets
   native + kernel semantic gates before its magnitude fallback is removed.
5. **FeaturePlan graph completion.** Full module graph discovery, then delete
   `ctx.features.bigint` semantic gating. Flip the audit-#16 differential fixture.
6. **Kill-list deletion.** Remove magnitude helpers, sentinel workarounds made
   redundant, and old `bigintBoxed` action fact once every edge reads the plan.

Do not combine slices 2–4. Completion is measured by deleting fallback
authority, not by adding another planner beside it.

## 9. Mandatory gates

Every slice:

- `npm test`, O0/O3/WASI matrix,
- debug-invariant suite,
- kernel parity + JS execution oracle,
- `npm run test:self`,
- build ×2 convergence,
- byte-identity corpus where the slice is shadow-only.

Before deleting magnitude fallbacks:

- `-5e-324`, `5e-324`, `Number.MIN_VALUE` under a BigInt-using graph,
- audit-#16 later-imported BigInt module in both import orders,
- watr memory64 limits,
- raw internal BigInt arithmetic and large/negative values,
- storage/param/result hops, recursive SCCs, closure/call_indirect, exports,
- fuzz 2000 × O0/O1/O2/O3,
- direct self-host base/new performance and retained-memory A/B.

No FeaturePlan claim until all those pass and the semantic `bigint` flag is
deleted or reduced to size-only demand.

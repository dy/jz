# jz inference module — design principles

Three load-bearing principles that shape `src/infer.js` (and the
`narrow.js` / `analyze.js` halves that still feed it). Anything that
violates one of them is a regression, not a refactor.

## 1. Collect before compile

All shape/flow facts are produced by **analysis passes that run before
emit**, never by ad-hoc inference inside the emit path. The emit phase
**reads** facts (`repOf`, `lookupValType`, `lookupNotString`,
`paramReps[k]`, `f.valResult`, etc.) but never derives them.

Why this matters:

- **Proofs.** Every dispatch-elision (`__length` → `__len`,
  `__to_num` → `asF64`, `__ptr_type` → branch fold, polymorphic
  `[]` → direct typed read) has a *named upstream fact* and a *named
  upstream pass*. When a regression appears, the chain is:
  `wat shows __length` ← `notString missing on param k` ←
  `notStringEvidence didn't fire` ← `body shape didn't match`. Every
  link is a deterministic AST walk over fully-prepared source.

- **Editor-hint consumability.** The same facts are emitted as custom
  WASM sections (`runtime.rests`, `runtime.i64`, etc.) for the JS
  boundary wrapper to read. Nothing prevents an editor host from
  consuming `ctx.func.repByLocal`, `ctx.func.paramReps`, and the per-
  function `f.valResult` / `f.arrayElemValType` to:
  - render param shapes as inlay hints (`(x: STRING, k: i32)`),
  - flag "this branch is suboptimal" when a call site forces a
    `paramReps[k]` field to sticky-null (the lattice already records
    *which* site disagreed — see narrow.js' D-phase),
  - surface `notString` / `intConst` / `arrayElemSchema` as
    optimization badges next to the source location.

- **Auditability.** "Why did this function specialize?" is answered by
  one record (`f.sig`, `f.valResult`, the rep map). "Why did this
  branch *not* specialize?" is answered by the absence of a fact at a
  known location, never by tracing the emit walk.

The phase chronology in `src/infer.js` (above the paramReps lattice
primitives, ~line 84) is the canonical reference for *what's valid
when*. Read it before adding a new consumer.

## 2. Every inference aspect needs an actionable test

If a fact has no test that observes its effect, it's shallow info —
deletable without anyone noticing. The standard is *not* "does the
binding carry the right VAL.* tag" (that's a unit test of the source).
The standard is **"does the compiled WAT change in a way that proves
the fact was used"**:

- `notStringEvidence` proven by: `(xs, v) => { xs[i] = v; return xs.length }`
  emits zero `$__length` calls.
- `methodEvidence` (STRING) proven by: `(s) => s.charCodeAt(0)` emits
  no `$__length` polymorphic dispatch on `s` shape.
- `intConst` proven by: when every caller passes `f(5)`, body's
  `local.get $k` is replaced by `f64.const 5` in emit.
- `inferArgArrElemSchema` proven by: initRows→runKernel flow makes
  `rows[i].x` skip `$__is_str_key` and route through direct
  schema-indexed `f64.load offset=K`.
- `paramReps` sticky-null proven by: caller A passes `[]`, caller B
  passes `"foo"`; body's `xs.length` still routes through `$__length`
  because the lattice poisoned `val`.

The test list at the top of `src/infer.js` (the evidence-ladder
docblock) names the eight rungs. Every rung that's marked `[done]` or
`[partial]` should map to at least one regression test in
`test/inference.js` that breaks when the source is disabled. Items
marked `[pending]` are honest about not having reached this bar yet —
they should be tracked in `todo.md`, not silently shipped.

Pure "fact set, fact read" unit tests on `ctx.func.repByLocal` are
fine *in addition* to a WAT test, but never as a replacement: the
emit-time consumer is the only thing the user observes.

`inferLocals` runs on every function — block- and expression-bodied
alike. The earlier `if (block)` gate at `analyzeFuncForEmit` only
wraps `analyzeBoxedCaptures` + `analyzePtrUnboxable` now, because
those two genuinely need `ctx.func.locals` populated (which only block
bodies produce). Expression arrows like `(s) => s.charCodeAt(0)`
narrow `s` to `VAL.STRING` exactly the same way the block-bodied
equivalent does.

## 3. Consolidation over scatter

The first wave (todo.md tracks A1/A2/A4/C3/C4/D1/D2/D5 done) pulled
inference primitives out of analyze.js / narrow.js / prepare.js /
plan.js into one place. The criterion is **conceptual cohesion at the
import-graph leaf**: anything answering "what shape is this binding,
and what proves it?" lives in `src/infer.js`. Anything answering
"what's the canonical AST shape of expression X?" lives in
`src/analyze.js`. Anything answering "should this binding cross the
JS boundary differently?" lives in `src/exports.js` /
`interop/nanbox.js`.

Two intentional non-moves:

- `analyzeValTypes` and `analyzeIntCertain` stay in `analyze.js`
  because they share `valTypeOf` / `shapeOf` / `staticObjectProps` /
  `typedElemCtor` helpers. Moving them inverts the import direction
  (infer.js already imports those). The orchestrator `inferLocals`
  lives in infer.js and calls them — that's the seam.
- `callerParamFactMap` stays in analyze.js because
  `narrowReturnArrayElems` (also in analyze.js) is its only consumer.

When in doubt: move the *primitive* (single-name, side-effect-free) to
infer.js, leave the *body-wide ctx-mutating pass* in analyze.js.

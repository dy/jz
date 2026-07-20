# Stage 1 — BindingId: design (from the 2026-07-20 terrain map)

Plan: .work/architecture-plan.md "Stage 1". Terrain facts verified against the
tree; file:line refs are from the scout pass.

## The insight the terrain confirms

The BindingId IS the name. Prepare already alpha-renames shadowed/sibling
locals (`name<uniq>`, prepare/index.js:1769-1782) and every downstream
consumer (repOf, locals, findFreeVars, schema.vars, idxKey) is string-keyed
and rename-transparent. So Stage 1 is not a new key type threaded through 61
importers — it is: make the existing rename TOTAL (every binding, unique
module-wide), then delete the containment machinery that exists only because
names were ambiguous.

## What the rename must add (gaps found)

1. **Params are never renamed** (prepare/index.js:2596-2602 identity-maps
   them). A param shadowing a module binding, or agreeing by name with
   another function's param, is exactly the vars-fallback ambiguity class.
2. **Plain catch params aren't even registered** in scopes/funcLocalNames
   (2253-2257) — invisible to isDeclared, never renamed.
3. **Destructured decl targets registered but never renamed** (1735-1746) —
   a destructured shadow silently overwrites the scope entry.
4. **Module scope never renamed** (gate `scopes.length > 0`) — correct to
   KEEP: module-level bindings are the canonical first-claim namespace; the
   uniqueness invariant is "no function-local may collide with any module
   name or any other function's local".

## Scheme

`namef<fnId>_<serial>` for every function-local binding (params, lets,
catch, destructure targets), unconditionally. fnId = the ownerStack arrow id
prepare already mints (ownerUniq, prepare/index.js:2580); serial = per-fn
counter. Module-level bindings stay bare. Two properties fall out:

- Module-wide uniqueness by construction (no census needed to detect
  collisions — they are unrepresentable).
- Determinism: same source → same names (no global uniq counter ordering
  hazards across prepare passes — today's ctx.func.uniq is one flat module
  counter; per-fn serial makes names stable under sibling-function edits,
  which the formatting-invariance gate extends to).

Keep `` (T) as the separator — it is the established synthetic sigil,
already stripped nowhere (WAT `$name` embeds it today for shadowed locals;
no new class of output). `#` rejected: no need for a second convention.

## Deletions unlocked (in landing order)

- **1a. Rename totality** (params/catch/destructure/all-locals + fnId).
  No deletions yet — behavior-neutral rename. Differential leg: compile the
  full test corpus with rename ON vs OFF (registry flag `totalRename`),
  assert identical output bytes on programs with no collisions, identical
  VALUES everywhere. Battery + α-rename fuzz mode (rename every user
  binding at random → byte-identical output modulo name section).
- **1b. Census collapse**: with unique names, `bindSites/assignSid/
  declInitUnknown/ownerStack(as poison scope)/assignBindOwners` — the
  prepare-internal containment (≈200 lines, prepare/index.js:57-129,
  848-940) — reduce to: `poisoned` = "THIS binding observed conflicting
  shapes" (same-binding `=` disagreement only), `varsBarred` = DELETED
  (nothing to bar — a barred name cannot exist), `vars` = one map keyed by
  unique names, locals allowed back in (the vars-scope split's
  save/restore choreography in compile/index.js:1202-1385, 1548-1833
  simplifies later, Stage 2 owns that).
  idOf's belt re-check (module/schema.js:58) becomes a plain lookup.
- **1c. assumedBounds keys**: idxKey(recv, idx) keeps its shape but recv/idx
  names are now binding-unique — the CLONE fragility (stampClonedIdxProof,
  type.js:1999-2012) remains only for structural idx rewrites; move key to
  (recv-binding, canonical idx) where canonical = post-rename AST print.
  assumedConstHull stays as the value-level complement.
- **1d. Name-section translation**: dollar() (ir.js:1190) emits the raw
  key today. Add the reverse map at the ONE consumer that shows names to
  humans: strip `…` suffix in dollar()'s WAT-local path when the
  bare prefix is unambiguous within the function, else keep suffix.
  err()/formatErrorNode keep raw AST (debuggability > prettiness; note in
  ledger).

## Risks / checks

- **Self-host arena volume**: every local name grows ~4-6 chars. Kernel
  build size + selfhost-perf gate will price it; if the fresh-compile
  geomean moves, intern the suffix (fnId digits shared) or shorten T-form.
- **constInts / module consts**: unaffected (module scope stays bare).
- **paramReps/param-lattice channels**: keyed by function identity + index,
  not name (verify in 1a differential).
- **exports**: exports map already separates external key from internal
  name (prepare/index.js:2486-2568) — untouched.
- **defFunc/function names**: separate namespace (3236-3304), out of scope
  for 1a-1c; unify only if a live collision class shows up.
- **Kernel-leg**: the self-hosted kernel compiles the SAME prepare code —
  rename totality must not trip the known kernel closure-ABI classes
  (the census walkers were hoisted to iterative worklists already; keep
  new code in that style — no nested self-recursive closures).

## Sequencing

1a alone is a battery-landable unit and carries all the risk; 1b is pure
deletion once 1a is default-on; 1c is a key-shape change with existing pins
(biquad assumption tests); 1d is cosmetic. Flag `totalRename` registers in
PASS_NAMES? No — it is not an optimization; register in TUNING_KEYS while
the differential runs, delete the flag when default flips (Stage-0 gate
keeps it honest).

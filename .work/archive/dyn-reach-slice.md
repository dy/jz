# Per-schema dyn-reach slice (the 4 GiB close) — recon 2026-08-22, main 114a373b

Problem: `needsDynShadow` (ir.js:1860) short-circuits on whole-program
`ctx.types.anyDynKey` — one `obj[k]` read/write or `for-in` ANYWHERE makes
EVERY object literal mirror all schema fields into a per-object dyn-props
hash (object.js:187 the dominant site; 13.48M __dyn_set calls per
self-compile even after hash-wall's presize). `refineDynKeys`
(narrow.js:3900) is all-or-nothing (one unprovable site keeps the global
bit forever at self-host scale). The dominant __dyn_set contributors
(emptyWalkFacts, ast.js some, parse.js loc) have zero dynamic exposure of
their own — pure collateral.

SMALLEST SOUND SLICE (recon-verified, no new traversals, no new infra):
1. program-facts.js `collectSlotWriteHazards` (:1288+): add sibling
   channel `hz.dynPointsTo: Set<sid> | 'ALL'`, fed from the SAME visit()
   walk by ALSO observing `[]` READS and `for-in` (mirroring
   observeNodeFacts:154-162 — the walk currently only sees keyed WRITES),
   through the existing `sidOf`/`addPointsTo`/`markPointsToAll`/
   `KEYED_EXEMPT_VALS` machinery verbatim.
2. module/schema.js: expose `ctx.schema.schemaDynReach(sid)` mirroring
   `schemaShadowed`'s 15-line shape (:463-476; that fn is the per-schema
   mirror already built for bigint-boxing — inherits dynVars' bare-name
   blind spot, so dynPointsTo is the NEW feed, not dynKeyVars).
3. ir.js `needsDynShadow`: keep anyDynKey-false path untouched; when
   TRUE, resolve the call site's sid and shadow iff `schemaDynReach(sid)`
   OR sid unresolvable (fail-closed = today's behavior). ~8 call sites,
   each already has the sid locally (object.js:187 schemaId local, :734
   tSid, :1263 schemaId; emit-assign.js:875 vaProbe.ptrAux, :913/:930
   idOf hoist, :691 add idOf, :957 chainSid fallback). emit.js:57 import
   is vestigial (no call site); json.js:601 is a comment, not a caller.
4. Keep refineDynKeys as-is (legit early-out for zero-dyn programs).

HAZARDS (each with in-repo precedent):
1. Unknown-schema receivers are COMMON (14 __dyn_get_any* + 40
   __dyn_get_expr* codegen sites; emitSchemaSlotGuarded/devirtSchemaReads
   exist because of this) — 'ALL' sentinel caps the win; MEASURE the
   realized reduction, don't assume.
2. Schema merging: object.js:160-180 adopts merged/superset schema ids —
   key the fact at the id ACTUALLY allocated; reuse ctx.schema.register's
   coalescing.
3. Write/read granularity mismatch is this subsystem's documented
   corruption mode (CARRIER PROGRAM §15/§16, schema.js:441-453): the
   construction-time shadow decision and EVERY read-side dyn-props probe
   must use identical schema granularity; never substitute the
   (deliberately over-marking) nameEscapes binding-level signal.

TESTS: dyn-keys.js has ZERO pins on needsDynShadow/__dyn_set shape — the
`in:` tests (:129-216) pin the sibling closed-schema fast path style to
mimic. ADD WAT-shape pins: per-schema __dyn_set presence/absence (a clean
literal in a program that dyn-touches a DIFFERENT schema loses its
mirror; the touched schema keeps it; unresolvable-receiver program keeps
all). Check before landing: data/closures/feature-gating/inference/
kernel-oracle/objects/parser-bugs/perf tests grep-hit these identifiers.

GATE: dormant goal-gate __dyn_set/alloc counts before/after + runway;
suite ZERO fails; kernel-parity vs SELF (native/kernel agreement, not
snapshot). Sequencing: NO dependency on deletion phase or program-facts
split — self-contained, clean seams (paramReps read-only threading per
collectSlotWriteHazards' own {fresh:true} convention).

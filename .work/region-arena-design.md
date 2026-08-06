# Region arena — phase-boundary rewind with survivor relocation

Owner: coordinator (in-thread design per the settled-design process).
Evidence base: .work/kernel-memory-curve.md (6bbe75a8) — the bump arena's
retain-everything cost COMPOUNDS with input complexity: jessie graph 60KB
watermarks 1.07GB, watr 104KB needs ~4.3GB, jzify-entry 406KB exceeds the
wasm32 ceiling. Native RSS for the same compiles is ~20x smaller (V8 GCs the
intra-compile temporaries the arena keeps). Unlocks: the jz x jz bench row,
the native-lane memory-competitiveness goal (w2c natives inherit the arena),
and likely warm-instance locality.

## The key discovery: the machinery already exists
`__clear` (module/core.js ~443-500) already implements the exact primitive at
the BETWEEN-compiles boundary: rewind the bump pointer to a saved high-water
mark, with durable-object relocation healed via forwarding pointers
(`__durable_fwd_log`/`__durable_fwd_heal`, `__durable_slot_log`) — and every
pointer deref already tolerates forwarding (`__ptr_offset`'s forwarding branch;
speed tier inlines the non-forwarded fast path, `inlinePtrOffsetFast`).
The design extends mark/rewind/heal to WITHIN-compile phase boundaries.
No new pointer convention, no GC — bounded, explicit regions.

## Mechanism
- `__region_mark()` -> saves the bump pointer (a scope value, stack-disciplined).
- `__region_exit(mark, root)` -> Cheney-copies the LIVE tree reachable from
  `root` to the mark point (compacting), writes forwarding headers at old
  sites (the existing convention), rewinds the bump pointer past the copied
  survivors. Stale references (ctx tables, caches) heal lazily through the
  forwarding branch exactly as durable relocation does today.
- Survivor identification is by ROOT, not tracing ctx: each phase has a single
  dominant output (front -> prepared AST; per-fixpoint-round -> the round's
  tree). Ancillary ctx state that must survive is either durable already
  (interned strings, schema tables) or re-derivable (caches invalidated at the
  boundary via the existing seam primitives — reanalyzeBody/invalidateBodies).
- Identity hazard: Map/Set keyed on pointer identity across a boundary breaks
  under copying. Inventory required per boundary (the round-9 outline-hunt
  lesson: watr trees + jz caches). Mitigation: boundaries are placed where the
  ledger already documents cache flushes (phase-boundary invalidation seams,
  4b149108) — identity consumers are flushed there by construction.

## Slices (each independently green, each warm-gated — warm cost is the
## historical killer of memory work; ring/fgather ratchets + selfhost-perf
## checkpoints mandatory per slice)
1. **Fixpoint-round region** (watOptimize): per-round mark/exit with the
   round's surviving tree as root. MEASURED (region-slice1-liveness.md,
   43e04856): churn/live 574-2342x sustained — GO — but the win arithmetic
   is capped: Slice 1 removes only CROSS-ROUND accumulation (~979MB / 25.8%
   on watr-graph); the pre-round baseline (2.2GB: front/prepare/emission +
   watOptimize setup) is untouched by it. Acceptance (corrected): round-loop
   segment capped at max single-round churn; kernel-parity byte-identical;
   warm cap holds. The ~1GB watermark target belongs to Slices 1+2 PAIRED.
   Prerequisite from the hazard inventory (4 sites): per-boundary handling
   for compiler-side Maps keyed on pointer identity (flush-or-rehash at the
   mark), REF_EQ raw-i64 equality audit; watr's own identity bookkeeping
   degrades safely (dirty-overapproximation).
2. **Front boundary** (post-prepare): parse/jzify intermediates die; root =
   prepared AST. Acceptance: further watermark drop; the 512MB small-source
   watermark begins to fall.
3. **Emit/encode boundary** + generalization; acceptance: jz-case graph
   (5.6MB) kernel-compiles under 4GiB => the jz x jz bench row RUNS; the
   full-corpus kernel watermark curve re-measured and committed.

## Non-goals
No general GC; no allocation-site rewrites; bench sources untouched. The
carrier decision (PTR.BIGINT) is orthogonal — regions move bytes, carriers
type them; both use the same forwarding tolerance.

## Risks (named, each with its tripwire)
- Copy cost vs win: Cheney copies live trees per round; if live size ~ churn
  size the win vanishes — measure round-liveness first in Slice 1 with a
  probe before wiring (a counter of live-vs-total per round).
- Lazy healing correctness: any consumer reading POINTER BITS without
  __ptr_offset (raw i64 compares, hash keys) sees stale addresses. The
  durable machinery already survived this class (its log exists for exactly
  one such hazard); the Slice-1 inventory greps the fixpoint's pointer-bit
  consumers (hash tables keyed on ptr bits!) before any wiring.
- Warm regression: mandated per-slice checkpoint, stop-on-fail per the
  boxed-bigint round-1 precedent.

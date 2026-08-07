# Heap-kind registry — one per-tag authority (audit-#13 critical-path item 3)

Owner: coordinator (in-thread design). The composition point for the two
active representation programs: carrier boxing (PTR.BIGINT) and region
relocation currently have NO shared contract — the region tracer hard-codes
ARRAY/STRING/SET/MAP shapes and traps on unknown kinds; a boxed BigInt under
JZ_CARRIER_BOX=1 + live regionHooks would trap or corrupt. The audit's
directive: not another `if PTR.BIGINT` branch — a registry every consumer
derives from.

## The registry (one table, module/layout-kinds.js, feeding codegen)
Per tag (NUMBER-f64 implicit, then PTR.STRING/ARRAY/OBJECT/SET/MAP/TYPED/
BUFFER/CLOSURE/EXTERNAL/BIGINT + atoms):
- allocation shape: header words, payload layout, elem width/stride rule
- child pointers: which payload slots hold boxed values (fixed offsets /
  strided elems / hash-table entries via __coll_order) — THE tracer input
- forwarding policy: relocatable? in-place-walk (durable arrays precedent)?
  rebuild-on-move (Set/Map rehash — identity is hash-of-content)?
- identity/hash semantics: pointer-bits identity (REF_EQ_KINDS) vs content
  (strings SSO/heap, bigint payload) — feeds $__eq/$__map_hash arms
- interop decode: how the host reads it (mem.read arms, i64exp lanes)
- typeof/classification arm

## Consumers that DERIVE (delete their private switches over time)
$__typeof · $__eq/$__eq_strict content arms · $__map_hash/$__same_value_zero ·
__region_copy_rec's kind dispatch (the hard-coded set becomes the registry's
forwarding column — PTR.BIGINT gets {relocatable, no children, content
identity} for free) · interop mem.read/write · the carrier box/unbox sites ·
JSON.stringify's walk · structuredClone if/when.

## Method (the codebase's own precedent)
The registry is COMPILE-TIME data feeding the existing WAT-template emission
(the err-codes.js/BIGINT_SENTINEL table pattern at bigger scale): each stdlib
helper's arms are GENERATED from the table where they today are hand-written
parallel switches. Migration is per-consumer, byte-identity-gated where the
generated arm must equal the hand-written one (the BodyModel shadow-assert
discipline), divergence = a latent inconsistency FOUND (report, don't paper).

## Slices
1. The table + a JZ_DEBUG_INVARIANTS shadow-check: registry columns vs the
   live behavior of $__typeof/$__eq/hash on every kind (probe programs per
   kind exercising each consumer) — zero codegen change.
2. __region_copy_rec generated from the forwarding column (regions' hard-coded
   set retired; PTR.BIGINT + OBJECT/HASH/CLOSURE gain entries — the trap-on-
   unknown becomes impossible-by-construction). Gated on the region program's
   own re-enable path (watr hook publication).
3. $__eq/$__map_hash arms generated; byte-identity per arm.
4. interop decode arms; the i64exp lane table folds in (kills the last
   sentinel-adjacent scatter).
5. Carrier Slice-3 consumption: the read-side dispatch derives its arms from
   the registry — Slice 3 lands ON this, not beside it.

## Risks
- Generated-vs-handwritten byte drift: the shadow/byte gates are the answer;
  any drift is a real inconsistency between today's parallel switches.
- Table completeness: start from layout.js TAG_MASK + the erasure census;
  the audit-#13 numbers (~59 presentVal refs, 41 features writes) are the
  before-metric — re-count after Slice 5 as the convergence proof.

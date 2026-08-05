# Dict-value census — moduleInit gap fix design (2026-07-31)

Read-only investigation deliverable: why watr's OPCODE/IMM never fire the
landed dict-value census, and the minimal sound fix. Verdict: LAND IT —
this is a bug-fix to a landed mechanism, not a new design.

## Root cause: TWO independent gaps, and the "deliberate exclusion" is a myth

1. **`initFacts.dynWriteVars` is never merged** in `collectProgramFacts`'s
   `if (initFacts)` block (program-facts.js ~313-336). Git archaeology:
   `dynWriteVars` was born in ffda6f86 (2026-06-15, for-in-unroll deopt),
   which touched emptyWalkFacts + mergeWalkFacts + the return object but
   NOT the textually separate initFacts merge block; c37111ee (2026-07-09)
   later extended that very block (arrResized/nameEscapes) and missed it
   again. The block's comment defends a DIFFERENT exclusion — refusing to
   run full walkFactsRoot (schema re-registration, valueUsed promotion)
   over moduleInits. `dynWriteVars` is produced by observeNodeFacts, the
   shared low-level collector recordModuleInitFacts already calls safely —
   exactly like dynVars/writtenProps/arrResized/nameEscapes/
   literalWriteKeys, which ARE merged. Oversight, not guard.
2. **`observeProgramSlots` walks moduleInits with `visitInit`**
   (program-facts.js ~692-714), which handles only `{}` schema-literal
   observation — no MUTATE_OPS/`[]` dict-write branch. `OPCODE[nm]=code++`
   is silently ignored by the census walker even though `visit()` (used
   for ast + function bodies) has the branch (~647-661). The census
   design's §1b "coverage is automatically consistent" claim was true for
   the schema-literal half, false for the dict-write half.

Fixing only the merge changes nothing observable (dictValueKindOf's gate
opens but the fact is never populated). Both fixes are required.

## Ordering soundness (why this is NOT the reverted-attempt class)

`ctx.module.initFacts` is built once, entirely during prepare
(recordModuleInitFacts, prepare/index.js:607/~3834); nothing later writes
it. moduleInits ARE mutated later by flattenFuncNamespaces' rewrite
(plan/scope.js:751-753) but only `.`/`.=` shapes — structurally cannot
change dynWriteVars membership. `ctx.types.dynWriteVars` is published
exactly once at plan/index.js:118; every consumer (kind.js, analyze.js,
type.js, emit.js) runs strictly after. No window where a body is analyzed
under the narrower set. The reverted historical fix failed because
recordGlobalRep runs at PREPARE time and had to retroactively mutate an
already-consumed val/schemaId; this fix enlarges a Set BEFORE first
publication. Not analogous.

## Fix A — merge (program-facts.js ~313-336, initFacts block)

```js
if (initFacts.dynWriteVars) for (const v of initFacts.dynWriteVars) f.dynWriteVars.add(v)
```

UNCONDITIONAL — not gated on initFacts.anyDyn: dynWriteVars is set by any
MUTATE_OPS op on a computed [] target while anyDyn/dynVars come from bare
reads and plain `=`; `OPCODE[nm]++` would populate dynWriteVars without
anyDyn. Mirrors the unconditional writtenProps/arrResized/nameEscapes
merges in the same block.

## Fix B — visitInit dict-write branch (+ cache extension)

Mirror visit()'s branch (~647-661) into visitInit (~692-714):

```js
} else if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
  const [, wobj, widx] = node[1]
  if (!isLiteralStr(widx)) {
    let root = wobj
    while (Array.isArray(root) && root[0] === '[]') root = root[1]
    if (typeof root === 'string') {
      const vt = writeVT(effectiveWriteValue(op, node[1], node[2]))
      if (vt) observeDictValue(root, vt); else poisonDictValue(root)
    }
  }
}
```

Real design piece: visitInit's per-moduleInit results are memoized in
pf.moduleInitSlot (~675-684, keyed by pf.gen) as flat [sid,idx,vt,ctor,ci]
schema-slot tuples replayed on cache hit. Dict observations are name-keyed
— extend the cached entry to { gen, obs, dictObs } with dictObs a parallel
[name, vt][] list replayed through observeDictValue exactly as obs replays
through observeSlot/observeCtor/observeConstInt.

Rejected alternative: a separate qualification channel bypassing
dynWriteVars — duplicates dynWriteVars' conservatism for a strict subset,
adds a second gate to keep in sync; violates the field-isolation
principle rather than reinforcing it.

## Expected effect (honest)

- OPCODE values are NUMBER (code++); IMM values are uniformly STRING (not
  poisoned, but no string fast path exists — zero benefit for IMM).
- Win sites: `OPCODE[n[0]] > 0xffff` in estBytes/ownBytes/cseFactsOf
  (optimize.js:3973,4030,4594) — cmpOp emits direct f64.gt instead of
  generic dispatch. The `typeof OPCODE[n] !== 'number'` identity check is
  correctly kept off the fact by the carve-out.
- LIMITER: the load stays generic __dyn_get (zero static schema → full
  dyn-props hash+probe+compare per read) and almost certainly dominates.
  Expect a small real win at the compare sites, NOT a mechanism that
  closes the watr 1.2-1.4x band alone — that needs the future
  receiver-HASH classification design. Measure, don't presume.

## Order + gates (mirrors census design §5)

1. Fix A alone. Gate: battery green; byte-identical WAT everywhere except
   watr-self-host-affected builds — any other diff means some pass
   depends on the under-approximation: STOP and investigate.
2. Fix B (+ cache extension). Gate: NEW test/inference.js fixture with
   the exact const.js shape (`export const T = {}; for (...) T[k] = n++`)
   in a bundled sub-module (moduleInit domain) — the existing census
   fixtures don't cover this domain (proven by the gap surviving them).
3. watr self-host isolation BEFORE jessie claims: O0/O2/O3 WAT diff at
   OPCODE/IMM read sites — expect f64.gt at compare sites, byte-identical
   __dyn_get load shape; 35/35 must hold.
4. Paired re-measurement of watr bench (1.195-1.426x band) — record the
   real number.
5. Do not conflate with the prec/jessie fix (writeVT param/truthiness
   resolution) — different gap, reported separately.

Full gate each step: battery, kernel-parity, kernel-oracle,
JZ_DEBUG_INVARIANTS leg, watr 35/35.

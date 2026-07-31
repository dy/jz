# Dict-mode value-type census — design (2026-07-31, pre-implementation)

Design for the global dict-mode value-type classification rework — the lever
behind jessie's dominant red root and watr's OPCODE/IMM read sites. Produced
by a read-only design pass that traced every referenced code path; three
corrections to the prior ledger framing are folded in (§0). The reverted
attempt's failure chain is addressed structurally (§3), not by care.

## 0. Grounding corrections (verified against source, not assumed)

1. **`prec` is receiver-untyped AND value-untyped.** `prec = {}` sits in
   subscript's comma-chained `export let` (parse.js:14-82). `recordGlobalRep`
   → `valTypeOf(['{}'])` → `VT['{}']` (kind.js:123-125) returns null for an
   empty-props literal, so `ctx.scope.globalValTypes` never gets `prec` at
   all. The existing dict-mode promotion (`{}` + dynWriteVars + empty schema
   → VAL.HASH; module/object.js:78-99, analyze.js:1469-1488,1566-1577) is
   per-function (`analyzeValTypes`) — only the module-init pseudo-body sees
   it; every other function falls through lookupValType to nothing and
   module/array.js:754,828 sees vt=null → fully generic `__dyn_get`.
   TWO missing facts: (a) receiver HASH, (b) value NUMBER. This design
   delivers (b) only, usable independently of (a) — that isolation is what
   avoids the wall.
2. **bench/vm and bench/dict DO NOT apply** — both are pure Int32Array
   kernels (vm.js:16,68-70; dict.js open-addressing on Int32Array slots),
   no `{}` or dynamic-key access anywhere. Their JIT reds have another
   cause. The prior ledger line "likely underlies watr/vm/dict" is wrong
   for vm/dict.
3. **watr IS a genuine match**: `export const OPCODE = {}, IMM = {}`
   (watr/src/const.js:161,168), filled `OPCODE[nm] = code++` in loops, read
   hot in optimize.js/compile.js as numbers (`OPCODE[n[0]] > 0xffff`,
   `typeof OPCODE[n] !== 'number'` — optimize.js:3973,4030,4594).
4. **The undefined/NaN-box coincidence is precedented**: kind.js:257-263
   (typedReadMaybeOob) already encodes "unproven read decodes to NaN-boxed
   undefined; NUMBER arithmetic/relational consumers get IEEE-754 NaN
   semantics which coincide with ToNumber(undefined); identity/typeof are
   the carve-out." Same carve-out applies here.

## 1. Census

### 1a. Two independent computations

**Local half** (a function's own `let d = {}`): receiver classification
already works (analyze.js:1478-1481,1569-1572 run after dynWriteVars is
populated). Extension: where dict/leanDictUse are detected (both let/const
~1478 and reassignment ~1569), scan the same body for `name[key] = rhs` /
compound writes rooted at `name`, resolve each via writeVT-style logic, and
`updateRep(name, { dictValueValType: vt })` alongside the existing
`setVal(name, VAL.HASH)`. Same-function, same-timing — no ordering issue,
no invalidation concern (localReps rebuilt fresh every compile).

**Global half** (prec, OPCODE, IMM): the reverted-fix target — see 1b.

### 1b. Where computed: piggyback on observeProgramSlots

`observeProgramSlots` (program-facts.js:398-694) is already the
whole-program value-kind census (powers ctx.schema.slotVT). It already:
- walks the right three domains (ast top-level, every ctx.func.list body,
  every moduleInits entry — lines 639-693), the same population
  dynWriteVars scans, so coverage is automatically consistent;
- installs per-function localValTypesOverlay (line 643) so param-aliased
  writes (`prec[op] = p`) resolve;
- has the right resolvers: `writeVT` (449-464; handles +/+=, ?:, &&/||/??,
  answers null for .prop reads — deliberately order-independent) and
  `effectiveWriteValue` (753-758; normalizes o.n++, o.f ||= x);
- runs twice at the right times: early inside collectProgramFacts (line
  376, gated on hasSchemaLiterals which any `{}` sets) and late
  post-narrowing with {fresh:true, paramReps} (plan/index.js:158) — the
  identical schedule inferModuleGlobalValTypes uses.

**Concrete change**: add `dictValueTypes: Map<string, VAL|null>` next to
slotTypes/slotCtors (411-413), plus one branch in visit() (595-637)
parallel to the `.prop=` branch at 620:

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

observeDictValue/poisonDictValue mirror observeSlot/poisonSlot's
first-wins-then-clash lattice (418-434), keyed by name. On {fresh:true}
clear dictValueTypes alongside slotTypes (line 475). Root-walk mirrors the
existing nested-[] root resolution (79-81,121-123).

### 1c. Joins and fail-open

- Join: first observed VAL.* wins; any different VAL.* poisons to null —
  identical to observeSlot.
- Poison triggers: writeVT null (any ./?. read on RHS, unresolved call,
  ambiguous +=) — the same conservative resolver schema slots trust.
- **NOT gated on dynWriteVars at census time** (the early call runs before
  ctx.types.dynWriteVars exists — gating there would recreate the ordering
  hazard). Census unconditionally for every `name[key]=rhs` root; gate at
  CONSUME time in kind.js, where dynWriteVars is always settled (kind.js
  runs during compile/emit, strictly after plan/index.js:118).
- += ambiguity: writeVT already resolves it (STRING poisons,
  unknown-either-side poisons, else NUMBER/BIGINT).

### 1d. Invalidation owner

Solver-owned via the 4b149108 seams by inheritance: the census lives inside
observeProgramSlots' existing two-call schedule, so it inherits that
freshness discipline (pf.gen, walkCache, {fresh:true} rebuild) for free.
One obligation: any future pass mutating a `name[key]=rhs` value shape
after the late call must re-trigger observeProgramSlots({fresh:true}) —
the rule schema slots already live under, not a new rule.

## 2. Consumer emission

**No new emit code.** `valTypeOf` (kind.js:464-489) is the single choke
point — cmpOp (emit.js:2436-2500), VT['+'], emitDecl's local-kind
inference (analyze.js:1480,1571), method dispatch all flow through it.
Two insertion points, both mirroring the global arrayElemValType branch
(kind.js:271-281):

- **VT['[]']** (~after line 281): if receiver is a non-local string name,
  read `ctx.scope.globalReps?.get(name)?.dictValueValType`, return it iff
  `ctx.types?.dynWriteVars?.has(name)`; plus a local-side branch reading
  `ctx.func.localReps?.get(name)?.dictValueValType`.
- **VT['.']** (~line 341, near the OBJECT||HASH branch): same two lookups —
  the fact is per-receiver, not per-key, so `prec.in` benefits identically
  (and computed-literal `prec['in']` rewrites to `['.',...]` at emit,
  module/array.js:762-763).

Share one helper `dictValueKindOf(name)` encoding "local first, then
global gated on dynWriteVars."

Downstream: cmpOp's NUMBER arm skips coercion → raw f64.ge/f64.le at the
isStmt (asi.js:24-25), loop-head (loop.js:26) sites; asi.js:74's `p >= lvl`
inherits via emitDecl's valTypeOf-on-RHS. The LOAD (`prec[op]`) still
routes generic `__dyn_get` — this design fixes the consumer of the loaded
value only; the receiver-HASH half is a separate future design under the
same field-isolation discipline.

**Soundness carve-out** (precedented): identity/typeof/nullish checks on a
dict read must not trust dictValueValType — mirror typedReadMaybeOob
(kind.js:257-263). Unwritten-key read = NaN-boxed undefined: safe for
NUMBER arithmetic/relational (IEEE NaN coincides with ToNumber(undefined)
semantics — `undefined >= x` false in JS, `f64.ge(NaN,x)` false in wasm),
unsafe for `=== undefined`/typeof which need the real tag.

## 3. Wall-avoidance, per link of the reverted chain

The reverted attempt retroactively corrected recordGlobalRep's verdict
(flip val to HASH after dynWriteVars was known). This design NEVER touches
val/schemaId/globalValTypes — it adds one additive ValueRep field
(`dictValueValType`, added to REP_FIELDS, reps.js:113-117) that no
existing pass reads or writes.

- **analyzeBody cache staleness**: structurally avoided — the global half
  touches nothing analyzeBody produces or any cache keyed off it; it lives
  in observeProgramSlots' own walk with its own freshness discipline. The
  4b149108 seams exist for passes that mutate analyzeBody-visible facts;
  this one doesn't, so there is nothing to invalidate.
- **emitDecl flow-overlay shadowing**: localValTypesOverlay (lookupValType
  tier #2, reps.js:6-19,156-162) only stores/reads `val`. dictValueValType
  is consulted only from VT['[]']/VT['.'] directly against
  globalReps/localReps, never through lookupValType — no path for an
  overlay entry to shadow it.
- **unboxablePtrs schema-id loss**: UNBOXABLE_KINDS (analyze.js:1692)
  excludes HASH — structurally unreachable. The prior break most plausibly
  came from flipping a global's val OBJECT→HASH after locals had bound to
  the shared interned empty-schema id, corrupting unrelated `{}` literals
  in watr's self-hosted source. This design never registers/frees/
  reassigns a schema id and never changes val — the corruption channel
  doesn't exist by construction.

Principle: **the census is a new, additive, read-only-consumed fact, not a
correction to an existing verdict.** Only the two new VT branches can see
it, and only when they explicitly ask.

## 4. Expected effect (honest)

- jessie: targets the exact named mechanism (generic compare machinery at
  the three hot sites). The archived 31% causal figure measured a
  DIFFERENT mechanism (durable-receiver __ihash_get_local probe doubling)
  — treat as target, re-measure after landing (step 5).
- watr: real candidate (OPCODE/IMM shape-identical to prec).
- vm, dict: do not apply — corrected, see §0.2.

## 5. Implementation order with gates

1. **Local half** (analyze.js ~1478-1488, ~1569-1577). Gate: full battery
   green; byte-identical WAT where the fact doesn't fire (mixed-kind-write
   name in dynWriteVars must not regress).
2. **Global census** (program-facts.js), no consumer wired. Gate: new
   test/inference.js fixture mirroring subscript's shape (cross-function,
   cross-module, param-aliased writes) shows dictValueTypes populated.
3. **Consumer wiring** (kind.js VT['[]']/VT['.'] + dictValueKindOf).
   Gate: test/dyn-keys.js + test/data.js green (the 87511c69 pin suites —
   highest-risk step for exactly that bug class).
4. **watr self-host in isolation before jessie**: compile watr-in-jz with
   the fact live; diff OPCODE/IMM read-site codegen O0/O2/O3 vs pre-change
   WAT (83d6add5 byte-identity discipline). 35/35 holds → wall confirmed
   avoided; fails → §3 has a hole, stop before jessie.
5. **jessie measurement**: paired-truth interleaved benchmark; update
   ledger with the REAL number, not the carried-forward causal figure.

Full gate at each step: battery, parity corpus, kernel leg, ratchet,
JZ_DEBUG_INVARIANTS leg (exercises REP_FIELDS typo-guard + the P4
dict-mode assertion at module/object.js:95), watr 35/35.

## 6. Risks

- 31% may not transfer (different mechanism measured) — unverified until
  step 5.
- Receiver classification stays unfixed: __dyn_get load untouched; if the
  load dominates over post-load dispatch, the win is smaller. Future
  separate design: receiver-HASH via the same field-isolation discipline.
- Compound writes (`x[k] += 1`) conservatively poison when ambiguous —
  grep subscript/watr before landing to know if value is left on the table.
- Compile-time cost: one more Map + MUTATE_OPS branch in a hot pass —
  confirm with compile-time budget tests.
- Pre-existing blind spot inherited (not introduced): bare top-level
  computed-key writes in bundled sub-module init code are invisible to
  dynWriteVars itself (program-facts.js:323-336) — same census domains,
  same gap.

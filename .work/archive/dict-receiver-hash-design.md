# Receiver-HASH classification for module-global dicts — design (2026-07-31)

Read-only design deliverable at HEAD f0d9879e. The empirically-proven jessie
lever: the value-kind census landed, fired for prec (dictValueValType NUMBER,
raw f64 compares at isStmt/loop-head) and jessie moved 1.006 — the LOAD
dominates. This design makes the load lean.

## 1. Ground truth (verified by compiled repro + WAT inspection, not inferred)

- **The allocation is ALREADY correct.** module/object.js:70-105's dict-mode
  branch (line 86: `target && !merged?.length && ctx.types.dynWriteVars?.has
  (target)`) gates on plan-time dynWriteVars directly, NOT lookupValType —
  so module-level `{}` dicts allocate via __hash_reuse_eph tagged PTR.HASH
  (tag 7) today. Verified in __start WAT for the subscript shape.
- **Mixed literal bracket write does NOT disqualify**: `prec['*'] = multPrec`
  (subscript accessor.js:87) registers no schema slot — merged stays empty,
  dict-mode still fires. Verified with microbench (tag 7 with the literal
  write mixed in).
- **Every read/write site is blind to it**: reads go __dyn_get →
  __dyn_get_t (__is_str_key + __str_hash) → __dyn_get_t_h (real-number bail,
  STRING 'length' case, STRING bail, CLOSURE env adjust, ARRAY follow, THEN
  the PTR.HASH shortcut at collection.js:2560-2563) → the same probe body
  __hash_get_local inlines in ONE call when vt is proven. Two extra call
  frames + ~6 wasted branches + runtime key normalization, per read.
- **Export/interop**: not a concern — mem.Hash marshals on the runtime tag.
- **Kernel self-host IS load-bearing**: jz's self-hosted build bundles
  node_modules/watr (OPCODE/IMM inside the graph). snapshot.js pre-eval
  bakes the post-init heap (HASH tag preserved verbatim); per-read cost in
  optimize.js hot functions remains at every self-host compile.

## 2. The design: approach (a), narrowly scoped — a FILL, never a correction

**Key invariant discovered**: the qualifying set is precisely the set whose
recordGlobalRep verdict is null BY CONSTRUCTION — VT['{}'] returns null for
exactly the empty-literal case (and never mints a schema id: the empty-args
branch returns before any ctx.schema.register/idOf), and dict-mode's own
precondition is the same predicate (empty merged schema). So:

One new pass in plan/index.js, immediately after the FIRST collectProgramFacts
call (line ~84, before flattenFuncNamespaces/devirtGlobalCalls), computing the
IDENTICAL predicate module/object.js:86 already uses ({} literal target +
dynWriteVars.has(name) + empty merged schema) over module-level decls, then:

    if (!ctx.scope.globalValTypes.has(name))
      ctx.scope.globalValTypes.set(name, VAL.HASH)

Only-if-absent — never overwrites. **Zero new consumer code**: every existing
vt===VAL.HASH gate (module/array.js:744,748,828 reads; write-side analog;
delete/in; for-in/Object.keys/values/entries via isHashTyped object.js:
314,347,445,508,1035) starts firing through lookupValType tier 4.

## 3. Wall-avoidance per link (the reverted 30/35 attempt)

1. **analyzeBody cache staleness**: fill sits before any of plan's own
   body-analysis passes; plan/index.js:181's existing invalidateAllBodyFacts()
   (the 4b149108 seam, whose own doc names "ambient overlay changing without
   a signature retype" as requiring the flush) already runs before emit —
   same discipline refineSlotIntCensus/refineFieldProvenance already ride.
2. **emitDecl overlay shadowing**: structurally impossible — the tier-2
   overlay is built fresh per-function at emit time, after plan() returns;
   it always reads the settled tier-4 value.
3. **unboxablePtrs schema-id loss**: structurally unreachable — the
   qualifying set never had a schema id minted (VT['{}'] empty branch never
   touches ctx.schema). NOTE: the postmortem's schema-id hypothesis is
   itself unproven ("most plausibly"); UNBOXABLE_KINDS is local-only per
   analyze.js:1762-1843 — the true historical root may lie elsewhere, which
   is what the watr isolation gate is FOR.

OPEN RISK (gate, don't assume): whether flattenFuncNamespaces/
devirtGlobalCalls/inferModuleGlobalValTypes pass 1 (running before the fill)
bake any AST-LEVEL decision invalidateAllBodyFacts can't undo. Judged
low-probability (those passes target func-namespace/devirt shapes, not plain
dict receivers) — the watr 35/35 gate exists exactly for this.

Fallbacks: (b) additive dictReceiver rep field consulted at emission sites —
safer on link 3 but duplicates the HASH gate at ~8 consumer sites forever
(the class of duplication dict-census-moduleinit-fix.md rejected); use only
if (a) fails the watr gate. (c) cheaper __dyn_get (IC/interned-key) — real
independent lever for the genuinely-polymorphic residual population (e.g.
subscript's closure-valued lookup[c]), NOT a substitute: a perfect IC still
pays a guard + indirect call vs the proven path's zero-guard direct call.

## 4. Qualification facts (verified against real sources)

- prec: parse.js:81 decl; writes parse.js:86 (computed), parse.js:135
  (??= computed), accessor.js:87 (literal bracket — harmless); reads
  asi.js:9,20,25, loop.js:26, accessor.js:64. Qualifies today.
- OPCODE/IMM: watr const.js:161-168, computed writes in bare top-level loop
  (NEEDS Fix A/B from dict-census-moduleinit-fix.md to enter dynWriteVars at
  all — hard dependency, land those first). ~15 OPCODE[n]!==undefined
  membership checks (existence tests — win comes from the lean load, not
  value kind) + 2 value compares (optimize.js:3973,4030).

## 5. Expected win (honest)

The archived 31% figure does NOT apply — traced: it measured CLOSURE-stored
property probe doubling (parse.space/.step etc), a different receiver class,
largely addressed by 70585fd/280e8f5. No fabricated percentage: the load's
structural saving is two call frames + branch cascade + runtime key
normalization per read across all prec/OPCODE sites — measure with paired
ABBA after landing. Residual gap noted: single-source spread {...prec}
(kind.js:137) stays null — unexercised by subscript/watr.

## 6. Order + gates

1. HARD DEP: land dict-census-moduleinit-fix.md Fix A+B first (watr target
   needs OPCODE in dynWriteVars).
2. The global-fill pass alone. Gate: battery green; byte-identical WAT
   everywhere the fill doesn't apply.
3. **watr self-host 35/35 in isolation before any jessie claim** (OPCODE/IMM
   live inside the self-hosted graph — this is the load-bearing gate).
   O0/O2/O3 WAT diff: expect lean hash reads at OPCODE sites + f64.gt at the
   two compares; byte-identical elsewhere.
4. Paired jessie re-measurement (ABBA) — record the real number.
5. Any failure → fallback (b) before broadening (a).

Full gates each step: battery, kernel-parity (rebuild dist first),
kernel-oracle, JZ_DEBUG_INVARIANTS leg, watr 35/35, selfhost battery.

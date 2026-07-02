# Pre-eval campaign — brief (user-mandated)

GOAL: jz detects statically-evaluable source, pre-evaluates it at compile time,
compiles only the residue. static-eval pushed to the limit.

USER DIRECTIVES:
- Metric #1: watr's INSTR table fully statically pre-evaluated and resolved in
  the self-host kernel (init snapshotting → data segment, no init-time build).
- IIFEs are static-eval candidates too.
- THE DREAM: enhanced precision — fold constant formula chains with RATIONAL /
  extended-precision arithmetic at compile time, round ONCE at the end
  ("carry float precision down the formulas"). Deliberate, documented
  improvement over per-op f64 rounding; option-gated off for bit-exact-vs-JS.

TIERS:
1. Pure-expression folding: numeric chains (rational carry), string
   concat/slice/case, bool/null folds, dead branches, pure-fn calls with
   constant args (execute module/math.js JS-side for bit-exact transcendentals),
   IIFE collapse.
2. Static object/array trees → schema slots + data segments.
3. Module-init snapshotting (V8-snapshot style): run top-level init at compile
   time, serialize the heap into the data segment. Kills warm-boot cost,
   shrinks __start, eliminates init-vs-runtime storage bug class. INSTR = the
   acceptance test.

GUARDS: fold only through proven purity (isPureFnCall etc.); never through host
imports/Date/random/observable effects; differential fuzz stays the floor
(rational-fold divergence documented + gated).

EXISTING SUBSTRATE: static.js (staticValue/staticPropertyKey/staticObjectProps),
bindStaticGlobal, intConst interproc consts, unrollSmallConstFor, forInUnroll,
watr const-fold. Unify — one preEval pass over prepared AST, fixpoint.

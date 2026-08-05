# for-of/for-in dict-population OOB crash — dissection + fix plan (2026-07-31)

Read-only dissection deliverable (pinned worktree at f0d9879e). Pre-existing
soundness bug, NOT introduced by Fix A/B — a live dormant landmine for
idiomatic user code (`for (const k of arr) dict[k] = …`, word-frequency
counters) at optimize>=1. Nothing in the current bench/example/test corpus
exercises the shape (verified by targeted + delegated scans).

## Minimal repro (traps at instantiation, in __start, O1+; O0 fine)

```js
export const T = {}
const arr = ['a', 'b', 'c']
let n = 0
for (const k of arr) T[k] = n++
```

Boundary matrix: for-of (name or literal), for-in, for-of-Set, `??=`, RMW
counters (`T[w]=(T[w]||0)+1`, `T[w]+=1`, `T[w]++`) all crash; C-style for
over a MODULE-LEVEL literal array is safe (array promoted to static data
segment — no runtime init); the SAME C-style loop with a LOCAL array
crashes; while-desugar safe; Map/Set never affected. Local-scope dicts
crash too — the earlier "local/RMW safe" ledger verdicts were fixture
artifacts (a trailing plain read of the dict disqualified the lean path).
Reproduces single-file AND bundled. Gate pass: hashRmwFusion in HOT_PASSES
(src/passes.js:21) — matches the O0/O1 boundary.

## Root cause (proven via WAT diff): def-before-use at module/object.js:87-93

```js
const domain = ctx.func.leanHashDomains?.get(target)
const want = domain ? asI32(emit(['*', ['.', domain, 'length'], 4])) : ['i32.const', 8]
return typed(['call', '$__hash_reuse_eph', old, want], 'f64')
```

`domain` (dictDomainOf, analyze.js:1263-1298, wired via leanHashDomains at
1552/1648) is a preallocation HINT name. The alloc site emits a RUNTIME read
of `domain.length` at the `{}` literal's own emission point — assuming the
domain value is already resident. for-of/for-in desugar (prepare/index.js:
3307/3347) mints a synthetic iterator-array temp declared in the loop's own
init — always a plain local, whose local.set executes AFTER the `{}` decl.
WASM zero-inits the local: `__ptr_offset(0.0)` then `i32.sub(_, 8)`
underflows, `i32.load` traps before __hash_reuse_eph even runs (the
ephemeral-reuse contract itself is NOT implicated). Same failure for any
local domain array declared after the dict.

The SECOND consumer of leanHashDomains — emit-assign.js:253-254
(tryHashRmwFusion capHint) — is sound: it uses only repOf(domain)?.arrayLen,
a compile-time fact, never emit().

## Fix (conceptual, small — module/object.js only)

Never emit() a runtime domain read at the alloc site. Mirror the sound
consumer: consult repOf(domain)?.arrayLen; when statically proven, size
`want` as `['i32.const', arrayLen*4]`; otherwise fall back to the existing
`['i32.const', 8]` default. Sound by the hint's own documented contract
(analyze.js ~1495-1497: speed-only, "an over/underestimate cannot affect
semantics") — degrading to the default cap is zero-regression, not a new
hole. Alternative (dominance check in dictDomainOf rejecting init-bound
names) is strictly more complex; not needed if the arrayLen route is taken.

## Pins/gates a fix needs

- New pins (test/inference.js or test/optimizer.js): (a) minimal for-of AND
  for-in repros, module-level AND local, asserting correct VALUES at O1-O3
  (not just no-trap); (b) bundled-entry-module variant; (c) differential
  check that the domain-sized cap still fires for genuinely provable cases
  (module-level literal array, C-style loop) — don't silently regress
  leanHashDomains to always-8; assert via WAT (i32.const sized-cap present)
  or count probe.
- Full gates: battery, JZ_DEBUG_INVARIANTS leg (P4 dict-mode assert nearby),
  kernel-parity (rebuild dist), kernel-oracle, watr 35/35, selfhost battery.

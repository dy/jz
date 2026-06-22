# Sound typed-array load-CSE + distinctness — design

**Goal:** beat rust-wasm (LLVM) on fft (−9%) and mat4 (−17%) by recovering the load-CSE / LICM
that LLVM gets from alias analysis. jz's optimizer deliberately has no WAT-level alias analysis
(hoist/CSE passes bail on ANY intervening store), so these gaps persist. Build the minimal SOUND
analysis that closes them — never an unsound noalias assumption ("valid jz is valid JS").

## fft butterfly (the canonical case)
```
re[b] = re[a] - tr      // (1) read re[a]   write re[b]
im[b] = im[a] - ti      // (2) read im[a]   write im[b]
re[a] = re[a] + tr      // (3) read re[a]   write re[a]   ← re[a] loaded AGAIN
im[a] = im[a] + ti      // (4) read im[a]   write im[a]   ← im[a] loaded AGAIN
```
where `a = i+j`, `b = a + half`, inside `for (let j=0; j<half; j++)`.

## Soundness (worked out, verified)
A cached load `arr[idx]` survives an intervening store `arr2[idx2]` iff the store cannot write the
read cell. Two independent sound proofs:

1. **Index-disjointness** (no array facts needed): `idx2 ≠ idx` provably. Holds when
   `idx2 = idx + P` with `P` provably > 0. `P = half` is the bound of `for(j=0; j<half; …)`:
   inside the body `0 ≤ j < half ⇒ half ≥ 1 > 0`. So `b = a+half ≠ a`. This alone makes the
   **re[a] CSE sound** — BOTH intervening stores (re[b], im[b]) are at index `b ≠ a`, regardless
   of whether im aliases re.

2. **Array-distinctness**: `arr2` provably ≠ `arr` (different buffers). Needed for the **im[a]
   CSE**: the intervening `re[a]` store (3) is at index `a` (same as im[a]'s index), so it only
   misses im[a] if `re ≠ im`. Provable when both are fresh `new TypedArray()` allocations that
   never escape-alias (escape analysis), or via inlining the callee so the concrete distinct
   allocations are visible.

## Increments
- **#1 — index-disjoint load-CSE (sound, this session):** reuse `arr[idx]` across a store whose
  index is `idx ± (positive loop bound)` or `idx ± (nonzero const)`. Resolve a name index to its
  `let` def (`b = a + half`) to compare. Recovers re[a] (½ the fft double-load). Helps any
  `x[i]…x[i+H>0]…x[i]` shape. Conservative: invalidate on any store NOT proven disjoint.
- **#2 — fresh-allocation distinctness:** track `new TypedArray()` bindings that don't escape as
  mutually-distinct; lets a store to a *different* such binding not invalidate. Recovers im[a]
  (full fft win) and is the basis for mat4 LICM (hoist `a[i]*b[j]` when out ≠ a,b).

## Hook — must be WAT-level, NOT AST (correctness finding)
AST level looked cleanest (named arrays + index exprs) BUT is **unsound**: at `prepare` jz doesn't
yet know if `re[a]` is a pure typed-array load or a dynamic/object read with side effects (type
info lands later in `compile`), and fft's `re`/`im` are *params* whose typed-ness is unknown then.
CSE-ing an impure read is wrong. So the pass MUST run at the **WAT level** (src/optimize/*, the
clean file, alongside `regionTrackCSE`): there `f64.load(addr)` is unambiguously a pure memory
read (dispatch already lowered). Trade-off: addresses are `base + (idx<<3)`, so disjointness needs
address+index tracing:
  - addr `L = base + (a<<3)`, store addr `S = base + (b<<3)`; same `base` local.
  - prove `a ≠ b`: trace `b`'s def `local.set $b (i32.add $a $half)` ⇒ `b = a + half`; prove
    `half > 0` from the enclosing `loop` (body runs only when `$j < $half`, `$j ≥ 0` ⇒ half ≥ 1).
  - then S ≠ L ⇒ the store can't hit L ⇒ reuse the cached load. (im[b] store: different base,
    but its index is also `b ≠ a`, so even if im aliases re it can't hit re[a].)
Different-base stores at the SAME index (re[a] store vs im[a] load) need increment #2 (distinctness).

## Status / next
Design + soundness proofs complete and verified by hand. Implementation = a correctness-critical
WAT-level alias-analysis pass (address/index def-tracing + loop-bound positivity). Do it in a
focused session against a GREEN tree with exhaustive verification (full suite + test/fuzz.js +
fft bit-exact + parity-gate) — a subtle CSE miscompile violates "valid jz is valid JS", so it must
not be rushed. fft bench gap confirmed real: jz ~1568µs vs rust-wasm ~1430µs (~9%, stable 3 runs).

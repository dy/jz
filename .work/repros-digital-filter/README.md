# jz bugs found compiling digital-filter (~/projects/digital-filter)

Sweep of all 64 library files. **64/64 compile** against the current working tree
(2026-07-06, after the Math-namespace alias fix and export-alias fix landed).
UPDATE 2026-07-08: repros 1–4 ALL FIXED (run.mjs exits 0); #5 stays the open
precision question (jz's own math kernels vs libm; rational-carry is the lever).

Run all: `node .work/repros-digital-filter/run.mjs`

| # | repro | status | effect | blocks (runtime, not compile) |
|---|-------|--------|--------|-------------------------------|
| 1 | export-alias.js + export-alias-lib.js | **FIXED** | `export { privateFn as alias }` cross-module | — |
| 2 | typedarray-copy.js | **FIXED** (c8c75d2) | TypedArray(typedArray) now copies with element conversion; buffer sources stay views | smooth/median.js, smooth/savitzky-golay.js |
| 3 | heap-map.js | **FIXED** (c8c75d2) | callback inliner's wrapper now carries ptrKind — named-ctor map reboxes | core/matched-z.js |
| 4 | nested-array.js | **FIXED** (c8c75d2) | schema-less mem.Object marshals as a first-class jz HASH (identity-preserving) | adaptive/rls.js |
| 5 | math-kernel-precision.js | info | sin/cos/exp ~1e-9 absolute vs libm (~30-bit); biquad's (1−cosω) cancellation amplifies to ~1.3e-6 relative coefficient error | pole accuracy of every design function |

Also fixed by the working-tree changes: `let {sin, cos} = Math` destructure
(all scopes), renamed aliases (`let s = Math.sin`), and the internal null-crash
on `let f = Math.exp` — test/destruct.js todos can be flipped.

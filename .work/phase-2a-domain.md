# Phase 2a: one numeric domain, first step

Part of `.work/architecture.md` (phase 2). Read that first, then `.work/maps/ranges.md`
sections 1 to 3 (a scout's map: leads with file:line, each claim marked verified or
inferred; check a line before relying on it; line numbers are from before phase 1).

## Why

A numeric fact is derived at many sites, each with its own copy of the rule, and the
copies disagree. `x % K` alone has 12 (static.js, interval-proof.js twice,
analyze-scans.js twice, summary/index.js twice, summary/num-range.js, int-range.js
three, word-ranges.js, ir/numeric.js, emit/arithmetic.js, int-certain.js,
expr-type.js). A hand-listed operator set is where miscompiles hide: on 2026-11-09
`i ||= 2.5` on an integer-declared local answered 2 because body-facts.js listed
`+= -= *= %= /=` and no other compound operator (fixed by routing every one through
`effectiveWriteValue`, src/ast.js). 27 more sites spell such a list (`grep "'+=' ||"`).

## This step

One transfer table for numeric values, and the sites that derive `%` reading it.
Not yet: `interval-proof` on by default (2b), the local's type decided once (2c),
`int-certain` deleted (2d). Say in the report what 2b needs, with the compile-time
cost of `interval-proof` per function measured.

### The table (decided; push back with evidence, do not improvise another)

One module (name it as the tree names things; `summary/num-range.js` already has
`{lo, hi, int, nz, gap}` and `optimize/int-range.js` `{lo, hi, int, nz, nan}`: grow one
of them, do not write a third). A value is `{lo, hi, int, nz, nan}`; one function per
operator maps operand values to the result's (`+ - * / % ** & | ^ << >> >>>`, unary
minus, the `Math` functions the tree already ranges). No function reads `ctx`, an AST
or a WAT node: callers convert at their edge (`[lo, hi]` pairs, WAT facts) until later
steps remove the conversions. A constant is resolved by ONE resolver the caller passes
(module constants included): no site resolves names its own way.

`%` in the table, for `a % k`: `k` a nonzero constant integer and `a` an integer that
is never NaN: `lo >= 0` gives `{int, lo: 0, hi: min(a.hi, |k| - 1), nz: false}` with
no finiteness needed of `a.hi`; `a.lo < 0` gives `[max(a.lo, 1 - |k|), min(a.hi, |k| - 1)]`
and may be -0. Anything else is the general Number. Check each case against Node
before writing it down (a negative divisor, a fractional one, 0, NaN, -0, Infinity).

### Two defects this step must close

1. **The ring cursor.** `p = (p + 1) % M`, `M` a module constant, keeps `p` f64 where
   the literal `% 16` makes it i32 (`.work/maps/ranges.md` §3: `hullOver` at
   analyze-scans.js about line 1650 resolves no module constant; int-range.js about
   840 wants finite bounds of the dividend before it will bound the remainder). Done
   when the `kernel/ring` cells of `test/spellings.js` for `% M` equal the mask
   spelling's, and `p` is an i32 local at every level (`--wat`).
2. **A copy no run can enter.** `scripts/perf-corpus.mjs` `genProgram('mixed', 7)`:
   plan/integral-loops.js holds `acc` to a word under a guard
   (`1 + max(1, ceil(n) + 1) * 1103515500` within i32) that fails for every run with a
   trip, and leaves the loop as written cold, without the wide accumulator. Every
   spelling pays it since phase 1 (`i++` always did): `test/perf-ratchet.js` records
   mixed 2264/1060 -> 2250/1085. Done when a version whose guard cannot hold for one
   trip is not made, by a rule over the guard's own terms (no program named), and the
   ratchet's `mixed` entered count is at or below 1060 on both hosts.

### Then delete

Every private `%` rule the table replaces, and any range helper left with one caller.
The step ends with fewer lines under `src/` than it began, or the report says why not.

## Rules

- General means general: no bench, kernel or corpus program is named or matched; no
  source gets a hint. If a cell needs a hint to close, the fact is too weak: say so.
- No new optimization pass. This step moves rules into one place and fixes two facts.
- Work only on your worktree branch; first `git rebase main` (local `main` is ahead of
  origin). Never push. Never run repo-wide `checkout`, `reset`, `stash`, `clean`,
  `restore`. Stage files by name. No attribution lines in commits. No em-dash.
- Stay out of `module/`, `src/ir/arrays.js`, `src/optimize/vectorize/`: another agent
  is in them.

## Verify, in this order

1. `node test/index.js spellings perf-ratchet` after each change: the cells you expect
   move, no other does. A cell that closes leaves the table (`--update`); none opens;
   a ratchet count that rises is a regression to explain, never to re-baseline alone.
2. A differential battery against Node over the operators you touch, all levels, with
   NaN, -0, fractions, 2^31, 2^32 and negative operands, locals declared from integer
   literals and from parameters. Two harnesses to copy from:
   `/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/cmpd.mjs`
   and `cmpd2.mjs` beside it (they take the repo path). A wrong answer is a miscompile:
   report its smallest source, never list it as a gap. README's FAQ lists the accepted
   divergences (bitwise operands of 2^63 and over; numeric export parameters).
3. `npm test`, then `npm run test:matrix`, `npm run test:generated`, `npm run test:self`.
   Do not run two of them at once; another agent shares the machine.

## Report

Per change: the sites that now read the table and the rules deleted (file:line), gate
cells and ratchet deltas, lines added and removed under `src/`. What did not close and
which site stopped it. What in this brief was wrong. What you ran and what you inferred.

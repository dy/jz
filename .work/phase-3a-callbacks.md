# Phase 3a: callbacks read the summary

Part of `.work/architecture.md` (phase 3). Read that first, then `.work/maps/ranges.md`
section 6 and `.work/maps/loops.md` section 1 (rows for `forEach`/`map`/`reduce`).
The maps are a scout's: leads with file:line, each claim marked verified or inferred;
check a line before relying on it.

## The defect

`a.reduce((s, x) => s + x, 0)` over numbers links `__to_str`, `__str_join` and
`__add_slow` and adds through the generic `+`, on every variant tried, the literal
`[1, 2, 3]` and `s - x` included (153 to 278 KB of WAT). Measured at the speed level
on `const a = []; … a.push(i * 2); return a.reduce((s, x) => s + x, 0)`: 51 functions,
15.7 KB, 1.29× V8's time; the same sum as a `for` loop: 30 functions, 7.4 KB.

The scout's reading (verify it): the emitter of `.reduce` hard-codes the accumulator's
representation as tagged with no value kind (`module/array.js`, near line 2645,
`accRep = { tagged: true }`); `makeCallback` (`module/array/callback.js`, about lines
169 to 176) takes a parameter's kind only from `argReps[i].val`; the summary has
already solved the accumulator's kind (`reduceResult`, `src/summary/index.js`, about
lines 2870 to 2884) and the inlined callback's temporaries never read it. Setting
`val: VAL.NUMBER` by hand cut the literal case from 153 KB to 11 KB, and is unsound
(an accumulator can become a string): the sound source is the summary.

## The change

A callback inlined by an array or typed-array method takes each parameter's kind from
what the summary solved for that parameter at that call: element, index, accumulator,
for every method that inlines a callback (`forEach`, `map`, `filter`, `reduce`,
`reduceRight`, `find`, `findIndex`, `some`, `every`, `flatMap`, `sort`'s comparator
and the rest: list the ones you find). One mechanism in `makeCallback` (or where the
tree puts it), not a case per method. Where the summary has no fact, today's tagged
representation stays.

General means: no method name, no callback shape and no bench is special-cased. If a
method needs its own line, say why in the report.

## Done when

- The reduce program above links no string helper and its `run` function has no call
  to a generic add; say what it costs in functions and bytes before and after.
- `Math.max(s, x)` as the reducer: the scout saw string helpers remain after the hand
  fix and did not find why. Find out; fix it if it is the same missing fact, report it
  if it is another.
- An accumulator that does become a string (`['a', 'b'].reduce((s, x) => s + x, '')`),
  one that changes kind midway (`[1, 'a'].reduce((s, x) => s + x, 0)`), an empty array
  with no initial value (throws in JS), and a reducer returning objects: each answers
  what Node answers at every level. Add them as behaviour tests beside the existing
  reduce tests if they are not there (differential against Node, no WAT patterns).
- `node test/index.js spellings`: the `kernel/dot/reduce` and `forEach` cells may move;
  a cell that closes leaves the table (`--update`), none opens. `perf-ratchet` is an
  equality per host: lock a drop with `--update` under each host, explain a rise.
- `npm test`, `npm run test:matrix`, `npm run test:generated`, `npm run test:self`.

## Not in this phase

- Vectorizing `forEach`/`reduce`/`for…of` reductions. If the typed loop still does not
  vectorize, report which check rejects it (file:line) and stop: the one loop
  constructor is the next step of phase 3.
- Any new pass.

## Report

Before and after for the probe (functions, bytes, helpers linked, time against V8 if
you measure it, with the machine load stated), the methods covered, the gate and
ratchet deltas, lines added and removed, what was wrong in this brief.

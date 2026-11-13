Scout report (Sonnet 5.5, 2026-11-13), tree `557fbd525`, read-only. Leads, not facts: V = the
scout read the line or ran the command, I = inferred. The integrator compiled five of the
reduced programs of `counter-census.md` on the same tree and saw the same f64 locals; nothing
else here is re-derived. `SCRATCH/counter-widths/` in the text is session scratch (the reduced
programs, the tree of `e88a8e907`, the instrumentation patch, the raw rows): not in the repo.

# guards.md: what run-time versioning costs here

Model: claude-sonnet-5-5. Everything below was measured; "I" marks the one inference.

## Entries and trips of every loop of `transform`, N = 2048 (V)

Method: `SCRATCH/counter-widths/rfft-count.mjs` is a copy of `examples/rfft/rfft.js` (the example is untouched) in which every `while` of `transform` is preceded by `__E.<name> = (__E.<name>|0) + 1` (entries) and starts with `__T.<name> = (__T.<name>|0) + 1` (trips). `node count.mjs 2048` calls `init(2048)`, fills the input, clears the counters, calls `rfft()` once (so `transform` runs once). Loops are named by their position in the source.

```
loop                                                  entries     trips  trips/entry
bit-reversal copy: while (i < N)                            1      2048      2048.00
first pass, outer: while (ix < N)                           1         6         6.00
first pass, inner: while (i0 < N)  [i0 += id]               6       683       113.83
stage loop: while ((nn = nn >>> 1))                         1        10        10.00
zero-angle, outer: while (ix < N)                          10        30         3.00
zero-angle, inner (n4 !== 1): while (i0 < N)               25       341        13.64
zero-angle, inner (n4 === 1): while (i0 < N)                5       341        68.20
twiddle: while (j < count)                                 10       502        50.20
twiddle, outer: while (ix < N)                            502       652         1.30
twiddle, inner: while (i0 < N)                            652      1252         1.92
total                                                    1213      5865
```

Other N (same program): N = 256: 163 entries, 672 trips in total, twiddle inner 69 entries / 93 trips (1.35 per entry). N = 4096: 2409 entries, 12066 trips, twiddle inner 1329 entries / 2845 trips (2.14 per entry).

Reading it:

- Almost all entries are the two innermost twiddle loops: the `ix` loop is entered 502 times (once per `j`, `j` trips 502 over 10 stages) and the `i0` loop 652 times, for 1252 butterflies: 1.92 butterflies per entry. The step `id` grows by 4 per pass, so the later `i0` loops run once.
- The loop that is entered few times and runs many is `j < count` (10 entries, 502 trips) and everything outside it (stage loop 1 entry; bit reversal 1 entry).
- Loops counted as innermost (`i0` loops of all four nests): 688 entries (6 + 25 + 5 + 652) for 2617 trips: 3.8 trips per entry.

## Size of one guard and of one trip (V, operator nodes in the emitted WAT, `nodes.mjs` on `rfft-now-speed.wat`)

- The planner's existing guard of the `j` loop (`typeof count === 'number' && count >= -2^31 && count <= 2^31-1`, then the rounded bound `ceil(count) >> 0`), lines 5167 to 5262 of `$transform` at speed: 55 operator nodes (the `typeof` test is a NaN-box tag test over `count`, because `count` is a typed-element read; the two comparisons are against `$__ff5`, `$__ff6`; the `floor`/`neg` rounding).
- One trip of the innermost loop in the integer copy (`$loop301.f2.f5.f7`): 240 operator nodes. The setup of its parent per entry: 23 nodes.
- The same guard evaluated per entry of the twiddle inner `i0` loop (I: counted by multiplication, not run): 652 entries x 55 = 35,860 nodes against 1252 trips x 240 = 300,480 nodes, +12% in operator nodes of that loop; per entry of the `ix` loop: 502 x 55 = 27,610. At the `j` loop entry, where the planner puts it: 10 x 55 = 550 nodes, 0.18% of the 300,480 nodes of the 1252 innermost trips. A guard at every loop entry of the function would be 1213 x 55 = 66,715 nodes.
- Where a version's guard sits (`plan/integral-loops.js:2187-2190`): in place of the loop statement, so it runs once per execution of that statement; an inner version nested in a copy is folded into the outer guard (`versions` map, `:625-629`, :2193-2195), so a guard per inner loop is not what the pass does today for a nest it versions.

## What follows (facts, not a design)

- A guard per entry of the `i0` loops costs about one eighth of those loops' trips and is entered 652 times at N = 2048; a guard on the loop whose trips it covers (`j`, 10 entries) or on the whole function (1 entry) costs under 0.2%.
- The guards the pass already emits for this function are of that cheap kind (two entries: bit reversal 1, `j` 10).
- The inputs that make the index locals diverge (rfft.md) are conditions on `N` alone (`N >= 2^31 - 1` for `id`/`ix`/`i0`, `N >= 2^29` for the stage `ix`), which do not change within a call: a test of `N` at the function's entry or at the stage loop's entry (1 entry) holds for every entry of every inner loop. The bound that bit-reversal `i` and `j` need (`N` and `count` words) is also invariant across the whole call.
- The twiddle `j` loop's guard is on `count`, an `Int32Array` element that changes per stage: it must be evaluated per stage (10 entries), not at the function entry.
- Bytes: each copy duplicates its nest: +2632 bytes at level 2, +3254 at speed for the two copies in this function (V, `bytes.mjs`: 26083 against 23451, 31645 against 28391 with `versionIntegralLoops` off). The twiddle copy is the larger one (it holds the three nested loops).

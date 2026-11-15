# Sentences the evidence contradicts, for the owner

From the reference run of 2026-11-14 (run 43583320878 on 3420027ce: the rivals' current
releases, 106 cases on four machine types), listed by the 9a writer and checked against
the run's summary by the integrator. None of these sentences was edited: they are the
owner's, and what each should say is the owner's decision. Numbers that the dataset
holds are written into the docs by `scripts/bench-readme.mjs` and checked by the claims
gate; the sentences below are prose around them.

"N x of X's time" is jz's time over X's: above 1, jz is slower. An average "N x" against
a rival is the rival's time over jz's: above 1, jz is faster.

## AGENTS.md, "Performance claims"

| lines | the sentence | what the run shows |
|---|---|---|
| 11-13 | "On every bench case, jz's wasm is the fastest among wasm producers" | behind the best wasm rival on 15 of 89 contested cases: fabrik 3.04x of the rival's time, polytri 2.37x, mapobj 1.35x, mapint 1.29x, stdlib-gamma 1.25x, threescene 1.21x, stdlib-pow 1.13x, gainclass 1.08x, hwb 1.06x, quatmul 1.05x, sosfilter 1.03x, worley 1.03x, threegeom 1.02x, trace 1.01x, arraynumeric 1.00x. Five of the fifteen are pending cases the gate does not hold yet (fabrik, polytri, mapobj, mapint, arraynumeric). The leads on dotprod, matmul and stdlib-ddot are relaxed floats against strict rivals: at JavaScript's floats jz trails on stdlib-ddot, mat4 and matmul (a local run; the exact lane's first reference run will say) |
| 20-24 | the cases not yet led against V8-family engines (`watr`, the self-compile, four decoders) | decode-dsd (1.33x of Deno's time) and crc32 (1.11x of V8's) are behind too and not named |
| 24-29 | bun/JSC: two classes held to bands | behind and not named: decode-wav 2.26x, decode-dsd 1.52x, decode-alac 1.41x, decode-qoa 1.30x, decode-tta 1.26x, resample 1.11x. The self-compile against JSC is 1.669x, past its 1.35x band. vm (0.84x) and dict (0.87x) lead JSC on this run |
| 9 | "CI-gated (`test/bench.js`)" | the release gate is `test/bench-claims.js` on the committed dataset; `test/bench.js` asserts ratios off CI only |

## README.md

| lines | the sentence | what the run shows |
|---|---|---|
| 425 | "about 2x on average" against V8 and AssemblyScript | V8 2.29x, AssemblyScript 2.66x (the weekly dataset: 2.44x, 2.75x) |
| 433-437 | the watr rounds ("9 to 13 of 21 rounds", "996 us against 1866 us") | no lane measures the rounds or the `--no-liftoff` timing; the dataset has jz 1989 us, JSC 1890 us |
| 480-482 | "rustc, clang and zig about 2x" | c-wasm 1.60x, rust-wasm 1.61x, zig 2.21x; Go 5.51x, MoonBit 5.08x |
| 482 | "Rust ... trail and C is level" | native C 1.03x, native Rust 1.04x |

## index.html

Written by the script from the weekly dataset now: the prefilled ratios 2.36, 2.23, 1.04,
0.66, 0.82 became 2.44, 2.75, 1.01, 0.57, 0.77; "scriptc ~90x" became 63x; "Static Hermes
~25x" became 21x.

## bench/README.md

| lines | the text | what the run shows |
|---|---|---|
| 107-145 | hwb and gainclass lead; munsell and stdlib-exp trail | hwb trails rust-wasm (14422 against 13567 us), gainclass trails c-wasm (108 against 100); munsell and stdlib-exp lead |
| 142 | three pending cases | `PENDING_CASES` holds 13 |
| 463-478 | the gate is `test/bench.js` with a geomean-only size band | the gate is `test/bench-claims.js` |
| several | Porffor alpha 19, Bend 2.0.39 | what the committed weekly dataset holds (results-ci.json, 2026-11-09; results.json holds alpha 13, 2026-09-30). `bench.yml` installs alpha 23 and 2.0.40, which the reference run measured and did not commit, its gate failing |

The last three rows are facts with a source (the gate's own list, package.json, the
dataset): 9b has the docs script write them, and the two releases follow the next
dataset a run commits.

## What stands red on main, and why

The `claims` job of the `test` workflow and one test of the `bench` workflow fail on
every push, as they did before this work: the committed reference dataset
(bench/results.json, 2026-09-30) predates 1,600 compiler commits and Porffor alpha 23,
and a reference run commits a new one only when its own gate passes. The run of
2026-11-14 passed 22 claims and failed 7, the sentences above. The five test suites,
the self-compile, test262, the pages and the examples gate are green.

## What the writer changed in the owner's text, each because the behaviour changed

- README's `optimize` row gained `relaxedFloat`.
- The FAQ's "Float sums in lanes" became "Float results at 'speed'", with the bound.
- "Constant arithmetic" gained "At 'speed'": the exact rationals follow `relaxedFloat`.
- The `** 0.5` clause: "(-Infinity) ** 0.5 is NaN" is what remains; `(-0) ** 0.5` is +0 now.
- The size sentence carries marked figures (0.79x over 57 cases; the text said 51).
- bench/README.md's colour-probe paragraphs and its "default optimize: 2" line, now `'speed'`.
- README, "Host functions": one sentence added, "A host function may call the module's
  exports while it runs." (the integrator, on the owner's word).

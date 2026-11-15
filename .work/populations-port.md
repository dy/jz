# The review's populations, into the repo

Not a phase of `.work/architecture.md`: the ground under all of them. Every landing since
phase 2 was reviewed against populations the integrator wrote: programs generated over a
grid, each answering what Node answers at every level. They measured each class of
wrong answer the plan lists (a uint32 read as a signed word, a host import that calls
back) and found some no one had looked for (two of the five defects behind a CommonJS
bundle; a third came from probes of its own, and the population gained its programs
when it moved here). They live in one session's temporary folder and in no repository. A reboot
loses them, and CI has never run one.

`SCRATCH` below is
`/private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad`.

## The outcome

Each population below is one of two things when you hand back:

1. **A test of the generated suite** (`test/<name>-population.js`, listed in
   `test/index.js` and in the `generated` set of `test/_suites.js`), holding every program
   of the scratch population, or
2. **Named as held already**: a test of the repo that runs the same programs (a writer
   moved its own population in: `test/boxed-counters-population.js`,
   `test/rules-population.js`, `test/vector-dependence.js`, `test/relaxed-float.js`,
   `test/integral-loops.js` are the likely ones). Say which test, and port what it lacks.

`test/try-population.js` (this branch) is the worked example: `trypop.mjs` as a test.
Read it beside `SCRATCH/trypop.mjs` before the first port.

## The populations

Run by `SCRATCH/popbattery.sh` and `SCRATCH/seqreview.sh` (read both: they are the
invocations); the last results on the tree this branch stands on are
`SCRATCH/seqreview-flow.out` and `SCRATCH/pop-flow-*.log`.

```
boxpop boxpop2 boxprobe boxprobe2        a loop's integers held as words (the box)
mergeprobe mergeprobe2 mergeprobe3       a copy that leaves for the loop as written
tierpop                                  the box as a tier above the planner's copy
cwpop uextpop boundwrap udiv             counters, bounds and uint32 at the word's edges
pcb/pcbpop pcb/boxlenpop pcb/entrypop    the bound tier's loops, a bound off `.length`, a `for` entering from a word
vecdep vecnarrow vecalias vecwrong       loops over typed arrays: order, narrow lanes, aliasing, the census's nine
p9a/pop                                  float reductions, exact and within the README's bound at speed
reentrypop p7check p7more                a host import that calls an export back
scout-7/repro/memfuzz memfuzz2           random aliasing programs
p8check                                  the phase 8 scout's three reaches
```

Each is `SCRATCH/<name>.mjs`; several share `SCRATCH/harness.mjs`. Their headers say
what each holds and why.

Three programs differ from Node on every tree, the fixed one too: `boxprobe`'s
"arguments of other kinds" (150 checks) and `vecnarrow`'s "u32 fixed mul" and "u32 fixed
mul 15" (72 checks each). For each, find which it is: a divergence the README documents
(cite the sentence, and hold the test to what the README says), or a wrong answer in
ordinary code. A wrong answer is listed in your hand-back with its smallest program; you
do not fix it here.

## The rules

- **No compiler source changes.** `src/`, `jzify/`, `module/` stay as they are. A
  population that finds a difference stops your port of it: write the program, the
  levels and both answers into the hand-back.
- **Every program, no sample.** A population is its grid. Where the time needs cutting,
  cut levels first, then say in the header what was cut and that the full grid agreed
  when you ran it (date it). Never drop a program that has ever differed.
- **The repo's form.** `jz` and `oracle` from `./util.js`; many functions to a module and
  one compile a configuration where the population allows it (a program whose point is
  what a callee is told of its arguments keeps its own callee: see the try population);
  one assertion per differing call, not per call; a header that says what the grid is
  and which defect class it guards, in the words of the plan's notes.
- **Time.** The generated leg is five minutes on four jobs today. A new file is three
  minutes alone at most on a quiet machine. The try population is the exception and its
  header says why (each program has callees of its own, so no two share a compile's
  work); a population of functions over shared arrays has no such reason. The machine is not quiet (two writers and a
  battery share it): run one population at a time, and write the load beside any time
  you report.
- **A test that cannot fail is no test.** For each port, show it fails against the
  defect its population was written for, where that is one commit to take out (the
  plan's notes name the fixing commits; `SCRATCH/takeout2.py` and `SCRATCH/takeouts.sh`
  are how the try population's four were done). Where you did not, say so by name.
  A port that passes with the fix out has found the population's hole: the try
  population passed with one of its four fixes out until it gained a use that holds a
  proof across the assignment. Add the programs that close it, and say so.
- **Checks before hand-back:** `npm run lint:imports`, `npm run audit:files`,
  `node test/index.js --suite=generated` native and under `JZ_TEST_HOST=wasi` (CI runs
  the generated suite on both), `node test/index.js --suite=all --list` reading as you
  expect. The integrator's battery runs the rest at landing.
- **Git.** Your own worktree and branch. Stage files by name (`git add -- path`), never
  `-A` or `.`; no push, no pull, no repo-wide `checkout`, `reset`, `stash`, `clean`. The
  owner is the sole author: no co-author line, no tool's name in a message. A subject
  says what changed, as the log's do. No em-dash anywhere.

## Hand-back

A table: scratch population, the repo test that holds it now (new or existing), programs,
configurations, time and load, shown to fail without its fix (the commit) or not. Then:
every difference found, every program dropped and why, and what you did not verify.

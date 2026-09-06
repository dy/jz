# Checkpoint proof and the emitFuncs BigInt reduction — `checkpoint-45868ec5`

Base `45868ec5` (the review integration HEAD), worktree `$S/ck-wt`, branch `checkpoint-45868ec5`. Main's eight pending files are not in this lineage; nothing here is combined-working-tree evidence. Dependencies: the worktree's own `node_modules` (symlinks to the main checkout's packages; watr copied from `/Users/div/projects/watr` at `5ff0037`, checkout clean; `web-audio-api@1.5.5` from a scratch install). `handoff-03cf346d` at `44309407` is untouched.

## Commits

| commit | subject | what |
|---|---|---|
| `bd191ffd` | Exercise the kernel's internal checkpoint on small programs | `test/self-checkpoint.js`, `test/_self-overlay-build.mjs`, `selfBuildWith` in `test/_self-build.js`, registration; red on the defect it finds |
| `7227316c` | Park a parsed WAT literal by its text | the checkpoint serializer repair, `scripts/self.js` `parkValue`, its own commit |
| (this) | the regression test, this record | `test/bigint-boundary.js` (red pins), registration |

## 1. The internal checkpoint, exercised

**Kernel.** A private kernel built from this tree by `test/_self-overlay-build.mjs` with one overlay on the entry's source: `__heap_large(heapMark) ? checkpointIR(optimized) : optimized` → `checkpointIR(optimized)`, so the real `checkpointIR` (park, finish, rewind, unpark) runs on every `compileSelf`; the shipping threshold `__heap_large` and every other line are the fresh self build's (same profile: optimize 1, snapshot on). The untouched fresh kernel (`selfBytes`, the self gate's own build) is the comparison. Both are built and instantiated by the test, never written to `dist/`.

**What the branch shows** (`test/self-checkpoint.js`, 5 tests, 44 assertions, pass at `7227316c`):
- The branch ran: after a forced compile the checkpoint stage mark is below the mark after watr and below the front's mark (the rewind returned to the post-init mark, the unparked IR above it); the park lane grew the instance's memory to its end (4,294,901,760 bytes); the fresh kernel's marks on the same program never decrease.
- Output: the forced kernel's bytes equal the fresh kernel's byte for byte for A (`export let main = () => 3 + 4 * 5`), B (a statement body: `$main$exp` wrapper, inlined callee), C (a string literal data segment and an array literal) and the empty program; each executes (23, 11, 10; the empty module has no entry) and the copies taken before the next compile, `_clear()` and further compiles reinstantiate and execute.
- Records: the same phases recorded and readable after the rewind, monotone before it; reading them after the checkpoint allocates nothing (the kernel's `__heap` before and after two `readMarks` equal). Recording's zero allocation is the recorder's own proof (`test/kernel-marks.js`, 12/12 at this base; the checkpoint changes nothing about the typed-array records, which sit below the rewind mark).
- Sequences: empty → empty, A → A, A → B at once, B first on a fresh forced instance (equal to B after A), a parse error → A (0 phases, 0 stages, then A equal to the fresh kernel's), the abrupt emit-time rejection (`b >>> 2` on a BigInt: `publishParameterAbi` the last completed phase, no stage after the front, deltas non-negative), `compileWat` (same text as the fresh kernel's, no stage marks) / `compileWarnings` / `compileDiag` between checkpointed compiles, `_clear()` between them (records identical through it, the next compile checkpoints again).

**What it found** (`bd191ffd` alone: 3 of 5 tests fail): a program whose main has a statement body exports through a `$main$exp` boundary wrapper; the wrapper's WAT text is parsed by watr, so its `(export "main")` name is a byte array with a `valueOf()` (watr/src/util.js `str`), and `parkValue` parked it as four numbers; after the unpark watr's assembler rejected it: `Bad export name`. Every real program has such a wrapper; the checkpoint had never produced a valid module for one. The direct path never sees it because the assembler accepts either form. `7227316c` parks such an array as its text (`value.valueOf()` a string), which the assembler converts back; a plain array parks as before. It is a candidate repair to the kernel's checkpoint transport, in its own commit for the review to take or drop; without it the proof stands only for programs without a boundary wrapper.

**Not covered:** a checkpoint on a large compile (the shipping threshold, 1 GB of growth) end to end: the recursive compile on this lineage fails in emitFuncs before its checkpoint (below). A failure *after* the checkpoint (inside watrCompile) is not exercised.

## 2. The recursive emitFuncs failure, reduced (read-only)

**Ordinary-JS regression** (`test/bigint-boundary.js`, red):

```js
const _hx8 = n => n.toString(16).padStart(8, "0")
export const i64Hex = bits => "0x" + _hx8(Number((bits >> 32n) & 0xFFFFFFFFn)) + _hx8(Number(bits & 0xFFFFFFFFn))
export const LAYOUT = { A: 1, NAN: 0x7FF8000000000000n }
export let f = () => i64Hex(LAYOUT.NAN).length   // 18 in JS; jz's output throws
```

`f()` throws `Cannot mix BigInt and other types, use explicit conversions` at O1 and O2; the host's own call `i64Hex(0x7FF8000000000000n)` throws the same. The same function not exported returns 18 at both levels.

- **Failing compiler function:** `i64Hex` (`layout.js:66`), called from `emitTypeofCmp` (`src/compile/emit/comparisons.js`, the `TYPEOF.number` arm, lines 80–91) with `LAYOUT.NAN_PREFIX_BITS` and `NEG_NAN_MASK`. In the kernel, `i64Hex` is the compiler's own function compiled by jz.
- **Source/AST producer:** a `typeof x === 'number'` comparison in expression position (a ternary condition, a value): `['?', ['===', ['typeof', x], code], …]`. The statement form `if (typeof x === 'number') …` takes flow-types' guard path and does not call it.
- **Semantic kind:** `i64Hex`'s parameter is ANY in the summary (the host boundary's ANY joined with BIGINT from every in-program call), and `numericDemand` is true: `demand()` marks a `>>` / `&` read NUM whatever the other operand (`32n`, `0xFFFFFFFFn`), and the seeded re-fixpoint then binds the exported parameter NUMBER.
- **Physical carrier:** the parameter is compiled `f64` (the boundary's numeric contract; `ctx.funcs` record `type: 'f64'`), one signature for the host wrapper and the in-program calls.
- **Consuming operation:** `bits >> 32n` inside `i64Hex`: the runtime's BigInt-mixing check on the shift, the left operand arriving through the f64 slot.
- **Native vs hosted:** natively (V8 running the compiler as JS) `i64Hex` is plain JS and works; in the kernel (the compiler compiled by jz) the same call mixes. The compiler's own source has `typeof x === 'number' ? … : …` in expression position (`src/abi/array.js` `addr` first among the failing subgraphs), so the kernel throws on itself; the last completed phase is `publishParameterAbi`, the failing phase `emitFuncs` (the throw is inside emitting the first function with such a test).
- **Sibling scope, error, reuse:** through a warm private kernel (level 1): `export const addr = (idx) => typeof idx === "number" ? 1 : 0` throws, again on a second compile, and the next compile (`export let main = () => 3 + 4 * 5`) succeeds on the same instance; the `if` form and the `"string"`, `"undefined"`, `"bigint"`, `"object"` arms compile. Compiler subgraphs: `src/abi/array.js` (97 lines, no BigInt in it) throws; `src/ir/tape.js`, `src/ast.js`, `src/abi/number.js`, `src/abi/string.js`, `src/abi/object.js`, `src/compile/active-function.js` compile. `layout.js` alone fails earlier with `RepresentationPlan host-box param lacks i64 boundary: i64Hex[0]` (recorded, not reduced).
- **A sibling in the watr stage:** small programs at O2/O3 (`for (const x of [1,2,3]) s += x`, `[…].forEach(x => s += x)`) throw the same message with emit completed and the watr stage not: watr's optimizer compiled in the kernel; watr's `encode.js` exports `i64(n)` with `n >>= 7n`, the same shape. Not reduced beyond the stage.

No summary, representation or emitter change is made; the rule the reduction points at (`demand()`: a NUMBER_OPS read with a BigInt operand is not a ToNumber read) belongs to the summary's owner.

## Gates on this lineage (literal)

| gate | result |
|---|---|
| `node test/self-checkpoint.js` at `7227316c` | 5/5, 44 assertions (at `bd191ffd`: 2/5, `Bad export name`) |
| `node test/index.js kernel-marks summary-keys summary-queries tape` | 42/42, 528 assertions |
| `node test/kernel-marks.js` / `summary-keys` / `summary` / `summary-queries` / `tape` | 12/12; 4/4; 18/18 (9,341); 7/7; 19/19 |
| `node test/self-compile.js` (private fresh functional self gate, at `7227316c`) | **20 pass / 6 fail** of 26: level-2 inliner `Cannot mix BigInt and other types`; f64x2 lane vectorizer `memory access out of bounds`; eq-zero optimizer parity; warm direct-call graph; warm-instance reuse compile → `_clear()` → compile parity; warm-instance reuse without `_clear()` `memory access out of bounds`. The same six as the base. |
| `node test/bigint-boundary.js` | **1 pass / 2 fail**: the two red pins of the defect above |
| full native suite, matrix, recursive | not run here; the recursive compile on this lineage fails in emitFuncs (above) before any checkpoint |

No performance evidence was collected. Scratch: `$S/scratchpad/kbisect.mjs` (a source through a kernel and natively, with the last completed phase and stage marks), `ksub.mjs` (a compiler subgraph through a kernel), `ck-wat.mjs` / `ck-wat2.mjs` (direct vs checkpointed IR text), `ck-probe.json` / `ck-diag.json` (diagnostic overlays), `red/*.js` (the reductions), `ck-self-compile.log`.

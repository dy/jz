# Sequence/result review — 2026-09-06

Bounded review of dirty main at `45868ec5`; not a v1 or bootstrap certificate.
The frozen optimizer/checkpoint candidates were not integrated. No dependency,
benchmark ledger, or shared watr source was edited here. `dist/jz.wasm` retains
its prior hash; self-builds used private outputs.

## Findings and repairs

- A comma expression forwards its final value, not the joined kinds of its
  discarded operands. Missing forwarding narrowed a real BigInt shift to i32:
  `[0,12]` instead of `[12,12]`.
- Forwarding the legacy `valTypeOf(last)` answer alone was insufficient: its
  receiver-oriented BigInt claim also admits nullish values. The initial
  candidate consequently misclassified `Number((mark(),c?6n:null))`. The settled
  summary now supplies the value-kind answer without an unknown-answer fallback;
  before summaries exist, the existing scoped reader supplies the answer.
- `semanticOf` and `currentOf` already followed comma tails, but
  `emittedCandidate` and the active-materialization reader did not. Both now
  retain the final producer's readiness/carrier. Nullable returns use the
  correct export decode. No extra return-expression rewalk, new persistent
  fact, or ANY/Boolean materialization widening was introduced.
- A statically known `typeof` result must still evaluate its operand once,
  including conversion failures. BigInt/Boolean folds now use existing comma
  lowering. Comparison folds reuse the already-emitted operand.
- Raw BigInts can look like Numbers or pointer tags. Proven BigInt/Boolean
  kinds decide all `typeof` comparisons. Dynamic object predicates admit null,
  but exclude boxed BigInts and the other primitive atoms.

The bare-binding bitwise normalization, grouped-reference validation, and
signed/far-shift helper were reviewed and left intact. Arithmetic normalization
and effectful member staging remain reverted, not partly reintroduced. Their
red pins remain. The member exception observer now preserves named errors
instead of treating every exception as an `Error.thrown` payload.

Two independent defects were reduced and pinned in `test/data.js`, not fixed:
`BigInt(null/undefined)` returns 0n, and local BigInt/Boolean results lose their
kind beside Numbers in heterogeneous arrays. Direct producers reproduce both,
without the repaired sequence behavior. Captured results, Boolean/Number merges,
member-reference ordering, and the exported-helper numeric-demand defect remain
separate open contracts.

## Regression evidence

`test/sequence-values.js` has 43 tests / 5137 assertions: direct and scoped kind
queries, eleven BigInt operators, collision/extreme payloads, discarded effects,
nested sequences, nullable returns/conversions/comparisons, named and primitive
exceptions, externally observed state, recovery, and retained executable bytes.
Native reuse includes empty→empty, A→A, immediate A→B versus fresh B, error→A,
and re-instantiation of copied/retained A and nullable B.

The five-module incremental baseline passes 15/43; current passes 43/43.
Other dirty-main files and installed dependencies are held fixed. This is **not**
a clean-HEAD comparison. `NODE_OPTIONS` carries the loader into the fresh-B
child; the earlier two-module command-line loader did not, so its child byte
mismatch was not valid failing-before evidence. The corrected baseline passes
fresh-B byte equality and fails on retained A's semantic result.

## Validation (combined working tree)

| Gate | Result |
|---|---|
| Final `npm test` | 4148 pass / 53 fail / 1 skip; 4202 tests, 49840 assertions |
| `test:matrix` | Native failed; later full legs skipped. This run preceded the second new red pin: 4148/4201, 52 failures, one skip. |
| Broad opt0 selection | 1421/1472; 18273 assertions |
| Broad opt3 selection | 1421/1472; 18331 assertions |
| Broad WASI selection | 1421/1470; 17733 assertions |
| Fresh private self | 20/26; 98 assertions; same six failures; performance skipped |
| Test262 language | 2996 pass, 4024 negative rejects, 9 failures, 21 negative accepts |
| Test262 builtins | 864 pass, 4 failures |

The final native failing-name set differs from the preceding 51-failure
sequence checkpoint only by the two new independent pins above. Conformance
has the same unexpected pass in each runner; no expectations were changed.
These reds are blockers, not a newly accepted baseline.

Broad selections:

```sh
FILES='sequence-values unsigned data statements strings inference optimizer perf minimal-output summary-queries summary-keys kernel-marks tape determinism perf-ratchet imports slot-hazards watr bool-identity'
JZ_TEST_OPTIMIZE=0 node test/index.js $FILES
JZ_TEST_OPTIMIZE=3 node test/index.js $FILES
JZ_TEST_HOST=wasi node test/index.js $FILES
```

## Byte/value probe

`sequence-cost.mjs` records 156 validated binaries per side (O0–O3): 84 are
byte-identical, including all 80 general/numerical control rows. Net output is
3248 bytes smaller; differences range from −466 to +22 bytes.

Twelve rows grow: four nullable returns gain six bytes in `jz:i64exp` metadata
(`"r":1`, selecting tagged result decode); eight object predicates gain 22
bytes for null inclusion and BigInt exclusion. Other changed rows shrink by
removing incorrect narrowing or unneeded dynamic type dispatch. No byte budget
was relaxed. Benchmark sources and committed results were not edited.

JS observations improve 308→396 of 468, with **zero previously matching
observations regressed**. The 72 remaining mismatches are all the independently
pinned mixed-array storage family; their smaller binaries are not correctness
wins. Direct-result reductions improve 28→84 of 84 while observing effects
through a separate export. The control machine code is unchanged; no timing,
compiler-allocation, heap, or recursive-memory measurement
is claimed. Another session was running private compiler work.

Replay, from the repository root (use any private output directory):

```sh
NODE_OPTIONS="--no-warnings --loader $PWD/.work/optimizer-review/sequence-before.mjs" \
  node test/index.js sequence-values
node test/index.js sequence-values

NODE_OPTIONS="--no-warnings --loader $PWD/.work/optimizer-review/sequence-before.mjs" \
  node .work/optimizer-review/sequence-cost.mjs /tmp/sequence-before.json
node .work/optimizer-review/sequence-cost.mjs /tmp/sequence-current.json
```

`sequence-review.json` retains compiler/dependency hashes, literal failing
names, gate log hashes, and per-case byte/output evidence. Transient WAT,
loader snapshots and full logs in the owned result-review scratch directory
were removed after retaining this replayable evidence: 49 files, 18769241 bytes.
Other sessions' scratch
and frozen candidates remain intact. All changes remain uncommitted.

# Integration after the pi session — 2026-09-06

One agent, main. The pi session (the coordinator) stopped mid-review with
main dirty at `45868ec5`; this session committed that work, found the root
causes of the kernel's hosted failures, integrated the frozen candidates and
the sibling watr, and left main clean.

## Commits, in order (main `45868ec5` → `96d12022`)

The pi session's pending work, split by slice:

| commit | subject |
|---|---|
| `925baca3` | Forward a sequence's kind, presence and carrier; evaluate typeof operands once |
| `86c888d6` | Normalize bare bitwise compound writes before planning; validate grouped references; count shifts exactly |
| `67bed3f5` | Throw a branded RangeError for BigInt division and remainder by zero (`division-review.md`) |

The kernel's root causes (found by bisecting kernel builds over the commits
since the last good dist, then instrumenting the compiler through overlay and
site-tagged kernels; each has a native reduction and a pin):

| commit | defect | where it showed |
|---|---|---|
| `d5083ba1`, `08ce820b` | the boundary reduction and pins (cherry-picked from the campaign) | |
| `c7a2a8dc` | numeric demand counted `bits >> 32n` a ToNumber read; a module binding's and a slot's BigInt carrier never reached the call edge | `Cannot mix BigInt` in emitFuncs on any `typeof x === 'number'` (layout.js i64Hex) |
| `245f86b9` | a nullable boolean was statically boolean: `t === false` lowered as "t is falsy", so `foldConstIf` dropped every `if` whose condition was no literal | `if (idx > 1) return …` compiled to its fall-through; the `continue`-in-`if` reduction |
| `32354a86` | every "is this a BigInt box" test read the tag alone; 12.0's bits spell tag 5 | watr's sinkSets counter threw on a local touched twelve times |
| `d5a35899` | a join written to a never-materialized binding took a boxed carrier; the materialization passes fed each other in fixed order | watr's f64 encoder wrote a box pointer for every `nan:0x…` constant (heap-dependent output bytes, traps) |
| `138291de` | the slot evidence must not cover a literal array's element | `[1n][0]` returned to the host as 5e-324 |
| `8881cc04` | a compound update never materialized its binding; a desugared `+=` lost the plan's identity | the ten checked-producer compound pins |
| `013523a4` | the summary escaped array callbacks; a nullable element folded `!== null` | module/object.js's static literal laid out null slots, the kernel trapped in pushStaticSlots |
| `96d12022` | the perf gate's native side lacked the kernel's heap-mark intrinsics | `test:self`'s second half never ran |

Integrated candidates: `campaign-5763b63f` and `campaign-1af98c2f` (16
commits rebased onto main, the consolidation pair `87925b99`/`6ee56ab4`
dropped since it nets to nothing; `28d21443`–`2bef5273`): the private build
transaction, the kernel-gate runner with attested verdicts, the checkpoint
proofs, the reachability judge, the wrong-code families, the harnesses that
name their kernel. Sibling watr fast-forwarded `5ff0037` → `5613521`
(`cfedd858` records it; `node_modules/watr` re-copied, parity checked).
Not integrated: `campaign-locals-jz` (the local-pass deletion, still +495…
+1,832 ops on the level-2 ratchet), `c2-fromcharcode` (needs the byte-array
data pipeline), the frozen `44309407`.

## Gates

- Native `npm test` at `8881cc04`: **4268 pass / 45 fail / 1 skip**, 52966
  assertions (`45868ec5` with the pending files: 4171 / 53 / 1). Fixed
  names: the ten compound pins, the watr NaN-payload pin, kernel parity
  O0/O2/O3, the kernel oracle's bare array-element return. New names: the
  campaign's pins (host BigInt carrier, fromCharCode family) and the three
  kernel-oracle levels, red on the envMeta row until `013523a4` (green
  since, `kernel-oracle kernel-parity self-families` 37/38 at `013523a4`).
- Fresh private self-compile: **26/26** (20/26 before). Hosted families
  22/23 (fromCharCode). Kernel oracle and parity green on a fresh kernel.
- opt0 / opt3 / WASI over `bigint-division sequence-values unsigned data
  errors statements` at `67bed3f5`: 689/737, 689/737, 687/735, every red
  within the native set.
- `test/self-compile-perf.js` now runs: warm 1.32–1.37× (cap 1.03), fresh
  1.03× (cap 0.99), measured on a loaded machine (a leaked `strbuild`
  benchmark process had held a core for two days; killed). Not evidence
  either way; re-measure unloaded.
- The remaining 45 native reds: the member-reference single-evaluation
  family (23: `obj[k()] op= rhs()` evaluates the receiver and key twice, the
  pi session's staging attempt regressed a `.subarray()` case and was
  reverted), result carriers (6), `unsigned`/`data`/`inference` base pins
  (the receiver-HASH ordering, the checked-index absent read, boolean
  identity beside Numbers in arrays, the optional BigInt reduction), the
  host BigInt carrier, fromCharCode, `watr bug: memory64`, the perf pins.

- `kernel-gate --build --gate functional,sequences,recursive` at `96d12022`
  (`$S/scratchpad/gate-96d12022.{json,log}`, kernel `k-96d12022.wasm`,
  14.6 MB): sequences GREEN 9/9; functional 12/20 GREEN (8/20 at the
  campaign's end were green, 14/20 red); the 8 red rows all compute the
  expected results (`main() 18`, `cls(5) 13`, `props('b') 110`,
  `main('12 + 345*6')`, `enc(5) 'AHOVC5'`) and differ from native by bytes:
  the kernel emits the static-string data segment where native does not
  (closures-classes O2), and folds an `(i32.or … (i32.const 0))` native
  keeps (maps-properties O1, strings-parser O1: a hosted optimizer decision
  differs). recursive RED: `jz × jz` reaches `plan:summary` (35 phases) and
  traps `unreachable` with the heap at 4,294,967,288 of 4,294,967,296 bytes
  after 60 s: the emitFuncs blocker is gone, the wasm32 ceiling is the
  blocker now (PLAN's regions and the reserve are the answer).

## Open, in order

1. Recursive self-compile: memory. `jz × jz` exhausts the 4 GB arena in the
   summary; the front alone is 660 MB.
2. Member-reference single evaluation: `r[k] op= v` must stage `r` and `k`
   once (the `++`/`--` member path already does). The reverted attempt shows
   the trap: an optimizer that pattern-matches the unstaged shape.
3. `x += y` for bare bindings still lowers through compoundAssign's own
   arithmetic; normalizing it to `x = x + y` at prepare (as the bitwise ops
   are) needs the `+=` shape recognizers in the loop optimizers to accept the
   normalized form.
4. Loose `==` on an `any` operand against a boolean or number: the static
   BOOL arm converts (`true == 1`), the dynamic `__eq` does not; the O2
   inlined join in `test/bool-identity.js`'s tri-state case shows it.
5. `String(x)` of an `any` holding a BigInt box: `__to_str` passes the box
   through (noted in `test/bigint-tag.js`).
6. A direct Map read stored into a BigInt64Array (`a[0] = m.get(k)`) writes
   the box bits; through a local it works.
7. The host BigInt reference carrier, the fromCharCode byte pipeline, the
   local-pass deletion's `$f$exp` shape: as recorded in `campaign-1af98c2f.md`.
8. Hosted byte parity on the functional corpus (the two divergences above).
9. 1993 leaked `jz-bench-c-*` directories under the system temp.

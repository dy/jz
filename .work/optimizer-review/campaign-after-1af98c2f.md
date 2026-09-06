# Next implementation campaign — after 1af98c2f / 7c391ea

Continue substantial implementation work, not another diagnosis-only checkpoint.
Send substantive milestone receipts and continue independent slices; do not wait
after each small result. The candidates below are review inputs, not integrated
or certified releases. No push, publication, main-tree merge, dependency install
in shared trees, or generated-artifact commit is authorized.

## Lineage and ownership

- Freeze JZ `campaign-5763b63f` at `1af98c2f`, `campaign-locals-jz` at
  `87925b99`, and watr `campaign-locals` at `7c391ea`. Preserve `5763b63f`
  and `44309407` too. Start new isolated branches/worktrees from the first
  JZ/watr pair. Do not copy dirty main or amend these frozen commits.
- Use private dependency consumption with exact watr commits and complete
  package/source parity. Do not write through shared dependency links.
  Reviewer status found an untracked `watr-wt/node_modules` symlink to
  `/Users/div/projects/watr/node_modules`: report source-clean versus fully
  clean accurately, preserve the link, and never install through it.
- Coordinator retains summary, representation planning, callable/ProgramIndex
  ownership, arithmetic/typeof lowering, and numeric-demand repairs.
- You retain generic watr passes, JZ optimizer scheduling/deletion, validation,
  private builds/checkpoint tooling, and budget/CI tooling.
- **Additional bounded delegation for this campaign:** you may repair the
  `String.fromCharCode` implementation and its shared Unicode encoding helpers
  in `module/string.js`, and ordinary host-BigInt argument marshaling in
  `interop.js`. These two leaf areas are yours on the isolated branch. Do not
  change representations, ABI planning, summaries, parser sources, or global
  pointer recognition to work around them. Escalate contract changes separately.

## 1. P0: close the remaining watr propagation wrong code FIRST

The reviewer independently ran this module against `7c391ea`:

```wat
(module
  (memory 1)
  (func $id (param i32) (result i32) (local.get 0))
  (func $write (result i32)
    (i32.store (i32.const 0) (i32.const 7)) (i32.const 1))
  (func (export "f") (result i32) (local $v i32) (local $r i32)
    (local.set $v (i32.load (i32.const 0)))
    (local.set $r (call $id (i32.add (call $write) (local.get $v))))
    (local.get $r)))
```

Unoptimized: **1**. `propagate` alone: **8**. Default pipeline: **8**.
The first load moves after `$write`. A statement-level outer call did not show
this failure; making the outer call the RHS of `local.set` does.

`SW_EXT`/`SW_MEM` are cumulative booleans, but sibling invalidation looks for a
false→true transition. An outer or earlier operation can already have set the
flag, hiding a later nested effect. Repair the event/evaluation-order model,
not this particular tree. Parent effects occur after evaluation of operands.
No per-shape exceptions or blanket disabling of propagation.

Required sweep and direct pins:

- First, second and repeated same-kind effects within one statement; nested
  calls in set/tee/drop/return/store operands, effects before and after the use.
- Calls, indirect/ref calls, memory writes/grow, global writes, table effects,
  explicit throws, loads and potentially trapping arithmetic/conversions.
- Named AND numeric locals; aliased input locals; nested control, zero-trip
  loops, early exits and exception-handler operands.
- Audit `localWritesOnly`: its claim is "trap-free", but it uses a small opcode
  regex rather than the shared trap predicate. Check loads and every supported
  trapping opcode. Consolidate effects with the existing watr authority.
- Audit discarded traps separately. Preserve trap presence/order under the
  documented optimization contract; an explicit throw is never discardable.
- Capture result, log, globals and memory **after every call**, before recovery
  can overwrite evidence. Current differential snapshots at the end of a call
  sequence can hide an early wrong write. Include nonzero initialized memory.
- Pin positive transformations as well as semantic equivalence; an accidental
  no-op optimizer must not satisfy the migration's transformation tests.

Deliver isolated correctness commits and failing-before WAT evidence. Run watr
unit/spec and JZ focused differential/optimizer gates before attempting item 3.
The frozen `7c391ea` is not safe to integrate on the strength of its old suite.

## 2. Make kernel-gate verdicts trustworthy, not merely recorded

The reviewer read `scripts/kernel-gate.mjs`. These are concrete fixes to make:

1. **Speed is currently always green** after measurements. `time()` does not
   validate or execute compiler output; no ratio is judged. A kernel returning
   garbage, or a much slower correct kernel, must not be certified. Require
   compatible provenance and successful semantic/output checks before timing,
   explicit comparison thresholds, balanced A/B and B/A sampling, and unloaded
   conditions throughout. Otherwise mark incomplete. Test false-green cases
   without requiring an unloaded CI machine or waiting for real slow builds.
2. **Memory can go green on one matching row**, ignoring unmatched or failed
   cases. Require the complete declared comparison set, compatible inputs,
   levels, profiles and successful prerequisite compilations. Judge the stated
   metrics, not heap cursor alone while claiming pages/peak too. A failed or
   rewound compilation's lower final heap is not an improvement. Separate
   completion, current heap, page memory and measured peak costs.
3. **External kernel provenance is not current checkout provenance.** A supplied
   `--kernel`/`--dist` file is currently described with today's graph/profile.
   Separate runner/input provenance from kernel-build provenance. Accept a
   validated build sidecar or mark origin unknown; reject mismatched attestation
   for certification. Include staged and untracked relevant sources, actual
   dependency commits/content, input hashes, and canonical path-independent
   content identities. A path/hash of opaque bytes is not a build attestation.
4. **`--build` recreates a separate transaction.** Reuse the validated private
   build lifecycle from slice A, including cleanup in every setup/read/validation/
   profile/worker/write failure, sticky failures and timeout ownership. Avoid
   another copy of spawn/read/validate/delete. Always retain a failure manifest
   when possible; do not leave private directories when validation throws.
5. Validate CLI and worker schema: empty gate lists, unknown corpus, invalid
   levels, missing values, conflicting kernel selectors, NaN/negative tolerance
   and timeout, malformed worker JSON, missing/duplicate cases, forged green
   status, non-finite metrics, and error/signal/exit-zero combinations. A required
   incomplete gate must not look like successful certification.
6. Fix units: `.length` is not UTF-8 input bytes; `maxRSS / 1024` is MiB, not MB.
   Distinguish process-wide peak from per-case allocations and reserved park
   space. Keep recursive completion separate from memory/speed policy; 64 MiB
   headroom alone does not establish a production memory budget.
7. The new CI workflow runs `npm install` without the required sibling watr
   checkout. Wire explicit reproducible consumption and test setup in a clean
   isolated checkout. An unpublished/unpushed watr commit is an external CI
   availability blocker, not permission to publish or invent a release pin.
   Do not claim the workflow runs remotely until dependencies are available.

Keep one runner and one manifest schema; extract shared lifecycle/judgment only
where genuinely reused. Expand `test/kernel-gate.js` beyond its four fixtures.
Deliver runner correctness, lifecycle, and CI wiring in separately reviewable
commits. Do not weaken functional gates or reclassify compiler wrong code.

## 3. Finish the shared local-pass deletion, without the ratchet regression

Resume from the restored-pass baseline, not by treating `87925b99` as ready.
After item 1, measure the remaining nest/slice/ring/condref cases again with
identical sources/options/dependencies. Keep base watr, corrected watr with
JZ passes, and corrected watr without JZ passes separate.

- Reduce each missed transformation to a general small WAT kernel, not a bench
  name, seed or recognizer. Pin the transformation and zero-trip/abrupt cases.
- The entire propagation family early has already hidden JZ's guards. Explore
  the necessary **shared local canonicalization at the early scheduling point**
  without forcing unrelated copy-merging/forwarding/unrolling there. A narrow,
  general shared pass or schedule is legitimate; a JZ-compatibility algorithm,
  copied predecessor, or per-bench policy is not.
- Implement the missing loop-carried/landing-statement behavior in watr with
  explicit def-use/effect rules. Do not broaden motion before the safety sweep.
- Retire JZ's two implementations, their private helper and live callers in the
  same reviewed slice. Options must retain meaningful documented behavior;
  no silently ignored flags or hidden permanent legacy route.
- A brittle local-name regex may be replaced only after proving its intended
  semantic/performance property independently (including mutations that remove
  the required check). Do not erase the two failing shape requirements.
- Require ratchet 10/10, unchanged structural/performance budgets, relevant
  differential/minimal/optimizer gates at O0/O1/O2/O3/fast/WASI, and private fresh
  self. Attribute every binary difference. Loaded timings cannot certify that
  the historical dispatch/vm regression is absent.
- Report net maintained production LOC across BOTH repositories, including
  shared code. Keep an unsuccessful deletion isolated and continue items 4–6.

## 4. Repair the Unicode character-construction leaf

Your `String.fromCharCode(c > 0x7f)` reduction blocks the hosted parser's escapes.
Repair the general encoding/conversion path in `module/string.js`, not watr's
parser or its source strings. Reuse existing UTF-8 writers/length calculations;
check the sibling `String.fromCodePoint` path if it shares the same mechanism.

Direct semantic tests: no arguments, NUL, ASCII endpoints, 0x80/0xff/0x100,
0x7ff/0x800/0xffff, modulo-65536 inputs, fractions, negative/non-finite numbers,
multiple arguments and evaluation/conversion failures. Cover byte lengths versus
code units honestly under the documented UTF-8 contract. Test surrogate pairs
and lone surrogates explicitly; if correctness requires a string-representation
contract change, stop that portion with a reduction, not an invented divergence.
Do not repair numeric-demand or object-coercion inference in this leaf commit.

Pin `\xHH`, `\uHHHH` and scalar escapes through native and hosted compilation,
plus checkpoint round-trip, embedded NUL, last-byte boundaries, error/recovery,
and retained outputs. Diagnostic encoder overlays may isolate the Unicode bug,
but overlay success is not shipping-kernel certification. Record both.

## 5. Repair host BigInt versus internal-box ingress, narrowly

Own only ordinary public export-call marshaling in `interop.js` and its tests.
A host JS BigInt is a semantic payload, not an internal jz pointer because its
bits happen to have a NaN-box prefix. Preserve internal pointer consumers such
as `memory.read`, retained memory references, and genuine boxed results; do not
change global `isBox` recognition to solve one ingress path.

Test exact signed-i64 values including zero, ±1, extrema, 0x7ff8/0x7ffa-shaped
payloads and neighboring patterns, host → function → typed store → return,
internal versus exported callers, raw/tagged coherent ABIs, absent/Number
mismatches, error/recovery and repeated calls. No unconditional i64-parameter
assertion. No summary, representation-plan or export-ABI changes in this slice.
If metadata is insufficient to distinguish contexts, report the missing contract
rather than adding magnitude/bit-pattern heuristics or guessing semantic kind.

## 6. Complete validation and make the remaining reductions actionable

- Run the missing opt0/opt3/WASI and conformance selections, then final full
  native/matrix on the ACTUAL frozen handoff state, not the earlier C-in state.
  If the native leg fails, invoke the other required legs explicitly and report
  them literally, not as a passing matrix. No expectation/ratchet relaxation.
- Remove the absent/stale-dist confound from private validation: let the relevant
  kernel parity/oracle harnesses consume explicit private validated fresh bytes,
  sharing the build transaction. Compare baseline/candidate on matching fresh
  profiles. Do not refresh shared dist or silently substitute disk artifacts.
- Keep functional native, hosted values, hosted byte identity, actual checkpoint,
  recursive completion, memory and speed separate. Do not make repeated full
  recursive attempts before a committed coordinator semantic fix is supplied.
- For the still-wrong tokenizer/guard metadata cases, record the first divergent
  immutable fact/producer and a minimal ordinary-JS program. Compare exact full
  fact graphs where useful; do not feed solver transfers into a reader. Send
  summary/representation reductions promptly and continue independent work.
- Correct overbroad report claims such as "every string-bearing program" with an
  enumerated demonstrated domain. Distinguish a root hypothesis from a proved
  first-divergent operation. Correct retained/deleted kernel and source-clean
  versus dependency-link status in the new receipt; leave frozen records intact.

## Coordinator status and receipts

Main has uncommitted sequence/presence/typeof repairs, including null in the
expression comparison path. Your null-in-guard sibling must still be checked
separately; it is not certified by that repair. Main's current bounded review
also adds explicit catchable BigInt division/remainder zero errors and signed
MIN/-1 handling. That review is NOT complete: the new numeric error code 214
also reclassifies a user `throw 214` as RangeError through the existing unbranded
error-code decoder. The coordinator must resolve this before claiming that
slice ready. Do not copy these dirty files; request a committed handoff when
needed. Numeric demand and the internal boxed-result/encoder boundary remain
coordinator work, not authorization to repair them under an optimizer slice.

Milestone receipts: exact parent/HEAD and ordered commits, files owned, direct
failing-before case, validated bytes/results/effects, unchanged and changed
budgets, literal red/incomplete gates, and the next independent task started.
At final handoff freeze all candidates, retain concise replayable evidence,
remove only owned expendable scratch, and list remaining ownership blockers.

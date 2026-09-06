# Optimizer/validation campaign after checkpoint-45868ec5

Authorization: isolated implementation in the owned worktrees below, not main-tree
integration, publication, or semantic-summary changes. This is a multi-deliverable
campaign; finish one reviewable slice at a time and continue with the next independent
item. Send milestone receipts rather than waiting after each small test. Stop only
at a protected ownership boundary, a regression you cannot attribute, or the final
frozen handoff.

## Base and ownership

- Preserve `checkpoint-45868ec5` at `5763b63f` and `handoff-03cf346d` at `44309407`.
  Make a new branch/worktree from `5763b63f`. That checkpoint repair remains a
  review candidate, not an assertion of integration into main.
- Coordinator owns `src/summary/`, representation planning, language emitters,
  ProgramIndex production ownership, and the newly reduced numeric-demand bug.
  Main also has pending sequence-kind/typeof-effect work. Do not copy dirty main.
- Your implementation scope: checkpoint/build-test harnesses, independent validation,
  compile-budget tooling, and the bounded generic-local-pass migration below.
  Additional JZ semantic or runtime changes need coordination first.
- Start a private watr worktree at `5ff0037`. Commit changes there and consume that
  exact candidate in your private JZ installation. Never edit shared node_modules
  or the coordinator's watr checkout. Record parity and all dependency differences.

## A. Finish and harden the checkpoint slice

The current candidate usefully found a real serialization defect. Close these
remaining proof and maintenance gaps before calling this slice ready:

1. Overlay selection must reject zero OR multiple matching modules and zero OR
   multiple occurrences of a replacement target. Fail closed on ambiguous edits.
   Test those errors without building large kernels for each harness fixture.
2. `selfBuildWith` duplicates the entire private build transaction. Share that
   transaction with `selfBuild`; preserve existing APIs, validation-before-publication,
   sticky errors, signals/timeouts including exit-zero-with-error, setup/read/cleanup
   failures, and no dist fallback. Extend the existing harness tests rather than
   keeping two independently maintained lifecycle implementations.
3. Test parsed WAT literals through the actual checkpoint: empty text, quotes,
   backslashes, NUL, non-ASCII UTF-8 and escaped byte sequences, export/import names,
   data segments and retained outputs. Pin ordinary arrays too. Establish exactly
   why invoking valueOf is safe for the compiler-owned transport domain; arbitrary
   user-object coercion is not a serializer rule. Compare direct/forced bytes.
4. Measure first and repeated RECORDING after the real rewind, not only reading
   afterward plus a separate recorder test. Prepare names/inputs before the measured
   call. Exercise capacity zero, overflow and reset across actual checkpoints.
5. Inject a clearly labeled test-only failure after unpark inside the encoding path;
   prove literal stage attribution, retained diagnostics/output, and immediate recovery.
   Keep the shipping-threshold large-program path explicitly unproven while blocked.
6. Remove the claim that every real program has a wrapper: the evidence concerns
   programs needing parsed boundary-wrapper literals. Distinguish heap cursor,
   allocated/committed memory, and the 4 GiB reserved park address space.

Correct `bigint-boundary`'s unconditional `param.type === 'i64'` expectation.
BigInt semantics do not require that one physical lane; raw/boxed f64 carriers can
be valid with a matching ABI. Pin values, errors, exact bits and boundary consistency.
Keep the numeric-demand semantic regression; do not repair its summary rule yourself.

Deliverable: separate harness hardening, serializer, and checkpoint-proof commits,
with direct failing-before regressions and actual fresh-kernel results.

## B. Replace the self-confirming reachability gate

Implement an independent source-semantic suite with hand-authored expected roots,
call/effect traces and JS results. Cover export aliases/re-exports, import startup,
recursion/SCCs, closures returned or stored in objects/arrays, higher-order callbacks,
class/method dispatch, named-function expression boundaries, and address-taken calls.
Disable inlining where needed to keep a required edge observable; do not rewrite
production programs to supply compiler hints.

Use test-only fault injection to remove one required root and one required edge.
The gate must fail because required behavior disappears or compilation fails, even
when production index and emitted-function census agree on the omission. Also show
that removing a genuinely dead callable is harmless. Include empty/error/reuse cases.
Keep the existing index/output census as a consistency diagnostic, not the independent
oracle. No production reachability switch or second graph authority.

Deliverable: registered tests plus a reproducible mutation command that demonstrates
that both faulty compilers are caught. Necessary ProgramIndex repairs are reductions
for the coordinator, not edits hidden inside the harness commit.

## C. Complete a real shared-optimizer consolidation

The bounded target is both generic local passes in `src/optimize/locals.js`:
`propagateSingleUse` and `foldSetToTee`.

1. Establish ablations against the unchanged candidate: each JZ pass off, watr's
   existing equivalent on/off, and the joint result. Inventory their actual distinct
   transformations and why they are scheduled where they are.
2. Implement missing GENERAL transformations in watr using its effect/def-use rules.
   Test numeric and named locals, reads and writes within the use expression, tees,
   nested control, zero-trip loops, branch exits, potentially trapping operations,
   try_table catch stack operands, calls/indirect calls, memory.size/grow, loads/stores,
   and vectorized functions. Never infer purity merely from absence of a call/store.
3. Invoke the shared implementation at the existing JZ scheduling point if necessary.
   Moving it wholesale after devirtualization already caused a roughly 4x dispatch
   regression; that is a regression to prevent, not an accepted tradeoff. One shared
   implementation may have an early invocation without creating a second optimizer.
4. In the same candidate slice, delete the replaced JZ implementations, private
   tally/motion helpers and dead imports/callers. Preserve supported options explicitly;
   no permanent legacy path, copied algorithm, or silent no-op flag.
5. Compare byte identity first; attribute every difference and pin the general kernel.
   Report all-in maintained LOC in BOTH repositories, not relocated lines as deletion.

Deliverable: watr commits and explicit private consumption, JZ deletion/integration
commit(s), scheduling evidence, differential tests, code-size deltas and fresh self
results. If equivalence or scheduling cannot be established, keep this slice separate,
report the minimal blocker, and continue the independent validation work.

## D. Turn compile budgets into reproducible gates

Extend existing compile-budget/recursive tooling rather than making another compiler
or benchmark framework. Accept explicit private kernel bytes for review runs; build
fresh outside timed regions and never silently substitute dist.

Record exact JZ/watr revisions, dirty-tree/source hashes, dependency parity, build
profile, input graph/hash, output validity/hash/size, named phase completions, heap
cursor versus peak/page memory, and failure phase. Completion deltas are not inclusive
phase costs and cannot be interpreted as allocation across a rewind.

Use a small/medium corpus (numeric, closures/classes, maps/properties, typed arrays,
strings/parser/encoder, and compiler subgraphs), plus the separate full recursive gate.
Pin empty, A/A, immediate A/B versus fresh B, error/A, retained bytes and executable
output. Missing/invalid output, stale diagnostics and timeouts must fail the appropriate
gate. Do not make a release gate green by blessing the known semantic failures or the
current near-ceiling memory as a new acceptable target.

Timing requires an unloaded machine and serial alternating baseline/candidate runs;
otherwise publish correctness/bytes/allocation evidence only. No benchmark source,
Porffor version, ledger thresholds, or measured-results refresh in this campaign.

Deliverable: reproducible manifest/commands, tested runner failure modes, focused CI
wiring and explicit green/red/incomplete fields. Keep functional bootstrap, recursive
completion, memory and speed as separate gates.

## E. Broader wrong-code reductions while semantic repairs are coordinated

Build a family-based native/hosted differential corpus around the six fresh-self reds:
expression versus statement typeof guards, exported versus internal BigInt arithmetic,
Number/BigInt/Boolean/nullish call boundaries, reassigned encoder inputs, vectorized
receiver/callback evaluation, and warm A/A/B reuse with and without clear.

Reduce failures to ordinary JS; identify producer, semantic kind, physical carrier,
consumer, effects and failing phase. Observe thrown-function state externally. Include
collision-shaped BigInt payloads, negative zero, subnormal Number, absence, error arms,
and retained output. Compare error classes or primitive `Error.thrown` payloads correctly.
Avoid duplicating existing pins under a new source spelling.

If a defect is independently proven to be in a watr generic pass, fix it in watr in
its own commit with a minimal WAT test and JZ semantic regression. If it belongs to
summary/representation/language lowering, send the reduction immediately and continue
other work; do not implement an inference fallback. A matching pair of wrong compilers
is not a JS oracle.

## Validation and handoff

Register new tests. Per implementation slice run relevant watr tests (including its
spec suite for optimizer changes), JZ native/opt0/opt3/WASI semantic selections,
determinism/ratchet/minimal/differential, checkpoint gates, and private fresh self.
At campaign integration run full npm test and matrix; list skipped legs literally.
Run conformance for acceptance/semantics changes. Try recursive compilation after the
coordinator supplies the demand repair; until then report the blocker rather than
burning repeated multi-GiB runs on the same failure.

Keep baseline, B-only and cumulative candidates distinct. Do not invent successful
whole-pipeline memory/speed results from a lower heap at the point of a trap.

At each substantive milestone provide exact base/HEAD/ordered commits, status, files
owned, gates and attributable costs. Final handoff includes reproducible retained
evidence, omitted coverage, all remaining reds and the smallest next blockers. Clean
only owned expendable scratch. Freeze the final candidates. No main-tree writes,
merge, push, dependency publication, or generated-artifact commits.

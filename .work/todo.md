# jz — TODO

Full working history (hunts, refutations, landing paths, process lessons)
archived in .work/archive-todo-2026-07.md — grep it before re-deriving
anything; every kernel bug class and perf frontier has a banked dissection.

## Status (2026-07-23)

DONE — architecture plan Stages 0–5 complete; V1 perf goals attained
(aggregate jz 1.00× leads every WASM lane: C 1.88× / Rust 1.97× / AS 2.06× /
V8 2.17×; native C 1.11×; strbuild/lz/immutable/glyfparse won). Re-audit
items landed: shared final-optimizer tail (watr-tail.js) + kernel byte-parity
leg · six named O0 flags killing bare optimize-object gates (+ latent
lean-hash O0 fix) · solver caller-ctx copies + throwing convergence caps ·
PR #108 incorporated (snprintf clamp + ASan bench-c leg) · kernel modules-ABI
(finally-scoping fix) · SSO/JSON cluster (reassigned-param val poisoning;
objects/strings/spread cleared from KERNEL_EXCLUDE) · subscript
template-escape fix (local commit) · JSON.parse(undefined) SyntaxError ·
MUTATE_OPS dedup (3 drifted sets fixed) · dyn-keys leg registered.

## Open

* [x] watr 5.7.11 PUBLISHED (user, 2026-07-23); jz dep bumped+locked,
      determinism 5/5 against the LOCKED package (no sibling symlink) —
      audit P0 CLOSED. Battery 3066/0 on published watr.
      Unblocks determinism-from-lockfile (audit P0) + CI determinism leg.
      CONFIRMED on CI @HEAD: test workflow fails ONLY 'determinism:
      warm-process recompile' x2 (published watr lacks the reset); watr
      workflow GREEN. Still to triage: selfhost/bench/test262/pages reds
      (test262 likely pre-existing curated-set drift). selfhost red = warm
      perf gate 1.041x vs 0.99 cap — CI builds the kernel with PUBLISHED
      watr@5.7.10, missing the local watr optimizer work the 0.949x baseline
      was measured with — same watr-publish root as determinism.
* [ ] Bench refresh at HEAD → commit results.json + re-check claims gates
      (was 50 commits stale with 7 red rows predating the perf wave).
* [ ] Kernel long-tail (each characterized in the archive):
  * shaped-parser: kernel compile throws value-lost "0" on any stable-let
    shape source; post-emitter (BC-proved: selection + emitJsonShapeParser
    identical native/kernel). Next: diff generated __jp_shape WAT text.
    Implies: some in-kernel err() loses its message (throws 0).
  * bigint family (statements 2 + data 1): both-bigint bitwise ops falsely
    mix-rejected in-kernel (subnormal-carrier typeof heuristic).
  * speculate 1 (plan-field) · preeval 2 (rational carry) ·
    pow-fold 3 / fifthroot 2 (memory OOB) · async 1 (wasi-warning channel).
  * kernel-parity TODO rows (dict|2, dict|3, sum|3, arr|3): in-kernel
    vectorizer/unroller bails where native fires (O3 output smaller).
  * test:self warm perf gate: audit measured 1.081×/1.033× vs 0.99× cap.
* [ ] Audit big-ticket (5–6): canonical LoopPlan (vectorizer consumes
      loop-model.js; 16 first-match recognizers → class dispatch);
      CompileSession + TargetProfile (59 ctx importers).
* [ ] V2-class perf tails: qoi (LLVM branch sched), shapes record layout
      byte-stride follow-up, sdf research-tier, ulam/raymarcher parity noise.

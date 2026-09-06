# Campaign after 1af98c2f / 7c391ea — `campaign-1af98c2f`

Base jz `1af98c2f` (worktree `$S/c2-wt`, branch `campaign-1af98c2f`) and watr `7c391ea` (worktree `$S/watr2-wt`, branch `campaign-locals-2`). `campaign-5763b63f` @ `1af98c2f`, `campaign-locals-jz` @ `87925b99`, watr `campaign-locals` @ `7c391ea`, `5763b63f` and `44309407` are untouched. Dependencies: c2-wt's own `node_modules` (symlinks to the main checkout's packages; `watr` a copy of watr2-wt, `$S/scratchpad/sync-watr2.sh`, parity checked at every watr commit; watr's generated `types/` absent, unused at run time). Both watr worktrees are **source-clean** (`git status -uno` empty) but **not fully clean**: each carries an untracked `node_modules` symlink to `/Users/div/projects/watr/node_modules`, used read-only for watr's own test runner and never installed through; the links are preserved. No push, publication, main-tree write, shared-dependency write or generated-artifact commit.

## Commits, in order

watr (`$S/watr2-wt`, on `7c391ea`):

| commit | subject |
|---|---|
| `1c871cc` | Log a statement's effects in evaluation order, as counts |
| `5613521` | Never discard a trap: isDiscardable at every drop site, hasTrap the one authority |

jz (`$S/c2-wt`, on `1af98c2f`):

| commit | item | subject |
|---|---|---|
| `2961bd75` | 2 | Share the private build transaction as scripts/private-build.mjs |
| `011f161e` | 2 | Make the kernel gate's verdicts earn themselves |
| `7098912d` | 2 | Give the kernel-gate workflow its sibling watr checkout |
| `9ddd25e3` | 6 | Name the kernel a harness consumes; never build or substitute dist for it |
| `a5c84843` | 6 | Reachability corpus: the entry is go, not the WASI leg's reserved run |

Isolated, not on the campaign branch: jz branch `c2-fromcharcode` @ `986f0186` (item 4, on `7098912d`).

Files owned: `scripts/private-build.mjs`, `scripts/kernel-gate.mjs`, `scripts/kernel-gate-judge.mjs`, `test/kernel-gate.js`, `test/_self-build.js`, `test/kernel-target.js` (kernel naming), `test/self-build.js`, `test/reachability.js`, `.github/workflows/kernel-gate.yml`, this record; on the isolated branch `module/string.js` (fromCharCode) and `test/from-char-code.js`; in watr `src/optimize.js`, `test/optimize.js`, `test/propagate-locals.js`.

## 1. P0: propagation wrong code (closed)

The reviewer's module (a load defined before a call nested in a later `local.set` RHS) read the callee's store: 1 unoptimized, 8 after `propagate` at `7c391ea`. Cause: `substGets` logged an instruction's memory write or call before walking its operands, as a boolean, and invalidated siblings only on a false→true transition, so an outer call's flag hid the nested `$write`.

- `1c871cc`: effects are counted (`SW_MEM`, `SW_EXT`) and logged after the operands, where wasm performs them; a sibling evaluated after any effect, first or repeated, sees it; table writes count as external state. Failing-before: the reviewer's case (now 1) and five of the six new sweep tests at `7c391ea`: the outer call as set/tee/drop/return/store operand and store address; first, second and repeated effects in one statement; a trapping value before a nested effect; numeric and aliased locals; nested control, a zero-trip loop, an early exit and a handler operand. The differential harness now snapshots result, host log, exported globals and memory after every call over pattern-filled memory (`PATTERN`).
- `5613521`: `isPure`'s contract says trap-free and its implementation admitted div/rem/trunc, and every site that drops an operand guarded on it; `isDiscardable` (pure and trap-free) now guards the dead store, `x−x`, `x*0` and the identity folds, a dropped value, an empty if's condition, equal select arms, the impossible convert compare and `dropEffects` (a pure trapping value stays under a drop). `hasTrap` is the one authority (null-checked reference ops and `unreachable` added); `localWritesOnly` consults it. A single-use trapping value that forwardPropagate moves retires its defining set with the move (`retireMovedDef`), so it evaluates once, at its use. Pins: dead, cancelling, dropped, zeroed, moved.
- Gates: watr unit 349/2 skip; `test/optimize.js` 294; `propagate-locals` 16/16; spec 268/20 skip (the main checkout's `test/official` linked for the run, removed after). jz with the repaired watr: ratchet 10/10; optimizer, differential, determinism, minimal-output, passes, bool-identity, closures, types, simd, watr, interval-proof, feature-gating 977/978 (`watr bug: memory64 limits` red at the base). Bench-corpus bytes vs `7c391ea`: size 58/58 identical, speed 57/58 (−30 B).

## 2. Kernel-gate verdicts

- `2961bd75`: the private build transaction (`scripts/private-build.mjs`: builder into its own temporary directory, read, validation, removal in every outcome, no dist fallback) shared by `test/_self-build.js`'s sticky loaders and the runner; `self-build` lifecycle 28/28.
- `011f161e`: runner provenance apart from kernel provenance (head, dirty tracked and untracked sources with a diff hash, the self graph and installed watr by path-independent content hashes, profile); a `--build` attests its bytes (`--keep-kernel` writes them with a sidecar); a `--kernel`/`--dist` file is attested only by a sidecar naming its exact bytes, else origin unknown; functional is a certification only for an attestation matching this checkout, otherwise incomplete with its results kept. Speed: both kernels compile each case to valid, correct output before timing; A/B/B/A sampling, medians, `--speed-tolerance`, load under `--load-limit` before and after every case; an unattested kernel or baseline is incomplete. Memory: judged only against a baseline of the same corpus, levels and profile whose complete row set this run matches with both sides compiled to completion; heap cursor, wasm memory size (the reserved park lane named) and per-gate-process peak (MiB) judged apart; a failed compile's lower heap is never an improvement. Reports: every argument validated (19 usage cases), a worker report trusted only when whole, finite, complete for its gate, consistent with its cases and from a clean exit; `JZ_KERNEL_GATE_WORKER` is a test-only hook the manifest records. Units: UTF-8 input bytes, MiB. Exit 3 for an incomplete gate; `certified` only when attested and all green. `scripts/kernel-gate-judge.mjs` holds the verdicts as pure functions; `test/kernel-gate.js` 8/8, 145 assertions (a 1.5x ratio, a loaded machine, a missing baseline row, a failed compile with a lower heap, a forged green over a red case, a green report from a failed worker, provenance cases, fixture kernels).
- `7098912d`: the workflow checks out `dy/watr` at `WATR_REF` beside jz, with submodules, before `npm install`; the pin (`5613521`) exists only in a local worktree, so the workflow cannot run remotely yet and the record does not claim it does.
- Live: a fresh attested kernel (`k2.wasm`, 14,561,426 B): sequences GREEN, functional RED as in the previous record, memory INCOMPLETE without a compatible baseline, speed INCOMPLETE under load 5 and, with `--load-limit 50` against itself, ratios 0.93–1.00 with the failing compiles per-case INCOMPLETE; `certified: false`.

## 3. The shared local-pass deletion (still blocked, isolated)

With the repaired watr the deletion candidate `87925b99` still grows the level-2 ratchet: nest +495, slice +1,832, ring +40, condref +876 (buf recovered by `7c391ea`); the restored-pass baseline is 10/10. Per program, the growth sits in `$f$exp` (+48 loop-body ops on slice seed 1 and nest seed 8) and `$__str_hash` (+1): with jz's `foldSetToTee` the single-use local holding an `if`-valued string length (a `local.tee $isSso` in its condition) was forwarded whole into its use; watr's fixpoint instead keeps the tee for effect under a `drop` and recomputes the pure arms at the use. Reduced to a small WAT kernel (`$S/scratchpad/ratchet-shape.wat`) watr sinks it correctly, so the blocker is context-dependent inside `$f$exp` (`ratchet-slice-1-{A,B}.wat` retained: A with the passes, B without). An attempt to let `sinkSets` move a value whose only effects are local writes (a general rule with explicit def-use conditions) made the ratchet worse in both configurations (passes on: ring +80, condref +4; off: nest +506, slice +1,872) and was not committed. The slice stays isolated at `campaign-locals-jz` @ `87925b99`; net maintained production LOC unchanged this campaign.

## 4. String.fromCharCode (repaired on an isolated branch, not shipped)

`c2-fromcharcode` @ `986f0186`: the unit ToUint16(ToNumber(code)) is encoded through `__fromCodePoint`'s UTF-8 writer; NaN and ±∞ are 0; a surrogate unit stays its own 3-byte sequence and two arguments never combine (the byte string model has no lone code unit: the contract gap, recorded, not asserted as JS). `test/from-char-code.js` 7/7, 204 assertions at O0–O3 (NUL, ASCII endpoints, 0x80/0xff/0x100, 0x7ff/0x800/0xffff, modulo 65536, fractions, negatives, non-finite, strings, multiple arguments, conversion order, a throwing valueOf, byte lengths beside code units). Through a kernel built with it (`k-fcc.wasm`), `"\xff".length` is 2 and `"\xff" === "ÿ"` holds hosted as natively.

Not on the campaign branch: the compiler's own binary-string builders (`module/array.js:57`, `object.js:240`, `typedarray.js:81`, `string.js:284–308`, `number.js:401`, `regex.js:244`, `math/pow-transcend.js:513`, `src/static-data.js:108`, `compile/intern-table.js:67`, `wat/assemble/static-data.js:242`) build data chunks with `String.fromCharCode(byte)` and count bytes as `.length` (`strPoolPush`, `dataPush`, `escBytes`), an idiom that under self-hosting held only through the truncation the repair removes; with it, the kernel's pool offsets and escaped data double every byte above 0x7f. A live proof is masked today by the boxed-constant encoder bug (the same programs already fail), so this is by code inspection. The change the repair needs is a byte-array data pipeline in the emitter, not a leaf.

## 5. Host BigInt ingress (contract reported, no code)

`interop.js i64Arg`: a plain host BigInt in a `tag` slot ("may be bigint") is taken for a jz-minted box when its bits carry the box prefix (`isBox`), because a jz reference handed back to the host and a BigInt value are the same JS type in that slot; `raw` slots (always bigint) would resolve it but are unreachable at the export boundary today, and a `tag` slot may legitimately receive either. The metadata does not distinguish the two, and the assignment forbids bit-pattern or magnitude guesses, so the missing contract is reported: host↔jz references need a carrier the host can tell from a BigInt value (a wrapper type, or a per-slot ABI that says a box is impossible). The collision pins stay red in `test/bigint-boundary.js`.

## 6. Validation on the frozen handoff state

- `9ddd25e3`: `test/kernel-target.js` names its kernel (`JZ_KERNEL=<file>` explicit bytes; the jz.wasm leg reads `dist/jz.wasm` by name and fails if absent; a native harness run builds fresh through the shared transaction); `test/self-build.js` drives the three sources. `a5c84843`: the reachability corpus's entry is `go` (`run` is the WASI leg's void command entry).
- Legs (`$S/scratchpad/c2-legs.log`, selection: optimizer, differential, determinism, minimal-output, passes, watr, self-families, reachability, bigint-boundary, strings): opt0 592/601, opt3 592/601, WASI 586/600 before `a5c84843`, its six reachability reds gone after (21/21 on WASI); every remaining red is a recorded pin (`bigint-boundary` ×4, `self-families` ×4) or `watr bug: memory64`. Conformance not run: no acceptance or semantics change is on the campaign branch (the fromCharCode change is isolated).
- Full native `node test/index.js` at `a5c84843` (`$S/scratchpad/c2-full-native.log`): 4148 pass / 22 fail / 1 skip: the 8 red pins; 5 red at the base (`statements` BigInt member compound-assign, `data` ×3, `inference` receiver-HASH); `watr bug: memory64`; 7 `kernel parity`/`kernel oracle`, now on a fresh private kernel through the shared transaction (e.g. `eqzero O0: diverges (native 13533B vs kernel 12285B)`): the hosted analysis/encoder divergences below. The matrix was not run as a whole; the legs above are the literal state.
- Hosted families with a fresh kernel (`$S/scratchpad/c2-families-hosted.log`): 24/48, 21 hosted cases red, unchanged.

## Reductions for the coordinator

1. (unchanged) A BigInt read through an internal call boundary, then `|=`/`+=`, is stored or converted as its box at O0/O1; the kernel's encoder mis-encodes every `f64.const nan:0x…` payload. Demonstrated domain: every corpus program carrying an SSO string constant or a typeof tag test (the functional gate's maps/strings/JSON/closures cases, `src/ir/tape.js`, `src/abi/number.js`); a root hypothesis for the warm-reuse reds, not proved there.
2. **New: a `while` loop's `if (…) { …; continue }` vanishes in the kernel.** Ordinary JS, wrong through a kernel with the encoder workaround (so not the constant bug), at O0 and O1, arrays and strings alike:
   ```js
   const g = (a) => { let n = 0; let i = 0; while (i < a.length) { if (a[i] === 7) { i++; continue } n++; i++ } return n }
   export let f = () => g([1, 7, 2])   // 2 in JS and natively; 3 through the kernel
   ```
   First divergent immutable fact: the kernel's IR for `g` at O0 has no `if` at all (natively `(if (block …) (then (local.set $i …) (br $loop0)))`), while the `for (…) if (…) n++` form and the `if/else` form without `continue` agree with native. Producer to examine: the `continue` lowering (`src/prepare/scope.js` `retargetLoopJumps`/`hasLoopJump`, `src/compile/emit/control-flow.js` `continue`) as compiled into the kernel. This is the `strings-parser` tokenizer's divergence (`"1| |+| |2"`).
3. (unchanged) `typeof v === "object"` false for `null` in a guard; the numeric-demand seeding; the recursive blocker.
4. The fromCharCode builders (item 4) and the host BigInt carrier (item 5) contracts above.

## Remaining ownership blockers

1. The boxed BigInt across an internal call boundary (encoder constants, hosted byte identity).
2. The `continue`-in-`if` drop in the kernel's front (reduction 2).
3. The binary-string data pipeline for the fromCharCode repair.
4. The host reference carrier for BigInt ingress.
5. The deletion's remaining `$f$exp` shape.

## Scratch retained (`$S/scratchpad`)

`sync-watr2.sh`, `p0.wat`, `ratchet-cmp.mjs`, `ratchet-shape.wat`, `ratchet-slice-1-{A,B}.wat`, `ratchet-nest-8-{A,B}.wat`, `bytes-vs.mjs`, `diag-encode.json`, `red/loop-space*.js`, `c2-legs.log`, `c2-full-native.log`, `c2-families-hosted.log`, `gate2-{a,b}.json`. Kernels `k2.wasm` (+ sidecar), `k-fcc.wasm`, `k-diag2.wasm` are expendable and deleted at the freeze; the earlier campaign's logs and manifests remain.

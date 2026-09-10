# Focused v1 architecture review

Reviewed 2026-09-09, starting at `2387c85216d1634bc93358008d3ca31b1d9ef1d1`.
This is a source review with executable probes by the coding assistant. It is
not independent external expert approval.

**Recommendation: retain the pipeline, repair the boundary defects below, and
withhold v1 readiness approval.** The review found concrete correctness gaps in
host memory handling and an incomplete optimizer effect model. It did not
establish a need to replace the IR, rewrite the compiler context, or implement
a new region system before v1.

Scope: semantic summaries → representation plans; emission → JZ/watr
optimization; compile-session ownership; compiler → host memory/ABI.
`CONTRIBUTING.md`, `PLAN.md`, and the implementation are the current architecture
baseline. This was not an exhaustive parser, stdlib, security, or DSP audit.

## Implementation status

The reproductions below describe the reviewed revision, not the current behavior.
The follow-up keeps the existing pipeline and implements the review's bounded work:

- **Finding 1:** unsigned-safe upward allocation alignment; odd/mixed allocations,
  addresses above 2 GiB, and the host-to-Wasm allocator handoff are pinned.
- **Finding 2:** compiler-emitted `jz:fields` contracts constrain host construction
  and writes. They cover value families, typed layouts, nested/nullable fields,
  integer refinements and discriminants consumed by lowering. Host-exposed BigInt fields use tagged storage, including mixed Number/BigInt
  shapes; the plain metadata preserves boolean identity and validates refinements. Shared-memory modules reject
  conflicting contracts. Retained arrays admit host element changes; fresh arrays
  keep their construction-time specialization. Interop remains compiler-free.
- **Finding 3:** recursive replacement values stage before destination stores;
  fresh views survive growth. Failure preserves destination contents and length,
  while allocations and user getter effects are not rolled back. Typed marshalling
  snapshots source views over its own growable memory before allocating.
- **Finding 4:** already repaired by JZ `d6884041` and the pinned watr `3f89641`.
  Shared memory-effect classification and LICM extraction cover bulk/atomic writes,
  unknown aliases, allocation, traps, zero-trip loops and private temporary uses.
- **Analysis freshness:** CONTRIBUTING names each dependency and invalidation seam.
  Whole-store invalidation now clears anonymous roots too; executable tests cover
  signature changes, body mutation and global invalidation. No context rewrite.
- **Release surface:** memory/ABI redesign documents are marked proposals;
  STABILITY specifies UTF-16, allocation/view/reset lifetime and host-write rules.

Validation and release evidence are recorded below. The implementation does not
constitute independent expert approval or close the speed/size release gates.

## Host-storage follow-up

Host-exposed schemas now box BigInt fields consistently, including schemas shared
by numbers and BigInts. Private schemas retain raw lanes; field-type contracts
remain at the host boundary so typed methods keep their specialization. Boolean
identity is preserved by the generic host marshaller. Fresh returned literals
allocate separately; module initialization outside loops still permits static
data. The field metadata encodes only present refinements. These changes require
matching compiler/interop revisions; the historical verification below predates
this follow-up. Final combined matrix/bootstrap verification remains pending.

The generic scalar pool now belongs to Watr, after folding/inlining and before
outlining. JZ's tape implementation is removed. Watr's 333 optimizer/propagation
tests and full JS/Wasm suites pass, including exact bits, imported-global indices
and the pooling/outline interaction. The size ratchets remain unchanged.

A later benchmark probe exposed a separate ownership defect: WASI clocks wrote
to address zero, which may hold static literals. The clock now owns eight bytes
in the static pool; no per-call allocation is added. Integer output also uses
the existing signed/unsigned formatters correctly. The 48 focused WASI tests
pass, and the alpha native benchmark produces its expected checksum.

## Architectural assessment

**The decomposition is suitable for v1. The principal weakness is incomplete
enforcement of contracts between otherwise reasonable components.**

The compiler already has the right central distinction: a semantic summary
describes what values can mean, while a function plan chooses how those values
are physically represented. ProgramIndex separately owns callable identity,
reachability, and parameter boundaries. These concepts should remain distinct;
collapsing them into a universal IR or another central registry would obscure
different lifecycles without resolving the findings below.

The highest-priority architectural work is at three seams:

1. **Open host world → closed compiler proofs.** Inferred facts survive host
   exposure, but the host writer does not receive enough metadata to enforce
   them. Choose an explicit policy for host mutation and make compiler and
   interop implement the same policy. This is more consequential than whether
   the internal fact tables use names, numeric IDs, Maps, or arrays.
2. **Language-specific proofs → generic optimization.** JZ and watr have a
   sensible intended division of responsibility, but JZ still carries a
   separate effect model and overlapping loop transformations. The essential
   consolidation is ownership of effects, aliasing, and motion legality.
   Moving pass code without transferring those proofs is insufficient.
3. **Allocation → lifetime and invalidation.** Host allocation, Wasm allocation,
   reset, and marshalling must agree on non-overlap and on what an allocating
   operation invalidates. Shared layout constants do not establish that
   behavioral agreement. The observed allocator and detached-view defects are
   examples of the missing invariant at this seam.

There is also **bounded internal design debt** in analysis freshness.
`src/compile/analyze/body-facts.js:38–73` explicitly allows a body-keyed cache to
become stale as ambient inference facts change. Signature fingerprints cover
one dependency class; phase invalidation covers the others. Consequently,
adding or moving a pass still requires knowing facts beyond its apparent
arguments. Preserve the existing mutation/invalidation seams and make each
remaining dependency's invalidation point explicit. This review found no new
cache miscompile and does not justify replacing `ctx` wholesale.

For v1, keep the shared pipeline entry points, single-consumption plans,
explicit ProgramIndex identity spaces, compiler-free interop, and tape link
handoff. Defer a new semantic IR, blanket immutable-context conversion, general
region API, or wholesale vectorizer replacement unless a measured problem
requires one. The acceptance criterion for a focused change is that a boundary
has one stated contract and identifiable producers and consumers—not that every
folder looks uniform.

## Findings

### 1. P1 — Standalone host allocations overlap

**Location:** `interop.js:65–75`, `makeJsAllocator`.

The allocator rounds the current pointer **down** to an eight-byte boundary,
then advances by the unrounded request size. Following any unaligned request,
the next allocation can overwrite the previous allocation's last bytes. This
affects the public `jz.memory()` path before a Wasm allocator is installed.
The compiled allocator's behavior cannot establish correctness for this second
allocation owner.

Run from the repository root using `node --input-type=module`:

```js
import jz from './index.js'
const memory = jz.memory()
const first = memory.Uint8Array([123])
console.log([...memory.read(first)]) // [123]
memory.Uint8Array([45])
console.log([...memory.read(first)]) // [0], expected [123]
```

**Required change:** define the same alignment and non-overlap invariant for
both allocators. Round allocation starts upward using unsigned-safe arithmetic,
or maintain an aligned bump pointer after every allocation. Preserve the
existing address handling above 2 GiB. Pin consecutive odd-size allocations,
mixed constructors, and the handoff from host allocation to Wasm allocation.
No new allocation abstraction is needed to correct this arithmetic.

### 2. P1 — Host writes can invalidate the compiler's settled field representation

**Locations:** `src/summary/index.js:42–47`, `interop.js:682–687`,
`src/link/sections.js:26–45`.

The summary deliberately retains field kinds when an object reaches the host:
it relies on host writes respecting those kinds. However, `memory.write()`
checks the object's property list and accepts any marshalable field value.
The emitted schema section carries property names, not the representation
contract needed to validate the replacement.

This is a missing contract between two owners: lowering treats a field as a
known typed array, while interop can replace it with a differently laid-out one.

```js
import jz from './index.js'
for (const optimize of [0, 2, 3]) {
  const m = jz(`
    const o = { a: new Float32Array([1, 2]) }
    export const get = () => o
    export const value = () => o.a[0]
  `, { optimize })
  const handle = m.instance.exports.get()
  m.memory.write(handle, { a: new Float64Array([3]) }) // accepted
  console.log(optimize, m.exports.value())           // 0, expected 3 or rejection
}
```

Replacing with `Float32Array([3])` returns `3` at all three tiers. Replacing
with `'abc'` is also accepted by the write and subsequently traps on the read.
The probe deliberately obtains an existing object's handle through the raw
instance export; that ABI is experimental, but the compiler and interop here
are the same revision and the writer is the supported `memory.write()` API.
This is not evidence that ordinary decoded-object returns preserve identity.

**Required decision:** either emit and enforce the field contracts at host
ingress/writes, or conservatively widen fields that the host may replace. If
field writes are intentionally a caller obligation, make it an explicit,
discoverable public restriction; the current metadata cannot tell a caller
which inferred constraints to preserve. Validation metadata should remain
plain data so `jz/interop` stays compiler-free. Cover typed-element kind,
nullable fields, and nested objects, not just this one constructor pair.

### 3. P1 — Recursive marshalling retains a view across memory growth

**Location:** `interop.js:656–667`, also the object branch at `682–687`.

`memory.write()` captures a `DataView`, then invokes `memory.wrapVal()` while
using that view to store each result. Marshalling a string or nested value can
grow Wasm memory and detach the captured buffer. A supported in-capacity array
write then throws a host `TypeError` instead of completing.

```js
import jz from './index.js'
const memory = jz.memory()
const target = memory.Array([0])
memory.write(target, ['x'.repeat(70000)])
// TypeError: Cannot perform DataView.prototype.setBigInt64 on a detached ArrayBuffer
```

**Required change:** make allocation a view-invalidation boundary. Stage
recursive marshalling before acquiring the destination view, as `memory.Array`
and `memory.Object` already do, or reacquire the view after each allocating
operation. Pin both array and object writes that cross a memory-page boundary.
Also specify what remains changed if marshalling an element fails partway
through; the current array path updates the length before all values marshal.

### 4. P2 — LICM's effect summary omits memory-writing instructions

**Location:** `src/optimize/licm.js:307–329`, consumed by the invariant-read
rules in the same function. `src/optimize/driver.js` invokes this pass before
and after address rewriting.

Only `f64.store` and `i32.store` set `hasDirectStore` and record stored bases.
Narrow stores, `f32.store`, `i64.store`, and bulk/atomic memory writes are not
classified by that branch. A whitelist of safe helper names cannot compensate
for missing instruction effects.

The following pass-level probe executes valid Wasm before and after JZ's
actual LICM. Its stand-in `__typed_idx` obeys the read-only-memory helper
contract that LICM relies on:

```js
import parse from 'watr/parse'
import encode from 'watr/compile'
import { hoistInvariantLoop } from './src/optimize/licm.js'

const module = parse(`(module
  (memory 1)
  (func $__typed_idx (param f64) (param i32) (result f64)
    (f64.convert_i32_u (i32.load8_u (i32.const 0))))
  (func $f (export "f") (result f64) (local $i i32) (local $s f64)
    (loop $l
      (i32.store8 (i32.const 0) (i32.const 1))
      (local.set $s (f64.add (local.get $s)
        (call $__typed_idx (f64.const 0) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (i32.const 2))))
    (local.get $s)))`)
const run = () => new WebAssembly.Instance(
  new WebAssembly.Module(encode(module))).exports.f()
console.log(run()) // 2
hoistInvariantLoop(module.find(n => n[0] === 'func' && n[1] === '$f'))
console.log(run()) // 0
```

An `i32.store` control remains `2`; an `i64.store` variant also changes `2` to
`0`. The read is moved before the write because the effect summary says the
loop has no direct store.

**Evidence limit:** this establishes an unsound pass contract, not a reproduced
end-to-end JS miscompile. Tested JS alias/view kernels retained correct answers
at O0/O2/O3, including with watr disabled. Other lowering barriers can mask this
gap today; they are not part of the pass's declared safety proof.

**Required change:** classify all supported Wasm memory effects conservatively;
unknown write targets must block alias-dependent motion. Keep helper purity,
mutable reads, allocation effects, and possible traps separate. Pin zero-trip
loops and every store family before consolidating LICM into watr. The migration
should remove JZ's duplicate authority only after watr can express the needed
proofs, as `PLAN.md` already requires.

## Architecture to preserve

| Boundary | Evidence in the implementation | Assessment |
|---|---|---|
| Host compiler / self-hosted compiler | `src/session.js`, `src/front.js`, `src/optimize/watr-tail.js` share reset choreography, semantic front end, and final optimizer policy | A useful defense against entry-point drift. Preserve the shared paths. |
| Semantic facts / physical representation | `src/summary/query.js` isolates queries from solver transfers; `src/compile/function-plan.js` transfers collections through opaque, single-consumption handles | These are substantive ownership mechanisms. Fix missing external contracts without replacing this separation. |
| Function identity / emission order | `src/compile/program-index.js` separates source, variant, graph, and concrete IDs, closes spaces, and publishes parameter ABI rows | Keep the explicit identity spaces and finalization checks. Reachability completeness still needs its corpus gate. |
| Function frame / nested emission | `src/compile/active-function.js` swaps whole records; `test/session-reentrancy.js` checks restoration and sequential fresh-process parity | Stronger than copying selected ambient fields. Sequential determinism tests do not establish nested public `compile()` reentrancy. |
| Assembly / linking | `linkAssembled` takes a module and explicit link inputs; `src/link/index.js` passes those into tape transformations | Keep the explicit handoff. Tape transport by itself does not guarantee semantic preservation of its passes. |
| Compiler / standalone host bridge | `test/interop.js` enforces compiler-free interop imports; `layout.js` supplies shared layout definitions | Preserve this dependency direction when adding field validation. Shared constants need shared behavioral contract tests too. |

The remaining ambient `ctx` and two representations of emitted WAT are costs,
but this review did not demonstrate that replacing either is necessary for v1.
Prioritize violations of ownership and semantics over file movement or blanket
immutability refactors.

## Release contract and review handoff

Documentation needs one explicit status hierarchy. `spec/memory.md` describes
named regions, `release()`, per-call reclamation, and retiring `memory.reset()`;
`spec/boundary.md` describes selectable guarded/typed ABIs and tier reports.
Those documents are not the implemented public surface described by
`STABILITY.md` and the README. Mark them as proposals or archive them; do not
let their unmarked status trigger another broad pre-v1 rewrite.
`STABILITY.md` also still lists UTF-8 string positions although the current
README, implementation, and contribution guide specify UTF-16 units.

The lack of an independent raw ABI version marker is already an explicit
experimental limitation in `STABILITY.md`. It is not a newly discovered v1
blocker if prebuilt consumers pin matching compiler and interop revisions.

An external reviewer should receive a pinned candidate, these reproductions,
and the test logs, then assess three questions independently:

1. Does every optimization assumption about host-visible values have an
   enforced or explicit public contract?
2. Does every motion/vectorization pass account for all memory effects,
   possible traps, and zero-trip execution at its actual pipeline position?
3. Does each memory owner preserve allocation, reset, relocation, and view
   validity across host calls and repeated stateful DSP processing?

Close the reproduced host defects first, settle the LICM effect contract, then
run the final revision's release gates. Stateful DSP allocation and teardown,
recursive self-compilation, conformance, and current competitive performance
remain separate evidence obligations in `PLAN.md`; this review does not
certify them or relax their thresholds.

## Original review verification record

- All four findings above have executable reproductions run during this review.
- `npm run test:types`: passed.
- Full matrix: interrupted at the user's request; no complete matrix result.
- Reachability probe completed before interruption: 144 specimens compiled,
  one compile error (unresolved `web-audio-api` module), zero reported unsound
  functions. This is incomplete corpus coverage, not a clean release gate.
- The first matrix attempt stopped at the async HTTP fixture because sandbox
  policy denied `listen(0)` (`EPERM`). The permitted rerun was stopped when the
  user requested architectural assessment without further tests.
- The starting tree was clean. Concurrent edits to `src/summary/index.js` and
  `test/summary.js` appeared during the review and were preserved. Test results
  must be read as working-tree evidence, not certification of an immutable
  release candidate. No compiler or runtime source was changed by this review.

## Follow-up validation

The tested compiler graph is `1c4d34066abbcfc46db9af526265045afd704fc6e6a442be275959e483f88c54`.
The source changes are pinned by JZ `df25e1ba6fda5c0400cd0a5bd77d7e308c20278c`.
Watr `ba30111bdcb5a34c1467be87a5b1df7c80207443` pins that public compiler revision.
Its default build, types, JS suite and Wasm suite pass without a local override
(352 core and 268 specification tests per backend, plus propagation tests).

- Focused host memory: 73 tests, 806 assertions; summary: 24 tests,
  9,399 assertions; buffer/inlining: 62 tests; freshness/invariants: 46 tests.
- Self-hosted correctness: 32 tests, 292 assertions. Recursive self-compilation
  produces and executes a 14,893,075-byte child compiler from the 15,417,678-byte
  host compiler. Build, public types and example builds pass.
- Self-compile timing remains red: warm best 1.320× against 1.03×;
  fresh 1.134× against 0.99×. The recursive run recorded load 17.45 against
  the release limit of 2, and has no build attestation; it is functional evidence,
  not certified release performance. No thresholds or benchmark inputs changed.
- The 200-block stateful filter test preserves state across resets, matches JS
  bit-for-bit and keeps its page count stable. This does not establish VST
  instance teardown, concurrent audio-thread safety or general real-time bounds.

Language/builtin conformance passes 3,151/869 cases with zero failures and zero
accepted negative-parse cases. Local default/O0/O3 each pass 4,487 tests with
one skip (62,947/62,820/62,942 assertions). The
[CI run for the pinned revision](https://github.com/dy/jz/actions/runs/34427703871)
passes all four configurations and extended fuzz: default/O0/O3 pass 4,482 tests
each, WASI passes 4,479, with six existing platform skips per configuration.
CI also verifies example builds, public types and installation of the packed
package. The duplicate local WASI run was stopped after CI’s WASI job passed.

The CI workflow remains red because its separate claims job fails 13 of 20
checks: stale reference/memory evidence, excessive swap in the committed timing
record, incomplete rival coverage, and runtime/size leadership gaps.

The competitive run before the final generic-field metadata correction passes
242 gates and fails 24. It reports
runtime gaps (including Watr at 1.360× V8 against its 1.25× band), ten size
losses to AssemblyScript, and a 306,790-byte encoder against the 300,000-byte
budget. TinyGo coverage is missing (0/44 cases), native-lowering evidence remains
stale, perf-fuzz fails, and two examples miss strict V8 wins. Timing was measured
under development load; these failures remain visible and do not certify rankings.
The remaining release blockers stay in PLAN.md; none are waived by this review.

The completed [benchmark CI run](https://github.com/dy/jz/actions/runs/34427703791)
on the pinned source passes 240 checks and fails 8: native-lowering reference
`alpha`, AssemblyScript size comparisons for bezfit/fft/sdf/shapes/slices/wordcount,
and Watr’s 300,000-byte budget. Available tools and rival versions differ from
the local run. Self-compile, kernel-gate, test262, Watr and pages workflows also
pass on that revision. These results close the review’s verification work;
the remaining performance/evidence failures still block v1 readiness.

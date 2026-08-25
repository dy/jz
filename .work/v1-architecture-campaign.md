# V1 architecture + performance campaign

Started from `302f43dd` after the 2026-08-22 audit campaign. The release bar is
truth-first: every accepted advertised shape is exact or rejects; performance
and architecture claims require fresh evidence, not a green-but-stale ledger.
Work lands serially; each merge product rebuilds `dist/jz.wasm` and passes the
native/optimization/WASI/wasm-hosted matrix. The agent never pushes.

## Acceptance program

1. **Soundness / correct-or-reject**
   - no prose-only known-wrong cases;
   - host and internal TypedArray reads/writes preserve runtime width and
     Number/BigInt identity, or reject before returning a value;
   - dynamic object coercion never substitutes a plausible wrong result.
2. **Performance claim**
   - `test:claims` reads fresh, complete evidence from HEAD and passes;
   - every Wasm and V8-family loss is closed under the repository's existing
     claim policy; caps are never loosened to make a release.
3. **Full jz×jz goal**
   - `default(code,0,0,modules,0)` completes below wasm32 2^32 bytes;
   - no corruption, warm-instance, parity, or oracle regression.
4. **Language contract**
   - one public semantics sentence reconciles the documented machine dialect;
   - in-scope invalid syntax rejects; test262 negative accepts are classified
     and driven to the declared subset-spec floor.
5. **Architecture convergence**
   - stable indexed value/result/storage provenance is shared across analysis,
     RepresentationPlan, emit, and host ABI;
   - split `program-facts.js` products and continue phase-view/plan authority;
   - no emitter fallback silently re-derives a missing frozen plan.
6. **Public API / ABI**
   - root and subpath declarations match runtime carriers;
   - no raw ABI is accidentally frozen; any future stable raw ABI is explicitly versioned;
   - README links the contract and a clean pack/publish rehearsal passes.
7. **Native target**
   - target capabilities are explicit and generic programs can use the native
     lane without the watr-only hard-coded build assumptions.

## Slice 1 — typed value/storage provenance (closed)

General class closed: a value whose concrete TypedArray ctor is erased by a
host boundary, local assignment, method result, conditional, or indirect call.

- `src/typed-provenance.js` is the cycle-free constructor/result authority:
  direct constructors, aliases, species-preserving copies, subarray views, and
  receiver-returning mutators.
- Open indexed reads dispatch by runtime element aux. Number/BigInt mixed reads
  use a tagged helper; known no-BigInt programs retain the numeric fast path.
- Open stores are outlined once, bounds-checked, width-aware, and distinguish
  raw/boxed/dynamic value domains. The Float64 unswitch recognizes the outlined
  form and recovers the vectorized fast arm. Existing ratchet ceilings remain.
- Mixed indirect closure-table results box BigInt at the producer. Computed
  named-method dispatch boxes only the BigInt candidate arm at that exact
  dynamic-property call; ordinary direct/indirect uses keep their prior raw ABI.
- Ordinary host Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64 arrays are
  supported through the public wrapper. Evidence-free host BigInt64/BigUint64,
  Float16, and Uint8Clamped arrays reject with a remedy; constructors inside
  compiled source retain full support. Explicit low-level memory constructors
  remain available.
- Error-message coercion accepts proven closed objects/static hooks and rejects
  open/dynamic object ToPrimitive paths, including a runtime guard for erased
  values, instead of returning an object or `"[object Object]"` incorrectly.
- A newly exposed storage bug was fixed: an unproven integer TypedArray read can
  be `undefined`, so it cannot be committed to an i32 local before an in-bounds
  proof.

Pinned adversarial kernels cover every optimize tier: erased host widths,
Number/BigInt conditional reads, matched and mismatched closure-table and
computed-method stores, BigInt map/slice/filter assignment,
`Number(BigInt64Array#at)`, and dynamic Error-message objects.

Validation after Slice 2: native 3652/3651/0/1 (21,349 assertions); matrix default/O0/O3
3652/3651/0/1 and WASI 3651/3650/0/1; wasm-hosted 2905/2904/0/1 (13,990);
functional self-compile 21/21; kernel parity 3/3 (33 byte-identical rows);
kernel oracle 14/14 (605); ratchet 10/10; optimizer fixpoint 10/10; test262
language 3003/0/54 xfail with the 2507/1538 negative split; builtins
853/0/86 xfail. After Slice 2, `dist/jz.wasm` is 17,001.8 kB versus 16,963.2 kB at campaign
start. The 159-module full jz×jz goal still reaches the exact 2^32 wall; Slice
1 is a soundness/authority close, not a claim that the memory goal moved.

Concurrent main's Shape #6 named-function storage-read provenance was merged
before landing. Its first wasm-hosted validation exposed three optional-chain
expressions in `paramBigintOnly` that the self-compiled compiler did not execute
stably; explicit Map/record checks restore the full shape #6 family under
`test:wasm` without changing the native plan. Slice 2 then closes both named
residuals: ++/-- asks the active plan when local valType is absent, and generic
closure planning carries its own storage-read provenance through
`HANDLER[key](...)`. Their former KNOWN-WRONG assertions now require 901n/899n
and 7n at O0/O2/O3.

## Slice 3 — public contract and declarations

The v1 language statement is now one finite rule: JZ preserves JavaScript
answers, exceptions, order, and effects except for the machine semantics
explicitly enumerated in README; everything else is exact or rejects. Invalid
programs accidentally accepted through missing early-error checks receive no
compatibility promise and remain a v1 gate. README and CONTRIBUTING point to
that same contract rather than granting an open-ended “native could do it”
escape hatch.

Every package export now has a declaration selected by its `exports.types`
condition. Public memory allocators return the real opaque `bigint` carrier,
not `number`; root declarations cover inspection, transform, pool, warnings,
and import-meta options; interop, WASI, and transform subpaths are type-checked
in CI and prepublish. The stable embedder surface is the wrapper API. Raw
NaN-box helpers, allocator exports, and custom sections remain explicitly
experimental until they gain an independent ABI version marker, avoiding an
accidental wasm32 layout freeze.

Slice validation: TypeScript 5.8 strict/NodeNext passes; matrix default/O0/O3
3653/3652/0/1 and WASI 3652/3651/0/1; wasm-hosted 2906/2905/0/1;
functional self-compile 21/21; parity 3/3; oracle 14/14; ratchet and fixpoint
10/10. The built npm rehearsal contains 123 files including all four
declaration files (2,430,009 bytes packed, 8,269,220 unpacked). Full publish
remains correctly blocked by stale claims evidence; this slice does not pretend
to close that later gate.

## Slice 4 — indexed typed-storage plan authority

Typed receiver/result/storage provenance now has one expression grammar.
`typedStorageFact` handles constructors, aliases, calls, fields, nested indexed
storage, value-preserving assignments, copy/view/mutator method chains, and
`?:`/`&&`/`||`/`??` joins. Its result is deliberately three-state: one ctor,
open, or sticky conflict. Keeping conflict distinct caught and preserved watr's
heterogeneous `Uint8/16/32/BigUint64Array` lane builder; collapsing conflict to
“unknown” retained stale width and made i64x2 encoding throw.

Analysis supplies phase-appropriate facts through `typed-context.js`. Before
emission, every ordinary function, closure, and `__start` publishes a sparse
TypedStoragePlan. It retains the already-detached analysis views, shares call
and ctor metadata once per program, and snapshots only typed field keys when
the slot census says such fields exist; it does not duplicate every AST node or
all names. Array/TypedArray reads, writes, getters, `instanceof`, closure-call
lattices, and loop length guards consume the plan. A structural test forbids
those emitters from returning to live `typedElem`/`globalTypedElem` lookup
chains. RepresentationPlan's active emit accessors now throw on a missing
BigInt body plan instead of silently answering NO_BIGINT.

Validation: matrix default/O0/O3 3657/3656/0/1 and WASI
3656/3655/0/1; wasm-hosted 2910/2909/0/1; functional self-compile 21/21;
parity 3/3; oracle 14/14; ratchet and fixpoint 10/10; watr 37/37. test262 is
unchanged at language 3003 pass / 0 fail / 54 xfail / 2507 neg-reject / 1538
neg-accept and builtins 853 / 0 / 86 xfail. Paired compile trials showed no
stable slowdown (run-to-run noise crossed parity); machine-independent output
ratchets stayed green. `dist/jz.wasm` is 17,010.0 kB (+8.2 kB from Slice 2).
The 161-module full jz×jz probe still reaches exactly 2^32 bytes and traps
(heap i32 -32); this is architecture authority, not the memory close.

## Slice 5 — early-error validation and exact negative ledger

Raw parse negatives now compile in their original Script/Module context rather
than under the runner's synthetic `_run` wrapper. `src/early-errors.js` validates
scope/redeclaration, parameters and patterns, assignment/update targets,
control flow and labels, class/private environments, exports, and the lexical
spellings jessie's value AST erases (numeric/BigInt separators, escapes,
templates, RegExp, Unicode identifiers, hashbangs, and contextual tokens).
Validation is part of `parse()`, so bundled modules, native compilation, and
`jz.wasm` cannot drift. Sloppy duplicate simple parameters are normalized with
the last binding authoritative, including O0, instead of leaking duplicate WAT
params.

Applicable test262 negative parses moved from 2507 reject / 1538 accept to
3858 reject / 187 accept while retaining 3003 language passes and zero failures
(an 88% reduction in accepted-invalid source). The remaining 187 are exact
path-gated and grouped by parser-context loss in
`test/test262-neg-accepts.json`; a one-for-one swap now fails, unlike the old
one-way count ceiling. They remain explicit v1 blockers, not a claimed zero.

Validation: matrix default/O0/O3 3659/3658/0/1 and WASI
3658/3657/0/1; wasm-hosted 2912/2911/0/1; functional self-compile 21/21;
parity 3/3; oracle 14/14; ratchet/fixpoint 10/10; language test262
3003/0/54 xfail with the 3858/187 negative split; builtins 853/0/86 xfail.
The parser scan raises parse-only time on small sources but paired total compile
trials stayed near parity; the fresh self compiler remains a strict win
(0.888x locally). The machine-sensitive warm pin is still red at 1.06–1.09x
against its unchanged 1.03 cap, so no performance claim is made or cap loosened.
`dist/jz.wasm` is 17,258.9 kB. The 162-module full jz×jz probe remains at
exactly 2^32 bytes and traps (heap i32 -24).

## Remaining order

Next: close or explicitly defer the 187 parser-context residuals, then 4 GiB
attribution/closure, fresh performance evidence + general loss fixes,
then generic native legalization/tooling. Source maps and ecosystem demos are
separate product-roadmap decisions, not substitutes for these gates.

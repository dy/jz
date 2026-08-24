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
   - only intentionally stable raw ABI is frozen and versioned;
   - README links the contract and a clean pack/publish rehearsal passes.
7. **Native target**
   - target capabilities are explicit and generic programs can use the native
     lane without the watr-only hard-coded build assumptions.

## Slice 1 — typed value/storage provenance (in validation)

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

Validation on the final merge product: native 3652/3651/0/1; matrix default/O0/O3
3652/3651/0/1 and WASI 3651/3650/0/1; wasm-hosted 2905/2904/0/1;
functional self-compile 21/21; kernel parity 3/3 (33 byte-identical rows);
kernel oracle 14/14 (605); ratchet 10/10; optimizer fixpoint 10/10; test262
language 3003/0/54 xfail with the 2507/1538 negative split; builtins
853/0/86 xfail. `dist/jz.wasm` is 16,993.8 kB versus 16,963.2 kB at campaign
start. The 159-module full jz×jz goal still reaches the exact 2^32 wall; Slice
1 is a soundness/authority close, not a claim that the memory goal moved.

## Remaining order

After Slice 1 merges: public types/contract (small, release-facing), indexed
ProgramIndex/result provenance consolidation, test262 early-error contract,
4 GiB attribution/closure, fresh performance evidence + general loss fixes,
then generic native legalization/tooling. Source maps and ecosystem demos are
separate product-roadmap decisions, not substitutes for these gates.

# Tiers

There is one lattice and one lowering. The typed kinds are `f64`, `i32`, `i64`, `v128`, `str`, `typedarray T`, `struct S`, `array T`, `dict V`, `closure C`, plus `any`, the tagged union of those kinds. A function is typed when no value in it is `any`; otherwise it is boxed. Both are compiled by the same lowering; a boxed function calls the runtime for its `any` operations. The tier is decided per function, once, by rule, and reported. No value inside a function changes tier.

## Assignment rule

A function is typed when both hold:

1. Its signature is provable: every parameter has one non-`any` kind and the result has one kind or is `void`. Evidence comes from the signature fixpoint below, from typed-array, struct, and literal arguments at every call site, and from the function's own body (a parameter used only as a typed array is a typed array). Source annotations are not read; the report says what evidence is missing.
2. Its body checks: every local, expression, and callee resolves to a non-`any` kind under local inference. One `any` site makes the function boxed; that site is the reported reason.

A boxed function is still lowered on the IR with static kinds everywhere the kind is known; only the `any` values go through runtime operations.

## Signature fixpoint

The lattice is the kinds above with `any` as top, computed over signatures only:

- start every parameter at the join of its call-site argument kinds; `any` when any site is unknown, a value read, or a host boundary under the guarded ABI;
- iterate until no signature changes; the lattice is finite and the join monotone, so the fixpoint exists;
- the call graph is complete by construction (roots: exports, address-taken functions, module-init references; edges: direct, member, dispatch, optional, default-parameter). The reachability probe pins completeness.

No pass mutates a signature after the fixpoint. Local inference reads signatures and never writes them.

## `any`

`any` exists for heterogeneous containers, host inputs under the guarded ABI, and JSON. Its representation is a tagged value in linear memory. The operations on `any` are the good-parts operators with JS semantics over the kinds that exist in the subset (`spec/subset.md`); there is no prototype chain, no shape transition, and no implicit conversion beyond what those operators define. A value read out of `any` narrows by a kind check; a failed check is a JS `TypeError` at the site.

## Closures

A closure is typed when its captured bindings have non-`any` kinds and its signature is provable; its capture record is a struct in the region that bounds its lifetime. Otherwise it is a boxed closure.

## What is never a tier decision

- Representation is not chosen per value: `i32` versus `f64` follows the rule in `spec/subset.md`.
- Boxing is not a fallback inside a typed function: if a value would need `any`, the function is boxed and the report says why.
- Vectorization, LICM, and CSE are dataflow on the IR and never change a tier.

## The tier report

`jz --tiers` (and the `tiers` option) emits one line per function:

```
typed  render        (f32array, f32array, struct Params) -> void      region: none escapes
boxed  scheduleNote  reason: `event.detail` is any at scheduleNote:12; typed if `event` is struct Event
call   render        from scheduleNote:31 with an any argument; kind-checked at entry
```

The report is deterministic and part of the differential corpus: a change that moves a function between tiers, or changes what a function lets escape, is a reviewed diff.

## Cost model the report exposes

- typed to typed: direct call;
- boxed to typed: kind checks on `any` arguments at the call, proportional to arity;
- typed to boxed: tagging at the call;
- a boxed function on a hot path is the signal to change the source shape the report names, never a compiler flag.

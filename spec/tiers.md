# Tiers

Every function is either typed or dynamic. The decision is made by rule, once, before lowering, and reported. No value inside a function switches tier.

## Assignment rule

A function is typed when both hold:

1. Its signature is provable: every parameter has one typed-tier type, and the result has one type or is `void`. Evidence comes from the signature fixpoint below, from typed-array and struct arguments at every call site, from the function's own body (a parameter used only as a typed array is a typed array), and from literal shapes. Source annotations are not required and not read; the report says what evidence is missing.
2. Its body checks: every local, every expression, and every callee resolves to typed-tier types under local inference. One unresolvable site makes the whole function dynamic; that site is the reported reason.

Exports use the host ABI chosen for the module (`spec/boundary.md`); a typed export keeps its signature and gets an adapter, a guarded export is dynamic at the boundary and may call a typed body.

## Signature fixpoint

One lattice, the typed-tier types plus `dynamic`, computed over signatures only:

- start every parameter at the join of its call-site argument types, `dynamic` when any site is unknown, a value read, or a host boundary;
- iterate until no signature changes; the lattice is finite and the join is monotone, so the fixpoint exists;
- the call graph is complete by construction (roots: exports, address-taken functions, module-init references; edges: direct, member, dispatch, optional, default-parameter). The reachability probe pins completeness.

No pass mutates a signature after the fixpoint. Local inference inside a body reads signatures and never writes them.

## Closures

A closure is typed when its captured bindings have typed-tier types and its signature is provable; its capture record is a struct. Otherwise it is a dynamic closure with a boxed environment. A typed closure passed to the dynamic tier is boxed at the boundary.

## What is never a tier decision

- Representation is not chosen per value. `i32` versus `f64` follows the type rule in `spec/subset.md`, not a per-site guess.
- Boxing is not a fallback inside a typed function. If a value would need a box, the function is dynamic and the report says why.
- Vectorization, LICM, and CSE are dataflow on the IR and never change a tier.

## The tier report

`jz --tiers` (and the `tiers` option) emits one line per function:

```
typed    render        (f32array, f32array, struct Params) -> void
dynamic  scheduleNote  reason: `node.gain` is a dictionary object at scheduleNote:12; typed if `node` has a fixed shape
adapter  render        called from scheduleNote:31 with a boxed argument; unboxed at entry
```

The report is deterministic and part of the differential corpus: a change that moves a function between tiers is a reviewed diff, not an accident.

## Cost model the report exposes

- typed to typed: direct call, no cost;
- dynamic to typed: an adapter that checks and unboxes each argument and boxes the result; cost proportional to arity;
- typed to dynamic: boxing at the call; the typed function stays typed;
- a dynamic function on a hot path is the signal to change the source shape the report names, never a compiler flag.

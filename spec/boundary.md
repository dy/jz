# Boundaries

Two boundaries exist: between the tiers inside a module, and between the module and its host. Both are explicit, generated once per crossing, and visible in the tier report.

## Value representations at a boundary

| Kind | Typed tier | Dynamic tier | Host (`guarded`) | Host (`typed`) |
|---|---|---|---|---|
| number | `f64` or `i32` | boxed number | JS number | `f64` / `i32` |
| boolean | `i32` | boxed boolean | JS boolean | `i32` |
| string | none | GC `i16` array | JS string via js-string builtins | JS string |
| typed array | `typedarray T` in linear memory | reference to the same storage | view over exported memory | view over exported memory |
| struct | `struct S`, unboxed fields | boxed object of shape S | plain object copy | plain object copy |
| object | none | GC object (shape or dictionary) | plain object copy | rejected |
| closure | `closure C` | boxed closure | JS function wrapper | rejected |
| BigInt | `i64` | none | JS BigInt | `bigint` |
| null / undefined | none | boxed sentinel | `null` / `undefined` | rejected |

A kind with "none" in a tier never appears there; the tier rule in `spec/tiers.md` guarantees it.

## Tier boundary inside a module

- typed to typed: direct call, typed signature.
- dynamic to typed: an adapter per callee. It checks each argument's kind, unboxes, calls, and boxes the result. A kind mismatch throws a JS `TypeError` naming the callee and parameter; the adapter is the only place a typed function can observe a wrong kind.
- typed to dynamic: boxing at the call site; the result is unboxed by kind check, and a mismatch is a `TypeError` at the site.
- A typed closure crossing into the dynamic tier is boxed with its capture record; a dynamic closure never enters a typed body.

## Host ABIs

A module, or an export, selects one:

- `guarded` (default): every export accepts any JS value. The adapter coerces per JS semantics (ToNumber, ToString, structured copy for objects and arrays), so calling with the wrong kind behaves as JS would. This is the JS-semantics contract and the only one that may publish JS-comparison numbers.
- `typed`: an export keeps its typed signature. The caller passes matching kinds; a mismatch traps with a message naming the export and parameter. No coercion code is emitted. This is the kernel contract and the only one that may publish kernel-size and kernel-speed numbers.

The two contracts are never mixed in one number. A README figure states which ABI produced it.

## Errors and traps

- Dynamic-tier errors are JS errors with JS classes; the host decodes them through the last-error channel, which follows the source: a module containing `throw` declares it regardless of reachability.
- Typed-tier traps (bounds, kind mismatch under `typed`) carry a message with the function and site; they are contracts, listed in the tier report.

## Memory sharing

Typed arrays are the shared storage between tiers and with the host: one linear-memory region, referenced by both tiers and exported as a view. GC objects cross to the host by copy or as `externref`, never by address.

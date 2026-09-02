# Boundaries

Two boundaries exist: between typed and boxed functions inside a module, and between the module and its host. Both are explicit, generated once per crossing, and visible in the tier report.

## Representations

| Kind | Typed value | As `any` | Host (`guarded`) | Host (`typed`) |
|---|---|---|---|---|
| number | `f64` or `i32` | tagged number | JS number | `f64` / `i32` |
| boolean | `i32` | tagged boolean | JS boolean | `i32` |
| string | `str` (region storage) | tagged reference | JS string via js-string builtins | JS string |
| typed array | `typedarray T` | tagged reference | view over exported memory | view over exported memory |
| struct | `struct S`, unboxed fields | tagged reference to the same storage | plain object copy | plain object copy |
| array, dict | `array T`, `dict V` | tagged reference | plain array or object copy | rejected |
| closure | `closure C` | tagged reference | JS function wrapper | rejected |
| BigInt | `i64` | none | JS BigInt | `bigint` |
| null / undefined | none | tagged sentinel | `null` / `undefined` | rejected |

The `any` representation is a tagged value in linear memory: a number carries itself; every other kind carries its tag and a region reference. A kind with "none" never appears in that column.

## Inside a module

- typed to typed: direct call, typed signature.
- boxed to typed: each `any` argument is kind-checked and narrowed at the call; a mismatch throws a JS `TypeError` naming the callee and parameter. This is the only place a typed function can observe a wrong kind.
- typed to boxed: values are tagged at the call; a result read back from `any` is narrowed by kind check.
- A typed closure crossing into `any` is tagged with its capture record; a boxed closure never enters a typed body.

## Host ABIs

A module, or an export, selects one:

- `guarded` (default): every export accepts any JS value. The adapter coerces per JS semantics (ToNumber, ToString, structured copy for arrays and objects into `any`), so calling with the wrong kind behaves as JS would. This is the JS-semantics contract and the only one that may publish JS-comparison numbers.
- `typed`: an export keeps its typed signature. The caller passes matching kinds; a mismatch traps with a message naming the export and parameter. No coercion code is emitted. This is the kernel contract and the only one that may publish kernel-size and kernel-speed numbers.

The two contracts are never mixed in one number. A README figure states which ABI produced it.

## Regions at the host boundary

- A value returned to the host under `guarded` is copied out; the region rule then releases it normally.
- A typed array returned or received under either ABI is a view over exported memory whose region is the session region, so the host owns its lifetime until `release()`.
- Nothing allocated by an export survives the call except what escapes into the session region or a named region; the tier report lists both per export.

## Errors and traps

- Errors on `any` operations are JS errors with JS classes; the host decodes them through the last-error channel, which follows the source: a module containing `throw` declares it regardless of reachability.
- Typed contracts (bounds, kind mismatch under `typed`, region escape rejections) trap or reject with a message naming the function and site; they are listed in the tier report.

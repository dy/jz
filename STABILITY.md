# Stability — the v1 public surface

What the first stable major will commit to. Anything not listed here is
internal or experimental and may change without notice before v1. Within a
stable major, listed items change only additively; removals or meaning changes
require a major bump.

## The semantics contract

**Correct within the documented dialect, or reject.** JZ accepts ordinary
JavaScript source but deliberately gives a finite set of constructs native,
machine-level semantics: wrapping i32 and i64 arithmetic, fixed object shapes, manual
memory lifetime, host-boundary job scheduling, and the other cases enumerated
under [“What differs from JS?”](README.md#what-differs-from-js). Those listed
differences are part of the language contract; they are not claims of exact
ECMAScript behavior.

Outside that explicit list, an accepted program must preserve JavaScript's
answers, exceptions, operand order, and effects at every optimization level.
Where the compiler cannot do so, it must reject rather than silently choose a
representation or value. Any unlisted silent wrong value is release-blocking.

The parser now validates structural scopes/targets/control flow plus lexical
numeric, string, template, RegExp, identifier, class, and module errors before
jzify, natively and in `jz.wasm`. Callers can select an explicit `script` or
`module` parse goal through `sourceType`; the default `jz` goal preserves the
export-as-ABI dialect. On the pinned test262 language corpus it rejects all
4,045 applicable negative-parse files and accepts none. The exact empty ledger
is gated in `test/test262-neg-accepts.json`; any future accepted-invalid path is
a v1 release blocker, never a supported extension.

## Package surface (`jz` on npm)

Entry points (package.json `exports`):

- `jz` — `jz(code, opts?)` default export → `{ exports, memory, instance,
  module }`; tagged-template form supported. `jz.pool` is the shared-memory
  worker pool. Named: `compile(code, opts?)` → `Uint8Array` (or WAT `string`
  with `{wat: true}`; `{inspect: true}` wraps either as `{wasm|wat, inspect}`),
  `compileModule`, `instantiate`, `transform`, `resolveWatrOpts`. The inspect
  payload and the object returned by `resolveWatrOpts` are not stable.
- `jz/interop` — the supported host bridge: `instantiate`, `toModule`, and
  `memory`. Enhanced memory exposes `String`, `Array`, `Object`, `Hash`,
  `Buffer`, `BigInt`, `External`, typed-array allocators, `read`, `wrapVal`,
  `write`, `alloc`, `allocTyped`, and `reset`. Lower-level exports remain
  available for expert use but are experimental as described below.
- `jz/wasi`, `jz/transform` — as documented in README.
- TypeScript declarations for the root and every exported subpath.

Marshalling policy at the host boundary: plain BigInt values cross only at
slots with compiler-emitted evidence (see ABI below); everywhere else they
reject with a typed `TypeError` — never a silent string or bit
reinterpretation.

## Host memory contract

Strings use UTF-16 code units. UTF-8 is an explicit encoding or I/O boundary.
`memory.Object()` and `memory.write()` enforce compiled field kinds, typed
storage layouts, nested schemas, integer refinements, and discriminants used
by lowering. Incompatible replacements throw `TypeError`; use matching values
or change the source to admit the intended alternatives. Nullable fields admit
their declared value family and nullish values. Decoding uses the same field
contract. Objects exposed by the compiled program use tagged BigInt fields, so
BigInts and numbers can share a shape without ambiguous raw bits. Private raw
schemas retain their experimental decoding restrictions. Returned object literals
have independent storage; host mutation of one result cannot change later results.
Booleans keep their identity in structured host construction and writes.

Modules sharing a memory must agree on contracts for an existing schema; an
incompatible module binding rejects rather than reinterpreting live objects.

Plain arrays shared with the host across calls have open element types; typed
arrays retain their element storage policy. Fresh arrays can remain specialized
while being built, before they are returned. The
`jz:fields` metadata is plain data consumed by compiler-free interop; its binary
format and `memory.fieldContracts` are experimental raw ABI details.

Allocation starts are rounded upward to eight-byte alignment, without signed
address truncation. An allocating operation may grow memory and invalidate
previous views; retain handles and reacquire views with `memory.read()`.
Plain-array and object writes marshal all replacement values before committing destination
contents and length. If staging throws, the destination stays unchanged, but
completed allocations remain until `reset()` and user getter side effects are
not rolled back. `reset()` invalidates post-reset-base handles; module-initialized
state remains live. Direct memory writes and forged raw pointers bypass these
checks and remain the caller's responsibility under the experimental raw ABI.

## CLI (`jz`, bin → cli.js)

Stable commands and flags: `jz <file.js>`, `--strict`, `--jzify`, `-e`,
`--output/-o` (`.wat`, `.wasm`, `-`), `-O0..3`/`-Os`/`-Ofast`/`--optimize`,
`--define/-D K=V` (repeatable), `--host js|wasi|native`, `--memory <pages>`,
`--max-memory <pages>`, `--import-memory`, `--no-alloc`, `--no-simd`,
`--why-not-simd`, `--stencil`, `--outer-strip`, `--no-tail-call`,
`--no-eh-abort`, `--names`, `--stats`, `--help/-h`. New flags may be added;
listed flags keep their meaning.

## Experimental raw Wasm ABI

The high-level wrapper API is the v1 embedder contract, but prebuilt binaries
must currently use matching compiler and interop revisions. Direct
consumption of raw Wasm is intentionally not frozen yet: emitted binaries carry
no independent ABI version marker, and a future carrier/layout redesign
(including wasm64) must not be trapped by an accidental pre-v1 promise.

For current-toolchain integrations, `jz:hostabi` records per-export BigInt
argument policy and `jz:i64exp` records i64-carried parameters/results. The
NaN-box helpers in `jz/interop`, `_alloc`/`_clear`, schema ids, custom-section
payloads, and carrier bit layout are internally consistent and regression-tested
for each build, but are not cross-release compatibility interfaces. Use
`jz/interop.instantiate()` unless the consumer pins the exact JZ version. A
future stable raw ABI requires an explicit version marker and decoder contract.

## Error contract

Error **classes and codes** are stable; message **text** is not (messages
may keep improving — pin behavior, not prose). Registration-time integrity
is guarded: a module silently overwriting another's flat emitter
registration is a loud error at compile-tool startup, not a latent
miscompile.

## Explicitly not stable

`_setCompileTarget` and any `_`-prefixed export; the `inspect` payload and
`resolveWatrOpts` result shape; the low-level `jz/interop` exports `wrap`,
`coerce`, `f64ToI64`, `i64ToF64`, `ptr`, `offset`, `type`, `aux`, and the four
`*_NAN` constants; raw Wasm custom sections and allocator exports;
compiled-module internal layout (NaN-box bit patterns, schema ids, function
names beyond exported ones — the name section is opt-in via `--names`);
`.work/` documents; kernel (`dist/jz.wasm`) byte identity between releases.

## Remaining v1 release gate

- **In-wasm self-compilation of jz itself** has passed below the wasm32
  ceiling. The 2026-09-08 integration produced a 13,685,741-byte compiler,
  instantiated it, and probed its output; functional and sequence gates also
  passed on that artifact. This closes the earlier fit-under-4-GiB blocker,
  not the remaining correctness or competitive-performance gates. Repeat
  release verification on the final packaged revision. Evidence and remaining
  failures are tracked in [PLAN.md](PLAN.md); historical verification is
  recoverable through [.work/README.md](.work/README.md).

## Known limitations at v1

- **DataView indexed own properties** are unsupported. Indexed writes reject;
  use DataView setters to write bytes. An unextended view has no `.length` or
  indexed elements; `.byteLength` and `.byteOffset` describe its byte bounds.
- **Ambiguous `boolean∪number` locals** whose stored identity would escape
  reject at compile time (truthiness-only uses compile fine); full support
  needs a tagged Boolean carrier plan.
- **Rest-parameter BigInt elements** have no reachable evidence today and
  reject per the marshalling policy.

### Iterator patterns

Array declaration, assignment and parameter patterns share lazy iterator pulls,
undefined-only defaults and IteratorClose on early completion or binding errors.
Strings consume Unicode code points. Literal arrays can lower directly.
Native Map/Set iteration views are snapshots, as in their existing keys/values/
entries methods; mutation during collection iteration is not live. Custom
iterator overrides on indexed values are not implemented. Plain object iterator
providers and generator machines use their next/return protocol.
